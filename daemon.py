"""
webterm session daemon - the process that owns the PTYs and stays alive (tmux-server role).

Why split it out:
    If the web server and the PTY share one process, every web-server restart kills the shells.
    Same reason tmux keeps a separate `tmux server` - the client can die, the session lives.

    [session daemon]  <- here. holds the PTYs. rarely restarted
         | local TCP (127.0.0.1:8771, NDJSON)
    [web server]      <- free to restart; it just reattaches
         | WebSocket
    [browser]

Protocol (one line = one JSON object):
    control connection - handles one request, then closes
        {"op":"list"}                                  -> {"ok":true,"result":{"sessions":[...]}}
        {"op":"create","name":..,"cwd":..,"cols":..,"rows":..}
        {"op":"kill","sid":..} / {"op":"rename","sid":..,"name":..}   (name = tab name)
        {"op":"label","sid":..,"label":..}                            (label = per-pane name)
        {"op":"write","sid":..,"text":..,"submit":bool}   (external callers = the wezterm cli send-text slot)
        {"op":"backlog","sid":..}                         (= the get-text slot)
        {"op":"ping"}
    attach connection - from here on this connection is a stream for one session
        send: {"op":"attach","sid":..}
        recv: {"ev":"out","data":".."} / {"ev":"end"}
        after that, client->daemon uses the same shape as the browser WS ({"t":"i"|"r"}), relayed as-is
"""
import asyncio
import json
import logging
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))

# Under pythonw.exe, sys.stdout/stderr are None and the logger dies at startup
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
    handlers=[logging.FileHandler(os.path.join(BASE, "daemon.log"), encoding="utf-8"),
              logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("webterm.daemon")

sys.path.insert(0, BASE)
from session import SessionManager  # noqa: E402

HOST = "127.0.0.1"
PORT = int(os.environ.get("WEBTERM_DAEMON_PORT", "8771"))

mgr = SessionManager()


async def send(w, obj):
    w.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
    await w.drain()


async def handle_control(w, msg):
    op = msg.get("op")
    if op == "ping":
        return {"ok": True, "result": {"pid": os.getpid(), "sessions": len(mgr.sessions)}}
    if op == "list":
        mgr.reap()
        return {"ok": True, "result": {"sessions": mgr.list()}}
    if op == "create":
        s = mgr.create(name=msg.get("name"), shell=msg.get("shell"), cwd=msg.get("cwd"),
                       cols=int(msg.get("cols") or 120), rows=int(msg.get("rows") or 30))
        return {"ok": True, "result": {"session": s.info()}}
    if op == "kill":
        return {"ok": True, "result": {"killed": mgr.kill(msg.get("sid"))}}
    if op == "rename":
        return {"ok": True, "result": {"renamed": mgr.rename(msg.get("sid"), msg.get("name", ""))}}
    if op == "label":
        r = mgr.label(msg.get("sid"), msg.get("label", ""))
        if r == "duplicate":
            return {"ok": False, "error": "that pane name already exists in this tab"}
        if r == "nosession":
            return {"ok": False, "error": "no such session"}
        return {"ok": True, "result": {"labeled": True}}
    if op == "write":
        s = mgr.get(msg.get("sid"))
        if not s or not s.alive:
            return {"ok": False, "error": "no such live session"}
        text = msg.get("text", "")
        if msg.get("submit"):
            text += "\r"
        s.write(text)
        return {"ok": True, "result": {}}
    if op == "backlog":
        s = mgr.get(msg.get("sid"))
        if not s:
            return {"ok": False, "error": "no such session"}
        return {"ok": True, "result": {"text": s.backlog()}}
    return {"ok": False, "error": f"unknown op {op!r}"}


async def handle_attach(r, w, sid):
    """Turn this connection into a stream dedicated to one session."""
    s = mgr.get(sid)
    if s is None:
        await send(w, {"ok": False, "error": "no such session"})
        return
    await send(w, {"ok": True, "result": {"session": s.info()}})

    backlog = s.backlog()
    if backlog:
        await send(w, {"ev": "out", "data": backlog})

    q = s.subscribe()
    log.info("attach sid=%s clients=%d", sid, len(s._subs))

    async def pump_out():
        while True:
            data = await q.get()
            if data is None:
                await send(w, {"ev": "end"})
                return
            await send(w, {"ev": "out", "data": data})

    out = asyncio.create_task(pump_out())
    try:
        while True:
            line = await r.readline()
            if not line:
                break
            try:
                m = json.loads(line)
            except Exception:
                continue
            t = m.get("t")
            if t == "i":
                s.write(m.get("d", ""))
            elif t == "r":
                s.resize(m.get("c", 120), m.get("r", 30))
    except (ConnectionResetError, asyncio.IncompleteReadError):
        pass
    except Exception as e:
        log.info("attach error sid=%s: %s", sid, e)
    finally:
        out.cancel()
        s.unsubscribe(q)
        log.info("detach sid=%s clients=%d (session stays alive)", sid, len(s._subs))


async def on_client(r, w):
    try:
        line = await r.readline()
        if not line:
            return
        msg = json.loads(line)
        if msg.get("op") == "attach":
            await handle_attach(r, w, msg.get("sid"))
            return
        await send(w, await handle_control(w, msg))
    except Exception as e:
        log.exception("client error: %s", e)
        try:
            await send(w, {"ok": False, "error": repr(e)})
        except Exception:
            pass
    finally:
        try:
            w.close()
        except Exception:
            pass


async def main():
    mgr.bind_loop(asyncio.get_running_loop())
    server = await asyncio.start_server(on_client, HOST, PORT)
    log.info("daemon started pid=%s on %s:%s", os.getpid(), HOST, PORT)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except OSError as e:
        # If it's already up, back off quietly (prevents a double-start)
        log.warning("daemon failed to start (may already be running): %s", e)
