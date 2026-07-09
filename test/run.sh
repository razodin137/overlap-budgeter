#!/usr/bin/env bash
# Permanent test harness for overlap-budgeter (no build, vanilla JS).
# Serves the repo root over HTTP and runs the assertion suite in headless
# chromium against the real app (loaded in an iframe, same-origin so the
# harness can reach the app's top-level globals). Prints a pass/fail summary.
#
# Usage: bash test/run.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8099}"
CHROME="${CHROME:-/usr/bin/chromium-browser}"

cd "$ROOT"
python3 -m http.server "$PORT" --bind 127.0.0.1 >/tmp/ob-srv.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1

"$CHROME" --headless=new --disable-gpu --no-sandbox --virtual-time-budget=6000 \
  --dump-dom "http://127.0.0.1:$PORT/test/harness.html" 2>/dev/null \
| python3 -c '
import sys, re, html
dom = sys.stdin.read()
title = re.search(r"<title>(.*?)</title>", dom)
print("TITLE:", html.unescape(title.group(1)) if title else "?")
s = re.search(r"id=\"__summary\"[^>]*>(.*?)</div>", dom, re.S)
r = re.search(r"id=\"__results\"[^>]*>(.*?)</div>", dom, re.S)
print(html.unescape((s.group(1) if s else "").strip()))
print(html.unescape((r.group(1) if r else "").strip()))
if "ALL PASS" not in (s.group(1) if s else ""):
    sys.exit(1)
'