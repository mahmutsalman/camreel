'use strict';
// The update rules (src/updater.js) with a FAKE updater: no network, no Electron.
//   U1 the app never restarts by itself: quitAndInstall is called only by install(), only when an update is ready
//   U2 no feed / not packaged → off: nothing is configured, no check is ever made
//   U3 the login never reaches a log line or the state the Settings window gets
//   U4 a failed check shows nothing (state goes back to idle); a ready update survives later errors
//   U5 downgrades are off
//   U6 the feed file: https only, bad files → off
//   node scripts/test-updater.js                       → PASS
//   STC_SABOTAGE=auto-restart node scripts/...         → must FAIL (U1)
//   STC_SABOTAGE=log-login    node scripts/...         → must FAIL (U3)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { loadFeed, createUpdater } = require('../src/updater.js');
const SAB = process.env.STC_SABOTAGE || '';
const fails = [];
let checks = 0;
const check = (ok, msg) => { checks++; if (!ok) fails.push(msg); };

const FEED = { url: 'https://example.invalid/app/update/', user: 'friend', pass: 'FAKE-PASS-12345' };
const B64 = Buffer.from('friend:FAKE-PASS-12345').toString('base64');

function rig(opts = {}) {
  const au = new EventEmitter();
  au.calls = { check: 0, install: 0, feed: null };
  au.checkForUpdates = () => { au.calls.check++; return opts.checkRejects ? Promise.reject(new Error(`401 for https://example.invalid/ with Authorization: Basic ${B64}`)) : Promise.resolve(null); };
  au.quitAndInstall = () => { au.calls.install++; };
  au.setFeedURL = (o) => { au.calls.feed = o; };
  const logs = [];
  const states = [];
  const timers = [];
  const order = [];
  const up = createUpdater({
    autoUpdater: au, feed: 'feed' in opts ? opts.feed : FEED, packaged: 'packaged' in opts ? opts.packaged : true, currentVersion: '0.3.4',
    log: (m) => logs.push(SAB === 'log-login' ? m.replace('[REDACTED]', B64) : m), onState: (s) => states.push(s),
    beforeInstall: () => order.push('before'), setTimer: (fn) => timers.push(fn), setEvery: (fn) => timers.push(fn),
  });
  if (SAB === 'auto-restart') au.on('update-downloaded', () => au.quitAndInstall());
  const origInstall = au.quitAndInstall; au.quitAndInstall = () => { order.push('install'); origInstall(); };
  return { au, up, logs, states, timers, order };
}
const leak = (r) => JSON.stringify([r.logs, r.states]).includes('FAKE-PASS') || JSON.stringify([r.logs, r.states]).includes(B64);

// U2: off
for (const [why, o] of [['no feed', { feed: null }], ['not packaged', { packaged: false }]]) {
  const r = rig(o);
  check(r.up.start() === false, `U2 ${why}: start() must say off`);
  check(r.au.calls.feed === null && r.timers.length === 0, `U2 ${why}: nothing configured, no timer`);
  r.up.check();
  check(r.au.calls.check === 0, `U2 ${why}: no check is made`);
  check(r.up.state().phase === 'off' && r.up.install() === false && r.au.calls.install === 0, `U2 ${why}: stays off, install does nothing`);
}

// the normal life: start → check → available → progress → downloaded → (later) the user clicks
{
  const r = rig();
  check(r.up.start() === true, 'start() with a feed in a packaged build');
  check(r.au.calls.feed && r.au.calls.feed.provider === 'generic' && r.au.calls.feed.url === FEED.url, 'the feed address is set');
  check(r.au.requestHeaders && r.au.requestHeaders.Authorization === 'Basic ' + B64, 'the login is sent as a header');
  check(r.au.autoDownload === true && r.au.autoInstallOnAppQuit === true, 'downloads by itself, installs at the next quit');
  check(r.au.allowDowngrade === false, 'U5 downgrades are off');
  check(r.au.logger === null, 'U3 the updater\'s own logger is off');
  check(r.timers.length === 2 && r.au.calls.check === 0, 'two timers (first check, repeat), no check before they fire');
  r.timers[0]();
  check(r.au.calls.check === 1, 'the first timer makes one check');
  check(r.up.install() === false && r.au.calls.install === 0, 'U1 install() before anything is downloaded does nothing');
  r.au.emit('checking-for-update');
  r.au.emit('update-available', { version: '0.3.5' });
  r.au.emit('download-progress', { percent: 41.6 });
  check(r.up.state().phase === 'downloading' && r.up.state().percent === 42 && r.up.state().version === '0.3.5', `downloading 42 %: ${JSON.stringify(r.up.state())}`);
  r.timers[1]();
  check(r.au.calls.check === 1, 'no second check while downloading');
  r.au.emit('update-downloaded', { version: '0.3.5' });
  check(r.up.state().phase === 'ready' && r.up.state().version === '0.3.5', 'ready after the download');
  check(r.au.calls.install === 0, 'U1 a finished download does NOT restart the app');
  for (let i = 0; i < 50; i++) { r.timers[1](); r.au.emit('checking-for-update'); r.au.emit('update-not-available'); r.au.emit('error', new Error('offline')); }
  check(r.au.calls.install === 0, 'U1 50 more timer rounds: still no restart');
  check(r.up.state().phase === 'ready', 'U4 a ready update survives later checks and errors');
  check(r.up.install() === true && r.au.calls.install === 1, 'U1 the user\'s click installs, once');
  check(JSON.stringify(r.order) === '["before","install"]', `the clean-exit hook runs BEFORE the restart: ${JSON.stringify(r.order)}`);
  check(r.states.every((s) => s.current === '0.3.4'), 'every state carries the running version');
  check(!leak(r), 'U3 no login in logs or states (normal life)');
}

// U3 + U4: errors that carry the login
{
  const r = rig({ checkRejects: true });
  r.up.start();
  r.timers[0]();
  r.au.emit('checking-for-update');
  r.au.emit('error', new Error(`cannot fetch https://friend:FAKE-PASS-12345@example.invalid/latest-mac.yml (Authorization: Basic ${B64})`));
  setImmediate(() => setImmediate(() => {
    check(r.logs.some((l) => /check failed/.test(l)), 'a failed check is logged');
    check(!leak(r), `U3 the login is redacted in error text: ${JSON.stringify(r.logs).replace(/FAKE-PASS-12345/g, '<PASS>').replace(new RegExp(B64, 'g'), '<B64>')}`);
    check(r.up.state().phase === 'idle' && !('error' in r.up.state()), 'U4 a failed check leaves the state idle, with no error to show');
    feedFile();
    done();
  }));
}

// U6
function feedFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camreel-feed-'));
  const f = path.join(dir, 'update-feed.json');
  const put = (o) => fs.writeFileSync(f, typeof o === 'string' ? o : JSON.stringify(o));
  check(loadFeed(path.join(dir, 'missing.json')) === null, 'U6 no file → off');
  put('{ not json'); check(loadFeed(f) === null, 'U6 broken file → off');
  put({ url: 'http://example.invalid/update' }); check(loadFeed(f) === null, 'U6 http is refused');
  put({ url: 'https://example.invalid' }); check(loadFeed(f) === null, 'U6 a bare host with no folder is refused');
  put({ url: 'https://example.invalid/app/update' }); { const x = loadFeed(f); check(x && x.url === 'https://example.invalid/app/update/' && !x.user, 'U6 https, no login: fine, slash added'); }
  put(FEED); { const x = loadFeed(f); check(x && x.user === 'friend' && x.pass === FEED.pass, 'U6 https with a login'); }
  put({ url: FEED.url, user: 'friend' }); { const x = loadFeed(f); check(x && !x.user && !x.pass, 'U6 half a login is no login'); }
  fs.rmSync(dir, { recursive: true, force: true });
}

function done() {
  if (fails.length) { console.log(`RESULT FAIL: ${fails.length} of ${checks} checks`); for (const x of fails) console.log('  ✗ ' + x); process.exit(1); }
  console.log(`RESULT PASS: ${checks} checks`);
}
