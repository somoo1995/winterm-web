"""
webterm — PTY 세션 매니저 (tmux 역할의 최소 구현)

핵심 설계:
  - PTY 를 브라우저가 아니라 이 프로세스(데몬)가 소유한다.
    → 브라우저를 닫아도 세션이 살아있고, 다시 붙으면 이어받는다.
  - 세션 하나당 reader 스레드 1개가 PTY 를 계속 읽어
    ① 링버퍼에 쌓고(재접속 재생용) ② 붙어있는 모든 구독자에게 push 한다.
  - 구독자별 asyncio.Queue 를 두어 느린 클라가 PTY 읽기를 막지 않게 한다.

wezterm cli 방식과의 차이:
  - 프로세스 spawn 없음(65ms 소멸), gui-sock 추종 없음, mux 없음 → 누수 위험 자체가 없다.
"""
import asyncio
import collections
import logging
import os
import threading
import time
import urllib.parse
import uuid

from winpty import PTY

log = logging.getLogger("webterm.session")

# OSC 0/2 = 창 제목 설정 시퀀스. 종결자는 BEL 또는 ST(ESC + 역슬래시)
_ESC = chr(27)
_BEL = chr(7)
_OSC_START = _ESC + chr(93)          # ESC ]
_ST = _ESC + chr(92)                 # ESC + 역슬래시

# 재접속 시 되감아 보여줄 출력량. 너무 크면 재생이 느리고, 작으면 화면 복원이 부족하다.
#
# ⚠ 이건 "줄 수"가 아니라 **출력 바이트**다. tmux 는 그리드+히스토리를 줄 단위로 구조적으로 보관하지만
#   여기는 스트림을 되감아 재생하는 방식이라, 화면을 통째로 다시 그리는 TUI(claude 등)는
#   한 프레임에 수 KB 씩 먹는다. 256KB 시절 claude 탭의 backlog 가 306,257자였다 = 이미 잘리고 있었다.
#
# 2MB 로 잡은 근거:
#   · 위쪽 뚜껑은 어차피 브라우저다 — xterm 의 `scrollback: 10000` 줄을 넘는 분량은 재생해도 버려진다
#   · 메모리는 세션당 이 값이라 10세션이어도 20MB 수준
#   · 재접속 시 이 양을 한 번에 밀어 넣으므로 키울수록 첫 화면이 늦게 뜬다
#   · daemon_client 의 STREAM_LIMIT(16MB)보다 충분히 작아야 한다 — JSON 이스케이프로 부풀기 때문
#     (64KB 기본값이던 시절 "claude 탭만 화면이 안 그려지는" 사고가 났던 그 한계)
RING_CHARS = 2 * 1024 * 1024
# PTY 에 읽을 게 없을 때 쉬는 시간. 0 이면 CPU 를 태우고, 크면 지연이 된다.
POLL_IDLE = 0.004

# ── 환경 정화 ────────────────────────────────────────────────────────────────
# 규칙은 envclean.py 에 모아뒀다(런처도 같은 규칙을 쓴다).
from envclean import clean_env  # noqa: E402


def build_env(extra=None):
    """PTY 에 넘길 환경. `extra` 는 이 세션에만 얹는 값(자기 주소 등)."""
    env = clean_env()
    if extra:
        env.update({k: v for k, v in extra.items() if v is not None})
    # pywinpty 는 "name=value\0name=value\0..." 형식의 문자열을 받는다
    return "".join(f"{k}={v}\0" for k, v in env.items())


# ⭐⭐ 세션의 **자기 주소**를 환경변수로 넣어준다 — pane 안에서 도는 claude 가
#   "나는 누구인가"를 알아야 다른 세션에게 "회신은 여기로" 라고 말할 수 있다.
#   (claude-peers 는 세션마다 peer_id 를 자동으로 줬다. 그걸 대체하는 조각이다.)
#
# ⚠ **위치(3-2)는 일부러 넣지 않는다.** 위치는 탭·pane 이 열리고 닫히면 밀리는데
#   환경변수는 spawn 때 한 번 박히고 못 바뀐다 → 그 조합은 곧 stale 거짓말이 된다
#   (wiki `pane-name-identity-auto-manual` 의 "박제된 이름이 stale 되어 오배달" 이 그 사고다).
#   변하지 않는 SID 만 박고, 지금 위치가 필요하면 `GET /api/resolve?target=$WEBTERM_SID` 로 묻는다.
#   TAB 도 이름이 바뀔 수 있어 "처음 이름"이라는 뜻으로만 쓴다.
# ⭐⭐ PowerShell 이 **현재 폴더를 알려주게** 만드는 프롬프트 주입.
#
# 목적: `cd` 한 뒤 분할(`Ctrl+]`)하면 새 pane 이 **지금 그 폴더**에서 열려야 한다.
#   실측(2026-08-26): 이 셸은 OSC 7·9;9·창 제목 중 아무것도 안 흘린다 → 우리가 흘리게 만든다.
#   Windows Terminal 의 셸 통합이 쓰는 것과 같은 수법이다(프롬프트에서 OSC 7 emit).
#
# ⚠ 세 가지를 지킨다:
#   ① **사용자 프롬프트를 망치지 않는다** — 프로필이 먼저 로드되고 `-Command` 가 나중에 실행되므로,
#      기존 `prompt` 를 붙잡아 두고(`$o`) 우리 프롬프트가 그걸 그대로 호출한다.
#   ② **PowerShell 5.1 문법만 쓴다** — `` `e `` 이스케이프는 PS6+ 라 `[char]27` 로 쓴다
#      (프로필 BOM 사고와 같은 계열의 함정. wiki voice-dictation 참조).
#   ③ 파일시스템이 아닌 위치(레지스트리 등)에서는 emit 하지 않는다.
def _osc7_prompt_arg():
    return (
        ' -NoExit -Command "'
        "$e=[char]27;$b=[char]7;"
        "$o=(Get-Command prompt -EA SilentlyContinue).ScriptBlock;"
        "function global:prompt{"
        "$l=$ExecutionContext.SessionState.Path.CurrentLocation;"
        "if($l.Provider.Name -eq 'FileSystem'){"
        "[Console]::Write($e+']7;file:///'+($l.ProviderPath -replace '\\\\','/')+$b)};"
        "if($o){& $o}else{'PS '+$l.Path+'> '}}"
        '"'
    )


def shell_cmdline(shell):
    """spawn 에 넘길 (exe, 인자문자열). PowerShell 이면 OSC 7 프롬프트를 얹는다.

    ⚠ `self.shell` 은 원본 그대로 둔다 — 보고용 문자열에 이 긴 주입이 섞이면 목록이 읽기 어려워진다.
    """
    exe, _, rest = shell.partition(" ")
    rest = rest.strip()
    base = os.path.basename(exe).lower()
    is_ps = base.startswith("powershell") or base.startswith("pwsh")
    # 사용자가 이미 -Command 로 뭔가 실행하도록 지정했다면 건드리지 않는다(덮어쓰면 그쪽 의도가 죽는다)
    if is_ps and "-command" not in rest.lower():
        rest = (rest + _osc7_prompt_arg()).strip()
    return exe, (rest or None)


def self_addr_env(sid, tab, port=8767):
    return {
        "WEBTERM_SID": sid,                                   # 불변 — 회신 주소로 이걸 쓴다
        "WEBTERM_TAB": tab or "",                             # spawn 시점 탭 이름(바뀔 수 있음)
        "WEBTERM_API": f"http://127.0.0.1:{port}",            # API 베이스(하드코딩 방지)
    }


# 한 번에 큐에 쌓아둘 최대 청크 수(느린 클라 방어). 넘치면 오래된 것부터 버린다.
QUEUE_MAX = 2048


class Session:
    def __init__(self, sid, name, shell, cwd, cols=120, rows=30, loop=None):
        self.sid = sid
        self.name = name
        self.shell = shell
        self.cwd = cwd
        self.cols = cols
        self.rows = rows
        self.created = time.time()
        self.loop = loop

        self._ring = collections.deque()      # (chunk, ...) — 총 길이를 _ring_len 으로 관리
        self._ring_len = 0
        self._ring_lock = threading.Lock()
        self._subs = set()                    # asyncio.Queue 집합
        self._subs_lock = threading.Lock()
        self._alive = True
        self._exit_code = None
        # 셸/앱이 OSC 로 알려주는 창 제목. "지금 이 세션에서 뭐가 돌고 있나"의 단일 소스다
        # (WezTerm 이 pane title 을 얻는 방식과 같다. 이미 흐르는 스트림이라 비용이 0)
        self.title = ""
        # 사용자가 이 pane 에 직접 붙인 이름(Ctrl+P). name(=탭 이름)과 역할이 다르다:
        #   name  = 탭 이름이자 그룹 키 — 같은 name 을 가진 세션들이 한 탭의 pane 이 된다
        #   label = 이 pane 하나의 이름 — 그룹에 영향을 주지 않는다
        # wiki `pane-name-identity-auto-manual` 의 원칙대로 **수동 지정분만 박제**하고,
        # 비워두면 자동(번호 + OSC title)이 현재 상태를 따라간다.
        self.label = ""
        self._osc_tail = ""                   # 청크 경계에 걸린 OSC 를 이어붙이기 위한 꼬리

        self.pty = PTY(cols, rows)
        # shell 문자열에 인자를 포함할 수 있게 첫 토큰만 실행파일로 쓴다
        # (기본값 `powershell.exe -NoLogo` — 배너가 없어야 프롬프트가 첫 줄에서 시작한다)
        exe, args = shell_cmdline(shell)
        self.pty.spawn(exe, cmdline=args, cwd=cwd,
                       env=build_env(self_addr_env(sid, name)))

        self._thread = threading.Thread(target=self._reader, daemon=True,
                                        name=f"pty-{sid[:8]}")
        self._thread.start()
        log.info("session spawned sid=%s name=%s shell=%s cwd=%s %dx%d",
                 sid, name, shell, cwd, cols, rows)

    # ---------- reader ----------
    def _reader(self):
        while self._alive:
            try:
                data = self.pty.read(blocking=False)
            except Exception as e:
                log.info("pty read ended sid=%s: %s", self.sid, e)
                break
            if data:
                self._scan_title(data)
                self._append_ring(data)
                self._broadcast(data)
                continue
            if not self.pty.isalive():
                break
            time.sleep(POLL_IDLE)
        self._alive = False
        try:
            self._exit_code = self.pty.get_exitstatus()
        except Exception:
            pass
        log.info("session ended sid=%s exit=%s", self.sid, self._exit_code)
        self._broadcast(None)  # 종료 신호

    # ⭐⭐ **cwd 는 spawn 값이 아니라 셸이 알려주는 현재 값이어야 한다.**
    #
    # 예전에는 `self.cwd` 가 spawn 시점 폴더로 **고정**이었다. 그래서 `cd` 한 뒤 `Ctrl+]` 로 분할하면
    # 새 pane 이 **옛 폴더**에서 열렸다(사용자 제보 2026-08-26: "생성하는 시점의 pane 의 cwd 를 따라가야
    # 하는데 그게 안 된다"). 프론트는 이미 현재 pane 의 cwd 를 보내고 있었으므로, 문제는 그 값이 낡은 것이었다.
    #
    # ⚠ 폰 3차·PC 3차와 같은 교훈: **관측 없이는 못 고친다.** 실측해보니 셸은 OSC 7 도, 9;9 도, 제목도
    #   아무것도 흘리지 않았다 → 추적할 신호 자체가 없었다. 그래서 **셸이 알려주게** 만들고(프롬프트에
    #   OSC 7 주입, 아래 `_osc7_prompt_arg`) 여기서 그걸 받는다.
    #
    # ⚠ Windows 에서 프로세스 CWD 를 밖에서 읽는 길(psutil `Process.cwd()`)은 못 쓴다 —
    #   PowerShell 의 `Set-Location` 은 프로세스의 실제 작업 디렉터리를 바꾸지 않는다(그래서 .NET API 가
    #   `Set-Location` 을 안 따라가는 그 유명한 함정이 있다). 즉 밖에서 읽으면 영원히 spawn 폴더다.
    @staticmethod
    def _path_from_file_url(u):
        """`file:///C:/a/b` · `file://host/C:/a/b` → `C:\\a\\b`. 아니면 None."""
        if not u.startswith("file:"):
            return None
        rest = u[5:]
        while rest.startswith("/"):
            rest = rest[1:]
        if "/" in rest and ":" not in rest.split("/", 1)[0]:
            rest = rest.split("/", 1)[1]          # host 부분 버리기 (`file://host/C:/...`)
        rest = urllib.parse.unquote(rest)         # 공백 등 %XX 복원
        return rest.replace("/", os.sep) or None

    def _update_cwd(self, path):
        path = os.path.normpath(path)
        if path == self.cwd:
            return
        if not os.path.isdir(path):               # 사라진 폴더·비파일시스템 위치는 무시
            return
        old, self.cwd = self.cwd, path
        log.info("cwd 갱신 sid=%s %s → %s", self.sid, old, path)

    def _handle_osc(self, payload):
        if payload[:2] in ("0;", "2;"):           # 창 제목
            self.title = payload[2:].strip()
        elif payload[:2] == "7;":                 # 표준 cwd 알림
            p = self._path_from_file_url(payload[2:].strip())
            if p:
                self._update_cwd(p)
        elif payload[:4] == "9;9;":               # ConEmu/Windows Terminal 방식 (혹시 오는 경우)
            p = payload[4:].strip().strip('"')
            if p:
                self._update_cwd(p)

    def _scan_title(self, chunk):
        r"""OSC 0/2(창 제목) · 7 · 9;9(cwd)를 훑어 self.title / self.cwd 를 갱신한다.

        원래는 제목만 봤는데 cwd 추적이 붙어 종결자까지 한 번에 끊고 **payload 를 dispatch** 하는
        구조로 바꿨다(예전 코드는 제목이 아닌 OSC 를 만나면 `ESC]` 두 글자만 넘겨 같은 시퀀스를 다시 훑었다).

        아래는 원래 주석 그대로:

        형식: ESC ] 0 ; <제목> BEL   또는   ESC ] 2 ; <제목> ST
        예)   ESC]0;<Claude Code>ST      ESC]0;<PS C:\work>BEL

        "지금 이 세션에서 뭐가 돌고 있나"를 여기서 얻는다(WezTerm 의 pane title 과 같은 출처).
        이미 흐르는 스트림이라 추가 비용이 없다 — 프로세스 트리를 뒤지는 것보다 싸고 정확하다.
        청크 경계에 걸린 미완성 OSC 는 꼬리로 들고 다음 청크에 이어붙인다.
        """
        buf = self._osc_tail + chunk
        self._osc_tail = ""
        pos = 0
        while True:
            i = buf.find(_OSC_START, pos)
            if i < 0:
                break
            body_at = i + len(_OSC_START)
            body = buf[body_at:]
            e_bel = body.find(_BEL)
            e_st = body.find(_ST)
            cands = [x for x in (e_bel, e_st) if x >= 0]
            if not cands:
                # 종결자가 아직 안 왔다 → 꼬리로 보관(비정상적으로 길면 버린다)
                # ⚠ cwd 경로가 제목보다 길 수 있어 512 → 1024 로 늘렸다
                rest = buf[i:]
                if len(rest) < 1024:
                    self._osc_tail = rest
                break
            e = min(cands)
            consumed = len(_BEL) if e == e_bel else len(_ST)
            pos = body_at + e + consumed
            self._handle_osc(body[:e])

    def _append_ring(self, chunk):
        with self._ring_lock:
            self._ring.append(chunk)
            self._ring_len += len(chunk)
            while self._ring_len > RING_CHARS and len(self._ring) > 1:
                self._ring_len -= len(self._ring.popleft())

    def _broadcast(self, data):
        if self.loop is None:
            return
        with self._subs_lock:
            subs = list(self._subs)
        for q in subs:
            try:
                self.loop.call_soon_threadsafe(self._put, q, data)
            except RuntimeError:
                pass  # 루프가 이미 닫힌 경우

    @staticmethod
    def _put(q, data):
        if q.qsize() >= QUEUE_MAX:
            try:
                q.get_nowait()   # 오래된 것부터 버려 뒤처진 클라가 메모리를 먹지 않게
            except Exception:
                pass
        q.put_nowait(data)

    # ---------- 구독 ----------
    def subscribe(self):
        q = asyncio.Queue()
        with self._subs_lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q):
        with self._subs_lock:
            self._subs.discard(q)

    def backlog(self):
        with self._ring_lock:
            return "".join(self._ring)

    # ---------- 조작 ----------
    def write(self, data):
        if self._alive:
            self.pty.write(data)

    def resize(self, cols, rows):
        # 동시 접속 시 정책: "마지막에 붙은 쪽 크기로" (tmux 의 최소창 타협을 쓰지 않는다)
        if not self._alive:
            return
        cols = max(20, min(500, int(cols)))
        rows = max(5, min(200, int(rows)))
        if (cols, rows) == (self.cols, self.rows):
            return
        self.cols, self.rows = cols, rows
        try:
            self.pty.set_size(cols, rows)
        except Exception as e:
            log.warning("resize failed sid=%s: %s", self.sid, e)

    def close(self):
        self._alive = False
        try:
            self.pty.write("\x03")   # 진행 중인 것 중단 시도
        except Exception:
            pass
        try:
            del self.pty              # pywinpty 는 소멸 시 프로세스를 정리한다
        except Exception:
            pass
        self._broadcast(None)

    @property
    def alive(self):
        return self._alive

    def info(self):
        return {
            "sid": self.sid,
            "name": self.name,
            "shell": self.shell,
            "cwd": self.cwd,
            "title": self.title,
            "label": self.label,
            "cols": self.cols,
            "rows": self.rows,
            "alive": self._alive,
            "clients": len(self._subs),
            "created": self.created,
        }


class SessionManager:
    def __init__(self):
        self.sessions = {}
        self.loop = None

    def bind_loop(self, loop):
        self.loop = loop
        for s in self.sessions.values():
            s.loop = loop

    def create(self, name=None, shell=None, cwd=None, cols=120, rows=30):
        sid = uuid.uuid4().hex[:12]
        # -NoLogo: 배너 5줄이 없어야 프롬프트가 첫 줄에서 시작한다
        shell = shell or os.environ.get("WEBTERM_SHELL", "powershell.exe -NoLogo")
        cwd = cwd or os.environ.get("WEBTERM_CWD") or os.path.expanduser("~")
        if not os.path.isdir(cwd):
            # 조용히 홈으로 떨어뜨리면 "왜 엉뚱한 데서 열리지" 를 추적할 수 없다.
            log.warning("cwd 없음 → 홈으로 대체: %r", cwd)
            cwd = os.path.expanduser("~")
        name = name or f"term{len(self.sessions) + 1}"
        s = Session(sid, name, shell, cwd, cols, rows, loop=self.loop)
        self.sessions[sid] = s
        return s

    def get(self, sid):
        return self.sessions.get(sid)

    def kill(self, sid):
        s = self.sessions.pop(sid, None)
        if s:
            s.close()
        return bool(s)

    def rename(self, sid, name):
        s = self.sessions.get(sid)
        if s:
            s.name = name
        return bool(s)

    def label(self, sid, label):
        """pane 개별 이름을 설정한다. 빈 문자열이면 자동 이름으로 되돌린다.

        **(탭 이름, label) 이 복합키**다 — 같은 탭 안에서는 pane 이름이 유일해야 한다.
        이름으로 pane 을 지목하는 쪽(우클릭 메뉴·앞으로 만들 shim)이 둘 중 어느 것인지
        말없이 골라버리면 "보이는 것과 다르게 동작"한다(wiki `pane-name-identity` 의 오배달 사고).
        클라이언트가 아니라 여기서 막는다 — API 를 직접 호출해도 뚫리지 않게.

        반환: "ok" | "nosession" | "duplicate"
        """
        s = self.sessions.get(sid)
        if not s:
            return "nosession"
        label = (label or "").strip()
        if label:
            for other in self.sessions.values():
                if other.sid != sid and other.name == s.name and other.label == label:
                    return "duplicate"
        s.label = label
        return "ok"

    def list(self):
        return [s.info() for s in self.sessions.values()]

    def reap(self):
        """죽은 세션 중 아무도 안 붙은 것을 치운다."""
        dead = [sid for sid, s in self.sessions.items()
                if not s.alive and len(s._subs) == 0]
        for sid in dead:
            self.sessions.pop(sid, None)
        return dead
