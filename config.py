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


def default_keymap():
    """The keymap as it SHIPS, before config.json is merged on top.

    The settings panel needs this to express a deletion. Because config.json merges per key - the
    property that lets someone hand-edit only the bindings they care about - a binding the panel
    dropped would keep showing through from the defaults. Knowing the defaults, the panel can send
    "" (deliberately unbound) for those instead, which `keymap()` above then filters out.
    """
    km = _strip_readme(_read(DEFAULT_PATH)).get("keymap") or {}
    return {k: v for k, v in km.items() if v}


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


# -- Saving (the in-app settings panel) ----------------------------------------
# Writes land in config.json (the user file), never in config.default.json - the defaults stay
# a readable record of what shipped, and deleting config.json always restores them.
#
# `security` is deliberately NOT writable here. That guard exists to survive a hostile page
# reaching this server, and a guard a page can switch off is not a guard. It stays file-only.
WRITABLE = ("keymap", "fontSize", "shell", "defaultCwd", "language")

# Kept in step with static/i18n.js. Two places, but the alternative is the server parsing JS.
LANGUAGES = ("en", "ko")

MAX_BINDINGS = 300
MAX_CHORD = 40
MAX_ACTION = 60


class ConfigError(ValueError):
    """Rejected settings. The message is shown to the user, so say what to fix."""


def _validate(patch):
    """Return (cleaned patch, keys to remove), or raise ConfigError.

    A null value means REMOVE that key from config.json, which is how "reset to defaults" works:
    merging an empty object would leave the old values in place, so the override has to be deleted
    for config.default.json to show through again.

    Unknown keys are an error, not a silent drop - a typo that vanishes quietly reads as
    'I saved it and nothing happened'.
    """
    if not isinstance(patch, dict):
        raise ConfigError("settings must be an object")
    unknown = [k for k in patch if k not in WRITABLE]
    if unknown:
        raise ConfigError("not writable from here: " + ", ".join(sorted(unknown)))

    remove = [k for k, v in patch.items() if v is None]
    patch = {k: v for k, v in patch.items() if v is not None}

    out = {}
    if "keymap" in patch:
        km = patch["keymap"]
        if not isinstance(km, dict):
            raise ConfigError("keymap must be an object")
        if len(km) > MAX_BINDINGS:
            raise ConfigError(f"too many bindings (max {MAX_BINDINGS})")
        clean = {}
        for chord, action in km.items():
            if not isinstance(chord, str) or not isinstance(action, str):
                raise ConfigError("keymap entries must be text")
            chord = chord.strip()
            action = action.strip()
            if not chord or len(chord) > MAX_CHORD:
                raise ConfigError(f"bad chord: {chord[:MAX_CHORD]!r}")
            if len(action) > MAX_ACTION:
                raise ConfigError(f"bad action: {action[:MAX_ACTION]!r}")
            clean[chord] = action          # "" is meaningful: deliberately unbound
        out["keymap"] = clean

    if "fontSize" in patch:
        try:
            size = float(patch["fontSize"])
        except (TypeError, ValueError):
            raise ConfigError("fontSize must be a number")
        if not 6 <= size <= 48:
            raise ConfigError("fontSize must be between 6 and 48")
        out["fontSize"] = size

    if "language" in patch:
        lang = patch["language"]
        if not isinstance(lang, str):
            raise ConfigError("language must be text")
        # "" means follow the browser. An unknown code would silently fall back to English, which
        # reads as "the setting did nothing", so reject it instead.
        if lang and lang not in LANGUAGES:
            raise ConfigError("unknown language: " + lang + " (have: " + ", ".join(LANGUAGES) + ")")
        out["language"] = lang

    for key, limit in (("shell", 300), ("defaultCwd", 1000)):
        if key in patch:
            val = patch[key]
            if not isinstance(val, str):
                raise ConfigError(f"{key} must be text")
            if len(val) > limit:
                raise ConfigError(f"{key} is too long (max {limit})")
            out[key] = val.strip()

    return out, remove


def save(patch):
    """Merge `patch` into config.json and return the config as it now reads.

    Written atomically: a half-written config.json would break every future start, and this is
    reachable from a phone on a flaky link. Keys already in the file that we don't touch
    (`security`, hand-written comments' neighbours) survive untouched.
    """
    clean, remove = _validate(patch)
    current = _read(USER_PATH)
    merged = _merge(current, clean)
    for key in remove:
        merged.pop(key, None)

    tmp = USER_PATH + ".tmp"
    with io.open(tmp, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, USER_PATH)             # atomic on both Windows and POSIX
    log.info("config saved - set: %s / reset: %s",
             ", ".join(sorted(clean)) or "-", ", ".join(sorted(remove)) or "-")
    return load(force=True)
