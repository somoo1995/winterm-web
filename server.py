"""
webterm web server - a pure relay between the browser and the session daemon.

This process holds no session state; the PTY is owned by daemon.py. So this server can be
restarted freely and the shells keep living through it.

    [browser xterm.js] --WebSocket--> [this server (relay)] --TCP--> [session daemon] --PTY--> [powershell]

Difference from wezterm-web: not get-text polling (1.5s) but a direct PTY stream (latency = network RTT).
"""
import asyncio
import json
import logging
import mimetypes
import os
import re
import subprocess
import sys
import time
from contextlib import asynccontextmanager

from fastapi import Body, FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import config
import daemon_client as dc

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")

# Python's `mimetypes` on Windows reads the REGISTRY, which often lacks `.woff2` / `.woff`.
# Then StaticFiles serves web fonts as `text/plain` and the browser won't use them as fonts
# -> the chosen font silently falls back (a hard-to-guess kind of failure).
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/woff", ".woff")
mimetypes.add_type("font/ttf", ".ttf")

# Under pythonw.exe, sys.stdout/stderr are None, so the uvicorn logger that writes to them
# dies at startup (we use pythonw to avoid a console window, so this must be guarded).
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

_handlers = [logging.FileHandler(os.path.join(BASE, "webterm.log"), encoding="utf-8"),
             logging.StreamHandler(sys.stdout)]
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
    handlers=_handlers,
)
log = logging.getLogger("webterm")


@asynccontextmanager
async def lifespan(app):
    ok = await dc.ensure_daemon()
    log.info("webterm started (daemon connection %s), static=%s", "OK" if ok else "FAIL", STATIC)
    yield
    # The daemon holds the sessions, so nothing is cleaned up here - that's the point of the split
    log.info("webterm stopped (sessions stay alive in the daemon)")


# JSON is always UTF-8 so omitting charset is standard (RFC 8259), but PowerShell 5.1's
# Invoke-RestMethod decodes as latin-1 when charset is absent, garbling non-ASCII responses.
# The browser is fine, so it's easy to miss. Skills/CLI attach over PowerShell, so we spell it out.
class UTF8JSONResponse(JSONResponse):
    media_type = "application/json; charset=utf-8"


app = FastAPI(title="webterm", lifespan=lifespan, default_response_class=UTF8JSONResponse)


# Under pythonw there's no console, so exceptions land nowhere.
# (Don't use BaseHTTPMiddleware - in starlette 1.0 it masks real exceptions as EndOfStream.)
@app.exception_handler(Exception)
async def log_exceptions(request, exc):
    log.exception("unhandled %s %s", request.method, request.url.path)
    return UTF8JSONResponse({"ok": False, "error": repr(exc)}, status_code=500)


@app.exception_handler(dc.DaemonDown)
async def daemon_down(request, exc):
    log.error("daemon connection failed: %s", exc)
    return UTF8JSONResponse({"ok": False, "error": str(exc)}, status_code=503)


# -- Browser-originated attack guard -------------------------------------------
# This is NOT "authentication". Who can reach the server is decided by the network
# (a private network / Tailscale). What this blocks is the one path that can't stop -
# an attack from the user's OWN browser hitting loopback. The attacker needn't be inside
# the tailnet, so a VPN is powerless.
#
#   Measured (2026-09-10, isolated instance):
#     - Host: attacker-rebind.example on GET /api/sessions -> 200, returned session list and sid
#     - Origin: https://evil.example on ws://.../ws/<sid>   -> accepted, full read/write
#     - Origin: https://evil.example on multipart POST /api/upload -> 200, file planted
#   (Whereas classic CSRF via text/plain on /api/send is 422 - FastAPI checks the content-type.)
#
# Don't use BaseHTTPMiddleware - in starlette 1.0 it masks real exceptions as EndOfStream
# (DEVLOG pitfall #4). Pure ASGI avoids that path and sees http and websocket in one place.
_UNSAFE_METHODS = ("POST", "PUT", "PATCH", "DELETE")


class BrowserGuard:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        kind = scope.get("type")
        if kind in ("http", "websocket") and config.guard_enabled():
            h = {k.decode("latin-1").lower(): v.decode("latin-1")
                 for k, v in (scope.get("headers") or [])}
            host, origin = h.get("host", ""), h.get("origin")

            # (1) DNS rebinding - a forged Host makes it same-origin, defeating CORS
            if not config.host_allowed(host):
                log.warning("blocked (Host) %r -> %s", host, scope.get("path"))
                return await self._deny(kind, send, f"host not allowed: {host}")

            # (2) Cross-origin WebSocket - CORS doesn't apply to WebSocket, so check it directly
            if kind == "websocket" and not config.origin_allowed(origin):
                log.warning("blocked (WS Origin) %r", origin)
                return await self._deny(kind, send, "origin not allowed")

            # (3) Cross-origin write - multipart arrives with no preflight (/api/upload was exploitable)
            if kind == "http" and scope.get("method") in _UNSAFE_METHODS                     and not config.origin_allowed(origin):
                log.warning("blocked (Origin) %s %s from %r", scope.get("method"),
                            scope.get("path"), origin)
                return await self._deny(kind, send, "origin not allowed")

        await self.app(scope, receive, send)

    @staticmethod
    async def _deny(kind, send, msg):
        if kind == "websocket":
            await send({"type": "websocket.close", "code": 4403})
            return
        body = json.dumps({"ok": False, "error": msg}, ensure_ascii=False).encode("utf-8")
        await send({"type": "http.response.start", "status": 403, "headers": [
            (b"content-type", b"application/json; charset=utf-8"),
            (b"content-length", str(len(body)).encode("ascii")),
        ]})
        await send({"type": "http.response.body", "body": body})


app.add_middleware(BrowserGuard)


# Route uvicorn's own loggers into the file too
for _n in ("uvicorn", "uvicorn.error", "uvicorn.access"):
    _lg = logging.getLogger(_n)
    _lg.handlers = _handlers
    _lg.setLevel(logging.INFO)


async def _ask(msg):
    """Control request to the daemon. Errors propagate so the exception handler turns them into 503."""
    res = await dc.request(msg)
    if not res.get("ok"):
        raise RuntimeError(res.get("error", "daemon error"))
    return res.get("result", {})


# The Enter must NOT ride in the same chunk as the body.
#   The daemon's write op, when submit, writes `text + "\r"` to the PTY in one go, but measured
#   (2026-08-26) all 6/6 arrive as a single lump like `"HELLO1\r"`. A shell (PSReadLine) runs it
#   fine, but a TUI like claude judges lumped input as a PASTE and treats the trailing `\r` as a
#   line break, not "submit" -> the text is in but Enter seems not pressed (~50% of the time; it
#   sometimes works because the judgment depends on length/timing, which is more confusing).
#   -> Write the body first, then, after a human-like gap, send `\r` on its own.
SUBMIT_GAP = 0.15   # seconds. minimum gap to clear the paste-detection window


def _as_text(v):
    """Normalize the value to write to the PTY into a string - the gate that keeps a non-str from
    leaking through to the daemon.

    Needed because of a PowerShell 5.1 `ConvertTo-Json` pitfall (measured 2026-09-01):
      if the value isn't a pure `[string]` but a `PSObject` with an ETS NoteProperty attached,
      `ConvertTo-Json` expands it into an object and sends `{"value":"body","Count":1}`.
      It's NOT a length issue - a 20k-char pure string serializes fine. The sender can't tell where
      the wrapping happened (it can attach anywhere in the pipeline), so the receiver should unwrap it.
      Left unguarded, the dict flows all the way to `session.write` and ends in
      `TypeError: argument 'to_write': 'dict' object is not an instance of 'str'`.
    """
    if isinstance(v, str):
        return v
    if isinstance(v, dict) and isinstance(v.get("value"), str):
        log.warning("text arrived wrapped as a PSObject - recovering by extracting value (keys=%s)",
                    sorted(v.keys()))
        return v["value"]
    if isinstance(v, list) and all(isinstance(x, str) for x in v):
        # A PowerShell array (e.g. Get-Content read without -Raw) arrived un-joined
        log.warning("text arrived as an array - joining with newlines (%d lines)", len(v))
        return "\n".join(v)
    if isinstance(v, (int, float, bool)):
        return str(v)
    # Raise ValueError (not RuntimeError, which means daemon failure -> 404) so the route maps it to 400
    raise ValueError(f"text must be a string - got type: {type(v).__name__}")


async def _write(sid, text, submit):
    """Write to the PTY. On submit, send the body and Enter as SEPARATE chunks."""
    text = _as_text(text)
    if text:
        await _ask({"op": "write", "sid": sid, "text": text, "submit": False})
    if submit:
        if text:
            await asyncio.sleep(SUBMIT_GAP)
        await _ask({"op": "write", "sid": sid, "text": "\r", "submit": False})


@app.get("/")
async def index():
    """index.html is the ONE file we never cache.

    New versions of static files are announced by the `?v=N` cache-buster inside THIS file - but if
    the file carrying that announcement is itself cached, the phone keeps biting the old version even
    after new code ships. Hit this for real (2026-08-24): the server served v=47 while the phone log
    kept showing `app.js?v=44`, nothing landed, and "it's not working?" repeated. It happens from the
    browser HTTP cache alone, even though sw.js caches nothing.
    -> Make this one file fetch fresh every time; keep caching the heavy static files via `?v=N`.
    """
    return FileResponse(os.path.join(STATIC, "index.html"),
                        headers={"Cache-Control": "no-store, no-cache, must-revalidate"})


# You need an installed PWA to get Window Controls Overlay (= WezTerm's INTEGRATED_BUTTONS).
# Both must be served from the ROOT path - putting them under /static narrows the service worker's
# scope to /static, so it can't govern the whole app and the install criteria aren't met.
@app.get("/manifest.webmanifest")
async def manifest():
    return FileResponse(os.path.join(STATIC, "manifest.webmanifest"),
                        media_type="application/manifest+json")


@app.get("/sw.js")
async def service_worker():
    return FileResponse(os.path.join(STATIC, "sw.js"), media_type="application/javascript")


@app.get("/api/clipboard")
async def api_clipboard():
    r"""Read the PC clipboard and return a string to paste (for an image, save a PNG and return its path).

    Calls the bundled `scripts/clipboard_paste.ps1` - for an image it saves to
    `%TEMP%\wezterm_clip\clip_*.png` and returns that path; for a file drop, the paths; for text, the text.

    Why the server reads it, not the browser:
      - A web page CANNOT stream image bytes into the terminal.
      - claude, on Ctrl+V (0x16), reads the clipboard itself
        (`powershell -Sta ... Clipboard::ContainsImage()`), but that path didn't work inside the webterm PTY.
      - WezTerm already solved this by pasting a PATH, so we do the same. claude, given a path, reads the file.

    `-Sta` is required - `System.Windows.Forms.Clipboard` only works on an STA thread.
    """
    # Use the bundled script. (Also check the home path once, for compatibility with older installs.)
    script = os.path.join(BASE, "scripts", "clipboard_paste.ps1")
    if not os.path.exists(script):
        script = os.path.join(os.path.expanduser("~"), ".claude", "scripts",
                              "clipboard_paste.ps1")
    if not os.path.exists(script):
        return UTF8JSONResponse({"ok": False, "error": "clipboard_paste.ps1 not found: " + script},
                                status_code=404)
    try:
        # Blocking call (~300ms), so run it in a thread - holding the event loop stalls other panes' output.
        def run():
            return subprocess.run(
                ["powershell.exe", "-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass",
                 "-File", script],
                capture_output=True, timeout=8,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        r = await asyncio.to_thread(run)
        text = r.stdout.decode("utf-8", "replace")
        return {"ok": True, "text": text}
    except Exception as e:
        log.info("clipboard read failed: %s", e)
        return UTF8JSONResponse({"ok": False, "error": str(e)}, status_code=500)


# -- File upload (phone -> PC) -------------------------------
# Receive a file the phone picked into a PC temp folder and return ITS PATH. The front end
# bracketed-pastes that path into a pane and claude reads the file - the SAME trick the clipboard
# image (`/api/clipboard`) uses (a web page can't stream bytes into the terminal, so route via a path).
#
# wezterm-web's /api/upload was base64 JSON + an image-extension whitelist. Here python-multipart
# is available, so we receive as a MULTIPART STREAM - base64 inflates 33% and loads fully into memory,
# which hurts immediately with a few phone photos.
UPLOAD_DIR = os.path.join(os.environ.get("TEMP") or os.environ.get("TMP") or "/tmp",
                          "webterm_uploads")
UPLOAD_MAX = 200 * 1024 * 1024      # 200MB per file (enough to accept phone videos)
UPLOAD_TTL = 86400                  # anything older than a day is cleared on the next upload (no unbounded growth)


def _upload_cleanup():
    try:
        cutoff = time.time() - UPLOAD_TTL
        for name in os.listdir(UPLOAD_DIR):
            p = os.path.join(UPLOAD_DIR, name)
            try:
                if os.path.isfile(p) and os.path.getmtime(p) < cutoff:
                    os.remove(p)
            except OSError:
                pass
    except OSError:
        pass


def _safe_name(name):
    """Trim a filename so it CAN'T become a path.

    Blocks three things at once:
      1. Path escape - `../../x` and `C:\\x` are cut down with basename.
      2. Windows-forbidden chars (`<>:"/\\|?*`) and control chars -> `_`
      3. SPACES -> `_`: the path is pasted straight into a pane, so a space makes the shell split args.
         Quoting is an option, but that confuses claude's path detection, so this is safer.
    """
    name = os.path.basename((name or "").replace("\\", "/").split("/")[-1])
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f\s]', "_", name).strip("._") or "file"
    return name[:120]


@app.post("/api/upload")
async def api_upload(files: list[UploadFile] = File(...)):
    """Receive the files the phone picked, save them, and return the LIST OF PC PATHS."""
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    _upload_cleanup()
    saved, errors = [], []
    stamp = time.strftime("%Y%m%d_%H%M%S")
    for i, up in enumerate(files or []):
        name = _safe_name(up.filename)
        # Prefix time + index so uploading the same name twice doesn't overwrite
        path = os.path.join(UPLOAD_DIR, f"{stamp}_{i}_{name}")
        size = 0
        try:
            # Disk writes block - doing them on the event loop stalls other panes' output
            # (/api/clipboard already uses to_thread for the same reason).
            fh = await asyncio.to_thread(open, path, "wb")
            try:
                while True:
                    chunk = await up.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > UPLOAD_MAX:
                        raise ValueError(f"exceeds {UPLOAD_MAX // (1024 * 1024)}MB")
                    await asyncio.to_thread(fh.write, chunk)
            finally:
                await asyncio.to_thread(fh.close)
            saved.append({"path": path, "name": name, "size": size})
            log.info("upload %s (%d bytes)", path, size)
        except Exception as e:
            try:
                os.remove(path)
            except OSError:
                pass
            log.info("upload failed %s: %s", name, e)
            errors.append({"name": name, "error": str(e)})
    if not saved:
        return UTF8JSONResponse({"ok": False, "error": "no files saved", "errors": errors},
                                status_code=400)
    return {"ok": True, "files": saved, "errors": errors}


@app.post("/api/diag")
async def api_diag(payload: dict = Body(default=None)):
    """Log one line of the render environment when a browser connects (dpr, actual font, cell size).

    A "text looks blurry" report is a render problem, not data, so it leaves no trace in logs/capture.
    Fixing by guesswork breaks what worked (already happened once), so look at the values first.
    """
    log.info("DIAG %s", json.dumps(payload or {}, ensure_ascii=False))
    return {"ok": True}


@app.get("/api/config")
async def api_config():
    """Return only the settings the front end uses (not server-internal values like the allowlist).

    Config editing is file-only - a write API would let the browser edit server files, a hole this
    program has no reason to open.
    """
    c = config.load()
    return {"ok": True,
            "defaultCwd": c.get("defaultCwd") or "",
            "fontSize": c.get("fontSize"),
            "keymap": config.keymap()}


@app.get("/api/health")
async def api_health():
    try:
        r = await dc.request({"op": "ping"}, timeout=3)
        return {"ok": True, "daemon": r.get("result", {})}
    except Exception as e:
        return UTF8JSONResponse({"ok": False, "error": str(e)}, status_code=503)


@app.get("/api/sessions")
async def api_list():
    return await _ask({"op": "list"})


@app.post("/api/sessions")
async def api_create(payload: dict = Body(default=None)):
    payload = payload or {}
    return await _ask({
        "op": "create",
        "name": payload.get("name"),
        # request value -> config.json -> (in the daemon) WEBTERM_* env vars -> home
        "shell": payload.get("shell") or config.load().get("shell") or None,
        "cwd": payload.get("cwd") or config.load().get("defaultCwd") or None,
        "cols": int(payload.get("cols") or 120),
        "rows": int(payload.get("rows") or 30),
    })


@app.delete("/api/sessions/{sid}")
async def api_kill(sid: str):
    r = await _ask({"op": "kill", "sid": sid})
    return {"ok": r.get("killed", False)}


@app.post("/api/sessions/{sid}/rename")
async def api_rename(sid: str, payload: dict = Body(...)):
    r = await _ask({"op": "rename", "sid": sid, "name": payload.get("name", "")})
    return {"ok": r.get("renamed", False)}


@app.post("/api/sessions/{sid}/label")
async def api_label(sid: str, payload: dict = Body(...)):
    """A pane's individual name. Unlike rename (tab name), it doesn't affect the group (tab)."""
    try:
        r = await _ask({"op": "label", "sid": sid, "label": payload.get("label", "")})
    except RuntimeError as e:
        # A name clash is a user-input problem, not a server failure -> return 409 to distinguish it
        return UTF8JSONResponse({"ok": False, "error": str(e)}, status_code=409)
    return {"ok": r.get("labeled", False)}


@app.post("/api/sessions/{sid}/send")
async def api_send(sid: str, payload: dict = Body(...)):
    """For external callers - the wezterm cli send-text slot. Writes straight to the PTY, no process spawn."""
    try:
        await _write(sid, payload.get("text", ""), bool(payload.get("submit")))
    except ValueError as e:
        return UTF8JSONResponse({"ok": False, "error": str(e)}, status_code=400)
    except RuntimeError as e:
        return UTF8JSONResponse({"ok": False, "error": str(e)}, status_code=404)
    return {"ok": True}


# -- Address a pane by name (resolve) --------------------------------------
# Lets external callers (skills, telegram, a future wezterm cli shim) address a pane without a sid.
#
# The rule must live in ONE place. A past incident came from "each caller having its own matching
# rule" - tg_daemon's `resolve_session` used prefix partial-matching and silently picked the first
# candidate between `oracleVpsForRustDesk` and `oracleVpsForRustDesk_1`, sending the message to the
# wrong session.
#
# So two rules:
#   1. NO partial matching - exact match only. Only the sid (which humans don't type) allows a prefix.
#   2. On ambiguity, DON'T pick - return the candidates and make the caller re-ask (409).
#
# Target syntax:
#   "tab:pane"  tab name + pane name (label) or pane number (1-based, same as screen order)
#   "tab"       only when the tab has a single pane
#   "pane"      only when the label is unique across everything (different tabs may share a label)
#   "3-2"       positional - the 2nd pane of the 3rd tab (how a human names it looking at the screen)
#   "3"         the 3rd tab (only when it has a single pane)
#   "<sid>"     a sid or its prefix
#
# Why positional: users don't memorize names, they call by VISIBLE order ("send to 3-2"). Without
# that form, callers guessed like "assume 3-1" - no rule means the caller invents one, which becomes
# a command landing in the wrong session.
# Order matters: a NAME match always comes first (a tab's label could be "3", a tab name could be
# "3-2"). It also comes before sid-prefix matching - a single digit easily catches a hex sid prefix.
def _match(sessions, target):
    """Returns: (session, None) | (None, candidate_list)"""
    alive = [s for s in sessions if s.get("alive")]
    t = (target or "").strip()
    if not t:
        return None, []

    def brief(s):
        return {"sid": s["sid"], "tab": s["name"], "label": s.get("label", ""), "cwd": s.get("cwd")}

    def pick(cands):
        if len(cands) == 1:
            return cands[0], None
        return None, [brief(c) for c in cands]

    if ":" in t:
        tab, _, pane = t.partition(":")
        tab, pane = tab.strip(), pane.strip()
        # If "tab" is empty (":name"), search for the label across everything
        group = [s for s in alive if s["name"] == tab] if tab else alive
        if not group:
            return None, []
        if pane.isdigit():          # the number is order within that tab - list order IS the screen number
            i = int(pane) - 1
            return (group[i], None) if 0 <= i < len(group) else (None, [])
        return pick([s for s in group if s.get("label", "") == pane])

    # A single token with no separator - try tab -> label -> position -> sid
    by_tab = [s for s in alive if s["name"] == t]
    if by_tab:
        return pick(by_tab)
    by_label = [s for s in alive if s.get("label", "") == t]
    if by_label:
        return pick(by_label)

    # Positional "3-2" (2nd pane of tab 3) / "3" (tab 3)
    #   Tab order is FIRST-APPEARANCE order in the session list - the same rule the browser tab bar
    #   draws (app.js: `[...new Set(sessions.map(s => s.name))]`). If the two diverge, the user's
    #   number and ours diverge, so copy the rule exactly.
    def tab_order():
        names = []
        for s in alive:
            if s["name"] not in names:
                names.append(s["name"])
        return names

    m = re.fullmatch(r"(\d+)\s*-\s*(\d+)", t)
    if m or t.isdigit():
        ti = int(m.group(1)) - 1 if m else int(t) - 1
        names = tab_order()
        if not (0 <= ti < len(names)):
            return None, []
        group = [s for s in alive if s["name"] == names[ti]]
        if not m:
            return pick(group)               # "3" - if multiple panes, return candidates (409)
        pi = int(m.group(2)) - 1
        return (group[pi], None) if 0 <= pi < len(group) else (None, [])

    by_sid = [s for s in alive if s["sid"] == t or s["sid"].startswith(t)]
    if by_sid:
        return pick(by_sid)
    return None, []


async def _resolve(target):
    """target -> session. On miss, returns a JSONResponse with 404; on ambiguity, one with 409."""
    r = await _ask({"op": "list"})
    s, cands = _match(r.get("sessions", []), target)
    if s:
        return s, None
    if cands:
        return None, UTF8JSONResponse(
            {"ok": False, "error": f"'{target}' matches multiple panes - address it as tab:pane",
             "candidates": cands}, status_code=409)
    return None, UTF8JSONResponse(
        {"ok": False, "error": f"no pane matches '{target}'"}, status_code=404)


# -- Tab / pane API --------------------------------------------------------
# The browser operates by sid (routes above), but external callers (skills, CLI) don't know the sid.
# A "tab" has no real existence on the server - it's the GROUP of sessions sharing a name - so the
# group operations live here in one place (a for-loop per caller scatters the rule).
# Tab-name rules - create and rename must use the SAME rule (guard one side only and it comes in the other).
#   ':'    -> collides with the address syntax (`tab:pane`)
#   '/' '\' -> the tab name goes into the URL path, mistaken for a path separator
_BAD_TAB_CHARS = re.compile(r"[:/\\]")


def _bad_tab_name(name):
    """A reason string if there's a problem, else None."""
    if not name:
        return "a tab name is required"
    if _BAD_TAB_CHARS.search(name):
        return "a tab name can't contain : / \\"
    return None


async def _sessions():
    return (await _ask({"op": "list"})).get("sessions", [])


def _tab_panes(sessions, name):
    return [s for s in sessions if s["name"] == name and s.get("alive")]


def _tab_view(sessions, name, i=None):
    ps = _tab_panes(sessions, name)
    return {
        # `i` = tab number (1-based). Without it the caller has no basis to address "3-2"
        #   (the number is visible but not in the list, so they'd guess).
        "i": i,
        "tab": name,
        "panes": [{"n": i + 1, "sid": s["sid"], "label": s.get("label", ""),
                   "cwd": s.get("cwd"), "title": s.get("title", "")}
                  for i, s in enumerate(ps)],
    }


@app.get("/api/tabs")
async def api_tabs():
    """The list viewed by tab. The pane number (n) is the same as the visible number."""
    ss = await _sessions()
    names = []
    for s in ss:
        if s.get("alive") and s["name"] not in names:
            names.append(s["name"])
    return {"ok": True, "tabs": [_tab_view(ss, n, i + 1) for i, n in enumerate(names)]}


@app.post("/api/tabs")
async def api_tab_create(payload: dict = Body(...)):
    """Create a tab (= start the first pane with that name).

    If the name already exists, REFUSE. The name is the group key, so creating silently would add a
    pane to the existing tab, not make a new tab - not what the caller meant. To add a pane to an
    existing tab, use POST /api/panes.
    """
    name = (payload.get("name") or "").strip()
    bad = _bad_tab_name(name)
    if bad:
        return UTF8JSONResponse({"ok": False, "error": bad}, status_code=400)
    ss = await _sessions()
    if _tab_panes(ss, name):
        return UTF8JSONResponse({"ok": False, "error": f"tab '{name}' already exists"}, status_code=409)
    r = await _ask({"op": "create", "name": name, "cwd": payload.get("cwd"),
                    "cols": int(payload.get("cols") or 120), "rows": int(payload.get("rows") or 30)})
    s = r.get("session", {})
    if payload.get("label"):
        await _ask({"op": "label", "sid": s["sid"], "label": payload["label"]})
    return {"ok": True, "tab": name, "sid": s.get("sid"), "cwd": s.get("cwd")}


@app.post("/api/tabs/{name}/rename")
async def api_tab_rename(name: str, payload: dict = Body(...)):
    """Rename a tab - applied to ALL panes of that tab at once."""
    new = (payload.get("name") or "").strip()
    bad = _bad_tab_name(new)
    if bad:
        return UTF8JSONResponse({"ok": False, "error": bad}, status_code=400)
    ss = await _sessions()
    ps = _tab_panes(ss, name)
    if not ps:
        return UTF8JSONResponse({"ok": False, "error": f"no tab '{name}'"}, status_code=404)
    if new != name and _tab_panes(ss, new):
        # Making it the same name merges two tabs and can break the (tab, label) composite key -> prevent it
        return UTF8JSONResponse({"ok": False, "error": f"tab '{new}' already exists - merging isn't supported"},
                            status_code=409)
    for s in ps:
        await _ask({"op": "rename", "sid": s["sid"], "name": new})
    return {"ok": True, "tab": new, "panes": len(ps)}


@app.delete("/api/tabs/{name}")
async def api_tab_close(name: str):
    """Close a tab = terminate all of its panes."""
    ps = _tab_panes(await _sessions(), name)
    if not ps:
        return UTF8JSONResponse({"ok": False, "error": f"no tab '{name}'"}, status_code=404)
    for s in ps:
        await _ask({"op": "kill", "sid": s["sid"]})
    return {"ok": True, "tab": name, "killed": len(ps)}


@app.post("/api/panes")
async def api_pane_create(payload: dict = Body(...)):
    """Add one more pane to an existing tab (= split).

    Without cwd, it INHERITS the folder of the tab's first pane - the natural expectation for a split.
    """
    tab = (payload.get("tab") or "").strip()
    if not tab:
        return UTF8JSONResponse({"ok": False, "error": "tab is required"}, status_code=400)
    ss = await _sessions()
    ps = _tab_panes(ss, tab)
    if not ps:
        return UTF8JSONResponse({"ok": False, "error": f"no tab '{tab}' - create it first"},
                            status_code=404)
    cwd = payload.get("cwd") or ps[0].get("cwd")
    r = await _ask({"op": "create", "name": tab, "cwd": cwd,
                    "cols": int(payload.get("cols") or ps[0].get("cols") or 120),
                    "rows": int(payload.get("rows") or ps[0].get("rows") or 30)})
    s = r.get("session", {})
    if payload.get("label"):
        try:
            await _ask({"op": "label", "sid": s["sid"], "label": payload["label"]})
        except RuntimeError as e:
            # The pane already exists - don't hide that only the naming failed
            return {"ok": True, "tab": tab, "sid": s.get("sid"), "n": len(ps) + 1,
                    "cwd": cwd, "label": "", "warning": str(e)}
    return {"ok": True, "tab": tab, "sid": s.get("sid"), "n": len(ps) + 1,
            "cwd": cwd, "label": payload.get("label", "")}


@app.post("/api/panes/label")
async def api_pane_label(payload: dict = Body(...)):
    """Address by name and set the pane's name. Empty reverts to auto."""
    s, err = await _resolve(payload.get("target", ""))
    if err:
        return err
    try:
        await _ask({"op": "label", "sid": s["sid"], "label": payload.get("label", "")})
    except RuntimeError as e:
        return UTF8JSONResponse({"ok": False, "error": str(e)}, status_code=409)
    return {"ok": True, "sid": s["sid"], "tab": s["name"], "label": payload.get("label", "")}


@app.delete("/api/panes")
async def api_pane_close(target: str):
    """Address by name and close one pane. If it's the tab's last pane, the tab disappears too."""
    s, err = await _resolve(target)
    if err:
        return err
    left = len(_tab_panes(await _sessions(), s["name"])) - 1
    await _ask({"op": "kill", "sid": s["sid"]})
    return {"ok": True, "sid": s["sid"], "tab": s["name"], "label": s.get("label", ""),
            "tab_closed": left <= 0, "panes_left": max(0, left)}


async def _pos_of(sid):
    """Compute this pane's screen position "3-2". None if not found.

    Position is computed ON DEMAND - stamped in an env var or DB, it shifts as panes open and close
    and soon becomes a lie (so we stamp only WEBTERM_SID and answer position here).
    """
    ss = await _sessions()
    alive = [s for s in ss if s.get("alive")]
    names = []
    for s in alive:
        if s["name"] not in names:
            names.append(s["name"])
    for s in alive:
        if s["sid"] == sid:
            group = [x for x in alive if x["name"] == s["name"]]
            return f"{names.index(s['name']) + 1}-{group.index(s) + 1}"
    return None


@app.get("/api/resolve")
async def api_resolve(target: str):
    """Just check where a send would go (returns candidates if ambiguous).

    Also a whoami - from inside a pane, `GET /api/resolve?target=$env:WEBTERM_SID` returns your
    current tab, label, and position.
    """
    s, err = await _resolve(target)
    if err:
        return err
    return {"ok": True, "sid": s["sid"], "tab": s["name"], "pos": await _pos_of(s["sid"]),
            "label": s.get("label", ""), "cwd": s.get("cwd"), "title": s.get("title", "")}


@app.post("/api/send")
async def api_send_by_name(payload: dict = Body(...)):
    """Address by name and send text - the front door for skills and external callers."""
    s, err = await _resolve(payload.get("target", ""))
    if err:
        return err
    try:
        await _write(s["sid"], payload.get("text", ""), bool(payload.get("submit")))
    except ValueError as e:
        return UTF8JSONResponse({"ok": False, "error": str(e)}, status_code=400)
    except RuntimeError as e:
        return UTF8JSONResponse({"ok": False, "error": str(e)}, status_code=404)
    return {"ok": True, "sid": s["sid"], "tab": s["name"], "label": s.get("label", "")}


# backlog is the RAW stream the PTY emitted, with ANSI control chars mixed in.
# It must be stripped for a human or skill to read (wezterm cli get-text read a grid, so it was already text).
# Limit: we hold a stream, not a grid, so a TUI that redraws by moving the cursor (claude etc.) shows
#   "what was output over time", not "the current screen". Shell output is accurate; a TUI is approximate.
_ANSI = re.compile(
    r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"      # OSC ... BEL/ST (window title, etc.)
    r"|\x1b\[[0-?]*[ -/]*[@-~]"               # CSI (color, cursor moves)
    r"|\x1b[@-Z\\-_]"                         # single ESC
    r"|[\x00-\x08\x0b\x0c\x0e-\x1f]"          # remaining control chars (keep tab/newline)
)


def strip_ansi(text):
    return _ANSI.sub("", text).replace("\r\n", "\n").replace("\r", "\n")


@app.get("/api/capture")
async def api_capture_by_name(target: str, lines: int = 0, raw: int = 0):
    """Address by name and read the screen - the wezterm cli get-text slot.

    Default is ANSI-stripped plain text; raw=1 returns the original stream as-is.
    """
    s, err = await _resolve(target)
    if err:
        return err
    r = await _ask({"op": "backlog", "sid": s["sid"]})
    text = r.get("text", "")
    if not raw:
        text = strip_ansi(text)
    if lines > 0:
        text = "\n".join([ln for ln in text.splitlines() if ln.strip()][-lines:])
    return {"ok": True, "sid": s["sid"], "tab": s["name"], "label": s.get("label", ""), "text": text}


@app.get("/api/sessions/{sid}/capture")
async def api_capture(sid: str):
    """For external callers - the wezterm cli get-text slot."""
    try:
        r = await _ask({"op": "backlog", "sid": sid})
    except RuntimeError as e:
        return UTF8JSONResponse({"ok": False, "error": str(e)}, status_code=404)
    return {"ok": True, "text": r.get("text", "")}


# -- Multi-client screen sizing --------------------------------------------
# The PTY has one size but several devices attach (PC 1600px + phone 412px).
# Left alone, it keeps getting TAKEN OVER by whoever asked last, so the PC screen shrinks to phone
# width and they fight over resizes, breaking the TUI (claude really did fail to draw).
#
# Policy: WHOEVER REPORTS A SIZE is the owner; the rest receive that size and draw to it.
#   The PC should grow the terminal when the window grows (like WezTerm), so its reported size applies.
#   The phone doesn't report by default (so it doesn't steal the PC's screen) and can grab ownership with `⤢`.
#   Either way, every client's xterm MUST follow the PTY size - a mismatch overlaps characters.
_client_sizes = {}          # {sid: {client_id: (cols, rows)}}
_applied_size = {}          # {sid: (cols, rows)} - last value sent to the daemon
_last_report = {}           # {sid: (cols, rows)} - most recently reported size (= current owner)


def _best_size(sid):
    """Use the size of the client that REPORTED LAST, as-is.

    Key point: like WezTerm, the PC must GROW THE TERMINAL when its window grows.
    Clamping to a min/max traps the PC at phone size - a thing that "won't grow when you enlarge it".

    Conflicts are resolved by ROLE SEPARATION, not policy:
      - the reporting side (owner, PC by default): asks for its own window size
      - the non-reporting side (phone): receives the PTY size and draws it (horizontal scroll)
      - `⤢` (force) can switch ownership
    """
    last = _last_report.get(sid)
    if last:
        return last
    sizes = _client_sizes.get(sid) or {}
    return next(iter(sizes.values()), None)


_forced_size = {}           # {sid: (cols, rows)} - a client demanded "fit to my screen"
_forced_by = {}             # {sid: cid} - the BROWSER that set the force (not the socket)
_force_gone = {}            # {sid: monotonic} - when the owner started being absent
FORCE_GRACE = 90            # seconds. drop the force if absent this long


def _live_force(sid):
    """A forced size holds only while the browser that set it is alive.

    Incident 1 (2026-08-23): the release only came on pressing `⤢` AGAIN. Close the browser with it on
    from a phone and the release never came, so `_forced_size` lingered and the PC stayed trapped at
    phone size (51x30). Worse, it equaled `_applied_size`, so there wasn't even a resize call - no log trace.

    Incident 2 (2026-08-24): so we changed it to "release the moment the socket drops", and it leaked
    the other way - a phone reconnects its WS just from turning off the screen or app-switching. Each
    time, ownership was lost and the PTY jumped to PC size, which the phone then drew, cutting off the
    statusline.
    -> Base the judgment on the BROWSER (cid), not the socket (id(ws)), and even then grant a
       FORCE_GRACE period. Tolerate brief drops; release only on a real departure.
    """
    owner = _forced_by.get(sid)
    if owner is None:
        return None
    here = {cid for cid, _ in (_client_sizes.get(sid) or {})}
    if owner in here:
        _force_gone.pop(sid, None)
        return _forced_size.get(sid)
    gone_at = _force_gone.get(sid)
    if gone_at is None:
        _force_gone[sid] = time.monotonic()
        return _forced_size.get(sid)          # just dropped - still treat as owner
    if time.monotonic() - gone_at < FORCE_GRACE:
        return _forced_size.get(sid)
    _forced_size.pop(sid, None)
    _forced_by.pop(sid, None)
    _force_gone.pop(sid, None)
    log.info("force auto-released sid=%s (owner absent > %ds)", sid, FORCE_GRACE)
    return None


async def _sync_size(sid, att, force=None, owner=None):
    """Decide the PTY size.

    Default is the size of the client that reported last (usually the PC window).
    Setting force via `⤢` pins that size and ignores other clients' reports.
    That pin holds only while the setting client is alive (`_live_force`).
    """
    if force:
        _forced_size[sid] = force
        _forced_by[sid] = owner
        _force_gone.pop(sid, None)
    target = _live_force(sid) or _best_size(sid)
    if target and _applied_size.get(sid) != target:
        _applied_size[sid] = target
        await att.resize(target[0], target[1])
        # Log WHO asked for this size. With several clients, "last reporter is owner" makes them steal
        #   from each other; without the culprit you just pile up guesses (2026-08-24).
        who = ", ".join(sorted({c for c, _ in (_client_sizes.get(sid) or {})}))
        log.info("resize sid=%s -> %dx%d (%s) requested_by=%s attached=[%s]",
                 sid, target[0], target[1],
                 "forced" if _forced_size.get(sid) else "reporter",
                 owner or "-", who)


@app.websocket("/ws/{sid}")
async def ws_term(ws: WebSocket, sid: str):
    await ws.accept()
    att = dc.Attach(sid)
    # Identity is the BROWSER, not the socket (see `_live_force`). The socket id is bundled in only for
    # cleanup, since the same browser can briefly overlap two while reconnecting.
    cid = ws.query_params.get("cid") or f"anon-{id(ws)}"
    client_id = (cid, id(ws))
    try:
        await att.open()
    except Exception as e:
        log.info("attach failed sid=%s: %s", sid, e)
        await ws.close(code=4004, reason="no such session")
        return

    log.info("ws attach sid=%s", sid)

    async def pump_out():
        """daemon -> browser"""
        async for kind, data in att.events():
            if kind == "end":
                await ws.close(code=4000, reason="session ended")
                return
            await ws.send_text(data)

    out_task = asyncio.create_task(pump_out())
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            t = msg.get("t")
            if t == "i":
                await att.input(msg.get("d", ""))
            elif t == "r":
                size = (int(msg.get("c", 120)), int(msg.get("r", 30)))
                _client_sizes.setdefault(sid, {})[client_id] = size
                _last_report[sid] = size          # the most recent reporter owns the size
                # force=true means "fit to my screen" - keep this size even when others report
                await _sync_size(sid, att,
                                 force=size if msg.get("force") else None,
                                 owner=cid)
            elif t == "unforce":
                _forced_size.pop(sid, None)
                _forced_by.pop(sid, None)
                _force_gone.pop(sid, None)
                await _sync_size(sid, att)
            elif t == "ping":
                await ws.send_text("")   # latency-measuring echo (an empty string isn't drawn)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.info("ws error sid=%s: %s", sid, e)
    finally:
        out_task.cancel()
        # This client left, so recompute the size (when the phone leaves, revert to PC size).
        # Apply only if clients remain - if nobody's left, don't touch the PTY size.
        (_client_sizes.get(sid) or {}).pop(client_id, None)
        if _client_sizes.get(sid):
            try:
                await _sync_size(sid, att)
            except Exception:
                pass
        else:
            _client_sizes.pop(sid, None)
            _last_report.pop(sid, None)
            # Nobody left -> drop the force too, so the next client takes its own size
            _forced_size.pop(sid, None)
            _forced_by.pop(sid, None)
            _force_gone.pop(sid, None)
        att.close()
        log.info("ws detach sid=%s (session stays alive in the daemon)", sid)


app.mount("/static", StaticFiles(directory=STATIC), name="static")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("WEBTERM_PORT", "8767"))
    host = os.environ.get("WEBTERM_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port, log_level="warning",
                ws_ping_interval=20, ws_ping_timeout=30)
