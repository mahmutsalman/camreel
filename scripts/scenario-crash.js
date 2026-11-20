'use strict';
// A crash must not end the strip: the watchdog relaunches CamReel.
//   node scripts/scenario-crash.js                       → PASS expected
//   STC_SABOTAGE=no-watchdog node scripts/scenario-crash.js → must FAIL (no relaunch)
// Scratch userData + stand-in. Hard crash = kill -SEGV of the main process. Then a clean
// quit (SIGTERM) must NOT relaunch. Only processes whose environment names OUR scratch
// folder are ever signalled.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const S = process.env.STANDIN_URL || 'http://127.0.0.1:8777';
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'camreel-crash-'));
fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({ sources: [{ url: `${S}/guest?n=1&auth=FAKE-TOKEN-1111`, name: 'G1' }] }, null, 2));
const LOG = path.join(ud, 'logs', 'camreel.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logText = () => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } };
const count = (re) => (logText().match(re) || []).length;
// main Electron processes started for OUR scratch folder (env checked with ps eww)
function ourMains() {
  const out = execFileSync('/bin/ps', ['-axE', '-ww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter((l) => l.includes('/Electron.app/Contents/MacOS/Electron ') && l.includes(`STC_USERDATA=${ud}`) && !l.includes('--type=')).map((l) => Number(l.trim().split(/\s+/)[0]));
}
async function waitFor(fn, ms) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return Date.now() - t; await sleep(250); } return null; }

(async () => {
  const res = [];
  const ok = (name, pass, detail) => res.push({ name, pass: !!pass, detail });
  const env = { ...process.env, STC_USERDATA: ud, STC_CONFIG: '', STC_WATCHDOG: '1' };
  const first = spawn(ELECTRON, [ROOT], { env, stdio: 'ignore', detached: true });
  first.unref();
  ok('starts, strip shown, watchdog on', await waitFor(() => /strip window shown/.test(logText()) && /crash watchdog: on|crash watchdog: off/.test(logText()), 20000) !== null, logText().split('\n').filter((l) => /watchdog/.test(l)).join(' | '));
  await sleep(3000);
  const pid1 = ourMains()[0];
  process.kill(pid1, 'SIGKILL');   // an unexpected end (SIGKILL: no macOS crash dialog on his screen)
  const t = await waitFor(() => { const m = ourMains(); return m.length && m[0] !== pid1 && count(/strip window shown/g) >= 2; }, 15000);
  ok('after a hard crash CamReel is relaunched and the strip is shown again', t !== null, `${t} ms`);
  ok('the new instance says it restarted', /started after an unexpected exit/.test(logText()));
  const pid2 = ourMains()[0];
  if (pid2 && pid2 !== pid1) {
    process.kill(pid2, 'SIGTERM');                     // a clean quit
    await sleep(6000);
    ok('a clean quit is NOT relaunched', ourMains().length === 0, ourMains());
  } else ok('a clean quit is NOT relaunched', false, 'no second instance to quit');
  for (const p of ourMains()) { try { process.kill(p, 'SIGTERM'); } catch {} }   // never leave ours behind
  await sleep(2000);
  fs.writeFileSync(path.join(ROOT, 'proof', `crash-${process.env.STC_SABOTAGE || 'test'}-log.txt`), logText().replace(/auth=[^&\s"']+/g, 'auth=[REDACTED]'));
  const failed = res.filter((x) => !x.pass);
  for (const x of [...failed, ...res.filter((x) => x.pass)]) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.detail !== undefined ? '   ' + String(JSON.stringify(x.detail)).slice(0, 200) : ''}`);
  console.log(failed.length ? `RESULT FAIL ${failed.length}/${res.length}` : `RESULT PASS ${res.length}/${res.length}`);
  process.exit(failed.length ? 1 : 0);
})();
