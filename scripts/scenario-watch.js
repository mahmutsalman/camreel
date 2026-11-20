'use strict';
// Strip-parking detection: node scripts/scenario-watch.js
//   STC_SABOTAGE=no-watch node scripts/scenario-watch.js   → detection off: must go red
// Scratch userData, one fake-token stand-in guest. Brings the strip to the front; the Stage
// Manager park uses our own test window app (scripts/build-cover.sh), never his apps.
// Do not run while he is live.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PREFIX = process.env.STC_SABOTAGE ? `watch-sabotage-${process.env.STC_SABOTAGE}` : 'watch';
const S = process.env.STANDIN_URL || 'http://127.0.0.1:8777';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'camreel-watch-'));
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ sources: [{ url: `${S}/guest?n=1&auth=FAKE-TOKEN-1111`, name: 'G1' }] }, null, 2));
const get = (url) => new Promise((r) => http.get(url, (res) => { res.resume(); res.on('end', () => r(true)); }).on('error', () => r(false)));

(async () => {
  let server = null;
  if (!(await get(`${S}/states`))) { server = spawn(process.execPath, [path.join(ROOT, 'standin/server.js')], { stdio: 'ignore', env: { ...process.env, STANDIN_PORT: new URL(S).port } }); await new Promise((r) => setTimeout(r, 800)); }
  const proof = { out: path.join(ROOT, 'proof'), prefix: PREFIX, watchTest: true, openSettings: true };
  fs.rmSync(path.join(ROOT, 'proof', `${PREFIX}-result.json`), { force: true }); // never judge a stale result
  const res = spawnSync(path.join(ROOT, 'scripts/prove.sh'), ['', JSON.stringify(proof), '120'], { encoding: 'utf8', env: { ...process.env, STC_USERDATA: userData, STC_CONFIG: '' } });
  const logs = ((res.stdout || '') + (res.stderr || '')).split('\n').filter((l) => l.includes('[camreel]'));
  fs.writeFileSync(path.join(ROOT, 'proof', `${PREFIX}-log.txt`), logs.join('\n') + '\n');
  if (server) server.kill();
  let code = 1;
  try { code = judge(JSON.parse(fs.readFileSync(path.join(ROOT, 'proof', `${PREFIX}-result.json`), 'utf8')), logs.join('\n')); }
  catch (e) { console.log('RESULT FAIL (could not judge):', e.message); }
  process.exit(code);
})();

function judge(r, log) {
  const res = [];
  const ok = (name, pass, detail) => res.push({ name, pass: !!pass, detail });
  if (r.error) ok('ran without error', false, r.error);
  ok('starts drawn full size', r.startOk, r.startGeo);
  ok('no "cannot detect" hint on this Mac (detection is available)', r.hintShown === false);
  for (const c of (r.cases || []).filter((c) => c.skipped)) console.log(`SKIP  ${c.name}: ${c.skipped}`);
  for (const c of (r.cases || []).filter((c) => !c.skipped)) {
    ok(`${c.name}: yellow bar in Settings within 2 s`, c.bannerAfterMs !== null && c.bannerAfterMs <= 2000, `${c.bannerAfterMs} ms · "${c.banner}" · state ${c.state} · drawn ${c.geoWhileBad && c.geoWhileBad.w}x${c.geoWhileBad && c.geoWhileBad.h}`);
    ok(`${c.name}: tray icon turns yellow`, c.trayWarn);
    ok(`${c.name}: "Bring strip back" (real click) → bar gone, strip full size`, c.clicked && c.goneAfterMs !== null && c.stateAfter === 'ok' && c.geoAfter && c.geoAfter.w >= 400 && c.geoAfter.onscreen, `${c.goneAfterMs} ms · ${c.stateAfter} · ${c.geoAfter && `${c.geoAfter.w}x${c.geoAfter.h}`}`);
    ok(`${c.name}: tray back to normal`, c.trayWarnAfter === false);
  }
  ok('log lines for every change', /strip window: ok -> (minimized|parked)/.test(log) && (!r.stageManager || /strip window: ok -> parked/.test(log)) && /strip window: ok -> hidden/.test(log) && /brought back/.test(log), log.split('\n').filter((l) => /strip window/.test(l)).join(' | '));
  ok('the test cover window (our own app) was closed', r.coverClosed);
  const failed = res.filter((x) => !x.pass);
  for (const x of [...failed, ...res.filter((x) => x.pass)]) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.detail !== undefined ? '   ' + String(JSON.stringify(x.detail)).slice(0, 220) : ''}`);
  console.log('keep strip visible (always on top) while another app comes forward:', JSON.stringify(r.keepVisible));
  console.log(failed.length ? `RESULT FAIL ${failed.length}/${res.length}` : `RESULT PASS ${res.length}/${res.length}`);
  return failed.length ? 1 : 0;
}
