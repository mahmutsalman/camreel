'use strict';
// A COVERED strip must keep drawing (the stream captures it from the window server).
//   node scripts/scenario-covered.js            all variants (each ~45 s; normal priority: the
//                                               measurement is the frame rate, which taskpolicy
//                                               -b itself would throttle). Do not run while live.
// Variant "default" must PASS; "throttle" (every defence off) is the sabotage.
// Also: the strip MINIMIZED (what keeps running, what stops), reported, not judged.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const S = process.env.STANDIN_URL || 'http://127.0.0.1:8777';
const get = (url) => new Promise((r) => http.get(url, (res) => { res.resume(); res.on('end', () => r(true)); }).on('error', () => r(false)));
const VARIANTS = (process.env.VARIANTS || 'default,throttle,bg-only,switches-off,minimized').split(',');
const ENV = {
  default: {},
  throttle: { STC_SABOTAGE: 'throttle' },                       // every defence off
  'bg-only': { STC_BG_THROTTLE: '1' },                          // backgroundThrottling on, switches kept
  'switches-off': { STC_OMIT_SWITCHES: 'disable-renderer-backgrounding,disable-background-timer-throttling,disable-backgrounding-occluded-windows' },
  minimized: {},
};

function steps(variant) {
  const bad = variant === 'minimized' ? { action: 'minimize' } : { action: 'cover' };
  const good = variant === 'minimized' ? { action: 'restore' } : { action: 'uncover' };
  return [
    { action: 'focus' }, { wait: 6000, stripShot: 'before', tag: 'visible' },
    { ...bad, tag: 'bad-start' }, { wait: 5000 }, { stripShot: 'bad-1' }, { wait: 5000 }, { stripShot: 'bad-2' }, { wait: 10000, tag: 'bad-end' },
    { ...good, tag: 'bad-stop' }, { wait: 3000, tag: 'after' },
  ];
}

function judge(variant, r) {
  const at = (tag) => (r.steps.find((s) => s.step.includes(`"tag":"${tag}"`)) || {}).atMs;
  const s0 = at('bad-start'), s1 = at('bad-stop');
  const inBad = r.samples.filter((x) => x.t > s0 + 1500 && x.t <= s1);
  const before = r.samples.filter((x) => x.t > at('visible') + 2000 && x.t <= s0);
  const rate = (xs) => xs.length > 1 ? (xs.at(-1).frameRuns - xs[0].frameRuns) / ((xs.at(-1).t - xs[0].t) / 1000) : 0;
  const gT = (xs) => xs.length > 1 && xs.at(-1).guests[0] && xs[0].guests[0] ? (xs.at(-1).guests[0].t - xs[0].guests[0].t) / ((xs.at(-1).t - xs[0].t) / 1000) : null;
  const gF = (xs) => xs.length > 1 && xs.at(-1).guests[0] && xs[0].guests[0] ? (xs.at(-1).guests[0].f - xs[0].guests[0].f) / ((xs.at(-1).t - xs[0].t) / 1000) : null;
  const shots = Object.fromEntries(r.steps.filter((s) => s.shot).map((s) => [s.step.match(/"stripShot":"([^"]+)"/)[1], s.shot.md5]));
  return {
    variant,
    loopPerSecVisible: +rate(before).toFixed(1), loopPerSecBad: +rate(inBad).toFixed(1),
    guestVideoSecPerSecBad: gT(inBad) === null ? null : +gT(inBad).toFixed(2),
    guestFramesPerSecBad: gF(inBad) === null ? null : +gF(inBad).toFixed(1),
    badSeconds: Math.round((s1 - s0) / 1000),
    hiddenSeenByPage: r.vis ? r.vis.filter((v) => v.t > s0 + 1500 && v.t <= s1).some((v) => v.doc && v.doc.h) : null,
    windowPictureChanged: !!(shots['bad-1'] && shots['bad-2'] && shots['bad-1'] !== shots['bad-2']),
    pictureCaptured: !!(shots['bad-1'] && shots['bad-2']),
  };
}

(async () => {
  let server = null;
  if (!(await get(`${S}/states`))) { server = spawn(process.execPath, [path.join(ROOT, 'standin/server.js')], { stdio: 'ignore', env: { ...process.env, STANDIN_PORT: new URL(S).port } }); await new Promise((r) => setTimeout(r, 800)); }
  await get(`${S}/control?n=1&state=alive`);
  const rows = [];
  for (const v of VARIANTS) {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'camreel-cover-'));
    // a strip that FITS on the screen (700 tall, top-left of the main display), so the cover hides all of it
    fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ sources: [{ url: `${S}/guest?n=1&auth=FAKE-TOKEN-1111`, name: 'G1' }], layout: { cycleSeconds: 10, cardWidth: 400 }, window: { width: 480, height: 700, x: 80, y: 60 } }, null, 2));
    const proof = { out: path.join(ROOT, 'proof'), prefix: `covered-${v}`, coverSample: true, visSample: {}, steps: steps(v) };
    fs.rmSync(path.join(ROOT, 'proof', `covered-${v}-result.json`), { force: true }); // never judge a stale result
    spawnSync(path.join(ROOT, 'scripts/prove.sh'), ['', JSON.stringify(proof), '120'], { encoding: 'utf8', env: { ...process.env, ...ENV[v], STC_USERDATA: userData, STC_CONFIG: '', STC_NORMAL_PRIORITY: '1' } });
    try { rows.push(judge(v, JSON.parse(fs.readFileSync(path.join(ROOT, 'proof', `covered-${v}-result.json`), 'utf8')))); }
    catch (e) { rows.push({ variant: v, error: e.message }); }
    console.log(JSON.stringify(rows.at(-1)));
  }
  if (server) server.kill();
  fs.writeFileSync(path.join(ROOT, 'proof', 'covered-summary.json'), JSON.stringify(rows, null, 2));
  // the verdict: the default strip, covered 20 s, must keep drawing and its guest moving
  const d = rows.find((x) => x.variant === 'default');
  const pass = (x) => x && x.loopPerSecBad >= 20 && x.guestVideoSecPerSecBad >= 0.8 && x.windowPictureChanged;
  console.log(`default covered: ${pass(d) ? 'PASS' : 'FAIL'}`);
  for (const x of rows.filter((x) => x.variant !== 'default' && x.variant !== 'minimized')) console.log(`${x.variant} (sabotage) covered: ${pass(x) ? 'still PASSES (this defence did not matter)' : 'FAILS (this defence matters)'}`);
})();
