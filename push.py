"""
Web Push - a notification on the phone's lock screen when a pane needs you.

The use case: you hand claude a task in a pane, put the phone down, and want to know when it stops
to ask something. A claude hook (Notification / Stop) POSTs /api/push/send; this module sends it to
every browser that turned notifications on (Settings > General), and the service worker (sw.js)
shows it. Tapping it opens webterm on that pane.

    hook -> POST /api/push/send -> pywebpush -> FCM / Mozilla / Apple -> sw.js -> notification

Optional: pywebpush is imported lazily, so a missing package turns this feature off (the settings
panel says so) instead of stopping the server.

Two files next to config.json, both .gitignored:
    push-vapid.pem   - the VAPID key pair, made on first use. Subscriptions are bound to its public
                       key, so deleting it silently orphans every phone (they must subscribe again).
    push-subs.json   - one entry per subscribed browser (endpoint + keys + device name).
"""
import json
import logging
import os
import threading
import time

import config

log = logging.getLogger("webterm.push")

KEY_PATH = os.path.join(config.BASE, "push-vapid.pem")
SUBS_PATH = os.path.join(config.BASE, "push-subs.json")

# The `sub` claim of the VAPID JWT: a contact for the push service operator. Required by the spec,
# never checked by FCM. A generic value on purpose - this goes to a third party.
DEFAULT_CONTACT = "mailto:webterm@example.com"

# How long the push service keeps a message for a phone it can't reach right now. pywebpush's default
# is 0 = "deliver now or drop", and a phone in Doze is exactly the phone that isn't reachable now.
TTL = 3600

_lock = threading.Lock()            # sends run in worker threads; the subs file is shared
_vapid = None


class Unavailable(Exception):
    """pywebpush is not installed - the feature is off, not broken."""


def _lib():
    try:
        import pywebpush            # noqa: F401
        from py_vapid import Vapid, b64urlencode
    except ImportError as e:
        raise Unavailable(f"pywebpush is not installed ({e.name}) - pip install pywebpush") from e
    return Vapid, b64urlencode


def available():
    try:
        _lib()
        return True
    except Unavailable:
        return False


def _key():
    """The VAPID key, created on first use."""
    global _vapid
    if _vapid is None:
        Vapid, _ = _lib()
        with _lock:
            if not os.path.exists(KEY_PATH):
                v = Vapid()
                v.generate_keys()
                # 0600 from the start: it is a private key.
                fd = os.open(KEY_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                os.close(fd)
                v.save_key(KEY_PATH)
                log.info("push: new VAPID key %s", KEY_PATH)
            _vapid = Vapid.from_file(KEY_PATH)
    return _vapid


def public_key():
    """applicationServerKey for pushManager.subscribe (base64url, uncompressed EC point)."""
    from cryptography.hazmat.primitives import serialization as s
    _, b64urlencode = _lib()
    raw = _key().public_key.public_bytes(s.Encoding.X962, s.PublicFormat.UncompressedPoint)
    return b64urlencode(raw)


def _load():
    try:
        with open(SUBS_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    return [x for x in data if isinstance(x, dict) and isinstance(x.get("sub"), dict)
            and x["sub"].get("endpoint")] if isinstance(data, list) else []


def _save(subs):
    tmp = SUBS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(subs, fh, ensure_ascii=False)
    os.replace(tmp, SUBS_PATH)


def subscribe(sub, dev="", cid=""):
    """Store one browser's subscription. Same endpoint, or the same browser (cid) with a new
    endpoint after the old one rotated -> replaced, not added."""
    ep = sub.get("endpoint")
    if not ep or not isinstance(sub.get("keys"), dict):
        raise ValueError("not a push subscription")
    with _lock:
        subs = [x for x in _load() if x["sub"]["endpoint"] != ep and not (cid and x.get("cid") == cid)]
        subs.append({"sub": sub, "dev": dev[:40], "cid": cid[:64], "at": time.time()})
        _save(subs)
        return len(subs)


def unsubscribe(endpoint="", cid=""):
    with _lock:
        subs = _load()
        left = [x for x in subs if x["sub"]["endpoint"] != endpoint and not (cid and x.get("cid") == cid)]
        if len(left) != len(subs):
            _save(left)
        return len(subs) - len(left)


def devices():
    return [{"dev": x.get("dev", ""), "cid": x.get("cid", ""), "at": x.get("at")} for x in _load()]


def send(title, body, url="/", tag="webterm", only_cid=""):
    """Send to every subscribed browser (or one). Blocking - call it from a thread.

    Returns (sent, removed). Subscriptions the push service calls gone (404/410: the user revoked
    the permission or cleared the site) are dropped; any other failure keeps it for next time."""
    from pywebpush import WebPushException, webpush
    vapid = _key()
    subs = _load()
    targets = [x for x in subs if not only_cid or x.get("cid") == only_cid]
    payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag}, ensure_ascii=False)
    claims = {"sub": (config.load().get("pushContact") or DEFAULT_CONTACT)}
    sent, dead = 0, set()
    for x in targets:
        try:
            webpush(subscription_info=x["sub"], data=payload, vapid_private_key=vapid,
                    vapid_claims=dict(claims), ttl=TTL, timeout=10,
                    # "high" lets FCM wake a phone in Doze; a pane waiting on you is worth it.
                    headers={"Urgency": "high"})
            sent += 1
        except WebPushException as e:
            code = getattr(getattr(e, "response", None), "status_code", None)
            if code in (404, 410):
                dead.add(x["sub"]["endpoint"])
            else:
                log.warning("push to %s failed (%s): %s", x.get("dev") or "?", code, e)
        except Exception as e:
            log.warning("push to %s failed: %r", x.get("dev") or "?", e)
    if dead:
        with _lock:
            _save([x for x in _load() if x["sub"]["endpoint"] not in dead])
    return sent, len(dead)
