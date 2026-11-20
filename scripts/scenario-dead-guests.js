'use strict';
// The dead-guest + live-config proof, end to end, against the local stand-in.
//   node scripts/scenario-dead-guests.js            → proof/dead-*.png + proof/dead-result.json, PASS/FAIL per check
//   STC_SABOTAGE=always-alive node scripts/...      → the liveness check is OFF: must go red
// Uses a SCRATCH config file (never config.json). Fake tokens only.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PREFIX = process.env.STC_SABOTAGE ? 'dead-sabotage' : 'dead';
const S = process.env.STANDIN_URL || 'http://127.0.0.1:8777';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-scenario-'));
const CFG = path.join(scratch, 'config.json');

const guest = (n, name) => ({ url: `${S}/guest?n=${n}&display=single&auth=FAKE-TOKEN-${n}${n}${n}${n}`, name });
const base = {
  hideWhenDead: true, deadAfterSeconds: 4, showAfterSeconds: 1,
  layout: { side: 'right', cardWidth: 380, cycleSeconds: 10 },
  window: { width: 1920, height: 1080, background: '#00ff00' }, lookVersion: 2,
};
const cfg1 = { ...base, sources: [guest(1, 'G1'), guest(2, 'G2'), guest(3, 'G3'), guest(4, 'G4'), { url: `${S}/novideo?n=9&auth=FAKE-TOKEN-9999`, name: 'NoCam' }] };
const cfg2 = { ...base, sources: [guest(1, 'G1 renamed'), guest(2, 'G2'), guest(3, 'G3'), { url: `${S}/novideo?n=9&auth=FAKE-TOKEN-9999`, name: 'NoCam' }, guest(5, 'G5')] };
fs.writeFileSync(CFG, JSON.stringify(cfg1, null, 2));

const ctl = (n, state) => ({ http: `${S}/control?n=${n}&state=${state}` });
const steps = [
  { until: { shown: 4 }, timeoutMs: 25000 },
  { wait: 5000, shot: '1-four-alive' },
  { ...ctl(2, 'stop'), tag: 'kill2' },
  { until: { name: 'G2', mode: 'parked' }, timeoutMs: 12000, shot: '2-g2-killed' },
  { wait: 1500, shot: '2b-still-cycling' },
  { wait: 4000 },                                       // G2 stays parked a while
  { ...ctl(2, 'alive'), tag: 'revive2' },
  { until: { name: 'G2', mode: 'shown' }, timeoutMs: 12000 },
  { wait: 800, shot: '3-g2-back' },
  { ...ctl(3, 'blank') },
  { until: { name: 'G3', mode: 'parked' }, timeoutMs: 12000 },
  { ...ctl(3, 'alive') },
  { until: { name: 'G3', mode: 'shown' }, timeoutMs: 15000 },
  { ...ctl(4, 'remove') },
  { until: { name: 'G4', mode: 'parked' }, timeoutMs: 12000 },
  { ...ctl(4, 'alive') },
  { until: { name: 'G4', mode: 'shown' }, timeoutMs: 12000 },
  { writeConfig: cfg2, tag: 'edit' },
  { until: { name: 'G5', mode: 'shown' }, timeoutMs: 15000 },
  { wait: 800, shot: '4-config-edited' },
  { writeRaw: '{ "sources": [ { "url": "http://127.0.0.1:8765/guest?n=6&auth=FAKE-BROKEN-6666", ', tag: 'broken' },
  { wait: 2500, shot: '5-broken-json-kept' },
  { ...ctl(1, 'stop') }, { ...ctl(2, 'stop') }, { ...ctl(3, 'stop') }, { ...ctl(5, 'stop') },
  { until: { shown: 0 }, timeoutMs: 15000 },
  { wait: 800, shot: '6-none-alive' },
];

function get(url) { return new Promise((r) => http.get(url, (res) => { res.resume(); res.on('end', () => r(true)); }).on('error', () => r(false))); }

(async () => {
  let server = null;
  if (!(await get(`${S}/states`))) {
    server = spawn(process.execPath, [path.join(ROOT, 'standin/server.js')], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 800));
  }
  for (const n of [1, 2, 3, 4, 5]) await get(`${S}/control?n=${n}&state=alive`);
  const proof = { out: path.join(ROOT, 'proof'), prefix: PREFIX, debug: true, steps };
  fs.rmSync(path.join(ROOT, 'proof', `${PREFIX}-result.json`), { force: true }); // never judge a stale result
  const run = spawnSync(path.join(ROOT, 'scripts/prove.sh'), [CFG, JSON.stringify(proof), '180'], { encoding: 'utf8', env: process.env });
  const log = (run.stdout || '') + (run.stderr || '');
  fs.writeFileSync(path.join(ROOT, 'proof', `${PREFIX}-log.txt`), log.split('\n').filter((l) => l.includes('[stc]')).join('\n') + '\n');
  for (const n of [1, 2, 3, 4, 5]) await get(`${S}/control?n=${n}&state=alive`);
  let code = 1;
  try {
    const leaks = log.includes('FAKE-TOKEN') || fs.readFileSync(path.join(ROOT, 'proof', `${PREFIX}-result.json`), 'utf8').includes('FAKE-TOKEN');
    code = require('./check-dead-guests').check(path.join(ROOT, 'proof', `${PREFIX}-result.json`), leaks);
  } catch (e) { console.log('RESULT FAIL (could not judge):', e.message); }
  finally { if (server) server.kill(); fs.rmSync(scratch, { recursive: true, force: true }); }
  process.exit(code);
})();
