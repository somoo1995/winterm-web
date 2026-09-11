"""
webterm 웹서버 — 브라우저와 세션 데몬 사이의 **순수 중계기**

이 프로세스는 세션 상태를 하나도 갖지 않는다. PTY 는 daemon.py 가 소유한다.
따라서 이 서버는 마음껏 재시작해도 되고, 그동안에도 셸은 계속 살아있다.

    [브라우저 xterm.js] ──WebSocket──▶ [이 서버(중계)] ──TCP──▶ [세션 데몬] ──PTY──▶ [powershell]

wezterm-web 과의 차이: get-text 폴링(1.5초)이 아니라 PTY 스트림 직결(지연 = 네트워크 RTT).
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

# ⚠ Windows 의 python `mimetypes` 는 **레지스트리**를 읽는데 `.woff2`·`.woff` 가 없는 경우가 많다.
#   그러면 StaticFiles 가 웹폰트를 `text/plain` 으로 내보내고, 브라우저는 그걸 폰트로 안 쓴다
#   → 지정한 폰트가 조용히 폴백된다(원인을 짐작하기 어려운 종류의 고장).
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/woff", ".woff")
mimetypes.add_type("font/ttf", ".ttf")

# pythonw.exe 로 띄우면 sys.stdout/stderr 가 None 이라, 거기에 쓰려는 uvicorn 로거가
# 기동 즉시 죽는다(콘솔 창을 안 띄우려고 pythonw 를 쓰므로 반드시 막아야 한다).
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
    log.info("webterm started (데몬 연결 %s), static=%s", "OK" if ok else "실패", STATIC)
    yield
    # 세션은 데몬이 들고 있으므로 여기서 아무것도 정리하지 않는다 — 그게 분리의 목적이다
    log.info("webterm stopped (세션은 데몬에 그대로 살아있음)")


# ⚠ JSON 은 늘 UTF-8 이라 charset 을 안 붙이는 것이 표준이지만(RFC 8259),
#   **PowerShell 5.1 의 Invoke-RestMethod 는 charset 이 없으면 latin-1 로 디코딩**해
#   한글 응답이 `ì¤í¬ê²ì¦` 처럼 깨진다. 브라우저는 멀쩡하므로 눈치채기 어렵다.
#   스킬·CLI 가 PowerShell 로 붙으므로 여기서 명시해준다.
class UTF8JSONResponse(JSONResponse):
    media_type = "application/json; charset=utf-8"


app = FastAPI(title="webterm", lifespan=lifespan, default_response_class=UTF8JSONResponse)


# pythonw 로 띄우면 콘솔이 없어 예외가 어디에도 안 남는다.
# (BaseHTTPMiddleware 는 starlette 1.0 에서 진짜 예외를 EndOfStream 으로 덮으므로 쓰지 않는다)
@app.exception_handler(Exception)
async def log_exceptions(request, exc):
    log.exception("unhandled %s %s", request.method, request.url.path)
    return UTF8JSONResponse({"ok": False, "error": repr(exc)}, status_code=500)


@app.exception_handler(dc.DaemonDown)
async def daemon_down(request, exc):
    log.error("데몬 연결 실패: %s", exc)
    return UTF8JSONResponse({"ok": False, "error": str(exc)}, status_code=503)


# ── 브라우저발 공격 차단 ──────────────────────────────────────────────────────
# ⚠ 이것은 "인증"이 아니다. 누가 접근할 수 있느냐는 네트워크(사설망/Tailscale)가 정한다.
#   여기서 막는 것은 그 방식으로는 못 막는 경로 하나 — **사용자 자신의 브라우저**가
#   loopback 으로 때리는 공격이다. 공격자가 tailnet 안에 있을 필요가 없어서 VPN 이 무력하다.
#
#   실측(2026-09-10, 격리 인스턴스):
#     · Host: attacker-rebind.example 로 GET /api/sessions → 200, 세션 목록과 sid 반환
#     · Origin: https://evil.example 로 ws://…/ws/<sid>    → 수락, 읽기·쓰기 모두 가능
#     · Origin: https://evil.example 로 multipart POST /api/upload → 200, 파일 심어짐
#   (반면 /api/send 에 text/plain 로 넣는 고전 CSRF 는 FastAPI 가 content-type 을 봐서 422)
#
# ⚠ BaseHTTPMiddleware 를 쓰지 않는다 — starlette 1.0 에서 진짜 예외를 EndOfStream 으로
#   덮는다(DEVLOG 함정 #4). 순수 ASGI 는 그 경로를 안 타고, http 와 websocket 을 한자리에서 본다.
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

            # ① DNS 리바인딩 — 위조된 Host 로 오면 동일 출처 취급이 성립해 CORS 가 무력해진다
            if not config.host_allowed(host):
                log.warning("차단(Host) %r → %s", host, scope.get("path"))
                return await self._deny(kind, send, f"host not allowed: {host}")

            # ② 교차출처 WebSocket — WebSocket 에는 CORS 가 적용되지 않으므로 직접 봐야 한다
            if kind == "websocket" and not config.origin_allowed(origin):
                log.warning("차단(WS Origin) %r", origin)
                return await self._deny(kind, send, "origin not allowed")

            # ③ 교차출처 쓰기 — multipart 는 preflight 없이 날아온다(/api/upload 가 뚫렸다)
            if kind == "http" and scope.get("method") in _UNSAFE_METHODS                     and not config.origin_allowed(origin):
                log.warning("차단(Origin) %s %s from %r", scope.get("method"),
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


# uvicorn 자체 로거도 파일로 끌어온다
for _n in ("uvicorn", "uvicorn.error", "uvicorn.access"):
    _lg = logging.getLogger(_n)
    _lg.handlers = _handlers
    _lg.setLevel(logging.INFO)


async def _ask(msg):
    """데몬에 제어 요청. 실패는 그대로 올려 예외 핸들러가 503 으로 만든다."""
    res = await dc.request(msg)
    if not res.get("ok"):
        raise RuntimeError(res.get("error", "daemon error"))
    return res.get("result", {})


# ⭐ 엔터는 **본문과 같은 chunk 에 실으면 안 된다.**
#   데몬의 write op 은 submit 이면 `text + "\r"` 을 한 번에 PTY 에 쓰는데, 실측(2026-08-26)해 보면
#   6/6 전부 `"HELLO1\r"` 처럼 **한 덩어리로 도착**한다. 셸(PSReadLine)은 이래도 실행하지만
#   claude 같은 TUI 는 뭉쳐 들어온 입력을 **붙여넣기로 판정**해서 끝의 `\r` 을 '제출'이 아니라
#   '줄바꿈'으로 먹는다 → 글은 들어갔는데 엔터만 안 눌린 것처럼 보인다(체감 확률 50%,
#   판정이 길이·타이밍에 걸려 있어 될 때도 있는 것이 더 헷갈린다).
#   → 본문을 먼저 넣고, **사람이 치는 정도의 간격을 둔 뒤 `\r` 만 따로** 보낸다.
SUBMIT_GAP = 0.15   # 초. paste 판정 윈도우를 넘기기 위한 최소 간격


def _as_text(v):
    """PTY 에 쓸 값을 문자열로 정규화한다 — **비-str 이 데몬까지 새어나가지 않게 하는 관문**이다.

    ⭐ PowerShell 5.1 의 `ConvertTo-Json` 함정 때문에 필요하다(2026-09-01 실측).
      값이 순수 `[string]` 이 아니라 **ETS NoteProperty 가 붙은 `PSObject`** 면
      `ConvertTo-Json` 이 그것을 객체로 펼쳐서 `{"value":"본문","Count":1}` 로 보낸다.
      ⚠ **길이 문제가 아니다** — 2만자 순수 문자열도 정상 직렬화된다. 값이 어디서 감싸졌는지는
      보내는 쪽도 모르므로(파이프라인 어디서든 붙는다) **받는 쪽에서 벗기는 것이 맞다.**
      막지 않으면 dict 가 그대로 `session.write` 까지 흘러가
      `TypeError: argument 'to_write': 'dict' object is not an instance of 'str'` 로 끝난다.
    """
    if isinstance(v, str):
        return v
    if isinstance(v, dict) and isinstance(v.get("value"), str):
        log.warning("text 가 PSObject 로 감싸져 도착 — value 를 꺼내 복구한다 (keys=%s)",
                    sorted(v.keys()))
        return v["value"]
    if isinstance(v, list) and all(isinstance(x, str) for x in v):
        # PowerShell 배열(`Get-Content` 등 `-Raw` 없이 읽은 값)이 join 없이 온 경우
        log.warning("text 가 배열로 도착 — 줄바꿈으로 이어붙인다 (%d줄)", len(v))
        return "\n".join(v)
    if isinstance(v, (int, float, bool)):
        return str(v)
    # RuntimeError(=데몬 장애, 404) 와 섞이지 않게 ValueError 로 던진다 → 라우트가 400 으로 구분
    raise ValueError(f"text 는 문자열이어야 합니다 — 받은 타입: {type(v).__name__}")


async def _write(sid, text, submit):
    """PTY 쓰기. submit 이면 본문과 엔터를 **다른 chunk 로** 나눠 보낸다."""
    text = _as_text(text)
    if text:
        await _ask({"op": "write", "sid": sid, "text": text, "submit": False})
    if submit:
        if text:
            await asyncio.sleep(SUBMIT_GAP)
        await _ask({"op": "write", "sid": sid, "text": "\r", "submit": False})


@app.get("/")
async def index():
    """⚠ **index.html 만은 절대 캐시하지 않는다.**

    정적 파일의 새 버전은 이 파일 안의 `?v=N` 캐시버스터로 알린다 —
    그런데 **그 알림을 담은 파일이 캐시되면** 폰은 새 코드가 나와도 영영 옛 버전을 문다.
    실제로 겪었다(2026-08-24): 서버는 v=47 을 서빙하는데 폰 로그에는 계속 `app.js?v=44` 가 찍혔고,
    고친 것이 하나도 반영되지 않아 "안 되는데?"가 반복됐다. sw.js 가 아무것도 캐시하지 않는데도
    브라우저 HTTP 캐시만으로 이 일이 벌어진다.
    → 이 한 파일은 매번 새로 받게 하고, 무거운 정적 파일은 `?v=N` 으로 계속 캐시시킨다.
    """
    return FileResponse(os.path.join(STATIC, "index.html"),
                        headers={"Cache-Control": "no-store, no-cache, must-revalidate"})


# PWA 로 설치돼야 Window Controls Overlay(= WezTerm 의 INTEGRATED_BUTTONS)를 쓸 수 있다.
# 둘 다 **루트 경로로 서빙해야** 한다 — /static 아래 두면 서비스워커의 scope 가
# /static 으로 좁아져 앱 전체를 관장하지 못하고, 설치 요건도 충족되지 않는다.
@app.get("/manifest.webmanifest")
async def manifest():
    return FileResponse(os.path.join(STATIC, "manifest.webmanifest"),
                        media_type="application/manifest+json")


@app.get("/sw.js")
async def service_worker():
    return FileResponse(os.path.join(STATIC, "sw.js"), media_type="application/javascript")


@app.get("/api/clipboard")
async def api_clipboard():
    r"""⭐ PC 클립보드를 읽어 **붙여넣을 문자열**로 돌려준다(이미지면 PNG 로 저장한 뒤 그 경로).

    동봉된 `scripts/clipboard_paste.ps1` 을 부른다 — 이미지면 `%TEMP%\wezterm_clip\clip_*.png` 로
    저장하고 그 경로를, 파일 드롭이면 경로들을, 텍스트면 텍스트를 돌려준다.

    ⚠ 왜 브라우저가 아니라 서버가 읽는가:
      · 웹 페이지는 **이미지 바이트를 터미널로 흘려보낼 수 없다.**
      · claude 는 `Ctrl+V`(0x16)를 받으면 자기가 클립보드를 읽지만
        (`powershell -Sta ... Clipboard::ContainsImage()`), webterm PTY 안에서는 그 경로가 안 통했다.
      · WezTerm 이 이미 **경로를 붙여넣는 방식**으로 풀어둔 문제라, 같은 해법을 쓴다.
        claude 는 경로를 받으면 그 파일을 읽는다.

    ⚠ `-Sta` 는 필수다 — `System.Windows.Forms.Clipboard` 는 STA 스레드에서만 동작한다.
    """
    # 저장소에 동봉된 스크립트를 쓴다. (예전 설치본 호환을 위해 홈 경로도 한 번 본다)
    script = os.path.join(BASE, "scripts", "clipboard_paste.ps1")
    if not os.path.exists(script):
        script = os.path.join(os.path.expanduser("~"), ".claude", "scripts",
                              "clipboard_paste.ps1")
    if not os.path.exists(script):
        return UTF8JSONResponse({"ok": False, "error": "clipboard_paste.ps1 없음: " + script},
                                status_code=404)
    try:
        # ⚠ 블로킹 호출(≈300ms)이라 스레드로 뺀다 — 이벤트 루프를 잡으면 다른 pane 의 출력이 멎는다.
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
        log.info("clipboard 읽기 실패: %s", e)
        return UTF8JSONResponse({"ok": False, "error": str(e)}, status_code=500)


# ── 파일 업로드 (폰 → PC) ────────────────────────────────────
# 폰에서 고른 파일을 PC 임시폴더에 받아 **그 경로**를 돌려준다. 프론트가 그 경로를
# pane 에 bracketed paste 하면 claude 가 파일을 읽는다 — 클립보드 이미지(`/api/clipboard`)가
# 쓰는 것과 **같은 수법**이다(웹 페이지는 바이트를 터미널로 흘려보낼 수 없으므로 경로로 우회).
#
# ⚠ wezterm-web 의 `/api/upload` 는 base64 JSON + 이미지 확장자 화이트리스트였다.
#   여기서는 `python-multipart` 가 있으니 **multipart 스트리밍**으로 받는다 —
#   base64 는 33% 부풀고 메모리에 통째로 올라가서 폰 사진 몇 장이면 바로 아프다.
UPLOAD_DIR = os.path.join(os.environ.get("TEMP") or os.environ.get("TMP") or "/tmp",
                          "webterm_uploads")
UPLOAD_MAX = 200 * 1024 * 1024      # 파일 하나당 상한 200MB (폰 동영상까지는 받아주는 선)
UPLOAD_TTL = 86400                  # 1일 지난 것은 다음 업로드 때 지운다(디스크 무한 누적 방지)


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
    """파일명을 **경로가 되지 못하게** 깎는다.

    ⚠ 세 가지를 동시에 막는다:
      ① 경로 탈출 — `../../x`·`C:\\x` 는 basename 으로 잘라낸다.
      ② Windows 금지문자(`<>:"/\\|?*`)와 제어문자 → `_`
      ③ **공백** → `_` : 경로를 pane 에 그냥 paste 하므로 공백이 있으면 셸이 인자를 쪼갠다.
         따옴표로 감싸는 길도 있지만, 그러면 claude 의 경로 인식이 흔들려서 이 편이 안전하다.
    """
    name = os.path.basename((name or "").replace("\\", "/").split("/")[-1])
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f\s]', "_", name).strip("._") or "file"
    return name[:120]


@app.post("/api/upload")
async def api_upload(files: list[UploadFile] = File(...)):
    """폰에서 고른 파일들을 받아 저장하고 **PC 경로 목록**을 돌려준다."""
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    _upload_cleanup()
    saved, errors = [], []
    stamp = time.strftime("%Y%m%d_%H%M%S")
    for i, up in enumerate(files or []):
        name = _safe_name(up.filename)
        # 같은 이름을 두 번 올려도 덮어쓰지 않게 시각+순번을 앞에 붙인다
        path = os.path.join(UPLOAD_DIR, f"{stamp}_{i}_{name}")
        size = 0
        try:
            # ⚠ 디스크 쓰기는 블로킹이다 — 이벤트 루프에서 하면 **다른 pane 의 출력이 멎는다**
            #   (`/api/clipboard` 가 이미 같은 이유로 `to_thread` 를 쓴다).
            fh = await asyncio.to_thread(open, path, "wb")
            try:
                while True:
                    chunk = await up.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > UPLOAD_MAX:
                        raise ValueError(f"{UPLOAD_MAX // (1024 * 1024)}MB 초과")
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
            log.info("upload 실패 %s: %s", name, e)
            errors.append({"name": name, "error": str(e)})
    if not saved:
        return UTF8JSONResponse({"ok": False, "error": "저장된 파일 없음", "errors": errors},
                                status_code=400)
    return {"ok": True, "files": saved, "errors": errors}


@app.post("/api/diag")
async def api_diag(payload: dict = Body(default=None)):
    """브라우저가 접속 시 렌더 환경을 한 줄 남긴다(dpr·실제 폰트·셀 크기).

    "글자가 흐리다" 는 제보는 데이터가 아니라 렌더 문제라 로그·capture 에 흔적이 안 남는다.
    추측으로 고치면 멀쩡한 걸 망가뜨리므로(이미 한 번 겪었다) 값을 먼저 본다.
    """
    log.info("DIAG %s", json.dumps(payload or {}, ensure_ascii=False))
    return {"ok": True}


@app.get("/api/config")
async def api_config():
    """프론트가 쓰는 설정만 내준다(허용목록 같은 서버 내부 값은 빼고).

    설정 편집은 파일로만 한다 — 쓰기 API 를 두면 브라우저에서 서버 파일을 고칠 수 있게 되고,
    그건 이 프로그램이 굳이 열어줄 이유가 없는 구멍이다.
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
        # 요청값 → config.json → (데몬에서) WEBTERM_* 환경변수 → 홈
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
    """pane 개별 이름. rename(탭 이름)과 달리 그룹(탭)에 영향을 주지 않는다."""
    try:
        r = await _ask({"op": "label", "sid": sid, "label": payload.get("label", "")})
    except RuntimeError as e:
        # 이름 충돌은 서버 장애가 아니라 사용자 입력 문제다 → 409 로 구분해 돌려준다
        return UTF8JSONResponse({"ok": False, "error": str(e)}, status_code=409)
    return {"ok": r.get("labeled", False)}


@app.post("/api/sessions/{sid}/send")
async def api_send(sid: str, payload: dict = Body(...)):
    """외부 연동용 — wezterm cli send-text 자리. 프로세스 spawn 없이 PTY 에 바로 쓴다."""
    try:
        await _write(sid, payload.get("text", ""), bool(payload.get("submit")))
    except ValueError as e:
        return UTF8JSONResponse({"ok": False, "error": str(e)}, status_code=400)
    except RuntimeError as e:
        return UTF8JSONResponse({"ok": False, "error": str(e)}, status_code=404)
    return {"ok": True}


# ── 이름으로 pane 지목 (resolve) ──────────────────────────────────────────
# 외부(스킬·텔레그램·앞으로 만들 wezterm cli shim)가 sid 를 몰라도 pane 을 지목하게 한다.
#
# ⭐ 규칙이 **여기 한 곳에만** 있어야 한다. 예전 사고의 원인이 "부르는 쪽마다 자기 매칭 규칙을
#    갖고 있던 것"이었다 — tg_daemon 의 `resolve_session` 이 prefix 부분매칭으로
#    `oracleVpsForRustDesk` 와 `oracleVpsForRustDesk_1` 중 **첫 후보를 말없이 골라** 엉뚱한
#    세션에 메시지를 넣었다(wiki `pane-name-identity-auto-manual`).
#
# 그래서 두 가지를 지킨다:
#   ① **부분 매칭을 하지 않는다** — 정확 일치만. 사람이 안 쓰는 sid 만 접두 매칭을 허용한다.
#   ② **모호하면 고르지 않는다** — 후보를 그대로 돌려주고 되묻게 한다(409).
#
# 지목 문법:
#   "탭:패널"   탭 이름 + pane 이름(label) 또는 pane 번호(1-based, 화면 순서와 같다)
#   "탭"        그 탭의 pane 이 하나뿐일 때만
#   "패널"      label 이 전체에서 유일할 때만  (탭이 다르면 같은 label 이 있을 수 있다)
#   "3-2"       ⭐ **위치 지목** — 3번째 탭의 2번째 pane (사람이 화면을 보고 말하는 방식)
#   "3"         3번째 탭 (그 탭의 pane 이 하나뿐일 때만)
#   "<sid>"     sid 또는 그 접두
#
# ⭐ 위치 지목을 넣은 이유: 사용자는 이름을 외우지 않고 **보이는 순서**로 부른다("3-2 에 보내줘").
#    예전에는 그 형식이 없어서 부르는 쪽이 "3-1 추정" 같은 짐작을 했다 — 규칙이 없으면
#    호출자가 자기 규칙을 만들고, 그게 곧 엉뚱한 세션에 명령이 들어가는 사고가 된다.
# ⚠ 순서가 중요하다: **이름 일치가 항상 먼저**다(탭 label 이 "3" 이거나 탭 이름이 "3-2" 일 수 있다).
#    또 sid 접두 매칭보다도 앞에 둔다 — 한 자리 숫자는 16진수 sid 접두에 걸리기 쉽다.
def _match(sessions, target):
    """반환: (session, None) | (None, 후보목록)"""
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
        # "탭" 이 비어 있으면(":이름") 전체에서 label 을 찾는다
        group = [s for s in alive if s["name"] == tab] if tab else alive
        if not group:
            return None, []
        if pane.isdigit():          # 번호는 그 탭 안에서의 순서 — 목록 순서가 곧 화면 번호다
            i = int(pane) - 1
            return (group[i], None) if 0 <= i < len(group) else (None, [])
        return pick([s for s in group if s.get("label", "") == pane])

    # 접두사 없는 한 덩어리 — 탭 → label → 위치 → sid 순으로 시도한다
    by_tab = [s for s in alive if s["name"] == t]
    if by_tab:
        return pick(by_tab)
    by_label = [s for s in alive if s.get("label", "") == t]
    if by_label:
        return pick(by_label)

    # ⭐ 위치 지목 "3-2"(3번 탭 2번째 pane) / "3"(3번 탭)
    #   탭 순서는 **세션 목록에 처음 등장한 순서** — 브라우저 탭바가 그리는 순서와 같은 규칙이다
    #   (app.js: `[...new Set(sessions.map(s => s.name))]`). 두 곳이 어긋나면 사용자가 보는
    #   번호와 우리가 세는 번호가 달라지므로, 규칙을 그대로 베낀다.
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
            return pick(group)               # "3" — pane 이 여럿이면 후보를 돌려준다(409)
        pi = int(m.group(2)) - 1
        return (group[pi], None) if 0 <= pi < len(group) else (None, [])

    by_sid = [s for s in alive if s["sid"] == t or s["sid"].startswith(t)]
    if by_sid:
        return pick(by_sid)
    return None, []


async def _resolve(target):
    """target → 세션. 못 찾으면 404, 모호하면 409 를 담은 JSONResponse 를 함께 돌려준다."""
    r = await _ask({"op": "list"})
    s, cands = _match(r.get("sessions", []), target)
    if s:
        return s, None
    if cands:
        return None, UTF8JSONResponse(
            {"ok": False, "error": f"'{target}' 이(가) 여러 pane 에 해당합니다 — 탭:패널 로 지목하세요",
             "candidates": cands}, status_code=409)
    return None, UTF8JSONResponse(
        {"ok": False, "error": f"'{target}' 에 해당하는 pane 이 없습니다"}, status_code=404)


# ── 탭 / 패널 단위 API ────────────────────────────────────────────────────
# 브라우저는 sid 로 조작하지만(위쪽 라우트), 외부(스킬·CLI)는 sid 를 모른다.
# "탭"은 서버에 실체가 없고 **같은 name 을 가진 세션들의 묶음**이라, 그 묶음 연산을
# 여기 한 곳에 둔다 — 부르는 쪽마다 for 문을 돌리면 규칙이 흩어진다.
# 탭 이름 규칙 — 생성과 변경이 **같은 규칙**을 써야 한다(한쪽만 막으면 다른 쪽으로 들어온다).
#   ':'  → 지목 문법(`탭:패널`)과 충돌
#   '/' '\' → URL 경로에 탭 이름이 들어가므로 경로 구분자로 오해된다
_BAD_TAB_CHARS = re.compile(r"[:/\\]")


def _bad_tab_name(name):
    """문제가 있으면 사유 문자열, 없으면 None."""
    if not name:
        return "탭 이름이 필요합니다"
    if _BAD_TAB_CHARS.search(name):
        return "탭 이름에 : / \\ 는 쓸 수 없습니다"
    return None


async def _sessions():
    return (await _ask({"op": "list"})).get("sessions", [])


def _tab_panes(sessions, name):
    return [s for s in sessions if s["name"] == name and s.get("alive")]


def _tab_view(sessions, name, i=None):
    ps = _tab_panes(sessions, name)
    return {
        # ⭐ `i` = 탭 번호(1-based). 이걸 안 보여주면 부르는 쪽이 "3-2" 로 지목할 근거가 없다
        #   (번호는 보이는데 목록에는 없으니 짐작하게 된다).
        "i": i,
        "tab": name,
        "panes": [{"n": i + 1, "sid": s["sid"], "label": s.get("label", ""),
                   "cwd": s.get("cwd"), "title": s.get("title", "")}
                  for i, s in enumerate(ps)],
    }


@app.get("/api/tabs")
async def api_tabs():
    """탭 단위로 본 목록. pane 번호(n)는 화면에 보이는 번호와 같다."""
    ss = await _sessions()
    names = []
    for s in ss:
        if s.get("alive") and s["name"] not in names:
            names.append(s["name"])
    return {"ok": True, "tabs": [_tab_view(ss, n, i + 1) for i, n in enumerate(names)]}


@app.post("/api/tabs")
async def api_tab_create(payload: dict = Body(...)):
    """탭을 만든다(= 그 이름의 첫 pane 을 띄운다).

    ⚠ 같은 이름이 이미 있으면 **거부**한다. 이름이 곧 그룹 키라서, 말없이 만들면
      새 탭이 아니라 기존 탭의 pane 이 하나 늘어난 것이 된다 — 부른 쪽 의도와 다르다.
      기존 탭에 pane 을 더하려면 POST /api/panes 를 쓴다.
    """
    name = (payload.get("name") or "").strip()
    bad = _bad_tab_name(name)
    if bad:
        return UTF8JSONResponse({"ok": False, "error": bad}, status_code=400)
    ss = await _sessions()
    if _tab_panes(ss, name):
        return UTF8JSONResponse({"ok": False, "error": f"'{name}' 탭이 이미 있습니다"}, status_code=409)
    r = await _ask({"op": "create", "name": name, "cwd": payload.get("cwd"),
                    "cols": int(payload.get("cols") or 120), "rows": int(payload.get("rows") or 30)})
    s = r.get("session", {})
    if payload.get("label"):
        await _ask({"op": "label", "sid": s["sid"], "label": payload["label"]})
    return {"ok": True, "tab": name, "sid": s.get("sid"), "cwd": s.get("cwd")}


@app.post("/api/tabs/{name}/rename")
async def api_tab_rename(name: str, payload: dict = Body(...)):
    """탭 이름 변경 — 그 탭의 **모든 pane** 에 한 번에 적용한다."""
    new = (payload.get("name") or "").strip()
    bad = _bad_tab_name(new)
    if bad:
        return UTF8JSONResponse({"ok": False, "error": bad}, status_code=400)
    ss = await _sessions()
    ps = _tab_panes(ss, name)
    if not ps:
        return UTF8JSONResponse({"ok": False, "error": f"'{name}' 탭이 없습니다"}, status_code=404)
    if new != name and _tab_panes(ss, new):
        # 같은 이름이 되면 두 탭이 합쳐지고 (탭,label) 복합키가 깨질 수 있다 → 미리 막는다
        return UTF8JSONResponse({"ok": False, "error": f"'{new}' 탭이 이미 있습니다 — 합치기는 지원하지 않습니다"},
                            status_code=409)
    for s in ps:
        await _ask({"op": "rename", "sid": s["sid"], "name": new})
    return {"ok": True, "tab": new, "panes": len(ps)}


@app.delete("/api/tabs/{name}")
async def api_tab_close(name: str):
    """탭을 닫는다 = 그 탭의 pane 을 전부 종료한다."""
    ps = _tab_panes(await _sessions(), name)
    if not ps:
        return UTF8JSONResponse({"ok": False, "error": f"'{name}' 탭이 없습니다"}, status_code=404)
    for s in ps:
        await _ask({"op": "kill", "sid": s["sid"]})
    return {"ok": True, "tab": name, "killed": len(ps)}


@app.post("/api/panes")
async def api_pane_create(payload: dict = Body(...)):
    """기존 탭에 pane 을 하나 더 만든다(= 분할).

    cwd 를 안 주면 **그 탭의 첫 pane 이 있던 폴더를 물려받는다** — 분할의 자연스러운 기대값이다.
    """
    tab = (payload.get("tab") or "").strip()
    if not tab:
        return UTF8JSONResponse({"ok": False, "error": "tab 이 필요합니다"}, status_code=400)
    ss = await _sessions()
    ps = _tab_panes(ss, tab)
    if not ps:
        return UTF8JSONResponse({"ok": False, "error": f"'{tab}' 탭이 없습니다 — 먼저 만드세요"},
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
            # pane 은 이미 생겼다 — 이름만 못 붙였다는 것을 숨기지 않는다
            return {"ok": True, "tab": tab, "sid": s.get("sid"), "n": len(ps) + 1,
                    "cwd": cwd, "label": "", "warning": str(e)}
    return {"ok": True, "tab": tab, "sid": s.get("sid"), "n": len(ps) + 1,
            "cwd": cwd, "label": payload.get("label", "")}


@app.post("/api/panes/label")
async def api_pane_label(payload: dict = Body(...)):
    """이름으로 지목해 pane 이름을 붙인다. 빈 값이면 자동으로 되돌린다."""
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
    """이름으로 지목해 pane 하나를 닫는다. 그 탭의 마지막 pane 이면 탭도 사라진다."""
    s, err = await _resolve(target)
    if err:
        return err
    left = len(_tab_panes(await _sessions(), s["name"])) - 1
    await _ask({"op": "kill", "sid": s["sid"]})
    return {"ok": True, "sid": s["sid"], "tab": s["name"], "label": s.get("label", ""),
            "tab_closed": left <= 0, "panes_left": max(0, left)}


async def _pos_of(sid):
    """지금 이 pane 의 화면 위치 "3-2" 를 계산한다. 못 찾으면 None.

    ⭐ 위치는 **물어볼 때 계산**한다 — 환경변수나 DB 에 박아두면 pane 이 열리고 닫힐 때
      밀려서 곧 거짓이 된다(그래서 `WEBTERM_SID` 만 박고 위치는 여기서 답한다).
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
    """보내기 전에 어디로 가는지 확인만 한다(모호하면 후보를 돌려준다).

    자기 자신을 확인하는 용도(whoami)로도 쓴다 — pane 안에서
    `GET /api/resolve?target=$env:WEBTERM_SID` 를 부르면 지금 내 탭·label·위치가 돌아온다.
    """
    s, err = await _resolve(target)
    if err:
        return err
    return {"ok": True, "sid": s["sid"], "tab": s["name"], "pos": await _pos_of(s["sid"]),
            "label": s.get("label", ""), "cwd": s.get("cwd"), "title": s.get("title", "")}


@app.post("/api/send")
async def api_send_by_name(payload: dict = Body(...)):
    """이름으로 지목해 텍스트를 넣는다 — 스킬·외부 연동의 정문."""
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


# backlog 는 PTY 가 뱉은 **날것의 스트림**이라 ANSI 제어문자가 섞여 있다.
# 사람이나 스킬이 읽으려면 벗겨야 한다(wezterm cli get-text 는 그리드를 읽으므로 이미 텍스트였다).
# ⚠ 한계: 우리는 그리드가 아니라 스트림을 갖고 있어서, 커서를 옮겨 화면을 다시 그리는 TUI(claude 등)는
#   "지금 화면"이 아니라 "그동안 출력된 것"이 나온다. 셸 출력은 정확하고 TUI 는 근사치다.
_ANSI = re.compile(
    r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"      # OSC ... BEL/ST (창 제목 등)
    r"|\x1b\[[0-?]*[ -/]*[@-~]"               # CSI (색·커서 이동)
    r"|\x1b[@-Z\\-_]"                         # 단발 ESC
    r"|[\x00-\x08\x0b\x0c\x0e-\x1f]"          # 남은 제어문자 (탭·개행은 남긴다)
)


def strip_ansi(text):
    return _ANSI.sub("", text).replace("\r\n", "\n").replace("\r", "\n")


@app.get("/api/capture")
async def api_capture_by_name(target: str, lines: int = 0, raw: int = 0):
    """이름으로 지목해 화면을 읽는다 — wezterm cli get-text 자리.

    기본은 ANSI 를 벗긴 평문이고, `raw=1` 이면 원본 스트림을 그대로 준다.
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
    """외부 연동용 — wezterm cli get-text 자리."""
    try:
        r = await _ask({"op": "backlog", "sid": sid})
    except RuntimeError as e:
        return UTF8JSONResponse({"ok": False, "error": str(e)}, status_code=404)
    return {"ok": True, "text": r.get("text", "")}


# ── 다중 클라이언트 화면 크기 조정 ────────────────────────────────────────
# PTY 크기는 하나뿐인데 붙는 기기는 여러 개다(PC 1600px + 폰 412px).
# 그냥 두면 **마지막에 요청한 쪽으로 계속 뺏겨** PC 화면이 폰 폭으로 쪼그라들고,
# 서로 리사이즈를 주고받으며 TUI 가 깨진다(실제로 claude 화면이 안 그려지는 사고가 났다).
#
# 정책: **크기를 보고하는 쪽이 주인**이고, 나머지는 그 크기를 받아 그린다.
#   PC 는 창을 늘리면 터미널도 늘어나야 하므로(WezTerm 과 같게) 보고한 크기를 그대로 적용한다.
#   폰은 기본적으로 보고하지 않아 PC 화면을 뺏지 않고, `⤢` 로 주인을 가져올 수 있다.
#   ⚠ 어느 경우든 **모든 클라의 xterm 은 PTY 크기를 따라가야 한다** — 다르면 글자가 겹쳐 그려진다.
_client_sizes = {}          # {sid: {client_id: (cols, rows)}}
_applied_size = {}          # {sid: (cols, rows)} — 마지막으로 데몬에 보낸 값
_last_report = {}           # {sid: (cols, rows)} — 가장 최근에 보고된 크기(= 현재 주인)


def _best_size(sid):
    """**마지막으로 보고한 클라의 크기**를 그대로 쓴다.

    핵심: PC 는 WezTerm 처럼 **창을 늘리면 터미널도 늘어나야** 한다.
    최소/최대로 조정하면 PC 가 폰 크기에 갇혀 "창을 키워도 안 커지는" 물건이 된다.

    충돌은 정책이 아니라 **역할 분리**로 푼다 —
      · 크기를 보고하는 쪽(주인, 기본은 PC): 자기 창 크기를 그대로 요구
      · 보고하지 않는 쪽(폰): PTY 크기를 받아서 그린다(가로 스크롤)
      · `⤢`(force)로 주인을 바꿀 수 있다
    """
    last = _last_report.get(sid)
    if last:
        return last
    sizes = _client_sizes.get(sid) or {}
    return next(iter(sizes.values()), None)


_forced_size = {}           # {sid: (cols, rows)} — 특정 클라가 "내 화면에 맞춰" 라고 요구한 경우
_forced_by = {}             # {sid: cid} — 그 강제를 건 **브라우저**(소켓이 아니다)
_force_gone = {}            # {sid: monotonic} — 주인이 안 보이기 시작한 시각
FORCE_GRACE = 90            # 초. 이만큼 안 돌아오면 강제를 버린다


def _live_force(sid):
    """⭐ 강제 크기는 **건 브라우저가 살아 있는 동안만** 유효하다.

    ⚠ 사고 기록 ①(2026-08-23): 해제가 `⤢` 를 **다시 누를 때만** 왔다. 폰에서 켠 채 브라우저를
    닫으면 해제 신호가 영영 안 와서 `_forced_size` 가 남고, **PC 로 돌아와도 폰 크기(51x30)에
    갇혔다.** 게다가 `_applied_size` 와 같아 resize 호출조차 없어 로그에 흔적도 안 남았다.

    ⚠ 사고 기록 ②(2026-08-24): 그래서 "소켓이 끊기면 즉시 해제"로 고쳤더니 이번엔 반대로 샜다 —
    **폰은 화면을 끄거나 앱을 전환하기만 해도 WS 가 끊겼다 붙는다.** 그때마다 주인 자격이
    날아가 PTY 가 PC 크기로 튀었고, 폰은 그 큰 크기를 그대로 그려 **statusline 이 잘렸다.**
    → 판정 기준을 **소켓(`id(ws)`) 이 아니라 브라우저(`cid`)** 로 올리고, 그마저도
      `FORCE_GRACE` 만큼 유예한다. 잠깐의 끊김은 견디고 진짜 떠난 경우만 해제한다.
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
        return _forced_size.get(sid)          # 방금 끊긴 것 — 아직 주인으로 대우한다
    if time.monotonic() - gone_at < FORCE_GRACE:
        return _forced_size.get(sid)
    _forced_size.pop(sid, None)
    _forced_by.pop(sid, None)
    _force_gone.pop(sid, None)
    log.info("force 자동해제 sid=%s (주인이 %d초 넘게 안 돌아옴)", sid, FORCE_GRACE)
    return None


async def _sync_size(sid, att, force=None, owner=None):
    """PTY 크기를 정한다.

    기본은 **마지막으로 보고한 클라의 크기**(보통 PC 창 크기).
    `⤢` 로 force 를 걸면 그 크기가 고정되어 다른 클라의 보고를 무시한다.
    단 그 고정은 **건 클라가 살아 있는 동안만**이다(`_live_force`).
    """
    if force:
        _forced_size[sid] = force
        _forced_by[sid] = owner
        _force_gone.pop(sid, None)
    target = _live_force(sid) or _best_size(sid)
    if target and _applied_size.get(sid) != target:
        _applied_size[sid] = target
        await att.resize(target[0], target[1])
        # ⚠ **누가 이 크기를 요구했는지** 함께 남긴다. 여러 클라가 붙으면 "마지막 보고자가 주인"
        #   규칙 때문에 서로 크기를 뺏는데, 범인을 모르면 추측만 쌓인다(2026-08-24).
        who = ", ".join(sorted({c for c, _ in (_client_sizes.get(sid) or {})}))
        log.info("resize sid=%s → %dx%d (%s) 요구=%s 붙은클라=[%s]",
                 sid, target[0], target[1],
                 "강제" if _forced_size.get(sid) else "보고자 기준",
                 owner or "-", who)


@app.websocket("/ws/{sid}")
async def ws_term(ws: WebSocket, sid: str):
    await ws.accept()
    att = dc.Attach(sid)
    # 소켓이 아니라 **브라우저**를 신원으로 쓴다(`_live_force` 참조). 소켓 id 는 같은 브라우저가
    # 재연결하며 잠시 두 개 겹칠 수 있어 정리용으로만 함께 묶는다.
    cid = ws.query_params.get("cid") or f"anon-{id(ws)}"
    client_id = (cid, id(ws))
    try:
        await att.open()
    except Exception as e:
        log.info("attach 실패 sid=%s: %s", sid, e)
        await ws.close(code=4004, reason="no such session")
        return

    log.info("ws attach sid=%s", sid)

    async def pump_out():
        """데몬 → 브라우저"""
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
                _last_report[sid] = size          # 가장 최근 보고자가 크기의 주인
                # force=true 면 "내 화면에 맞춰" — 다른 클라가 보고해도 이 크기를 유지한다
                await _sync_size(sid, att,
                                 force=size if msg.get("force") else None,
                                 owner=cid)
            elif t == "unforce":
                _forced_size.pop(sid, None)
                _forced_by.pop(sid, None)
                _force_gone.pop(sid, None)
                await _sync_size(sid, att)
            elif t == "ping":
                await ws.send_text("")   # 지연 측정용 에코(빈 문자열은 화면에 안 그려진다)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.info("ws error sid=%s: %s", sid, e)
    finally:
        out_task.cancel()
        # 이 클라가 빠졌으니 크기를 재계산한다(폰이 나가면 PC 크기로 되돌아온다).
        # 남은 클라가 있을 때만 반영 — 아무도 없으면 PTY 크기를 건드리지 않는다.
        (_client_sizes.get(sid) or {}).pop(client_id, None)
        if _client_sizes.get(sid):
            try:
                await _sync_size(sid, att)
            except Exception:
                pass
        else:
            _client_sizes.pop(sid, None)
            _last_report.pop(sid, None)
            # 아무도 안 남았으면 강제도 함께 버린다 — 다음에 붙는 클라가 자기 크기를 가져간다
            _forced_size.pop(sid, None)
            _forced_by.pop(sid, None)
            _force_gone.pop(sid, None)
        att.close()
        log.info("ws detach sid=%s (세션은 데몬에 그대로 살아있음)", sid)


app.mount("/static", StaticFiles(directory=STATIC), name="static")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("WEBTERM_PORT", "8767"))
    host = os.environ.get("WEBTERM_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port, log_level="warning",
                ws_ping_interval=20, ws_ping_timeout=30)
