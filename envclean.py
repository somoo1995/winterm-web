"""Build a clean environment to pass to child processes.

Where this server was launched from can pollute the child shell's environment. Seen in practice:
    CLAUDECODE=1 / CLAUDE_CODE_* -> the child CLI thinks it's non-interactive and drops color,
                                    and a newly launched claude is treated as a child session (transcript off)
    WEZTERM_UNIX_SOCKET          -> running wezterm cli inside a session grabs a stale socket
                                    and spawns a mux-server (the path behind a system-freeze incident)

A terminal must hand its child a clean shell, so we don't pass these on. The pollution depends
on WHERE it was launched, which makes it hard to reproduce - so the scrubbing lives in code, not
in "it worked when I launched from Explorer". Both the session (session.py) and the launcher
(launcher.py) use this.
"""
import os

STRIP_PREFIXES = ("CLAUDE_CODE_", "WEZTERM_")
STRIP_EXACT = {
    "CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT",
    "FORCE_COLOR", "NO_COLOR", "CLICOLOR", "CLICOLOR_FORCE",
}
# Conversely, always inject these - tell the app color is supported
FORCE_ENV = {
    "TERM": "xterm-256color",
    "COLORTERM": "truecolor",
    "TERM_PROGRAM": "webterm",
}


def clean_env(extra=None):
    """Env dict with the polluting vars removed. `extra` overrides values on top."""
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(STRIP_PREFIXES) and k not in STRIP_EXACT}
    env.update(FORCE_ENV)
    env.pop("TERM_PROGRAM_VERSION", None)
    if extra:
        env.update(extra)
    return env
