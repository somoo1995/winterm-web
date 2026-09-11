"""설정 로딩과 출처 검사.

    config.default.json  (저장소 기본값, 고치지 않는다)
          ↓ 키 단위 병합
    config.json          (사용자 값, .gitignore 됨)

`_readme` 키는 사람용 주석이라 병합 후 걷어낸다.
"""
import io
import json
import logging
import os
from urllib.parse import urlsplit

BASE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PATH = os.path.join(BASE, "config.default.json")
USER_PATH = os.path.join(BASE, "config.json")

log = logging.getLogger("webterm.config")

_cache = None


def _read(path):
    if not os.path.exists(path):
        return {}
    try:
        # utf-8-sig: 사람이 메모장으로 고치면 BOM 이 붙는다. 그걸로 죽으면 안 된다.
        return json.load(io.open(path, encoding="utf-8-sig"))
    except Exception as e:
        # 설정이 깨졌다고 터미널을 못 쓰게 만들지 않는다. 로그를 남기고 기본값으로 간다.
        log.error("설정을 읽지 못했다 (%s): %s → 이 파일은 무시한다", path, e)
        return {}


def _strip_readme(o):
    if isinstance(o, dict):
        return {k: _strip_readme(v) for k, v in o.items() if k != "_readme"}
    return o


def _merge(base, over):
    """dict 는 키 단위로 병합하고 나머지는 덮어쓴다.

    키맵을 통째로 바꾸지 않고 **바꿀 조합만** 적을 수 있어야 하므로 키 단위여야 한다.
    (`"Ctrl+n": ""` 처럼 빈 값으로 두면 그 조합을 앱이 가로채지 않는다)
    """
    out = dict(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load(force=False):
    global _cache
    if _cache is None or force:
        _cache = _strip_readme(_merge(_read(DEFAULT_PATH), _read(USER_PATH)))
        log.info("설정 로드 — 사용자 config.json %s", "있음" if os.path.exists(USER_PATH) else "없음")
    return _cache


def keymap():
    """{"Ctrl+]": "pane.split.h", ...} — 값이 빈 문자열인 항목은 뺀다(=가로채지 않음)."""
    return {k: v for k, v in (load().get("keymap") or {}).items() if v}


# ── 출처 검사 ────────────────────────────────────────────────────────────────
# 접근 통제 자체는 네트워크(사설망/Tailscale)의 몫이다. 여기서 막는 것은 그것으로
# 막을 수 없는 것 하나 — **사용자 자신의 브라우저에서 loopback 으로 들어오는 공격**이다.
#
#   악성 페이지 → DNS 리바인딩으로 127.0.0.1 과 동일 출처가 됨   (Host 검사로 차단)
#              → /api/sessions 를 읽어 sid 획득
#              → ws://127.0.0.1/ws/<sid> 로 셸 장악              (Origin 검사로 차단)
#
# 이 경로는 공격자가 tailnet 안에 있을 필요가 없어서 VPN 이 관여하지 못한다.

def _norm(h):
    """호스트 문자열을 비교 가능한 꼴로. 포트를 떼고 IPv6 대괄호를 벗긴다."""
    if not h:
        return ""
    h = h.strip().lower()
    if h.startswith("["):                      # [::1]:8767
        end = h.find("]")
        if end != -1:
            h = h[1:end]
    elif h.count(":") == 1:                    # host:port (IPv6 는 콜론이 여럿이라 제외)
        h = h.rsplit(":", 1)[0]
    return h


def _matches(host, patterns):
    h = _norm(host)
    if not h:
        return False
    for p in patterns or []:
        p = _norm(p)
        if p.startswith("*."):
            suffix = p[1:]                     # "*.ts.net" → ".ts.net"
            if h == p[2:] or h.endswith(suffix):
                return True
        elif h == p:
            return True
    return False


def guard_enabled():
    return bool((load().get("security") or {}).get("enabled", True))


def host_allowed(host):
    sec = load().get("security") or {}
    return _matches(host, sec.get("allowedHosts") or [])


def origin_allowed(origin):
    """Origin 이 없으면 통과 — 브라우저만 Origin 을 붙이므로 curl·스크립트를 막지 않는다."""
    if not origin:
        return True
    sec = load().get("security") or {}
    allowed = sec.get("allowedOrigins") or sec.get("allowedHosts") or []
    try:
        host = urlsplit(origin).hostname or ""
    except Exception:
        return False
    return _matches(host, allowed)
