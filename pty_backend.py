"""PTY backend - the single place in this project that knows which OS it is running on.

Everything above this file (session.py, daemon.py, server.py) speaks one vocabulary:

    argv-ish shell string, env as a **dict**, sizes as **(cols, rows)**

and each backend translates that into whatever its own PTY library wants. The translations
are deliberately asymmetric and easy to get wrong, so they live here and nowhere else:

    | thing        | Windows (pywinpty)              | POSIX (ptyprocess)          |
    | ------------ | ------------------------------- | --------------------------- |
    | command      | (exe, cmdline string)           | argv list                   |
    | env          | "k=v\\0k=v\\0..." single string  | dict                        |
    | size order   | (cols, rows)                    | (rows, cols)  <- flipped    |
    | read         | returns str, non-blocking poll  | raw fd -> bytes -> decode   |
    | teardown     | `del` (destructor reaps)        | terminate(force=True)       |

## The read() contract

    read(timeout) -> str   non-empty: output
                  -> ""    nothing within `timeout` (caller should loop)
                  -> None  EOF, the child is gone (caller should stop)

Returning "" instead of blocking forever is what lets the one reader thread per session
notice `_alive` going False and exit.

## Why the decoder is incremental (POSIX)

On POSIX we read raw bytes off the fd, and a read can land in the MIDDLE of a multi-byte
UTF-8 character - which is most Korean text. Decoding each chunk independently would emit a
replacement char at every unlucky boundary. `codecs.getincrementaldecoder` carries the partial
tail into the next chunk. pywinpty already hands us str, so Windows never had this problem and
the bug would only ever have appeared on the Mac.
"""
import codecs
import logging
import os
import shlex
import sys
import time

log = logging.getLogger("webterm.pty")

IS_WINDOWS = sys.platform == "win32"
IS_MACOS = sys.platform == "darwin"

# Idle sleep when the PTY has nothing to read (Windows polls; POSIX uses select).
# 0 burns CPU; too big adds latency.
POLL_IDLE = 0.004

# Read size for one POSIX fd read.
READ_CHUNK = 65536


class PtyUnavailable(RuntimeError):
    """The PTY layer cannot start on this machine - the message is meant for a human."""


# -- Platform support ----------------------------------------------------------
SUPPORTED_PLATFORMS = ("win32", "darwin", "linux")


def platform_name():
    if IS_WINDOWS:
        return "Windows"
    if IS_MACOS:
        return "macOS"
    if sys.platform.startswith("linux"):
        return "Linux"
    return sys.platform


def check_supported():
    """Raise PtyUnavailable with an actionable message, or return quietly.

    Called from the daemon and the web server at startup so an unsupported OS gets a sentence
    instead of a bare `ModuleNotFoundError: No module named 'winpty'` from an import 20 frames down.
    """
    if not (IS_WINDOWS or IS_MACOS or sys.platform.startswith("linux")):
        raise PtyUnavailable(
            f"winterm-web does not support this platform ({sys.platform}).\n"
            f"Supported: Windows 10 1809+ / 11, macOS, Linux."
        )
    if IS_WINDOWS:
        try:
            import winpty  # noqa: F401
        except ImportError:
            raise PtyUnavailable(
                "pywinpty is not installed - it is the Windows ConPTY binding and is required.\n"
                "    python -m pip install -r requirements.txt"
            )
    else:
        try:
            import ptyprocess  # noqa: F401
        except ImportError:
            raise PtyUnavailable(
                "ptyprocess is not installed - it is the POSIX PTY binding and is required.\n"
                "    python3 -m pip install -r requirements.txt"
            )


# -- Default shell -------------------------------------------------------------
def default_shell():
    """The shell to spawn when neither config nor WEBTERM_SHELL says otherwise.

    Windows: -NoLogo so the 5-line banner doesn't push the prompt down.
    POSIX:   the user's $SHELL, login mode so their profile (PATH, aliases) actually loads.
             `-l` matters more on macOS than Linux - a GUI-launched process there inherits a
             minimal PATH, so without it `brew` installs are missing from the shell.
    """
    if IS_WINDOWS:
        return "powershell.exe -NoLogo"
    fallback = "/bin/zsh" if IS_MACOS else "/bin/bash"
    return (os.environ.get("SHELL") or fallback) + " -l"


# -- Shell discovery -----------------------------------------------------------
# The settings panel offers a LIST rather than a free-text box. Typing the command by hand means
# knowing both the executable and the flags it wants (-NoLogo, -l), and a typo produces a pane
# that just fails to open with no hint as to why.
#
# Cached: /api/config is fetched on every page load and this touches the filesystem.
_shells_cache = None

# (command, label). The command carries the flags, since that is the part nobody should have to
# remember - see default_shell() for why -NoLogo and -l are there.
_WIN_CANDIDATES = [
    ("powershell.exe -NoLogo", "Windows PowerShell"),
    ("pwsh.exe -NoLogo", "PowerShell 7"),
    ("cmd.exe", "Command Prompt"),
    ("wsl.exe", "WSL"),
    ("bash.exe -l", "Git Bash"),
]
# Extra places to look for a shell that may not be on PATH.
_WIN_EXTRA_PATHS = {
    "bash.exe -l": [
        os.path.join(os.environ.get("ProgramFiles", "C:" + os.sep + "Program Files"),
                     "Git", "bin", "bash.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Git", "bin", "bash.exe"),
    ],
}


def _win_shells():
    import shutil

    found = []
    for cmd, label in _WIN_CANDIDATES:
        exe = cmd.split(" ", 1)[0]
        if shutil.which(exe):
            found.append({"cmd": cmd, "label": label})
            continue
        for path in _WIN_EXTRA_PATHS.get(cmd, []):
            if os.path.exists(path):
                rest = cmd.split(" ", 1)[1] if " " in cmd else ""
                found.append({"cmd": (path + " " + rest).strip(), "label": label})
                break
    return found


def _posix_shells():
    """/etc/shells is the system's own answer to "what may a login shell be", so prefer it and
    fall back to probing if it is missing (some containers have no such file)."""
    seen, found = set(), []
    paths = []
    try:
        with open("/etc/shells", encoding="utf-8", errors="replace") as f:
            paths = [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]
    except OSError:
        paths = []
    for extra in ("/bin/zsh", "/bin/bash", "/bin/sh", "/usr/bin/fish", "/opt/homebrew/bin/fish"):
        if extra not in paths:
            paths.append(extra)
    current = os.environ.get("SHELL")
    if current and current not in paths:
        paths.insert(0, current)
    for path in paths:
        if path in seen or not os.path.exists(path):
            continue
        seen.add(path)
        name = os.path.basename(path)
        found.append({"cmd": f"{path} -l", "label": f"{name}  ({path})"})
    return found


def detect_shells():
    """Shells that actually exist on this machine, most conventional first.

    The first entry is what `default_shell()` would pick, so the panel can label it.
    """
    global _shells_cache
    if _shells_cache is None:
        _shells_cache = _win_shells() if IS_WINDOWS else _posix_shells()
    return _shells_cache


# -- OSC 7 (cwd reporting) -----------------------------------------------------
# Goal: after `cd`, a split (`Ctrl+]`) must open the new pane in THAT folder. The shell has to
# tell us where it is, and measured (2026-08-26) PowerShell emits none of OSC 7 / 9;9 / title,
# so we make it emit. Same trick Windows Terminal's shell integration uses.
#
# Three rules:
#   1. Don't break the user's prompt - the profile loads first and `-Command` runs after, so we
#      capture the existing `prompt` ($o) and have ours call it as-is.
#   2. PowerShell 5.1 syntax only - the backtick-e escape is PS6+, so use `[char]27`
#      (same family of pitfall as the profile-BOM incident).
#   3. Don't emit at non-filesystem locations (registry, etc.).
def _osc7_prompt_arg():
    return (
        ' -NoExit -Command "'
        "$e=[char]27;$b=[char]7;"
        "$o=(Get-Command prompt -EA SilentlyContinue).ScriptBlock;"
        "function global:prompt{"
        "$l=$ExecutionContext.SessionState.Path.CurrentLocation;"
        "if($l.Provider.Name -eq 'FileSystem'){"
        "[Console]::Write($e+']7;file:///'+($l.ProviderPath -replace '\\\\','/')+$b)};"
        "if($o){& $o}else{'PS '+$l.Path+'> '}}"
        '"'
    )


# POSIX note: zsh and bash do NOT emit OSC 7 by default either, and the equivalent fix would be
# injecting into the user's rc file (precmd / PROMPT_COMMAND) - i.e. editing their dotfiles.
# That is a bigger decision than a spawn flag, so for now POSIX simply does not report cwd:
# `_update_cwd` is never called and the session keeps its spawn folder. A split then opens where
# the pane STARTED rather than where it currently is. Degraded, not broken.


def _win_cmdline(shell):
    """Windows: `shell` string -> (exe, args-string). Appends the OSC 7 prompt for PowerShell."""
    exe, _, rest = shell.partition(" ")
    rest = rest.strip()
    base = os.path.basename(exe).lower()
    is_ps = base.startswith("powershell") or base.startswith("pwsh")
    # If the user already told it to run something via -Command, leave it (overwriting kills their intent)
    if is_ps and "-command" not in rest.lower():
        rest = (rest + _osc7_prompt_arg()).strip()
    return exe, (rest or None)


def _posix_argv(shell):
    """POSIX: `shell` string -> argv list.

    shlex so quoted paths survive (`"/Applications/My Shell" -l`). If the string is unparseable
    (a stray quote), fall back to a naive split rather than refusing to open a terminal at all.
    """
    try:
        argv = shlex.split(shell)
    except ValueError:
        argv = shell.split()
    return argv or ["/bin/sh"]


# -- Windows backend -----------------------------------------------------------
class _WindowsPty:
    def __init__(self, shell, cwd, env, cols, rows):
        from winpty import PTY

        self._pty = PTY(cols, rows)
        exe, args = _win_cmdline(shell)
        # pywinpty wants the environment as one "name=value\0name=value\0..." string
        env_str = "".join(f"{k}={v}\0" for k, v in env.items())
        self._pty.spawn(exe, cmdline=args, cwd=cwd, env=env_str)

    def read(self, timeout=POLL_IDLE):
        try:
            data = self._pty.read(blocking=False)
        except Exception as e:
            log.info("pty read ended: %s", e)
            return None
        if data:
            return data
        if not self._pty.isalive():
            return None
        time.sleep(min(timeout, POLL_IDLE))
        return ""

    def write(self, text):
        self._pty.write(text)

    def set_size(self, cols, rows):
        self._pty.set_size(cols, rows)

    def isalive(self):
        try:
            return bool(self._pty.isalive())
        except Exception:
            return False

    def exit_status(self):
        try:
            return self._pty.get_exitstatus()
        except Exception:
            return None

    def close(self):
        try:
            self._pty.write("\x03")   # try to interrupt whatever is running
        except Exception:
            pass
        try:
            del self._pty             # pywinpty reaps the process on destruction
        except Exception:
            pass


# -- POSIX backend -------------------------------------------------------------
class _PosixPty:
    def __init__(self, shell, cwd, env, cols, rows):
        import select

        from ptyprocess import PtyProcess

        self._select = select
        # dimensions is (rows, cols) here - the opposite order from pywinpty
        self._proc = PtyProcess.spawn(_posix_argv(shell), cwd=cwd, env=env,
                                      dimensions=(rows, cols))
        self._fd = self._proc.fd
        # See the module docstring: a read can split a multi-byte character (Korean), so the
        # decoder has to carry the partial tail across chunks.
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._eof = False

    def read(self, timeout=POLL_IDLE):
        if self._eof:
            return None
        try:
            r, _, _ = self._select.select([self._fd], [], [], timeout)
        except (OSError, ValueError):
            self._eof = True
            return None
        if not r:
            return ""
        try:
            raw = os.read(self._fd, READ_CHUNK)
        except OSError as e:
            # EIO when the child exits is the NORMAL end-of-session on Linux; macOS tends to
            # return b"" instead. Both mean the same thing, so don't log either as an error.
            log.info("pty read ended: %s", e)
            self._eof = True
            return None
        if not raw:
            self._eof = True
            return None
        return self._decoder.decode(raw)

    def write(self, text):
        buf = text.encode("utf-8")
        while buf:
            n = os.write(self._fd, buf)
            if n <= 0:
                break
            buf = buf[n:]

    def set_size(self, cols, rows):
        self._proc.setwinsize(rows, cols)      # (rows, cols) - flipped vs pywinpty

    def isalive(self):
        try:
            return bool(self._proc.isalive())
        except Exception:
            return False

    def exit_status(self):
        try:
            # ptyprocess only fills in `exitstatus` while reaping the child, and reaping happens
            # inside isalive(). Read it straight after EOF without this and it is always None.
            self._proc.isalive()
            return self._proc.exitstatus
        except Exception:
            return None

    def close(self):
        try:
            self.write("\x03")        # try to interrupt whatever is running
        except Exception:
            pass
        try:
            self._proc.terminate(force=True)
        except Exception:
            pass
        self._eof = True


# -- Factory -------------------------------------------------------------------
def open_pty(shell, cwd, env, cols, rows):
    """Spawn `shell` on a PTY.

    shell : command STRING (e.g. "powershell.exe -NoLogo" / "/bin/zsh -l"). Each backend parses
            it the way its own library wants - do not pre-split it here.
    env   : plain dict. The Windows backend converts it to pywinpty's NUL-joined string.
    cols/rows : always in THIS order at the boundary; POSIX flips it internally.
    """
    check_supported()
    if IS_WINDOWS:
        return _WindowsPty(shell, cwd, env, cols, rows)
    return _PosixPty(shell, cwd, env, cols, rows)
