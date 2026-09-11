"""webterm launcher - start everything and open the app window with one double-click.

    webterm.exe                check/start the daemon + web server, then open a Chrome app window
    webterm.exe --restart      restart the web server only (sessions kept) and open
    webterm.exe --status       show current status
    webterm.exe --stop         stop the web server only (sessions kept)
    webterm.exe --stop-all     stop the daemon too  (WARNING: all open shells end)
    webterm.exe --install      open a normal window to install as an app (removes the title bar)
    webterm.exe --no-browser   just start, don't open a window

Does the same as `start.ps1` but is built as a console-less GUI app, so anything meant for a
human goes to a MessageBox instead of the console (and only appears on failure).

## Three pitfalls this file guards against (all hit in practice)

1. The daemon MUST have a console. Under pythonw.exe (no console) or DETACHED_PROCESS,
   ConPTY creation dies with PanicException: HRESULT(0x00000000).
   -> python.exe + CREATE_NO_WINDOW (allocate a console, show no window).
   This launcher itself needs no console - the daemon creates the ConPTY, not the launcher,
   and CREATE_NO_WINDOW allocates a NEW console for the child.
2. When finding a process by port, match ONLY the 127.0.0.1 binding. tailscale serve listens
   on the same port on 100.x/IPv6, so killing the first listener by port alone kills tailscaled
   (it happened). Here we also double-check the image name is python-family.
3. Environment pollution. Running this launcher inside a claude session would leak that
   environment into the server/daemon -> scrub it with envclean.clean_env() (same rule as session.py).
"""
import ctypes
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from envclean import clean_env  # noqa: E402

PORT = int(os.environ.get("WEBTERM_PORT", "8767"))
DAEMON_PORT = int(os.environ.get("WEBTERM_DAEMON_PORT", "8771"))
HOST = "127.0.0.1"
URL = f"http://{HOST}:{PORT}"

CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_PROCESS_GROUP = 0x00000200
DETACHED = 0x00000008

# Escape hatch for keeping the exe outside the project = the WEBTERM_ROOT env var.
# Don't hardcode a personal absolute path here - it mustn't land in a public repo, and it
# wouldn't exist on anyone else's PC anyway.


def app_root():
    """The folder containing server.py / daemon.py. By default the exe sits here."""
    here = (os.path.dirname(os.path.abspath(sys.executable))
            if getattr(sys, "frozen", False)
            else os.path.dirname(os.path.abspath(__file__)))
    for cand in (here, os.environ.get("WEBTERM_ROOT")):
        if cand and os.path.exists(os.path.join(cand, "server.py")):
            return cand
    return None


ROOT = app_root()


# -- Talking to the human ------------------------------------------------------
MB_OK, MB_YESNO = 0x0, 0x4
MB_ICONERROR, MB_ICONINFO, MB_ICONWARN = 0x10, 0x40, 0x30
IDYES = 6


def box(text, title="webterm", flags=MB_OK | MB_ICONINFO):
    return ctypes.windll.user32.MessageBoxW(0, str(text), title, flags)


def fail(text):
    logline("ERROR " + text.replace("\n", " / "))
    tail = ""
    if ROOT:
        tail = f"\n\nLog: {os.path.join(ROOT, 'launcher.log')}"
    box(text + tail, "webterm - startup failed", MB_OK | MB_ICONERROR)
    sys.exit(1)


def logline(text):
    if not ROOT:
        return
    try:
        with open(os.path.join(ROOT, "launcher.log"), "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {text}\n")
    except Exception:
        pass


def run(cmd):
    """Run a command without a console window and return its stdout."""
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=10,
                             creationflags=CREATE_NO_WINDOW,
                             encoding="utf-8", errors="replace")
        return out.stdout or ""
    except Exception:
        return ""


# -- Ports / processes ---------------------------------------------------------
def is_up(port, timeout=0.4):
    with socket.socket() as s:
        s.settimeout(timeout)
        return s.connect_ex((HOST, port)) == 0


def listener_pid(port):
    """PID of our process LISTENING on 127.0.0.1:port.

    Match ONLY the loopback binding - tailscale serve listens on the same port on 100.x / IPv6,
    so by port alone you'd catch tailscaled (killed once). On top of that, verify the image name
    is python-family so we never touch someone else's process.
    """
    want = f"{HOST}:{port}"
    for line in run(["netstat", "-ano", "-p", "TCP"]).splitlines():
        f = line.split()
        if len(f) >= 5 and f[1] == want and f[3].upper() == "LISTENING":
            pid = f[4]
            if pid.isdigit() and _is_python(int(pid)):
                return int(pid)
    return None


def _is_python(pid):
    out = run(["tasklist", "/FI", f"PID eq {pid}", "/NH", "/FO", "CSV"]).lower()
    return "python" in out


def kill(pid):
    run(["taskkill", "/PID", str(pid), "/F"])


def find_python():
    """Find python.exe (with console) and pythonw.exe (without).

    Frozen as an exe, sys.executable is webterm.exe itself, so it's useless.
    WindowsApps\\python.exe on PATH is a Microsoft Store stub that dies instantly -> excluded.
    """
    cands = []
    env_py = os.environ.get("WEBTERM_PYTHON")
    if env_py:
        cands.append(env_py)
    if not getattr(sys, "frozen", False) and sys.executable:
        cands.append(sys.executable)

    for line in run(["where", "python"]).splitlines():
        line = line.strip()
        if line and "windowsapps" not in line.lower():
            cands.append(line)

    out = run(["py", "-3", "-c", "import sys;print(sys.executable)"]).strip()
    if out:
        cands.append(out)

    local = os.environ.get("LOCALAPPDATA", "")
    if local:
        base = os.path.join(local, "Programs", "Python")
        if os.path.isdir(base):
            for d in sorted(os.listdir(base), reverse=True):
                cands.append(os.path.join(base, d, "python.exe"))

    for c in cands:
        if not c or not os.path.exists(c):
            continue
        d, name = os.path.split(c)
        py = c if name.lower() == "python.exe" else os.path.join(d, "python.exe")
        if not os.path.exists(py):
            continue
        pyw = os.path.join(d, "pythonw.exe")
        return py, (pyw if os.path.exists(pyw) else py)
    return None, None


# -- Startup -------------------------------------------------------------------
def spawn(exe, script, flags):
    subprocess.Popen(
        [exe, os.path.join(ROOT, script)], cwd=ROOT, close_fds=True,
        env=clean_env({"WEBTERM_PORT": str(PORT), "WEBTERM_HOST": HOST}),
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=flags,
    )


def wait_up(port, secs=12.0):
    end = time.time() + secs
    while time.time() < end:
        if is_up(port):
            return True
        time.sleep(0.3)
    return False


def ensure_daemon(py):
    if is_up(DAEMON_PORT):
        logline("daemon already running - kept (sessions preserved)")
        return True
    logline("starting daemon")
    # python.exe (has a console) + CREATE_NO_WINDOW. Under pythonw, ConPTY panics.
    spawn(py, "daemon.py", CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
    return wait_up(DAEMON_PORT, 10)


def ensure_server(pyw, restart=False):
    pid = listener_pid(PORT)
    if pid and not restart:
        logline(f"web server already running (PID {pid})")
        return True
    if pid:
        logline(f"restarting web server - killing existing PID {pid}")
        kill(pid)
        time.sleep(0.5)
    logline("starting web server")
    # The web server creates no PTY, so it needs no console -> pythonw (no window)
    spawn(pyw, "server.py", CREATE_NO_WINDOW)
    return wait_up(PORT, 12)


# -- Browser -------------------------------------------------------------------
def find_browser():
    pf, pf86 = os.environ.get("ProgramFiles", ""), os.environ.get("ProgramFiles(x86)", "")
    local = os.environ.get("LOCALAPPDATA", "")
    for p in (
        os.path.join(pf, r"Google\Chrome\Application\chrome.exe"),
        os.path.join(pf86, r"Google\Chrome\Application\chrome.exe"),
        os.path.join(local, r"Google\Chrome\Application\chrome.exe"),
        os.path.join(pf86, r"Microsoft\Edge\Application\msedge.exe"),
        os.path.join(pf, r"Microsoft\Edge\Application\msedge.exe"),
    ):
        if p and os.path.exists(p):
            return p
    return None


def pwa_shortcut():
    """The installed PWA's shortcut (.lnk). If present, prefer opening via this.

    Window Controls Overlay only turns on in an installed PWA window - the title bar disappears
    and the window buttons sit on the tab bar, same look as WezTerm's INTEGRATED_BUTTONS.
    A window opened with --app=URL always keeps the title bar.

    Chrome/Edge create the shortcut in a Start-menu subfolder on install (`Chrome Apps` / `Edge Apps`).
    Running that .lnk is simpler and safer than digging out the app-id.
    Only search SUBFOLDERS - directly under Programs is our own launcher shortcut, and catching that
    would make an infinite loop of relaunching itself.
    """
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return None
    programs = os.path.join(appdata, r"Microsoft\Windows\Start Menu\Programs")
    if not os.path.isdir(programs):
        return None
    for entry in os.listdir(programs):
        sub = os.path.join(programs, entry)
        if not os.path.isdir(sub):
            continue
        if "chrome" not in entry.lower() and "edge" not in entry.lower():
            continue
        for f in os.listdir(sub):
            if f.lower().startswith("webterm") and f.lower().endswith(".lnk"):
                return os.path.join(sub, f)
    return None


def open_window():
    """Open a window. If an installed PWA exists, prefer that (title-bar-less window)."""
    lnk = pwa_shortcut()
    if lnk:
        logline(f"opening PWA window: {lnk}")
        os.startfile(lnk)
        return

    exe = find_browser()
    if not exe:
        import webbrowser
        webbrowser.open(URL)
        return
    logline("opening app-mode window (not installed - title bar stays)")
    subprocess.Popen(
        [exe, f"--app={URL}", "--window-size=1600,1000"],
        env=clean_env(), close_fds=True,
        creationflags=CREATE_NO_WINDOW | DETACHED,
    )


def cmd_install():
    """Open a NORMAL window for installing.

    App-mode windows have no address bar and thus no install button, so use a normal window
    only when installing.
    """
    exe = find_browser()
    if not exe:
        import webbrowser
        webbrowser.open(URL)
    else:
        subprocess.Popen([exe, "--new-window", URL], env=clean_env(), close_fds=True,
                         creationflags=CREATE_NO_WINDOW | DETACHED)
    box("Install webterm as an app from the window that just opened.\n\n"
        "  the install icon on the right of the address bar  or\n"
        "  the menu -> Cast, save, and share -> Install page as app\n\n"
        "Once installed, the title bar disappears and the window buttons\n"
        "sit on the tab bar (same look as WezTerm's INTEGRATED_BUTTONS).\n\n"
        "After that, webterm.exe opens that window automatically.",
        "webterm - install as app")


# -- Commands ------------------------------------------------------------------
def cmd_status():
    d, w = listener_pid(DAEMON_PORT), listener_pid(PORT)
    lines = [
        f"session daemon : {'running (PID %d)' % d if d else 'stopped'}   port {DAEMON_PORT}",
        f"web server     : {'running (PID %d)' % w if w else 'stopped'}   port {PORT}",
    ]
    if d and w:
        try:
            with urllib.request.urlopen(f"{URL}/api/sessions", timeout=5) as r:
                ss = json.loads(r.read().decode("utf-8")).get("sessions", [])
            lines.append(f"\nopen sessions : {len(ss)}")
            lines += [f"   - {s.get('name')}  ({s.get('cwd')})" for s in ss]
        except Exception as e:
            lines.append(f"\nsession query failed: {e}")
    lines.append(f"\n{URL}")
    box("\n".join(lines), "webterm - status")


def cmd_stop(all_=False):
    w = listener_pid(PORT)
    if all_:
        d = listener_pid(DAEMON_PORT)
        if d and box("This also stops the session daemon.\n\nAll open shells will end. Continue?",
                     "webterm - stop all", MB_YESNO | MB_ICONWARN) != IDYES:
            return
        if w:
            kill(w)
        if d:
            kill(d)
        box("winterm-web fully stopped" if (w or d) else "already stopped")
        return
    if w:
        kill(w)
    msg = "web server stopped"
    if is_up(DAEMON_PORT):
        msg += " (session daemon still running - sessions alive)"
    box(msg)


def main():
    args = {a.lower() for a in sys.argv[1:]}
    if not ROOT:
        fail("Could not find the webterm source.\n"
             "Put webterm.exe in the folder that has server.py,\n"
             "or set the WEBTERM_ROOT environment variable.")

    if "--status" in args:
        return cmd_status()
    if "--install" in args:
        py, pyw = find_python()
        if py:
            ensure_daemon(py)
            ensure_server(pyw)
        return cmd_install()
    if "--stop" in args:
        return cmd_stop(False)
    if "--stop-all" in args:
        return cmd_stop(True)

    py, pyw = find_python()
    if not py:
        fail("Could not find python.\n"
             "You can set the WEBTERM_PYTHON environment variable to a python.exe path.")

    if not ensure_daemon(py):
        fail(f"The session daemon did not come up (port {DAEMON_PORT}).\n"
             f"Check {os.path.join(ROOT, 'daemon.log')}.")

    if not ensure_server(pyw, restart="--restart" in args):
        fail(f"The web server did not come up (port {PORT}).\n"
             f"Check {os.path.join(ROOT, 'webterm.log')}.")

    logline(f"ready -> {URL}")
    if "--no-browser" not in args:
        open_window()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        import traceback
        logline("UNCAUGHT " + traceback.format_exc().replace("\n", " / "))
        box(f"Unexpected error:\n\n{e}", "webterm", MB_OK | MB_ICONERROR)
        sys.exit(1)
