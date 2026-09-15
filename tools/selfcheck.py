"""Self-check: does the PTY layer work on THIS machine?

    python3 tools/selfcheck.py

Opens real shells through pty_backend and exercises the whole contract - spawn, output,
non-ASCII, window title, resize, teardown - then prints one PASS/FAIL block you can paste back.

It talks to NO ports and starts NO daemon, so it cannot disturb a webterm that is already
running. Every shell it opens is its own child and is killed before it exits.
"""
import os
import sys
import threading
import time

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

fails = []
notes = []


def check(name, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {detail}" if detail else ""))
    if not cond:
        fails.append(name)


def wait_for(fn, secs=20.0, step=0.15):
    end = time.time() + secs
    while time.time() < end:
        try:
            if fn():
                return True
        except Exception:
            pass
        time.sleep(step)
    return False


print("=" * 72)
print("winterm-web self-check")
print(f"  python   : {sys.version.split()[0]}  ({sys.executable})")
print(f"  platform : {sys.platform}")
print("=" * 72)

# --- dependencies ---------------------------------------------------------
try:
    import pty_backend
except Exception as e:
    print(f"  FAIL  import pty_backend   {e!r}")
    sys.exit(1)

print(f"  detected : {pty_backend.platform_name()}")

try:
    pty_backend.check_supported()
    check("platform supported + PTY binding installed", True)
except Exception as e:
    check("platform supported + PTY binding installed", False, str(e).replace("\n", " / "))
    print("\nStop here - install dependencies first:  python3 -m pip install -r requirements.txt")
    sys.exit(1)

shell = os.environ.get("WEBTERM_SHELL") or pty_backend.default_shell()
print(f"  shell    : {shell!r}")
print("-" * 72)

from session import Session, SessionManager  # noqa: E402

# --- file:// URL parsing --------------------------------------------------
f = Session._path_from_file_url
if pty_backend.IS_WINDOWS:
    check("file:///C:/a/b -> drive path", f("file:///C:/a/b") == "C:\\a\\b", repr(f("file:///C:/a/b")))
else:
    check("file:///home/u/x keeps its root slash", f("file:///home/u/x") == "/home/u/x",
          repr(f("file:///home/u/x")))
check("non-file URL is ignored", f("http://x/y") is None)

# --- spawn ----------------------------------------------------------------
mgr = SessionManager()
s = mgr.create(name="selfcheck", cols=100, rows=30)
check("shell spawns and produces output", wait_for(lambda: s.alive and s.backlog()),
      f"cwd={s.cwd}")
if not s.alive:
    print("\nThe shell died immediately. Full output follows:\n")
    print(s.backlog()[-3000:])
    sys.exit(1)

# --- echo round trip ------------------------------------------------------
MARK = "SELFCHECK-OK-4417"
s.write(f"echo {MARK}\r")
check("input reaches the shell and output comes back",
      wait_for(lambda: s.backlog().count(MARK) >= 2))

# --- non-ASCII ------------------------------------------------------------
# On POSIX we read raw bytes, so a read landing mid-character would corrupt this.
KO = "hangul-probe-\ud55c\uae00"
s.write(f"echo {KO}\r")
ok = wait_for(lambda: s.backlog().count(KO) >= 2, 15)
check("multi-byte (UTF-8) output survives chunk boundaries", ok)
if not ok:
    notes.append("Non-ASCII failed. If the shell itself printed mojibake, check the locale "
                 "(LANG/LC_ALL should be a UTF-8 one, e.g. en_US.UTF-8).")

# --- window title (OSC) ---------------------------------------------------
# This is how a pane gets its "what is running here" label.
s.write("printf '\\033]0;TITLE-PROBE\\007'\r" if not pty_backend.IS_WINDOWS
        else "$host.UI.RawUI.WindowTitle = 'TITLE-PROBE'\r")
ok = wait_for(lambda: s.title == "TITLE-PROBE", 12)
check("OSC window title is captured", ok, f"title={s.title!r}")

# --- cwd reporting (OSC 7) ------------------------------------------------
# Windows injects an OSC 7 prompt; POSIX shells do not emit it by default, so a miss there is
# EXPECTED for now and only means a split opens in the pane's starting folder.
target = os.environ.get("SystemRoot", "C:\\Windows") if pty_backend.IS_WINDOWS else "/tmp"
s.write(f'cd "{target}"\r')
got_cwd = wait_for(lambda: os.path.normcase(os.path.realpath(s.cwd))
                   == os.path.normcase(os.path.realpath(target)), 12)
if pty_backend.IS_WINDOWS:
    check("OSC 7 cwd tracking", got_cwd, f"cwd={s.cwd!r}")
else:
    print(f"  {'PASS' if got_cwd else 'INFO'}  OSC 7 cwd tracking   "
          f"{'works' if got_cwd else 'not emitted by this shell (expected; splits will open in the start folder)'}")
    if not got_cwd:
        notes.append("OSC 7 is not emitted by this shell - known gap on POSIX, not a failure.")

# --- resize ---------------------------------------------------------------
s.resize(80, 24)
check("resize is recorded", (s.cols, s.rows) == (80, 24), f"{(s.cols, s.rows)}")
s.write("tput cols\r" if not pty_backend.IS_WINDOWS else "$Host.UI.RawUI.WindowSize.Width\r")
check("the shell itself sees the new width", wait_for(lambda: "80" in s.backlog()[-4000:], 12))

# --- concurrency ----------------------------------------------------------
s2 = mgr.create(name="selfcheck2", cols=90, rows=25)
check("a second shell runs alongside the first", wait_for(lambda: s2.alive and s2.backlog()))

# --- teardown -------------------------------------------------------------
sid, sid2 = s.sid, s2.sid
mgr.kill(sid)
mgr.kill(sid2)
check("shells stop when killed", not s.alive and not s2.alive)
check("manager forgets them", mgr.get(sid) is None and mgr.get(sid2) is None)
time.sleep(1.0)
left = [t.name for t in threading.enumerate() if t.name.startswith("pty-")]
check("reader threads exit (no leak)", not left, str(left))

# --- report ---------------------------------------------------------------
print("=" * 72)
if fails:
    print(f"FAILED ({len(fails)}):")
    for n in fails:
        print(f"  - {n}")
else:
    print("ALL PASSED")
for n in notes:
    print(f"NOTE: {n}")
print("=" * 72)
sys.exit(1 if fails else 0)
