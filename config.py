"""Config loading and origin checks.

    config.default.json  (repo defaults, don't edit)
          | merged per key
    config.json          (user values, .gitignored)

The `_readme` keys are human comments and are stripped after merging.
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
        # utf-8-sig: editing in Notepad adds a BOM; don't choke on it.
        return json.load(io.open(path, encoding="utf-8-sig"))
    except Exception as e:
        # A broken config must not make the terminal unusable. Log it and fall back to defaults.
        log.error("could not read config (%s): %s -> ignoring this file", path, e)
        return {}


def _strip_readme(o):
    if isinstance(o, dict):
        return {k: _strip_readme(v) for k, v in o.items() if k != "_readme"}
    return o


def _merge(base, over):
    """Merge dicts per key; overwrite everything else.

    Per-key so a user can list ONLY the bindings they change, not the whole keymap.
    (Setting a value to "" like `"Ctrl+n": ""` stops the app intercepting that chord.)
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
        log.info("config loaded - user config.json %s", "present" if os.path.exists(USER_PATH) else "absent")
    return _cache


def keymap():
    """{"Ctrl+]": "pane.split.h", ...} - entries with an empty-string value are dropped (= not intercepted)."""
    return {k: v for k, v in (load().get("keymap") or {}).items() if v}


# -- Origin checks -------------------------------------------------------------
# Access control itself is the network's job (a private network / Tailscale). What we block
# here is only what that can't stop - an attack from the user's OWN browser hitting loopback.
#
#   malicious page -> DNS rebinding makes it same-origin as 127.0.0.1   (blocked by Host check)
#                  -> reads /api/sessions to get a sid
#                  -> ws://127.0.0.1/ws/<sid> to seize the shell        (blocked by Origin check)
#
# This path needs no attacker inside the tailnet, so a VPN can't help.

def _norm(h):
    """Normalize a host string for comparison: strip the port and IPv6 brackets."""
    if not h:
        return ""
    h = h.strip().lower()
    if h.startswith("["):                      # [::1]:8767
        end = h.find("]")
        if end != -1:
            h = h[1:end]
    elif h.count(":") == 1:                    # host:port (IPv6 has multiple colons, so excluded)
        h = h.rsplit(":", 1)[0]
    return h


def _matches(host, patterns):
    h = _norm(host)
    if not h:
        return False
    for p in patterns or []:
        p = _norm(p)
        if p.startswith("*."):
            suffix = p[1:]                     # "*.ts.net" -> ".ts.net"
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
    """No Origin -> allowed. Only browsers send Origin, so curl/scripts aren't blocked."""
    if not origin:
        return True
    sec = load().get("security") or {}
    allowed = sec.get("allowedOrigins") or sec.get("allowedHosts") or []
    try:
        host = urlsplit(origin).hostname or ""
    except Exception:
        return False
    return _matches(host, allowed)
