"""What code is actually RUNNING, versus what is on disk.

Updating webterm means three things can fall out of step independently, and they are fixed in
very different ways:

    browser JS      stale -> reload the page. Nothing is lost.
    web server      stale -> restart it. Every shell stays open (that is why it is a separate
                             process from the daemon).
    session daemon  stale -> restart it. EVERY SHELL DIES.

Static files are served straight off disk, so a `git pull` updates the UI instantly while the
Python processes keep running the old code. The symptom is a new-looking screen whose buttons
return 405 - twice in one afternoon (2026-09-15) that cost real debugging time, once to the
author and once to a teammate. Nothing on screen said which of the three was behind.

So: fingerprint each process's own files, capture the fingerprint at startup, and compare it with
disk. A hash rather than a version number because it cannot be forgotten - there is no constant to
remember to bump.
"""
import hashlib
import io
import os
import re

BASE = os.path.dirname(os.path.abspath(__file__))

# Which files belong to which process. The split is the whole point: it decides whether the user
# is told "restart, nothing is lost" or "restart, and your shells will close".
SERVER_FILES = ("server.py", "config.py", "daemon_client.py", "version.py", "updatecheck.py")
DAEMON_FILES = ("daemon.py", "session.py", "pty_backend.py", "envclean.py")


def _digest(names):
    h = hashlib.sha256()
    for name in sorted(names):
        try:
            with io.open(os.path.join(BASE, name), "rb") as f:
                raw = f.read()
        except OSError:
            # A missing file is itself a state worth distinguishing from an empty one.
            h.update(b"<missing:" + name.encode("ascii", "replace") + b">")
            continue
        # Normalise line endings before hashing. A checkout on Windows can rewrite LF to CRLF
        # with no semantic change, and here that would raise a false "restart the daemon" -
        # the one message that costs the user every open shell. Wrong in that direction is
        # expensive, so compare content, not bytes.
        h.update(raw.replace(b"\r\n", b"\n"))
    return h.hexdigest()[:12]


def server_code():
    return _digest(SERVER_FILES)


def daemon_code():
    return _digest(DAEMON_FILES)


def app_ver():
    """The APP_VER constant in static/app.js - the build the browser is meant to be running.

    Read from the file rather than duplicated here, so there is one place to bump.
    """
    try:
        with io.open(os.path.join(BASE, "static", "app.js"), encoding="utf-8") as f:
            src = f.read()
    except OSError:
        return 0
    # Whole file, not a head slice: the constant sits behind a long comment block and has already
    # drifted past the 4KB mark once, which silently reported version 0 and disabled the check.
    m = re.search(r"APP_VER\s*=\s*(\d+)", src)
    return int(m.group(1)) if m else 0
