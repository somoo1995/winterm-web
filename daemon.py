"""
webterm 세션 데몬 — PTY 를 소유하고 계속 살아있는 프로세스 (tmux server 역할)

왜 분리하나:
    웹서버와 PTY 가 한 프로세스면 웹서버를 고쳐 재시작할 때마다 셸이 같이 죽는다.
    tmux 가 `tmux server` 를 따로 두는 이유와 같다 — 클라이언트는 죽어도 세션은 산다.

    [세션 데몬]  ← 여기. PTY 보관. 거의 재시작하지 않는다
         ↕ 로컬 TCP (127.0.0.1:8771, NDJSON)
    [웹서버]     ← 재시작 자유. 다시 붙기만 하면 된다
         ↕ WebSocket
    [브라우저]

프로토콜 (한 줄 = JSON 하나):
    제어 연결 — 요청 1건 처리 후 닫는다
        {"op":"list"}                                  → {"ok":true,"result":{"sessions":[...]}}
        {"op":"create","name":..,"cwd":..,"cols":..,"rows":..}
        {"op":"kill","sid":..} / {"op":"rename","sid":..,"name":..}   (name = 탭 이름)
        {"op":"label","sid":..,"label":..}                            (label = pane 개별 이름)
        {"op":"write","sid":..,"text":..,"submit":bool}   (외부 연동용 = wezterm cli send-text 자리)
        {"op":"backlog","sid":..}                         (= get-text 자리)
        {"op":"ping"}
    attach 연결 — 이후 그 연결은 한 세션 전용 스트림이 된다
        보내기: {"op":"attach","sid":..}
        받기  : {"ev":"out","data":".."} / {"ev":"end"}
        이후 클라→데몬은 브라우저 WS 와 같은 형식({"t":"i"|"r"})이라 웹서버가 그대로 중계한다
"""
import asyncio
import json
import logging
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))

# pythonw.exe 로 띄우면 sys.stdout/stderr 가 None 이라 로거가 기동 즉시 죽는다
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
            return {"ok": False, "error": "같은 탭에 이미 그 패널 이름이 있습니다"}
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
    """이 연결을 한 세션 전용 스트림으로 전환한다."""
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
        log.info("detach sid=%s clients=%d (세션은 계속 살아있음)", sid, len(s._subs))


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
        # 이미 떠 있으면 조용히 물러난다(중복 기동 방지)
        log.warning("daemon 기동 실패(이미 실행 중일 수 있음): %s", e)
