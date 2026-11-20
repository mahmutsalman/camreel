'use strict';
// MIRROR, end to end, with real clicks in Settings and pixels from the strip:
// two stand-in guests (G1, G2), still strip. Phase 1: both normal → ⇋ on G1 → ⇋ off G1 →
// "Mirror all cameras" (G2 follows it, G1 keeps its own "off") → ⇋ on G1. Phase 2 (restart):
// both mirrored, from disk. Never used on stream.
const fs = require('fs');
const path = require('path');
const { Menu } = require('electron');
const { redact } = require('./redact');
const { analyze } = require('./proof-pixels');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ app, getStrip, getSettings, log, PROOF, CONFIG_FILE }) {
  const out = path.resolve(PROOF.out || 'proof');
  const prefix = PROOF.prefix || 'mirror';
  const r = { phase: PROOF.phase, states: {} };
  const S = () => getSettings().webContents;
  const strip = () => getStrip().webContents.executeJavaScript('window.__stc.snapshot()');
  const disk = () => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } };
  async function waitFor(fn, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch {} await sleep(150); } return false; }
  async function click(sel, i = 0) {
    const pt = await S().executeJavaScript(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${i}]; if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
    if (!pt) throw new Error('nothing to click: ' + sel);
    S().sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
    S().sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    S().sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  }
  async function look(tag) {
    await sleep(1500); // the class flips at once; give the compositor + a few video frames
    // compare like with like: wait until the cards have stopped settling (same position 1 s apart)
    r.settledWaitOk = (r.settledWaitOk !== false) && await waitFor(async () => (await strip()).settled, 30000);
    await sleep(400);
    const snap = await strip();
    const img = await getStrip().webContents.capturePage();
    fs.writeFileSync(path.join(out, `${prefix}-${tag}.png`), img.toPNG());
    const d = disk();
    r.states[tag] = { cards: analyze(img, snap), disk: { mirror: (d.sources || []).map((s) => s.mirror ?? null), mirrorAll: d.layout && d.layout.mirrorAll },
      rows: getSettings() ? await S().executeJavaScript('window.__settings.rows().filter((x) => !x.empty).map((x) => x.mirror)') : null };
  }
  try {
    if (PROOF.phase === 2) {
      Menu.getApplicationMenu().getMenuItemById('settings').click();
    }
    await waitFor(async () => getSettings() && (await S().executeJavaScript('!!window.__settings')), 10000);
    const want = PROOF.phase === 3 ? 1 : 2;
    if (PROOF.phase === 4) {
      // a real Twitch guest link (no token: no name tag on it) + a non-Twitch page, hide ON
      await sleep(28000); // the note needs 20 s with no tag since the page loaded (Twitch renders it late)
      r.rows4 = await S().executeJavaScript('window.__settings.rows().filter((x) => !x.empty).map((x) => ({ name: x.name, npNote: x.npNote }))');
      try { r.notFoundLogged = /Twitch's name tag not found/.test(fs.readFileSync(require('path').join(require('electron').app.getPath('userData'), 'logs', 'camreel.log'), 'utf8')); } catch { r.notFoundLogged = false; }
      fs.writeFileSync(path.join(out, `${prefix}-phase4.json`), redact(JSON.stringify(r, null, 2)));
      app.quit(); return;
    }
    r.bothShown = await waitFor(async () => (await strip()).cards.filter((c) => c.mode === 'shown').length === want, 25000);
    if (PROOF.phase === 1) {
      await look('A-normal');
      await click('.mirror', 0); await look('B-G1-mirrored');
      await click('.mirror', 0); await look('C-G1-normal-again');
      await click('input[data-k="layout.mirrorAll"]'); await look('D-mirror-all');
      await click('.mirror', 0); await look('E-G1-mirrored');
      // ONE save that renames G2 AND sets its mirror off (0.2.3 dropped the rename in this case)
      const d = disk(); d.sources[1].name = 'G2 renamed'; d.sources[1].mirror = false;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(d, null, 2));
      await sleep(1200); await look('E2-rename-and-unmirror');
      r.namesAfterE2 = (await strip()).cards.map((c) => c.name);
      d.sources[1].name = 'G2'; delete d.sources[1].mirror; fs.writeFileSync(CONFIG_FILE, JSON.stringify(d, null, 2)); // back to "follow Mirror all"
      await sleep(1200); await look('E3-G2-follows-all-again');
      // "Hide Twitch's name tag": mirror on + hide on -> no tag; off -> the tag is back (readable)
      await click('input[data-k="layout.hideTwitchName"]'); await look('I-mirror-and-hide');
      await click('input[data-k="layout.hideTwitchName"]'); await look('J-hide-off');
      await click('input[data-k="layout.hideTwitchName"]'); await look('K-hide-on-again'); // stays on: restart check
    } else if (PROOF.phase === 3) {
      // a page with NO <video>: the in-page mirror cannot work, so the whole card must flip
      await look('G-novideo-normal');
      await click('.mirror', 0); await sleep(4500); await look('H-novideo-mirrored');
      try { r.fallbackLogged = /mirror: page has no video, flipping the whole card/.test(fs.readFileSync(require('path').join(require('electron').app.getPath('userData'), 'logs', 'camreel.log'), 'utf8')); } catch { r.fallbackLogged = false; }
    } else {
      await look('F-after-restart');
    }
  } catch (e) { r.error = redact(e); }
  fs.writeFileSync(path.join(out, `${prefix}-phase${PROOF.phase}.json`), redact(JSON.stringify(r, null, 2)));
  log(`mirror test phase ${PROOF.phase} done`);
  app.quit();
}

module.exports = { run };
