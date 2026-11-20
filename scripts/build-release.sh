#!/bin/bash
# The build friends get, Mac AND Windows, WITH the update feed inside. Low CPU priority.
#   scripts/build-release.sh                     only from branch "publish", with nothing uncommitted
#   PLATFORMS=win scripts/build-release.sh       only one of them (mac | win | "mac win", default both)
#   ALLOW_BRANCH=1 scripts/build-release.sh      a trial build from another branch (never publish it)
# Output: dist-release/<version>/
#   mac: CamReel-<v>-universal.dmg · CamReel-<v>-universal-mac.zip · latest-mac.yml   (signed + notarized)
#   win: CamReel-Setup-<v>.exe · CamReel-Setup-<v>.exe.blockmap · latest.yml           (NOT signed: SmartScreen asks once)
# Cost: several minutes of CPU, and the Mac notarization UPLOADS the app to Apple (hundreds of MB):
# ask before running it while you are streaming. The Windows build uploads nothing.
set -euo pipefail
cd "$(dirname "$0")/.."
FEED="$HOME/.camreel/update-feed.json"
VER=$(node -p "require('./package.json').version")
BRANCH=$(git branch --show-current)
PLATFORMS="${PLATFORMS:-mac win}"
if [ -z "${ALLOW_BRANCH:-}" ]; then
  [ "$BRANCH" = "publish" ] || { echo "STOP: friends' builds come from branch 'publish' (this is '$BRANCH')."; exit 1; }
  [ -z "$(git status --porcelain)" ] || { echo "STOP: uncommitted changes. A friend's build must be exactly a commit."; exit 1; }
fi
[ -f "$FEED" ] || { echo "STOP: $FEED is missing (the update address + login). Without it the build can never update itself."; exit 1; }
node scripts/test-seats.js && node scripts/test-updater.js && node scripts/test-redact.js >/dev/null && node scripts/test-styles.js >/dev/null
trap 'rm -f src/update-feed.json' EXIT
install -m 600 "$FEED" src/update-feed.json
OUT="dist-release/$VER"; mkdir -p "$OUT"
git rev-parse HEAD > "$OUT/commit.txt"; echo "$BRANCH" > "$OUT/branch.txt"

if [[ " $PLATFORMS " == *" mac "* ]]; then
  rm -rf dist
  APPLE_KEYCHAIN_PROFILE="${APPLE_KEYCHAIN_PROFILE:-your-notary-profile}" taskpolicy -b npx electron-builder --mac --universal --publish never
  DMG=$(ls dist/*.dmg | head -1); ZIP=$(ls dist/*-mac.zip | head -1); YML=dist/latest-mac.yml
  [ -f "$DMG" ] && [ -f "$ZIP" ] && [ -f "$YML" ] || { echo "FAIL mac: dmg, zip or latest-mac.yml is missing in dist/"; exit 1; }
  grep -q "^version: $VER$" "$YML" || { echo "FAIL mac: latest-mac.yml is not version $VER"; exit 1; }
  APP=$(ls -d dist/mac-universal/*.app | head -1)
  codesign --verify --deep --strict "$APP" || { echo "FAIL mac: the app's signature does not verify"; exit 1; }
  spctl -a -t exec -vv "$APP" 2>&1 | grep -q "Notarized Developer ID" || { echo "FAIL mac: the app is not notarized (spctl)"; exit 1; }
  npx asar list "$APP/Contents/Resources/app.asar" | grep -q "update-feed.json" || { echo "FAIL mac: the update feed is not inside the app"; exit 1; }
  cp "$DMG" "$ZIP" "$YML" "$OUT/"
  echo "BUILT mac $VER"
fi

if [[ " $PLATFORMS " == *" win "* ]]; then
  rm -rf dist
  taskpolicy -b npx electron-builder --win --x64 --publish never
  EXE="dist/CamReel-Setup-$VER.exe"; YML=dist/latest.yml
  [ -f "$EXE" ] && [ -f "$EXE.blockmap" ] && [ -f "$YML" ] || { echo "FAIL win: installer, blockmap or latest.yml is missing in dist/"; ls dist; exit 1; }
  grep -q "^version: $VER$" "$YML" || { echo "FAIL win: latest.yml is not version $VER"; exit 1; }
  grep -q "CamReel-Setup-$VER.exe" "$YML" || { echo "FAIL win: latest.yml does not name CamReel-Setup-$VER.exe"; exit 1; }
  npx asar list dist/win-unpacked/resources/app.asar | grep -q "update-feed.json" || { echo "FAIL win: the update feed is not inside the app"; exit 1; }
  cp "$EXE" "$EXE.blockmap" "$YML" "$OUT/"
  echo "BUILT win $VER"
fi

echo "BUILT $VER ($PLATFORMS) from $BRANCH @ $(cut -c1-7 "$OUT/commit.txt") → $OUT"
ls -lh "$OUT"
echo "NEXT: open the dmg, RUN this exact build yourself, then scripts/publish-release.sh $VER"
