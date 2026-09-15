"""Keep platform branches from spreading.

    python3 tools/check_platform_branches.py

One source tree, not one per OS. That only stays affordable while the OS-specific parts sit in
a few known files - measured at the time of writing, 6,400 lines carried 32 platform branches
and 13 of them were in pty_backend.py, which exists to hold them. session.py, the module that
actually drives the PTY, had two.

The danger is not the count, it is the spread. `if IS_WINDOWS: ... elif IS_MACOS: ...` sprinkled
through server.py is how a shared codebase turns into three codebases that happen to share a
directory. Clipboard, autostart and the installer are all still to come, and each is a chance to
do exactly that.

So: platform branches live in a *_backend.py module. Everything else asks that module.

This check is deliberately allowlist-based rather than zero-tolerance. The entries below are
real branches that predate the rule; they belong in a backend and should move when their area
gets one. Capping them means the debt cannot grow quietly, which is the part that matters.
"""
import io
import os
import re
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MARKERS = re.compile(r"\bIS_WINDOWS\b|\bIS_MACOS\b|\bsys\.platform\b|\bplatform\.system\b")

# Files allowed to branch freely - holding the branches is their job.
BACKENDS = re.compile(r"_backend\.py$")

# Files exempt for other reasons.
EXEMPT = {
    "version.py",                      # reports which code is running, not what it does
    os.path.join("tools", "selfcheck.py"),
    os.path.join("tools", "smoketest.py"),
    os.path.join("tools", "check_platform_branches.py"),
}

# Pre-existing branches, with the backend they should move to. Lower these, never raise them.
ALLOWED = {
    # Spawning a process differs per platform (creationflags vs start_new_session). Belongs
    # with the PTY/process concerns once there is a process_backend.
    "daemon_client.py": 4,
    # An import, plus file:// path semantics - "how does this platform spell a path".
    # Belongs in pty_backend alongside the other path handling.
    "session.py": 2,
}


def main():
    failures = []
    checked = 0
    for root, dirs, files in os.walk(BASE):
        dirs[:] = [d for d in dirs
                   if d not in (".git", "__pycache__", ".venv", "venv", "build", "dist", "_backup")]
        for name in sorted(files):
            if not name.endswith(".py"):
                continue
            rel = os.path.relpath(os.path.join(root, name), BASE)
            if BACKENDS.search(rel) or rel in EXEMPT:
                continue
            checked += 1
            try:
                with io.open(os.path.join(root, name), encoding="utf-8") as f:
                    hits = [(i, ln.rstrip()) for i, ln in enumerate(f, 1) if MARKERS.search(ln)]
            except OSError:
                continue
            budget = ALLOWED.get(rel, 0)
            if len(hits) > budget:
                failures.append((rel, budget, hits))

    print(f"checked {checked} files outside *_backend.py")
    if not failures:
        print("OK - no new platform branches outside a backend module")
        return 0

    print()
    for rel, budget, hits in failures:
        print(f"FAIL  {rel}: {len(hits)} platform branches, allowed {budget}")
        for i, ln in hits:
            print(f"        {i}: {ln.strip()[:96]}")
    print()
    print("Platform branches belong in a *_backend.py module, not scattered through the code.")
    print("Adding clipboard support? Create clipboard_backend.py and let the caller ask it,")
    print("the way session.py asks pty_backend instead of testing sys.platform itself.")
    print("If a branch genuinely cannot move, raise the file's budget in ALLOWED and say why.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
