"""Is there a newer webterm on GitHub than the one installed here?

The version is the `VERSION` file - a release date such as `2026.09.23` (a second release on
the same day is `2026.09.23.2`). A person can read that: "you have 2026.09.23, the latest is
2026.09.30". Bump it on every push that users should pick up. The remote value is the same
file read straight from `main` on GitHub.

Git shas were tried first and rejected: exact, but nobody can tell from `975562` whether they
are behind or by how much. The sha of `main` is still recorded in `.installed-commit` by
install.ps1 / update.ps1, purely as a trace of what was installed.

A checkout WITH `.git` is a developer machine, where "main is ahead of you" is the normal
state of unpushed work: the numbers are still shown, but no banner and no update button.

The check is cheap (one small GET) but not free, so it runs at most every CHECK_EVERY seconds
and never blocks a request: the result is cached and served from memory.
"""
import asyncio
import io
import json
import logging
import os
import subprocess
import sys
import time
import urllib.request

log = logging.getLogger("webterm")

BASE = os.path.dirname(os.path.abspath(__file__))
REPO = "somoo1995/winterm-web"
BRANCH = "main"
MARKER = os.path.join(BASE, ".installed-commit")
CHECK_EVERY = 6 * 3600          # seconds
TIMEOUT = 8

VERSION_FILE = os.path.join(BASE, "VERSION")

state = {
    "checked": 0.0,             # time.time() of the last attempt
    "local": None,              # VERSION on this disk ("" = file missing = very old install)
    "remote": None,             # VERSION on GitHub main
    "available": False,
    "error": None,
    "dev": os.path.isdir(os.path.join(BASE, ".git")),
}


def local_version():
    try:
        with io.open(VERSION_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def _key(v):
    """'2026.09.23.2' -> (2026, 9, 23, 2) so versions compare as numbers, not text."""
    out = []
    for part in (v or "").split("."):
        try:
            out.append(int(part))
        except ValueError:
            out.append(0)
    return tuple(out)


def _fetch_remote():
    req = urllib.request.Request(
        f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/VERSION",
        headers={"User-Agent": "webterm-updatecheck", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read().decode("utf-8").strip()


async def check(force=False):
    """Refresh the cached answer if it is older than CHECK_EVERY (or `force`). Returns `state`."""
    if not force and time.time() - state["checked"] < CHECK_EVERY:
        return state
    state["checked"] = time.time()
    state["local"] = local_version()
    try:
        remote = await asyncio.to_thread(_fetch_remote)
        state["remote"], state["error"] = remote, None
        # Newer on GitHub than here. An install with no VERSION file predates the file, so it
        # is behind by definition.
        state["available"] = _key(remote) > _key(state["local"])
        log.info("update check: local=%s remote=%s available=%s",
                 state["local"] or "?", remote, state["available"])
    except Exception as e:
        state["error"] = str(e)[:200]      # offline, proxy, GitHub down - just try again later
        log.info("update check failed: %s", state["error"])
    return state


def public():
    """What /api/version hands to the browser."""
    return {"available": bool(state["available"]) and not state["dev"],
            "local": state["local"] if state["local"] is not None else local_version(),
            "remote": state["remote"],
            "checked": state["checked"] or None,
            "dev": state["dev"], "error": state["error"]}


def start_update():
    """Run tools/update.ps1 detached. It replaces the files; the existing stale banner then
    tells the user which process to restart. Returns (ok, message)."""
    script = os.path.join(BASE, "tools", "update.ps1")
    if not os.path.exists(script):
        return False, "tools/update.ps1 is missing"
    if not sys.platform.startswith("win"):
        return False, "in-app update is Windows only; run git pull / re-run the installer"
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
    try:
        subprocess.Popen(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
                         cwd=BASE, creationflags=flags, close_fds=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        return False, f"could not start the updater: {e}"
    return True, "updating"


def restart_daemon():
    """Restart the session daemon AND the web server. EVERY SHELL DIES - the caller must have
    had the user confirm that with the number of live sessions in front of them.

    The launcher's `--stop-all` asks the same question in a Windows message box, which nobody
    can answer from a detached process, so the stopping is done here: kill the python processes
    listening on the two loopback ports (LocalAddress checked exactly - a `tailscale serve` on
    the same port once got killed by a port-only match), then start the launcher, which brings
    both back. The web server kills itself in the process; the browser reconnects."""
    exe = os.path.join(BASE, "webterm.exe")
    if not sys.platform.startswith("win") or not os.path.exists(exe):
        return False, "no launcher here; restart daemon.py by hand"
    web_port = int(os.environ.get("WEBTERM_PORT", "8767"))
    daemon_port = int(os.environ.get("WEBTERM_DAEMON_PORT", "8771"))
    script = (
        f"$ports = @({daemon_port}, {web_port}); "
        "foreach ($port in $ports) { "
        "  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | "
        "  Where-Object { $_.LocalAddress -eq '127.0.0.1' } | ForEach-Object { "
        "    $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; "
        "    if ($p -and $p.ProcessName -match '^python') { Stop-Process -Id $p.Id -Force } } }; "
        "Start-Sleep -Seconds 1; "
        f"& '{exe}' --no-browser"
    )
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
    try:
        subprocess.Popen(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
                         cwd=BASE, creationflags=flags, close_fds=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        return False, f"could not start the restart: {e}"
    return True, "restarting daemon and server"


def restart_server():
    """Ask the launcher to restart the web server (sessions live in the daemon and survive)."""
    exe = os.path.join(BASE, "webterm.exe")
    if sys.platform.startswith("win") and os.path.exists(exe):
        cmd = [exe, "--restart", "--no-browser"]
    else:
        return False, "no launcher here; restart server.py by hand"
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
    try:
        subprocess.Popen(cmd, cwd=BASE, creationflags=flags, close_fds=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        return False, f"could not start the launcher: {e}"
    return True, "restarting"
