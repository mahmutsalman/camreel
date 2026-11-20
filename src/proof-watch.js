'use strict';
// Strip-parking detection, end to end: minimize / Stage Manager park / hide the strip,
// expect the yellow bar in Settings + yellow tray within 2 s, press "Bring strip back"
// with a REAL click, expect the bar gone and the strip drawn full size again.
// The Stage Manager park uses a window of OUR OWN test app (tools/cover/camreel-cover),
// never one of his apps, and quits it afterwards. Never used on stream.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { redact } = require('./redact');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => new Promise((r) => execFile('/bin/sh', ['-c', cmd], (e, out) => r(String(out || '').trim())));

async function run({ app, getStrip, getSettings, getState, getTray, getGeo, log, PROOF, CONFIG_FILE }) {
  const out = path.resolve(PROOF.out || 'proof');
  const prefix = PROOF.prefix || 'watch';
  const r = { cases: [] };
  const S = () => getSettings().webContents;
  const banner = () => S().executeJavaScript('window.__settings.stripBanner()');
  async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return Date.now() - t0; } catch {} await sleep(100); } return null; }
  async function click(sel) {
    const pt = await S().executeJavaScript(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || e.offsetParent === null) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
    if (!pt) return false;
    S().sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
    S().sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    S().sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    return true;
  }
  async function shot(name) {
    for (const [n, w] of [['settings', getSettings()]]) {
      if (!w || w.isDestroyed()) continue;
      fs.writeFileSync(path.join(out, `${prefix}-${name}-${n}.png`), (await w.webContents.capturePage()).toPNG());
    }
  }
  const { spawn } = require('child_process');
  const COVER = path.join(__dirname, '..', 'tools', 'cover', 'camreel-cover');
  let cover = null;
  const startCover = (x, y, w, h) => { cover = spawn(COVER, [x, y, w, h].map(String), { stdio: 'ignore' }); };
  const stopCover = () => { if (cover) { cover.kill('SIGTERM'); cover = null; } };
  async function oneCase(name, makeBad) {
    const c = { name };
    await makeBad();
    c.bannerAfterMs = await waitFor(async () => !!(await banner()), 4000);
    c.banner = await banner();
    c.state = getState();
    c.trayWarn = getTray().warn;
    c.geoWhileBad = getGeo();
    await shot(name);
    c.clicked = await click('#bringBack');
    c.goneAfterMs = await waitFor(async () => !(await banner()) && getState() === 'ok', 4000);
    await sleep(600);
    c.stateAfter = getState();
    c.trayWarnAfter = getTray().warn;
    c.geoAfter = getGeo();
    r.cases.push(c);
  }

  try {
    await waitFor(async () => getSettings() && (await S().executeJavaScript('!!(window.__settings && window.__settings.stripBanner)')), 10000);
    // start from a strip drawn at full size
    app.focus({ steal: true }); getStrip().show(); getStrip().focus();
    r.startOk = (await waitFor(() => getState() === 'ok' && getGeo() && getGeo().w >= 400, 6000)) !== null;
    r.startGeo = getGeo();
    r.hintShown = await S().executeJavaScript('!document.getElementById("stripHint").hidden');

    await oneCase('minimize', async () => getStrip().minimize());
    r.stageManager = (await sh('defaults read com.apple.WindowManager GloballyEnabled')) === '1';
    if (!r.stageManager) r.cases.push({ name: 'stage-manager-park', skipped: 'Stage Manager is off on this Mac right now (not changed by the test)' });
    else await oneCase('stage-manager-park', async () => {
      // Stage Manager is per display: our cover window opens ON the strip's display
      const b = getStrip().getBounds();
      startCover(b.x + 20, Math.max(b.y, 0) + 60, 400, 300); // our own app comes forward on the strip's display
    });
    stopCover();
    await oneCase('hide', async () => getStrip().hide());

    // "Keep strip visible": does an always-on-top strip survive another app coming forward?
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    cfg.window = cfg.window || {};
    cfg.window.keepVisible = true;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    await sleep(1500);
    { const b = getStrip().getBounds(); startCover(b.x + 20, Math.max(b.y, 0) + 60, 400, 300); }
    await sleep(3000);
    r.keepVisible = { state: getState(), geo: getGeo(), onTop: getStrip().isAlwaysOnTop() };
  } catch (e) {
    r.error = redact(e);
  } finally {
    stopCover();
    r.coverClosed = cover === null;
  }
  fs.writeFileSync(path.join(out, `${prefix}-result.json`), JSON.stringify(r, null, 2));
  log('watch test done');
  app.quit();
}

module.exports = { run };
