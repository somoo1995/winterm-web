"""
Web server -> session daemon client.

Design: the web server is a pure relay and holds no session state.
    - Control requests are one-shot connections (local TCP is cheap, and nothing lingers if the web server drops)
    - One daemon attach connection per browser WS -> the daemon already fans out, so no routing logic here
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

# The daemon MUST have a console. Under pythonw.exe (no console) or DETACHED_PROCESS,
# ConPTY creation dies with PanicException: HRESULT(0x00000000) (measured), because
# CreatePseudoConsole needs console infrastructure.
# CREATE_NO_WINDOW = allocate a console but show no window -> ConPTY works, no console flash.
CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_PROCESS_GROUP = 0x00000200


class DaemonDown(Exception):
    pass


def _python():
    """Find a python.exe with a console (pythonw can't do ConPTY). Also avoid the WindowsApps stub."""
    exe = sys.executable or "python.exe"
    if exe.lower().endswith("pythonw.exe"):
        cand = os.path.join(os.path.dirname(exe), "python.exe")
        if os.path.exists(cand):
            return cand
    return exe


def spawn_daemon():
    cmd = [_python(), os.path.join(BASE, "daemon.py")]
    log.info("spawning daemon: %s", cmd)
    subprocess.Popen(
        cmd, cwd=BASE, close_fds=True,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP,
    )


# asyncio's default readline buffer is 64KB. The backlog (ring buffer for reconnect redraw)
# grows to 256KB and more after JSON escaping, so the default fails the whole redraw with
# "ValueError: Separator is not found, and chunk exceed the limit".
# Symptom seen: only busy claude tabs failed to draw; quiet shell tabs were fine.
STREAM_LIMIT = 16 * 1024 * 1024


async def connect(timeout=2.0):
    return await asyncio.wait_for(
        asyncio.open_connection(HOST, PORT, limit=STREAM_LIMIT), timeout)


async def ensure_daemon(tries=12, delay=0.4):
    """Spawn the daemon if it's down and wait until it's up."""
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
            log.info("daemon connection confirmed")
            return True
        except Exception:
            continue
    return False


async def request(msg, timeout=10.0):
    """One control request. If the daemon is down, try spawning it once and retry."""
    for attempt in (1, 2):
        try:
            r, w = await connect()
        except Exception:
            if attempt == 1 and await ensure_daemon():
                continue
            raise DaemonDown("cannot connect to the session daemon")
        try:
            w.write((json.dumps(msg, ensure_ascii=False) + "\n").encode("utf-8"))
            await w.drain()
            line = await asyncio.wait_for(r.readline(), timeout)
            if not line:
                raise DaemonDown("daemon closed the connection without responding")
            return json.loads(line)
        finally:
            try:
                w.close()
            except Exception:
                pass
    raise DaemonDown("cannot connect to the session daemon")


class Attach:
    """A daemon stream connection matching one browser WS."""

    def __init__(self, sid):
        self.sid = sid
        self.r = None
        self.w = None

    async def open(self):
        self.r, self.w = await connect()
        await self._send({"op": "attach", "sid": self.sid})
        line = await self.r.readline()
        if not line:
            raise DaemonDown("attach failed")
        ack = json.loads(line)
        if not ack.get("ok"):
            raise DaemonDown(ack.get("error", "attach refused"))
        return ack.get("result", {})

    async def _send(self, obj):
        self.w.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        await self.w.drain()

    async def input(self, data):
        await self._send({"t": "i", "d": data})

    async def resize(self, cols, rows):
        await self._send({"t": "r", "c": cols, "r": rows})

    async def events(self):
        """Output stream pushed by the daemon: ('out', str) or ('end', None)."""
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
