"""Smoke test: boot the real web server and drive it over its HTTP API.

    python3 tools/smoketest.py

selfcheck.py proves the PTY layer works. This proves the layer ABOVE it - that server.py
imports and serves on this OS, that it auto-spawns the session daemon, and that a session
created over HTTP actually reaches a shell and comes back.

It runs on ISOLATED PORTS (18767 / 18771), never the defaults, and sets them in the child's
env before spawning, so it cannot attach to - or kill - a webterm the user is really using.
Both processes it starts are killed on the way out.

Not covered here (needs a browser and a human): the WebSocket stream, rendering, fonts,
keyboard, and the clipboard endpoint.
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("SMOKE_PORT", "18767"))
DAEMON_PORT = int(os.environ.get("SMOKE_DAEMON_PORT", "18771"))
URL = f"http://127.0.0.1:{PORT}"

fails = []


def check(name, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {detail}" if detail else ""))
    if not cond:
        fails.append(name)


def api(path, method="GET", payload=None, timeout=15):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def wait_for(fn, secs=45.0, step=0.4):
    end = time.time() + secs
    while time.time() < end:
        try:
            if fn():
                return True
        except Exception:
            pass
        time.sleep(step)
    return False


print("=" * 72)
print(f"winterm-web smoke test   (isolated ports {PORT} / {DAEMON_PORT})")
print("=" * 72)

env = dict(os.environ)
env["WEBTERM_PORT"] = str(PORT)
env["WEBTERM_DAEMON_PORT"] = str(DAEMON_PORT)
env["WEBTERM_HOST"] = "127.0.0.1"

proc = subprocess.Popen([sys.executable, os.path.join(BASE, "server.py")],
                        cwd=BASE, env=env,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
sid = None
daemon_pid = None
try:
    # --- boot ------------------------------------------------------------
    def healthy():
        if proc.poll() is not None:
            raise RuntimeError("server exited")
        return api("/api/health", timeout=3).get("ok") is True

    up = wait_for(healthy, 60)
    check("server boots and the daemon answers", up)
    if not up:
        proc.terminate()
        out = proc.communicate(timeout=10)[0].decode("utf-8", "replace")
        print("\n--- server output ---\n" + out[-4000:])
        raise SystemExit(1)

    # The server spawns the daemon itself - a platform-specific code path (start_new_session on
    # POSIX, CREATE_NO_WINDOW on Windows) that selfcheck.py never touches, since it drives
    # SessionManager in-process.
    daemon_pid = api("/api/health")["daemon"].get("pid")
    check("daemon was auto-spawned by the server", isinstance(daemon_pid, int), f"pid={daemon_pid}")

    # --- static assets ---------------------------------------------------
    with urllib.request.urlopen(URL + "/", timeout=10) as r:
        html = r.read().decode("utf-8", "replace")
    check("index page served", r.status == 200 and "<" in html, f"{len(html)} bytes")
    for asset, kind in (("/static/app.js", "javascript"), ("/static/app.css", "css")):
        with urllib.request.urlopen(URL + asset, timeout=10) as r:
            check(f"{asset} served as {kind}", kind in r.headers.get("Content-Type", ""),
                  r.headers.get("Content-Type"))
    # Fonts are why server.py patches `mimetypes` at import: on Windows it reads the registry,
    # which often has no .woff2, and StaticFiles then serves fonts as text/plain - the browser
    # refuses them and the chosen font silently falls back. Serve one and check the type.
    with urllib.request.urlopen(URL + "/static/fonts/jetbrains-mono.css", timeout=10) as r:
        check("font stylesheet served", "css" in r.headers.get("Content-Type", ""),
              r.headers.get("Content-Type"))
    woff = "/static/fonts/jbm/jetbrains-mono-latin-500-normal.woff2"
    with urllib.request.urlopen(URL + woff, timeout=10) as r:
        check("woff2 served as font/woff2 (not text/plain)",
              r.headers.get("Content-Type") == "font/woff2", r.headers.get("Content-Type"))

    check("config endpoint", isinstance(api("/api/config").get("keymap"), dict))

    # --- session over HTTP ----------------------------------------------
    # Note the envelope: _ask() UNWRAPS the daemon's {"ok","result"} and returns `result`, so
    # these read `r["session"]` / `["sessions"]`. /capture is the odd one out - it re-wraps as
    # {"ok","text"}. A failure arrives as a 503/404, i.e. as an HTTPError, not as ok:false.
    sess = api("/api/sessions", "POST", {"name": "smoke", "cols": 100, "rows": 30})["session"]
    sid = sess["sid"]
    check("create session over HTTP", bool(sid))
    print(f"        sid={sid}  shell={sess['shell']!r}  cwd={sess['cwd']}")

    check("session appears in the list",
          any(s["sid"] == sid for s in api("/api/sessions")["sessions"]))

    MARK = "SMOKE-HTTP-OK-8830"
    check("send text", api(f"/api/sessions/{sid}/send", "POST",
                           {"text": f"echo {MARK}", "submit": True}).get("ok") is True)

    check("captured output contains the echo",
          wait_for(lambda: api(f"/api/sessions/{sid}/capture")["text"].count(MARK) >= 2, 45))

    r = api("/api/resolve?target=smoke")
    check("resolve by name", r.get("sid") == sid, f"pos={r.get('pos')}")

    # --- teardown --------------------------------------------------------
    dead = sid
    api(f"/api/sessions/{dead}", "DELETE")
    check("session removed",
          wait_for(lambda: not any(s["sid"] == dead
                                   for s in api("/api/sessions")["sessions"]), 10))
    sid = None
finally:
    if sid:
        try:
            api(f"/api/sessions/{sid}", "DELETE")
        except Exception:
            pass
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    # The daemon is a DETACHED grandchild - terminating the server does not take it with it,
    # which is the whole point of the split (shells outlive a server restart). So kill it by the
    # pid it reported, never by port: tailscale serve can listen on the same port on 100.x and
    # killing the first listener by port once killed tailscaled.
    if daemon_pid:
        try:
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/PID", str(daemon_pid), "/F"],
                               capture_output=True, timeout=10)
            else:
                os.kill(daemon_pid, 15)
            print(f"  (isolated daemon pid {daemon_pid} stopped)")
        except Exception as e:
            print(f"  (could not stop isolated daemon pid {daemon_pid}: {e})")

print("=" * 72)
print("FAILED:" if fails else "ALL PASSED", *(f"\n  - {n}" for n in fails))
print("=" * 72)
sys.exit(1 if fails else 0)
