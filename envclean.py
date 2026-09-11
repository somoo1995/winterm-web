"""자식 프로세스에 물려줄 **깨끗한 환경**을 만든다.

이 서버를 어디서 띄웠느냐에 따라 자식 셸의 환경이 오염된다. 실제로 겪은 것:
    CLAUDECODE=1 / CLAUDE_CODE_* → 자식 CLI 가 "비대화형"으로 판단해 색을 끄고,
                                    새로 띄운 claude 가 자식 세션 취급되어 transcript 가 꺼진다
    WEZTERM_UNIX_SOCKET          → 세션 안에서 wezterm cli 를 치면 stale 소켓을 물어
                                    mux-server 를 spawn 한다(시스템 freeze 사고의 그 경로)

터미널은 "깨끗한 셸"을 줘야 하므로 물려주지 않는다. 그리고 이 오염은 **띄운 장소에 따라
달라지므로** 재현이 어렵다 — 코드에 정화 로직을 박아야지 "탐색기에서 띄우면 되더라"로
넘기면 안 된다. 그래서 세션(session.py)뿐 아니라 런처(launcher.py)도 이 규칙을 쓴다.
"""
import os

STRIP_PREFIXES = ("CLAUDE_CODE_", "WEZTERM_")
STRIP_EXACT = {
    "CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT",
    "FORCE_COLOR", "NO_COLOR", "CLICOLOR", "CLICOLOR_FORCE",
}
# 반대로 반드시 심어줄 것 — 색 지원을 앱에게 알린다
FORCE_ENV = {
    "TERM": "xterm-256color",
    "COLORTERM": "truecolor",
    "TERM_PROGRAM": "webterm",
}


def clean_env(extra=None):
    """오염 변수를 걷어낸 환경 dict. extra 로 덮어쓸 값을 준다."""
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(STRIP_PREFIXES) and k not in STRIP_EXACT}
    env.update(FORCE_ENV)
    env.pop("TERM_PROGRAM_VERSION", None)
    if extra:
        env.update(extra)
    return env
