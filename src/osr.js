'use strict';
// OFFSCREEN guests (render mode "offscreen", the way OBS does a Browser Source):
// each guest page is a hidden, offscreen BrowserWindow (still a top-level page: no
// iframe, no header changes) painting at a FIXED frame rate (30) into a GPU texture.
// Each frame's texture is handed to the strip renderer without a CPU copy
// (sharedTexture: import → send → VideoFrame → canvas) and released at once.
// A parked (hidden) guest keeps running at 2 fps and its frames are not sent.
//   "offscreen"        GPU shared texture (default)
//   "offscreen-bitmap" the CPU path: paint bitmap copied over IPC (for comparison)
const { BrowserWindow, sharedTexture } = require('electron');

const FPS = 30;

const PARKED_FPS = 2;

class OsrGuests {
  constructor({ getStrip, log, onLoad, attachKeys, bitmap }) {
    this.getStrip = getStrip;
    this.log = log;
    this.onLoad = onLoad;           // (id, state) -> strip
    this.attachKeys = attachKeys;
    this.bitmap = !!bitmap;
    this.map = new Map();           // id -> guest
    this.stats = { painted: 0, sent: 0, dropped: 0, errors: 0 };
  }

  open({ id, url, width, height, muted }) {
    if (this.map.has(id)) return;
    const win = new BrowserWindow({
      show: false, width, height, useContentSize: true, frame: false, paintWhenInitiallyHidden: true,
      webPreferences: {
        offscreen: this.bitmap ? true : { useSharedTexture: true },
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: process.env.STC_SABOTAGE === 'throttle' || process.env.STC_BG_THROTTLE === '1', autoplayPolicy: 'no-user-gesture-required', partition: 'persist:guests',
      },
    });
    const wc = win.webContents;
    // starts parked (2 fps, frames not sent) until the strip sees it live and shows its card
    const g = { id, win, active: false, busy: false };
    this.map.set(id, g);
    wc.setFrameRate(PARKED_FPS);
    wc.setAudioMuted(!!muted);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.attachKeys(wc);
    // the mirror CSS lives in the page: a reload/navigation drops it, so put it back
    wc.on('dom-ready', () => { const want = g.css || {}; g.cssKeys = {}; for (const [name, css] of Object.entries(want)) this.setCss(id, name, css, true); });
    wc.on('did-start-loading', () => this.onLoad(id, 'loading'));
    wc.on('did-stop-loading', () => this.onLoad(id, 'loaded'));
    wc.on('did-fail-load', (_e, code, desc, _u, isMain) => {
      if (!isMain || code === -3) return;
      this.onLoad(id, `failed ${code} ${desc}`);
      setTimeout(() => { if (!wc.isDestroyed()) wc.reload(); }, 10000);
    });
    wc.on('render-process-gone', (_e, d) => {
      this.onLoad(id, `crashed (${d.reason})`);
      setTimeout(() => { if (!wc.isDestroyed()) wc.reload(); }, 3000);
    });
    wc.on('paint', (e, dirty, image) => (this.bitmap ? this.paintBitmap(g, image) : this.paintTexture(g, e.texture)));
    wc.loadURL(url).catch(() => {}); // failures arrive as did-fail-load (never log the url)
  }

  async paintTexture(g, tex) {
    if (!tex) return;
    this.stats.painted++;
    const strip = this.getStrip();
    // Only one frame per guest in flight: a slow consumer drops frames, never piles them up.
    if (!g.active || g.busy || !strip || strip.isDestroyed()) { this.stats.dropped++; tex.release(); return; }
    g.busy = true;
    let imported = null;
    try {
      imported = sharedTexture.importSharedTexture({ textureInfo: tex.textureInfo, allReferencesReleased: () => tex.release() });
      await sharedTexture.sendSharedTexture({ frame: strip.webContents.mainFrame, importedSharedTexture: imported }, g.id);
      this.stats.sent++;
    } catch (err) {
      this.stats.errors++;
      if (this.stats.errors < 5) this.log('offscreen frame not delivered: ' + err.message);
    } finally {
      if (imported) imported.release(); else tex.release();
      g.busy = false;
    }
  }

  paintBitmap(g, image) {
    this.stats.painted++;
    const strip = this.getStrip();
    if (!g.active || !strip || strip.isDestroyed()) { this.stats.dropped++; return; }
    const size = image.getSize();
    strip.webContents.send('stc:osr-bitmap', { id: g.id, width: size.width, height: size.height, data: image.toBitmap() });
    this.stats.sent++;
  }

  close(id) {
    const g = this.map.get(id);
    if (!g) return;
    this.map.delete(id);
    if (!g.win.isDestroyed()) g.win.destroy();
  }

  // CSS inserted INTO the guest page by name (mirror the video, hide Twitch's name tag);
  // a reload/navigation drops it, so dom-ready puts every wanted one back
  async setCss(id, name, css, want) {
    const g = this.map.get(id);
    if (!g || g.win.isDestroyed()) return;
    g.css = g.css || {}; g.cssKeys = g.cssKeys || {};
    if (want) g.css[name] = css; else delete g.css[name];
    const wc = g.win.webContents;
    try {
      if (want && !g.cssKeys[name]) g.cssKeys[name] = await wc.insertCSS(css, { cssOrigin: process.env.STC_SABOTAGE === 'css-author' ? 'author' : 'user' });
      if (!want && g.cssKeys[name]) { const k = g.cssKeys[name]; delete g.cssKeys[name]; await wc.removeInsertedCSS(k); }
    } catch { delete g.cssKeys[name]; }
  }

  setActive(id, active) {
    const g = this.map.get(id);
    if (!g || g.active === active) return;
    g.active = active;
    if (!g.win.isDestroyed()) g.win.webContents.setFrameRate(active ? FPS : PARKED_FPS);
  }

  resize(width, height) {
    for (const g of this.map.values()) if (!g.win.isDestroyed()) g.win.setContentSize(width, height);
  }

  exec(id, code) {
    const g = this.map.get(id);
    if (!g || g.win.isDestroyed()) return Promise.resolve([]);
    return g.win.webContents.executeJavaScript(code);
  }

  forEachContents(fn) { for (const g of this.map.values()) if (!g.win.isDestroyed()) fn(g.win.webContents); }
  closeAll() { for (const id of [...this.map.keys()]) this.close(id); }
}

module.exports = { OsrGuests, FPS };
