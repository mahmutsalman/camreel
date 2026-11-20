#!/bin/bash
# Sum %CPU of THIS project's Electron processes (main + GPU + renderers + 4 guests)
# every 2 s for ~20 s. %CPU is per core: 100 = one full core.
# usage: scripts/measure-cpu.sh <config.json>
cd "$(dirname "$0")/.."
CFG="${1:-scripts/config-standin-4.json}"
scripts/prove.sh "$CFG" '{"out":"proof","prefix":"cpu","shots":[0],"holdMs":30000,"loadTimeoutMs":15000,"settleMs":500}' 75 >/dev/null 2>&1 &
RUNNER=$!
# wait for the guests to load (hold starts after the first shot)
for i in $(seq 1 60); do [ -f proof/cpu-1.png ] && [ proof/cpu-1.png -nt "$CFG" ] && break; sleep 0.5; done
sleep 2
SUMS=()
for i in $(seq 1 10); do
  S=$(ps -axo pcpu=,command= | grep "StreamTogetherCycle/node_modules/electron" | grep -v grep | awk '{s+=$1} END {printf "%.1f", s}')
  N=$(pgrep -f "StreamTogetherCycle/node_modules/electron" | wc -l | tr -d ' ')
  echo "t=$((i*2))s  processes=$N  cpu=${S}%"
  SUMS+=("$S")
  sleep 2
done
printf '%s\n' "${SUMS[@]}" | sort -n | awk '{a[NR]=$1; s+=$1} END {printf "avg %.1f%%  worst %.1f%%  (n=%d)\n", s/NR, a[NR], NR}'
echo "per process at the end:"
ps -axo pcpu=,rss=,command= | grep "StreamTogetherCycle/node_modules/electron" | grep -v grep | awk '{t=$3; for(i=4;i<=NF;i++) if ($i ~ /^--type=/) t=$i; printf "  %5s%%  %6d MB  %s\n", $1, $2/1024, t}'
wait $RUNNER
