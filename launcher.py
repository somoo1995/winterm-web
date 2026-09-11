"""webterm 런처 — 더블클릭 하나로 기동하고 앱 창을 연다.

    webterm.exe                데몬·웹서버를 확인/기동한 뒤 Chrome 앱 창으로 연다
    webterm.exe --restart      웹서버만 재시작(세션은 유지)하고 연다
    webterm.exe --status       현재 상태를 보여준다
    webterm.exe --stop         웹서버만 정지(세션 유지)
    webterm.exe --stop-all     데몬까지 정지 ⚠ 열려있는 셸이 전부 종료된다
    webterm.exe --install      앱으로 설치하기 위해 일반 창으로 연다(타이틀바 제거용)
    webterm.exe --no-browser   기동만 하고 창은 열지 않는다

`start.ps1` 과 같은 일을 하지만 콘솔 없는 GUI 앱으로 빌드되므로,
사람에게 보일 말은 콘솔이 아니라 MessageBox 로 낸다(실패했을 때만 뜬다).

## 이 파일이 지키는 함정 셋 (전부 실제로 밟았던 것)

1. **데몬은 콘솔이 있어야 한다.** `pythonw.exe`(콘솔 없음)나 `DETACHED_PROCESS` 로 띄우면
   ConPTY 생성이 `PanicException: HRESULT(0x00000000)` 로 죽는다.
   → `python.exe` + `CREATE_NO_WINDOW`(콘솔은 할당, 창은 안 띄움).
   이 런처 자신은 콘솔이 없어도 된다 — ConPTY 를 만드는 건 데몬이지 런처가 아니고,
   `CREATE_NO_WINDOW` 는 자식에게 **새 콘솔을 할당**하기 때문이다.
2. **포트로 프로세스를 찾을 때 `127.0.0.1` 바인딩만 골라야 한다.** `tailscale serve` 가
   같은 포트를 `100.x`/IPv6 에도 리슨해서, 포트만 보고 첫 리스너를 죽이면 tailscaled 가 죽는다
   (실제로 죽였다). 여기서는 이미지 이름이 python 계열인지까지 한 번 더 본다.
3. **환경 오염.** 이 런처를 claude 세션 안에서 실행하면 그 환경이 서버·데몬에 통째로 상속된다
   → `envclean.clean_env()` 로 걷어내고 넘긴다(`session.py` 와 같은 규칙).
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

# exe 를 프로젝트 밖에 복사해 두는 경우를 위한 탈출구 = `WEBTERM_ROOT` 환경변수.
# ⚠ 여기에 개인 절대경로를 박지 않는다 — 공개 저장소에 남으면 안 되고,
#   다른 사람 PC 에서는 어차피 존재하지 않는 경로다.


def app_root():
    """server.py / daemon.py 가 있는 폴더. exe 는 이 폴더에 두는 것이 기본이다."""
    here = (os.path.dirname(os.path.abspath(sys.executable))
            if getattr(sys, "frozen", False)
            else os.path.dirname(os.path.abspath(__file__)))
    for cand in (here, os.environ.get("WEBTERM_ROOT")):
        if cand and os.path.exists(os.path.join(cand, "server.py")):
            return cand
    return None


ROOT = app_root()


# ── 사람에게 말 걸기 ──────────────────────────────────────────────────────────
MB_OK, MB_YESNO = 0x0, 0x4
MB_ICONERROR, MB_ICONINFO, MB_ICONWARN = 0x10, 0x40, 0x30
IDYES = 6


def box(text, title="webterm", flags=MB_OK | MB_ICONINFO):
    return ctypes.windll.user32.MessageBoxW(0, str(text), title, flags)


def fail(text):
    logline("ERROR " + text.replace("\n", " / "))
    tail = ""
    if ROOT:
        tail = f"\n\n로그: {os.path.join(ROOT, 'launcher.log')}"
    box(text + tail, "webterm — 기동 실패", MB_OK | MB_ICONERROR)
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
    """콘솔 창을 띄우지 않고 명령을 실행해 표준출력을 돌려준다."""
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=10,
                             creationflags=CREATE_NO_WINDOW,
                             encoding="utf-8", errors="replace")
        return out.stdout or ""
    except Exception:
        return ""


# ── 포트 · 프로세스 ───────────────────────────────────────────────────────────
def is_up(port, timeout=0.4):
    with socket.socket() as s:
        s.settimeout(timeout)
        return s.connect_ex((HOST, port)) == 0


def listener_pid(port):
    """127.0.0.1:port 를 LISTENING 중인 우리 프로세스의 PID.

    ⚠ 반드시 loopback 바인딩만 고른다 — tailscale serve 가 같은 포트를 100.x / IPv6 에도
      리슨하고 있어서, 포트만 보면 tailscaled 가 잡힌다(실제로 죽인 적 있다).
      거기에 더해 이미지 이름이 python 계열인지 확인해 남의 프로세스를 절대 안 건드린다.
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
    """콘솔 있는 python.exe 와 콘솔 없는 pythonw.exe 를 찾는다.

    ⚠ exe 로 얼어붙으면 sys.executable 은 webterm.exe 자신이라 쓸 수 없다.
    ⚠ PATH 의 WindowsApps\\python.exe 는 Microsoft Store 스텁이라 즉시 죽는다 → 제외.
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


# ── 기동 ─────────────────────────────────────────────────────────────────────
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
        logline("데몬 이미 실행중 — 유지(세션 보존)")
        return True
    logline("데몬 기동")
    # ⚠ 콘솔 있는 python.exe + CREATE_NO_WINDOW. pythonw 로 띄우면 ConPTY 가 패닉한다.
    spawn(py, "daemon.py", CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
    return wait_up(DAEMON_PORT, 10)


def ensure_server(pyw, restart=False):
    pid = listener_pid(PORT)
    if pid and not restart:
        logline(f"웹서버 이미 실행중 (PID {pid})")
        return True
    if pid:
        logline(f"웹서버 재시작 — 기존 PID {pid} 종료")
        kill(pid)
        time.sleep(0.5)
    logline("웹서버 기동")
    # 웹서버는 PTY 를 만들지 않으므로 콘솔이 필요 없다 → pythonw(창 없음)
    spawn(pyw, "server.py", CREATE_NO_WINDOW)
    return wait_up(PORT, 12)


# ── 브라우저 ─────────────────────────────────────────────────────────────────
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
    """설치된 PWA 의 바로가기(.lnk). 있으면 이걸로 여는 것이 낫다.

    설치된 PWA 창에서만 **Window Controls Overlay** 가 켜진다 — 타이틀바가 사라지고
    창 버튼만 탭바에 얹히는, WezTerm 의 `INTEGRATED_BUTTONS` 와 같은 모양.
    `--app=URL` 로 띄운 창은 아무리 해도 타이틀바가 남는다.

    Chrome/Edge 는 설치할 때 시작 메뉴 하위 폴더(`Chrome 앱` / `Chrome Apps` / `Edge Apps`)에
    바로가기를 만든다. app-id 를 캐내는 것보다 그 .lnk 를 실행하는 편이 단순하고 안전하다.
    ⚠ **하위 폴더만** 뒤진다 — Programs 바로 아래에는 우리가 만든 런처 바로가기가 있어서,
      그것까지 잡으면 자기 자신을 다시 띄우는 무한 루프가 된다.
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
    """창을 연다. 설치된 PWA 가 있으면 그쪽(타이틀바 없는 창)을 먼저 쓴다."""
    lnk = pwa_shortcut()
    if lnk:
        logline(f"PWA 창으로 열기: {lnk}")
        os.startfile(lnk)
        return

    exe = find_browser()
    if not exe:
        import webbrowser
        webbrowser.open(URL)
        return
    logline("앱 모드 창으로 열기(미설치 — 타이틀바가 남는다)")
    subprocess.Popen(
        [exe, f"--app={URL}", "--window-size=1600,1000"],
        env=clean_env(), close_fds=True,
        creationflags=CREATE_NO_WINDOW | DETACHED,
    )


def cmd_install():
    """설치용으로 **일반 창**을 연다.

    앱 모드 창에는 주소창이 없어 설치 버튼도 없다. 그래서 설치할 때만 보통 창으로 띄운다.
    """
    exe = find_browser()
    if not exe:
        import webbrowser
        webbrowser.open(URL)
    else:
        subprocess.Popen([exe, "--new-window", URL], env=clean_env(), close_fds=True,
                         creationflags=CREATE_NO_WINDOW | DETACHED)
    box("지금 연 창에서 webterm 을 앱으로 설치하세요.\n\n"
        "  주소창 오른쪽의 설치 아이콘(⊕ 모양)  또는\n"
        "  ⋮ 메뉴 → 캐스트·저장·공유 → 페이지를 앱으로 설치\n\n"
        "설치하면 타이틀바가 사라지고 창 버튼이 탭바에 얹힙니다\n"
        "(WezTerm 의 INTEGRATED_BUTTONS 와 같은 모양).\n\n"
        "설치 후에는 webterm.exe 가 자동으로 그 창을 엽니다.",
        "webterm — 앱으로 설치")


# ── 명령 ─────────────────────────────────────────────────────────────────────
def cmd_status():
    d, w = listener_pid(DAEMON_PORT), listener_pid(PORT)
    lines = [
        f"세션 데몬 : {'실행중 (PID %d)' % d if d else '정지'}   포트 {DAEMON_PORT}",
        f"웹서버    : {'실행중 (PID %d)' % w if w else '정지'}   포트 {PORT}",
    ]
    if d and w:
        try:
            with urllib.request.urlopen(f"{URL}/api/sessions", timeout=5) as r:
                ss = json.loads(r.read().decode("utf-8")).get("sessions", [])
            lines.append(f"\n열린 세션 : {len(ss)}개")
            lines += [f"   · {s.get('name')}  ({s.get('cwd')})" for s in ss]
        except Exception as e:
            lines.append(f"\n세션 조회 실패: {e}")
    lines.append(f"\n{URL}")
    box("\n".join(lines), "webterm — 상태")


def cmd_stop(all_=False):
    w = listener_pid(PORT)
    if all_:
        d = listener_pid(DAEMON_PORT)
        if d and box("세션 데몬까지 종료합니다.\n\n열려있는 셸이 전부 종료됩니다. 계속할까요?",
                     "webterm — 전체 종료", MB_YESNO | MB_ICONWARN) != IDYES:
            return
        if w:
            kill(w)
        if d:
            kill(d)
        box("webterm 전체 정지됨" if (w or d) else "이미 정지 상태입니다")
        return
    if w:
        kill(w)
    msg = "웹서버 정지됨"
    if is_up(DAEMON_PORT):
        msg += " (세션 데몬은 계속 실행중 — 세션 살아있음)"
    box(msg)


def main():
    args = {a.lower() for a in sys.argv[1:]}
    if not ROOT:
        fail("webterm 소스를 찾지 못했습니다.\n"
             "webterm.exe 를 server.py 가 있는 폴더에 두거나,\n"
             "환경변수 WEBTERM_ROOT 로 경로를 지정하세요.")

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
        fail("python 을 찾지 못했습니다.\n"
             "환경변수 WEBTERM_PYTHON 에 python.exe 경로를 지정할 수 있습니다.")

    if not ensure_daemon(py):
        fail(f"세션 데몬이 뜨지 않았습니다 (포트 {DAEMON_PORT}).\n"
             f"{os.path.join(ROOT, 'daemon.log')} 를 확인하세요.")

    if not ensure_server(pyw, restart="--restart" in args):
        fail(f"웹서버가 뜨지 않았습니다 (포트 {PORT}).\n"
             f"{os.path.join(ROOT, 'webterm.log')} 를 확인하세요.")

    logline(f"준비 완료 → {URL}")
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
        box(f"예상치 못한 오류:\n\n{e}", "webterm", MB_OK | MB_ICONERROR)
        sys.exit(1)
