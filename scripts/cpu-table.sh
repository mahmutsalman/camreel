#!/bin/bash
# CPU at several guest counts against the stand-in. usage: scripts/cpu-table.sh "4:420 8:300 12:240"
cd "$(dirname "$0")/.."
SPECS="${1:-4:420 8:300 12:240}"
TMP=$(mktemp -d)
node "$PWD/standin/server.js" >/dev/null 2>&1 & SERVER=$!
sleep 1
for spec in $SPECS; do
  for n in $(seq 1 20); do curl -s "http://127.0.0.1:8777/control?n=$n&state=alive" >/dev/null; done
  for k in ${KILL//,/ }; do curl -s "http://127.0.0.1:8777/control?n=$k&state=stop" >/dev/null; done
  N=${spec%%:*}; W=${spec##*:}
  node scripts/make-standin-config.js "$N" "$TMP/cpu$N.json" "$W" "${CYCLE:-24}"
  rm -f proof/cpu-1.png
  echo "== $N guests, cardWidth $W, cycle ${CYCLE:-24}s, killed [${KILL:-}] scale ${STC_SCALE:-1} perfOff [${STC_PERF_OFF:-}]"
  scripts/measure-cpu.sh "$TMP/cpu$N.json" | grep -E "avg|gpu-process"
  python3 -c "import json;r=json.load(open('proof/cpu-result.json'));s=r['shots'][0];print('   renderer fps',s['fps'],' shown',sum(c['mode']=='shown' for c in s['cards']),'/',len(s['cards']))"
done
kill $SERVER; rm -rf "$TMP"
