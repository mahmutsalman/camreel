'use strict';
// Proof mode. Never used on stream. Two forms:
//  shots:  STC_PROOF='{"out":"proof","prefix":"b","shots":[0,3000,6000]}'
//          waits for the guests, captures the window at those moments, then quits.
//  steps:  STC_PROOF='{"out":"proof","prefix":"dead","steps":[...]}' a script:
//          {"wait":ms} · {"shot":"name"} · {"http":"url"} · {"writeConfig":{...}} ·
//          {"writeRaw":"text"} · {"until":{"shown":N}|{"name":"x","live":"alive"},"timeoutMs":ms}
//          Every step records a snapshot (card states, positions; never a URL), and a
//          timeline of state changes is kept. A separate checker judges the result.
// Optional: "keyTest": true, "holdMs": ms (keep running, e.g. for CPU measurement).
const fs = require('fs');
const path = require('path');
const http = require('http');
const { webContents, app: electronApp, BrowserWindow } = require('electron');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { redact } = require('./redact');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve(b)); }).on('error', (e) => resolve('error ' + e.message));
  });
}

async function run({ app, win, cfg, log, PROOF, CONFIG_FILE }) {
  const out = path.resolve(PROOF.out || 'proof');
  const prefix = PROOF.prefix || 'b';
  fs.mkdirSync(out, { recursive: true });
  const result = { prefix, background: cfg.window.background, shots: [], steps: [], timeline: [] };
  const snap = () => win.webContents.executeJavaScript('window.__stc.snapshot()');
  const t0 = Date.now();
  try {
    await new Promise((r) => win.once('ready-to-show', r));
    fs.writeFileSync(path.join(out, `${prefix}-window.json`), JSON.stringify({ mediaSourceId: win.getMediaSourceId(), pid: process.pid }));
    await sleep(300);
    if (PROOF.debug) await win.webContents.executeJavaScript('window.__stc.showDebug(true)');

    // timeline: every state change, sampled 4x a second
    let lastKey = '';
    const timer = setInterval(async () => {
      try {
        const s = await snap();
        const key = s.cards.map((c) => `${c.name}:${c.live}/${c.mode}`).join(' ');
        if (key !== lastKey) { lastKey = key; result.timeline.push({ atMs: Date.now() - t0, cards: key, configError: s.configError }); }
      } catch {}
    }, 250);

    const shoot = async (name) => {
      // a still strip: wait until the cards have arrived (pixels and positions from the same moment)
      if (PROOF.waitSettled) { const end = Date.now() + 20000; while (Date.now() < end && !(await snap()).settled) await sleep(200); }
      const img = await win.webContents.capturePage();
      const file = path.join(out, `${prefix}-${name}.png`);
      fs.writeFileSync(file, img.toPNG());
      const bmp = img.toBitmap(); // BGRA
      const s = await snap();
      s.osr = await win.webContents.executeJavaScript('window.__stc.osrStats ? window.__stc.osrStats() : null');
      s.pixels = require('./proof-pixels').analyze(img, s);
      result.shots.push({ name, file: path.relative(process.cwd(), file), atMs: Date.now() - t0, size: img.getSize(),
        cornerAlpha: bmp[3], cornerRGB: [bmp[2], bmp[1], bmp[0]], ...s });
      log(`proof shot ${name}`);
    };

    if (PROOF.shots) {
      // wait until every guest is alive (or 20 s)
      const until = Date.now() + (PROOF.loadTimeoutMs || 20000);
      while (Date.now() < until) { const s = await snap(); if (s.cards.length && s.cards.every((c) => c.live !== 'loading')) break; await sleep(250); }
      await sleep(PROOF.settleMs || 1000);
      const start = Date.now();
      for (let i = 0; i < PROOF.shots.length; i++) {
        const wait = start + PROOF.shots[i] - Date.now();
        if (wait > 0) await sleep(wait);
        await shoot(String(i + 1));
      }
    }

    // cover sampler: is the strip still drawing, is the guest video still moving?
    let coverTimer = null;
    if (PROOF.coverSample) {
      result.samples = [];
      coverTimer = setInterval(async () => {
        try {
          const s = await snap();
          result.samples.push({ t: Date.now() - t0, covered: !!global.__cover, minimized: win.isMinimized(), frameRuns: s.frameRuns,
            guests: s.cards.map((c) => { const m = /t=([\d.]+) f=(\d+)/.exec(c.video || ''); return m ? { t: Number(m[1]), f: Number(m[2]), mode: c.mode } : { mode: c.mode }; }) });
        } catch {}
      }, 1000);
    }
    // visibility sampler (the strip-parking experiment): every signal, twice a second
    let visTimer = null;
    if (PROOF.visSample) {
      result.vis = [];
      const winfo = PROOF.visSample.winfo;
      visTimer = setInterval(async () => {
        if (win.isDestroyed()) return;
        const row = { t: Date.now() - t0, isVisible: win.isVisible(), isMinimized: win.isMinimized(), isFocused: win.isFocused(),
          bounds: win.getBounds() };
        try { row.doc = await win.webContents.executeJavaScript('({ v: document.visibilityState, h: document.hidden, f: document.hasFocus() })'); } catch {}
        if (winfo) row.cg = await new Promise((r) => execFile(winfo, [win.getTitle()], (e, out) => { try { r(JSON.parse(out).filter((w) => w.owner === 'Electron')); } catch { r(null); } }));
        result.vis.push(row);
      }, 500);
    }
    for (const step of PROOF.steps || []) {
      const rec = { step: redact(JSON.stringify(step)).slice(0, 200), atMs: Date.now() - t0 };
      if (step.action === 'cover') {
        // my own opaque window exactly over the strip (same app: Stage Manager does not park it)
        const b = win.getBounds();
        global.__cover = new BrowserWindow({ x: b.x, y: b.y, width: b.width, height: b.height, frame: false, backgroundColor: '#202020', show: false, title: 'cover' });
        global.__cover.loadURL('data:text/html,<body style="background:#202020"></body>');
        global.__cover.show(); global.__cover.focus(); global.__cover.moveTop();
      }
      if (step.action === 'uncover' && global.__cover) { global.__cover.destroy(); global.__cover = null; }
      if (step.stripShot) {
        const id = String(win.getMediaSourceId()).split(':')[1];
        const file = path.join(out, `${prefix}-${step.stripShot}.png`);
        await new Promise((r) => execFile('/usr/sbin/screencapture', ['-x', '-o', `-l${id}`, file], () => r()));
        rec.shot = { file: path.relative(process.cwd(), file), md5: fs.existsSync(file) ? crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex') : null };
        if (global.__cover) rec.coveredWhenShot = true;
      }
      if (step.inspect) {
        // every guest page: does Twitch's name tag exist, and is it hidden? (no URL is ever recorded)
        const code = "(() => { const e = document.querySelector('.guest-star-browser-source-nameplate'); if (!e) return { found: false, title: document.title.slice(0, 40) }; const cs = getComputedStyle(e); return { found: true, display: cs.display, w: e.offsetWidth, h: e.offsetHeight, sheets: document.styleSheets.length, frames: document.querySelectorAll('iframe').length, title: document.title.slice(0, 40) }; })()";
        rec.guests = [];
        for (const wc of webContents.getAllWebContents()) {
          if (wc.getType() !== 'webview' && !(wc.getType() === 'window' && wc.getOwnerBrowserWindow && wc.getOwnerBrowserWindow() && !wc.getOwnerBrowserWindow().isVisible() && wc.isOffscreen && wc.isOffscreen())) continue;
          try { rec.guests.push({ type: wc.getType(), id: wc.id, ...(await wc.executeJavaScript(code)) }); } catch (e) { rec.guests.push({ id: wc.id, error: String(e.message).slice(0, 80) }); }
        }
        rec.stripCss = await win.webContents.executeJavaScript('window.__stc.cssState ? window.__stc.cssState() : null');
      }
      if (step.inspectRules) {
        // which rules set "display" on Twitch's name tag, and with what priority (selectors only)
        const code = "(() => { const e = document.querySelector('.guest-star-browser-source-nameplate'); if (!e) return null; const out = []; for (const sh of document.styleSheets) { let rules; try { rules = sh.cssRules; } catch { continue; } for (const r of rules) { try { if (r.selectorText && e.matches(r.selectorText) && r.style.display) out.push({ sel: r.selectorText.slice(0, 80), display: r.style.display, prio: r.style.getPropertyPriority('display') }); } catch {} } } return { inline: e.getAttribute('style'), rules: out, computed: getComputedStyle(e).display }; })()";
        rec.rules = [];
        for (const wc of webContents.getAllWebContents()) if (wc.getType() === 'webview') { try { rec.rules.push(await wc.executeJavaScript(code)); } catch (e) { rec.rules.push({ error: e.message }); } }
      }
      if (step.reloadGuests) for (const wc of webContents.getAllWebContents()) if (wc.getType() === 'webview') wc.reload();
      if (step.action === 'minimize') win.minimize();
      if (step.action === 'restore') win.restore();
      if (step.action === 'focus') { electronApp.focus({ steal: true }); win.show(); win.focus(); }
      if (step.action === 'hide') win.hide();
      if (step.action === 'show') win.show();
      if (step.sh) await new Promise((r) => execFile('/bin/sh', ['-c', step.sh], () => r()));
      if (step.wait) await sleep(step.wait);
      if (step.http) rec.reply = await get(step.http);
      if (step.writeConfig) fs.writeFileSync(CONFIG_FILE, JSON.stringify(step.writeConfig, null, 2));
      if (step.writeRaw !== undefined) fs.writeFileSync(CONFIG_FILE, step.writeRaw);
      if (step.patchLayout) { const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); c.layout = { ...(c.layout || {}), ...step.patchLayout }; fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); }
      if (step.patchWindow) { const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); c.window = { ...(c.window || {}), ...step.patchWindow }; fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); }
      if (step.userResize) { const [w, h] = win.getSize(); win.setSize(w + 200, h); await sleep(300); } // what a drag on the edge does (refused when not resizable? see contentSize)
      if (step.until) {
        const end = Date.now() + (step.timeoutMs || 15000);
        rec.met = false;
        while (Date.now() < end) {
          const s = await snap();
          const u = step.until;
          const ok = u.shown !== undefined ? s.cards.filter((c) => c.mode === 'shown').length === u.shown
            : s.cards.some((c) => c.name === u.name && (!u.live || c.live === u.live) && (!u.mode || c.mode === u.mode));
          if (ok) { rec.met = true; break; }
          await sleep(100);
        }
        rec.tookMs = Date.now() - t0 - rec.atMs;
      }
      if (step.shot) await shoot(step.shot);
      rec.snapshot = await snap();
      rec.resizable = win.isResizable(); rec.contentSize = win.getContentSize();
      result.steps.push(rec);
    }
    clearInterval(timer);
    if (visTimer) clearInterval(visTimer);
    if (coverTimer) clearInterval(coverTimer);
    if (PROOF.keyTest) {
      result.keys = await keyTest(win);
      // Esc must NOT quit any more (one stray key must never end a broadcast)
      await sleep(1500);
      result.keys.escapeKeptRunning = !win.isDestroyed();
    }
    if (PROOF.holdMs) { log(`holding ${PROOF.holdMs} ms for measurement`); await sleep(PROOF.holdMs); }
  } catch (e) {
    result.error = redact(e);
  }
  fs.writeFileSync(path.join(out, `${prefix}-result.json`), redact(JSON.stringify(result, null, 2)));
  app.quit();
}

// Keys sent the way a real keyboard arrives (sendInputEvent), into BOTH the app page
// and a guest page, because a click puts the keyboard focus inside a guest.
async function keyTest(win) {
  const press = (wc, keyCode) => { wc.sendInputEvent({ type: 'keyDown', keyCode }); wc.sendInputEvent({ type: 'keyUp', keyCode }); };
  const hidden = () => win.webContents.executeJavaScript('document.getElementById("debug").hidden');
  const guest = webContents.getAllWebContents().find((w) => w.getType() === 'webview');
  const frames = () => guest.executeJavaScript('window.__frames ?? -1');
  const out = {};
  const h0 = await hidden();
  press(win.webContents, 'D'); await sleep(400);
  out.dFromApp = { before: h0, after: await hidden() };
  press(guest, 'D'); await sleep(400);
  out.dFromGuest = { before: out.dFromApp.after, after: await hidden() };
  const f0 = await frames(); await sleep(300);
  press(guest, 'R'); await sleep(2000);
  const f1 = await frames();
  out.rFromGuest = { framesBefore: f0, framesAfterReload: f1, reloaded: f1 >= 0 && f1 < f0 };
  press(guest, 'Escape'); press(win.webContents, 'Escape');
  return out;
}

module.exports = { run };
