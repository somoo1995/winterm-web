"""
webterm - PTY session manager (a minimal tmux-server role).

Design:
  - The PTY is owned by this process (the daemon), not the browser.
    -> Close the browser and the session lives; reattach and you pick it up.
  - One reader thread per session keeps reading the PTY and (1) appends to a ring buffer
    (for reconnect replay), (2) pushes to every attached subscriber.
  - A per-subscriber asyncio.Queue keeps a slow client from blocking the PTY read.

Difference from the wezterm cli approach:
  - No process spawn (the 65ms cost is gone), no gui-sock chasing, no mux -> no leak risk at all.
"""
import asyncio
import collections
import logging
import os
import threading
import time
import urllib.parse
import uuid

from winpty import PTY

log = logging.getLogger("webterm.session")

# OSC 0/2 = window-title set sequence. Terminator is BEL or ST (ESC + backslash)
_ESC = chr(27)
_BEL = chr(7)
_OSC_START = _ESC + chr(93)          # ESC ]
_ST = _ESC + chr(92)                 # ESC + backslash

# How much output to replay on reconnect. Too big is slow to replay; too small under-restores.
#
# This is BYTES of output, not lines. tmux keeps a grid + history structurally by line; here we
# replay a rewound stream, so a full-screen TUI (claude etc.) eats several KB per frame. When this
# was 256KB, a claude tab's backlog was 306,257 chars = already being truncated.
#
# Why 2MB:
#   - The upper cap is the browser anyway - anything past xterm's `scrollback: 10000` is discarded on replay
#   - Memory is this value per session, so ~20MB even at 10 sessions
#   - It's pushed all at once on reconnect, so bigger = slower first paint
#   - Must be well under daemon_client's STREAM_LIMIT (16MB) since JSON escaping inflates it
#     (the 64KB default once caused "only claude tabs fail to draw")
RING_CHARS = 2 * 1024 * 1024
# Idle sleep when the PTY has nothing to read. 0 burns CPU; too big adds latency.
POLL_IDLE = 0.004

# -- Environment scrubbing -----------------------------------------------------
# The rules live in envclean.py (the launcher uses the same ones).
from envclean import clean_env  # noqa: E402


def build_env(extra=None):
    """Environment to pass to the PTY. `extra` is added for this session only (its own address, etc.)."""
    env = clean_env()
    if extra:
        env.update({k: v for k, v in extra.items() if v is not None})
    # pywinpty wants a "name=value\0name=value\0..." string
    return "".join(f"{k}={v}\0" for k, v in env.items())


# Inject the session's OWN address as env vars - a claude running inside a pane needs to know
# "who am I" so it can tell another session "reply to me here".
# (claude-peers used to hand each session a peer_id; this replaces that piece.)
#
# The POSITION (3-2) is deliberately NOT injected. Position shifts as tabs/panes open and close,
# but an env var is stamped once at spawn and can't change -> the pair would soon be a stale lie.
# Only the immutable SID is stamped; if the current position is needed, ask
# `GET /api/resolve?target=$WEBTERM_SID`. TAB can be renamed too, so it means "the initial name" only.
#
# Prompt injection that makes PowerShell REPORT its current folder.
#
# Goal: after `cd`, a split (`Ctrl+]`) must open the new pane in THAT folder.
#   Measured (2026-08-26): this shell emits none of OSC 7 / 9;9 / window title -> we make it emit.
#   Same trick Windows Terminal's shell integration uses (emit OSC 7 from the prompt).
#
# Three rules:
#   1. Don't break the user's prompt - the profile loads first and `-Command` runs after, so we
#      capture the existing `prompt` ($o) and have ours call it as-is.
#   2. PowerShell 5.1 syntax only - the `` `e `` escape is PS6+, so use `[char]27`
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


def shell_cmdline(shell):
    """The (exe, args-string) to pass to spawn. For PowerShell, append the OSC 7 prompt.

    Leave `self.shell` as the original - mixing this long injection into the reporting string
    makes the session list hard to read.
    """
    exe, _, rest = shell.partition(" ")
    rest = rest.strip()
    base = os.path.basename(exe).lower()
    is_ps = base.startswith("powershell") or base.startswith("pwsh")
    # If the user already told it to run something via -Command, leave it (overwriting kills their intent)
    if is_ps and "-command" not in rest.lower():
        rest = (rest + _osc7_prompt_arg()).strip()
    return exe, (rest or None)


def self_addr_env(sid, tab, port=8767):
    return {
        "WEBTERM_SID": sid,                                   # immutable - use this as the reply address
        "WEBTERM_TAB": tab or "",                             # tab name at spawn (may change)
        "WEBTERM_API": f"http://127.0.0.1:{port}",            # API base (avoid hardcoding)
    }


# Max chunks queued at once (slow-client guard). On overflow, drop the oldest first.
QUEUE_MAX = 2048


class Session:
    def __init__(self, sid, name, shell, cwd, cols=120, rows=30, loop=None):
        self.sid = sid
        self.name = name
        self.shell = shell
        self.cwd = cwd
        self.cols = cols
        self.rows = rows
        self.created = time.time()
        self.loop = loop

        self._ring = collections.deque()      # (chunk, ...) - total length tracked in _ring_len
        self._ring_len = 0
        self._ring_lock = threading.Lock()
        self._subs = set()                    # set of asyncio.Queue
        self._subs_lock = threading.Lock()
        self._alive = True
        self._exit_code = None
        # Window title the shell/app reports via OSC. Single source of "what's running in this session"
        # (same way WezTerm gets a pane title; it's already in the stream, so zero cost).
        self.title = ""
        # Name the user set on this pane directly (Ctrl+P). Different role from name (= tab name):
        #   name  = tab name and group key - sessions with the same name are panes of one tab
        #   label = this one pane's name - doesn't affect the group
        # Only the manually-set value is stamped; left empty, the auto name (number + OSC title)
        # follows the current state.
        self.label = ""
        self._osc_tail = ""                   # tail carrying an OSC split across a chunk boundary

        self.pty = PTY(cols, rows)
        # Use only the first token as the exe so `shell` can carry arguments
        # (default `powershell.exe -NoLogo` - no banner so the prompt starts on line 1)
        exe, args = shell_cmdline(shell)
        self.pty.spawn(exe, cmdline=args, cwd=cwd,
                       env=build_env(self_addr_env(sid, name)))

        self._thread = threading.Thread(target=self._reader, daemon=True,
                                        name=f"pty-{sid[:8]}")
        self._thread.start()
        log.info("session spawned sid=%s name=%s shell=%s cwd=%s %dx%d",
                 sid, name, shell, cwd, cols, rows)

    # ---------- reader ----------
    def _reader(self):
        while self._alive:
            try:
                data = self.pty.read(blocking=False)
            except Exception as e:
                log.info("pty read ended sid=%s: %s", self.sid, e)
                break
            if data:
                self._scan_title(data)
                self._append_ring(data)
                self._broadcast(data)
                continue
            if not self.pty.isalive():
                break
            time.sleep(POLL_IDLE)
        self._alive = False
        try:
            self._exit_code = self.pty.get_exitstatus()
        except Exception:
            pass
        log.info("session ended sid=%s exit=%s", self.sid, self._exit_code)
        self._broadcast(None)  # end signal

    # cwd must be the CURRENT value the shell reports, not the spawn value.
    #
    # `self.cwd` used to be FIXED at the spawn folder, so after `cd` a `Ctrl+]` split opened the new
    # pane in the OLD folder (report 2026-08-26). The front end was already sending the current pane's
    # cwd, so the problem was that this value was stale.
    #
    # You can't fix what you can't observe: measured, the shell emitted no OSC 7, no 9;9, no title -
    # there was no signal to track. So we make the shell emit one (OSC 7 in the prompt, see
    # `_osc7_prompt_arg`) and receive it here.
    #
    # Reading a process's CWD from outside on Windows (psutil `Process.cwd()`) doesn't work -
    # PowerShell's `Set-Location` doesn't change the process's real working directory (the famous
    # pitfall where .NET APIs don't follow `Set-Location`). Read from outside and you'd forever see
    # the spawn folder.
    @staticmethod
    def _path_from_file_url(u):
        """`file:///C:/a/b` or `file://host/C:/a/b` -> `C:\\a\\b`, else None."""
        if not u.startswith("file:"):
            return None
        rest = u[5:]
        while rest.startswith("/"):
            rest = rest[1:]
        if "/" in rest and ":" not in rest.split("/", 1)[0]:
            rest = rest.split("/", 1)[1]          # drop the host part (`file://host/C:/...`)
        rest = urllib.parse.unquote(rest)         # restore %XX (spaces, etc.)
        return rest.replace("/", os.sep) or None

    def _update_cwd(self, path):
        path = os.path.normpath(path)
        if path == self.cwd:
            return
        if not os.path.isdir(path):               # ignore vanished folders / non-filesystem locations
            return
        old, self.cwd = self.cwd, path
        log.info("cwd updated sid=%s %s -> %s", self.sid, old, path)

    def _handle_osc(self, payload):
        if payload[:2] in ("0;", "2;"):           # window title
            self.title = payload[2:].strip()
        elif payload[:2] == "7;":                 # standard cwd notification
            p = self._path_from_file_url(payload[2:].strip())
            if p:
                self._update_cwd(p)
        elif payload[:4] == "9;9;":               # ConEmu/Windows Terminal style (in case it arrives)
            p = payload[4:].strip().strip('"')
            if p:
                self._update_cwd(p)

    def _scan_title(self, chunk):
        r"""Scan OSC 0/2 (window title), 7, and 9;9 (cwd) to update self.title / self.cwd.

        It used to look only at the title; with cwd tracking added, it now cuts at the terminator and
        dispatches the payload (the old code, on a non-title OSC, skipped only the two `ESC]` chars and
        rescanned the same sequence).

        Format: ESC ] 0 ; <title> BEL   or   ESC ] 2 ; <title> ST
        e.g.    ESC]0;<Claude Code>ST      ESC]0;<PS C:\work>BEL

        This is where "what's running in this session" comes from (same source as WezTerm's pane title).
        It's already in the stream, so no extra cost - cheaper and more accurate than walking the
        process tree. An incomplete OSC at a chunk boundary is carried as a tail into the next chunk.
        """
        buf = self._osc_tail + chunk
        self._osc_tail = ""
        pos = 0
        while True:
            i = buf.find(_OSC_START, pos)
            if i < 0:
                break
            body_at = i + len(_OSC_START)
            body = buf[body_at:]
            e_bel = body.find(_BEL)
            e_st = body.find(_ST)
            cands = [x for x in (e_bel, e_st) if x >= 0]
            if not cands:
                # Terminator not here yet -> keep as tail (discard if abnormally long)
                # A cwd path can be longer than a title, so 512 was raised to 1024
                rest = buf[i:]
                if len(rest) < 1024:
                    self._osc_tail = rest
                break
            e = min(cands)
            consumed = len(_BEL) if e == e_bel else len(_ST)
            pos = body_at + e + consumed
            self._handle_osc(body[:e])

    def _append_ring(self, chunk):
        with self._ring_lock:
            self._ring.append(chunk)
            self._ring_len += len(chunk)
            while self._ring_len > RING_CHARS and len(self._ring) > 1:
                self._ring_len -= len(self._ring.popleft())

    def _broadcast(self, data):
        if self.loop is None:
            return
        with self._subs_lock:
            subs = list(self._subs)
        for q in subs:
            try:
                self.loop.call_soon_threadsafe(self._put, q, data)
            except RuntimeError:
                pass  # loop already closed

    @staticmethod
    def _put(q, data):
        if q.qsize() >= QUEUE_MAX:
            try:
                q.get_nowait()   # drop the oldest so a lagging client doesn't eat memory
            except Exception:
                pass
        q.put_nowait(data)

    # ---------- subscription ----------
    def subscribe(self):
        q = asyncio.Queue()
        with self._subs_lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q):
        with self._subs_lock:
            self._subs.discard(q)

    def backlog(self):
        with self._ring_lock:
            return "".join(self._ring)

    # ---------- operations ----------
    def write(self, data):
        if self._alive:
            self.pty.write(data)

    def resize(self, cols, rows):
        # Concurrent-attach policy: "the size of whoever attached last" (not tmux's smallest-window compromise)
        if not self._alive:
            return
        cols = max(20, min(500, int(cols)))
        rows = max(5, min(200, int(rows)))
        if (cols, rows) == (self.cols, self.rows):
            return
        self.cols, self.rows = cols, rows
        try:
            self.pty.set_size(cols, rows)
        except Exception as e:
            log.warning("resize failed sid=%s: %s", self.sid, e)

    def close(self):
        self._alive = False
        try:
            self.pty.write("\x03")   # try to interrupt whatever is running
        except Exception:
            pass
        try:
            del self.pty              # pywinpty cleans up the process on destruction
        except Exception:
            pass
        self._broadcast(None)

    @property
    def alive(self):
        return self._alive

    def info(self):
        return {
            "sid": self.sid,
            "name": self.name,
            "shell": self.shell,
            "cwd": self.cwd,
            "title": self.title,
            "label": self.label,
            "cols": self.cols,
            "rows": self.rows,
            "alive": self._alive,
            "clients": len(self._subs),
            "created": self.created,
        }


class SessionManager:
    def __init__(self):
        self.sessions = {}
        self.loop = None

    def bind_loop(self, loop):
        self.loop = loop
        for s in self.sessions.values():
            s.loop = loop

    def create(self, name=None, shell=None, cwd=None, cols=120, rows=30):
        sid = uuid.uuid4().hex[:12]
        # -NoLogo: without the 5-line banner the prompt starts on line 1
        shell = shell or os.environ.get("WEBTERM_SHELL", "powershell.exe -NoLogo")
        cwd = cwd or os.environ.get("WEBTERM_CWD") or os.path.expanduser("~")
        if not os.path.isdir(cwd):
            # Falling back to home silently hides "why did it open in the wrong place".
            log.warning("cwd missing -> falling back to home: %r", cwd)
            cwd = os.path.expanduser("~")
        name = name or f"term{len(self.sessions) + 1}"
        s = Session(sid, name, shell, cwd, cols, rows, loop=self.loop)
        self.sessions[sid] = s
        return s

    def get(self, sid):
        return self.sessions.get(sid)

    def kill(self, sid):
        s = self.sessions.pop(sid, None)
        if s:
            s.close()
        return bool(s)

    def rename(self, sid, name):
        s = self.sessions.get(sid)
        if s:
            s.name = name
        return bool(s)

    def label(self, sid, label):
        """Set a pane's individual name. Empty string reverts to the auto name.

        (tab name, label) is a composite key - within one tab a pane name must be unique.
        If a name-based pane lookup (context menu, a future shim) silently picks the wrong one,
        it "behaves differently from what you see". Enforced here, not on the client - so it holds
        even when the API is called directly.

        Returns: "ok" | "nosession" | "duplicate"
        """
        s = self.sessions.get(sid)
        if not s:
            return "nosession"
        label = (label or "").strip()
        if label:
            for other in self.sessions.values():
                if other.sid != sid and other.name == s.name and other.label == label:
                    return "duplicate"
        s.label = label
        return "ok"

    def list(self):
        return [s.info() for s in self.sessions.values()]

    def reap(self):
        """Remove dead sessions that nobody is attached to."""
        dead = [sid for sid, s in self.sessions.items()
                if not s.alive and len(s._subs) == 0]
        for sid in dead:
            self.sessions.pop(sid, None)
        return dead
