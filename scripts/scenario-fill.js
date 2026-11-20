'use strict';
// "The guest's picture fills the card": 4 stand-in guests (each draws a colour band across its
// whole bottom); in the strip's own capture, the bottom rows of every visible card's picture
// must be picture, not black. (0.2.1 shipped with display:block on the webview: Twitch's video
// sat in the top ~64 % with black below.)
//   node scripts/scenario-fill.js
//   STC_RENDER=offscreen node scripts/scenario-fill.js
//   STC_SABOTAGE=webview-block node scripts/scenario-fill.js   → must FAIL
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const TAG = [process.env.STC_RENDER, process.env.STC_SABOTAGE].filter(Boolean).join('-');
const PREFIX = 'fill' + (TAG ? '-' + TAG : '');
const S = process.env.STANDIN_URL || 'http://127.0.0.1:8777';
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'camreel-fill-'));
fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({
  sources: [1, 2, 3, 4].map((n) => ({ url: `${S}/guest?n=${n}&auth=FAKE-TOKEN-${n}`, name: `G${n}` })),
  layout: { cycleSeconds: 0, cardWidth: 300 }, window: { width: 480, height: 1080 } }, null, 2));
const get = (url) => new Promise((r) => http.get(url, (res) => { res.resume(); res.on('end', () => r(true)); }).on('error', () => r(false)));

(async () => {
  let server = null;
  if (!(await get(`${S}/states`))) { server = spawn(process.execPath, [path.join(ROOT, 'standin/server.js')], { stdio: 'ignore', env: { ...process.env, STANDIN_PORT: new URL(S).port } }); await new Promise((r) => setTimeout(r, 800)); }
  for (const n of [1, 2, 3, 4]) await get(`${S}/control?n=${n}&state=alive`);
  fs.rmSync(path.join(ROOT, 'proof', `${PREFIX}-result.json`), { force: true }); // never judge a stale result
  spawnSync(path.join(ROOT, 'scripts/prove.sh'), ['', JSON.stringify({ out: path.join(ROOT, 'proof'), prefix: PREFIX, shots: [3000], waitSettled: true }), '90'],
    { encoding: 'utf8', env: { ...process.env, STC_USERDATA: ud, STC_CONFIG: '' } });
  if (server) server.kill();
  let failed = 1;
  try {
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'proof', `${PREFIX}-result.json`), 'utf8'));
    const px = r.shots[0].pixels;
    const names = Object.keys(px);
    const bad = names.filter((n) => !(px[n].bottomFill >= 0.9));
    console.log(`cards checked: ${names.length} · bottom rows filled: ${names.map((n) => `${n} ${px[n].bottomFill}`).join(', ')}`);
    console.log(`picture: proof/${PREFIX}-1.png`);
    failed = names.length === 4 && bad.length === 0 ? 0 : 1;
    console.log(failed ? `RESULT FAIL (black at the bottom of: ${bad.join(', ') || 'fewer than 4 cards visible'})` : 'RESULT PASS 4/4 cards filled');
  } catch (e) { console.log('RESULT FAIL (could not judge):', e.message); }
  process.exit(failed);
})();
