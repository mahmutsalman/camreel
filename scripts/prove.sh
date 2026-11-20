#!/bin/bash
# Run the app once in proof mode (background priority), then make sure every Electron
# process WE started is gone. Matches only this project's Electron by command line.
# usage: scripts/prove.sh <config.json> '<STC_PROOF json>' [max seconds]
set -u
cd "$(dirname "$0")/.."
CFG="$1"; PROOF_JSON="$2"; MAX="${3:-60}"
ELECTRON="$PWD/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
[ -x "$ELECTRON" ] || node node_modules/electron/install.js   # Electron 44 downloads its binary lazily
PRE="taskpolicy -b"; [ -n "${STC_NORMAL_PRIORITY:-}" ] && PRE=""
STC_CONFIG="$CFG" STC_PROOF="$PROOF_JSON" $PRE "$ELECTRON" "$PWD" &
PID=$!
for ((i=0; i<MAX*4; i++)); do kill -0 $PID 2>/dev/null || break; sleep 0.25; done
if kill -0 $PID 2>/dev/null; then echo "timeout: stopping our Electron ($PID)"; kill $PID; sleep 2; fi
# helpers that outlived it (match this project's path only)
LEFT=$(pgrep -f "StreamTogetherCycle/node_modules/electron" || true)
if [ -n "$LEFT" ]; then echo "cleaning leftover helpers: $LEFT"; kill $LEFT 2>/dev/null; fi
wait $PID 2>/dev/null
exit 0
