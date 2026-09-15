#!/bin/sh
# Update winterm-web in place (macOS / Linux).
#
#     sh tools/update.sh
#
# Two install shapes exist and only one of them can pull:
#   - cloned with git        -> git pull
#   - unpacked from a zip    -> no .git at all, so re-download and unpack over the top
#
# It deliberately does NOT restart anything. Which process needs restarting depends on what
# changed, and one of the answers closes every shell you have open - see the banner in the app,
# or the summary this prints at the end.
set -eu

cd "$(dirname "$0")/.."
ROOT=$(pwd)
echo "winterm-web update  ($ROOT)"
echo

before_server=$(python3 -c 'import version; print(version.server_code())' 2>/dev/null || echo "?")
before_daemon=$(python3 -c 'import version; print(version.daemon_code())' 2>/dev/null || echo "?")

if [ -d .git ]; then
  echo "== git pull =="
  git pull --ff-only
else
  echo "== downloading the latest zip (this install has no .git) =="
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/src.zip" \
    https://github.com/somoo1995/winterm-web/archive/refs/heads/main.zip
  # `tar` reads zip on macOS and on Windows 10+; --strip-components drops the wrapper folder.
  tar -xf "$tmp/src.zip" -C "$tmp"
  inner=$(find "$tmp" -maxdepth 1 -type d -name 'winterm-web-*' | head -n 1)
  # config.json and logs live here too - copy only what the archive actually ships.
  (cd "$inner" && tar cf - .) | tar xf - -C "$ROOT"
  rm -rf "$tmp"
fi

echo
echo "== dependencies =="
if [ -d .venv ]; then
  # shellcheck disable=SC1091
  . .venv/bin/activate
fi
python3 -m pip install -q -r requirements.txt
echo "ok"

after_server=$(python3 -c 'import version; print(version.server_code())' 2>/dev/null || echo "?")
after_daemon=$(python3 -c 'import version; print(version.daemon_code())' 2>/dev/null || echo "?")

echo
echo "== what to restart =="
if [ "$before_daemon" != "$after_daemon" ]; then
  echo "  SESSION DAEMON changed -> restarting it CLOSES EVERY SHELL."
  echo "      pkill -f 'daemon.py'   then start the server again"
elif [ "$before_server" != "$after_server" ]; then
  echo "  Web server changed -> restart it. Your open shells survive."
  echo "      Ctrl+C the server, then:  python3 server.py"
else
  echo "  No Python change - reload the page in the browser and you are done."
fi
echo "  (The app also shows this as a banner once you reload.)"
