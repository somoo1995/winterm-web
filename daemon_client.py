"""
웹서버 → 세션 데몬 클라이언트.

설계 원칙: 웹서버는 **순수 중계기**다. 세션 상태를 하나도 갖지 않는다.
    - 제어 요청은 연결 1회용(로컬 TCP 라 저렴하고, 웹서버가 끊겨도 남는 상태가 없다)
    - 브라우저 WS 하나당 데몬 attach 연결 하나 → 팬아웃은 데몬이 이미 하므로 라우팅 로직이 필요 없다
"""
import asyncio
import json
import logging
import os
import subprocess
import sys

log = logging.getLogger("webterm.daemon_client")

BASE = os.path.dirname(os.path.abspath(__file__))
HOST = "127.0.0.1"
PORT = int(os.environ.get("WEBTERM_DAEMON_PORT", "8771"))

# ⚠ 데몬은 **콘솔이 있어야 한다**.
#   pythonw.exe(콘솔 없음)나 DETACHED_PROCESS(콘솔 분리)로 띄우면 ConPTY 생성이
#   `PanicException: HRESULT(0x00000000)` 로 죽는다(실측). CreatePseudoConsole 이
#   콘솔 인프라를 필요로 하기 때문.
#   CREATE_NO_WINDOW = 콘솔은 할당하되 **창은 띄우지 않는다** → 콘솔 flash 없이 ConPTY 가능.
CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_PROCESS_GROUP = 0x00000200


class DaemonDown(Exception):
    pass


def _python():
    """콘솔 있는 python.exe 를 찾는다(pythonw 는 ConPTY 가 안 된다).
    PATH 의 WindowsApps 스텁도 피한다."""
    exe = sys.executable or "python.exe"
    if exe.lower().endswith("pythonw.exe"):
        cand = os.path.join(os.path.dirname(exe), "python.exe")
        if os.path.exists(cand):
            return cand
    return exe


def spawn_daemon():
    cmd = [_python(), os.path.join(BASE, "daemon.py")]
    log.info("데몬 기동: %s", cmd)
    subprocess.Popen(
        cmd, cwd=BASE, close_fds=True,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP,
    )


# ⚠ asyncio 스트림의 기본 readline 버퍼는 **64KB** 다.
#   backlog(재접속 화면 복원용 링버퍼)는 256KB 까지 자라고 JSON 이스케이프로 더 커지므로,
#   기본값이면 `ValueError: Separator is not found, and chunk exceed the limit` 로
#   **화면 복원이 통째로 실패한다.**
#   실제 증상: 출력이 많은 claude 탭만 화면이 안 그려지고, 조용한 셸 탭은 멀쩡했다.
STREAM_LIMIT = 16 * 1024 * 1024


async def connect(timeout=2.0):
    return await asyncio.wait_for(
        asyncio.open_connection(HOST, PORT, limit=STREAM_LIMIT), timeout)


async def ensure_daemon(tries=12, delay=0.4):
    """데몬이 없으면 띄우고, 뜰 때까지 기다린다."""
    try:
        r, w = await connect(0.6)
        w.close()
        return True
    except Exception:
        pass
    spawn_daemon()
    for _ in range(tries):
        await asyncio.sleep(delay)
        try:
            r, w = await connect(0.6)
            w.close()
            log.info("데몬 연결 확인")
            return True
        except Exception:
            continue
    return False


async def request(msg, timeout=10.0):
    """제어 요청 1건. 데몬이 없으면 한 번 띄워보고 재시도한다."""
    for attempt in (1, 2):
        try:
            r, w = await connect()
        except Exception:
            if attempt == 1 and await ensure_daemon():
                continue
            raise DaemonDown("세션 데몬에 연결할 수 없습니다")
        try:
            w.write((json.dumps(msg, ensure_ascii=False) + "\n").encode("utf-8"))
            await w.drain()
            line = await asyncio.wait_for(r.readline(), timeout)
            if not line:
                raise DaemonDown("데몬이 응답 없이 연결을 닫았습니다")
            return json.loads(line)
        finally:
            try:
                w.close()
            except Exception:
                pass
    raise DaemonDown("세션 데몬에 연결할 수 없습니다")


class Attach:
    """브라우저 WS 하나에 대응하는 데몬 스트림 연결."""

    def __init__(self, sid):
        self.sid = sid
        self.r = None
        self.w = None

    async def open(self):
        self.r, self.w = await connect()
        await self._send({"op": "attach", "sid": self.sid})
        line = await self.r.readline()
        if not line:
            raise DaemonDown("attach 실패")
        ack = json.loads(line)
        if not ack.get("ok"):
            raise DaemonDown(ack.get("error", "attach 거부"))
        return ack.get("result", {})

    async def _send(self, obj):
        self.w.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        await self.w.drain()

    async def input(self, data):
        await self._send({"t": "i", "d": data})

    async def resize(self, cols, rows):
        await self._send({"t": "r", "c": cols, "r": rows})

    async def events(self):
        """데몬이 밀어주는 출력 스트림. ('out', 문자열) 또는 ('end', None)."""
        while True:
            line = await self.r.readline()
            if not line:
                return
            try:
                m = json.loads(line)
            except Exception:
                continue
            ev = m.get("ev")
            if ev == "out":
                yield "out", m.get("data", "")
            elif ev == "end":
                yield "end", None
                return

    def close(self):
        try:
            if self.w:
                self.w.close()
        except Exception:
            pass
