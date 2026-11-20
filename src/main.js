'use strict';
// CamReel (was "Stream Together Cycle"). Two windows:
//  - the STRIP: nothing but the guest cards on the background. The only thing Meld captures.
//  - SETTINGS: a normal window (the sources table + layout). Closing it never quits.
// Each guest URL is loaded as its OWN top-level page in an Electron <webview> (a separate
// WebContents, not an iframe), so X-Frame-Options never applies. Headers are never touched
// (no webRequest rewriting, no proxy). Secrets (?auth=…) never reach a log: redact().
//
// The main process owns: the windows, the settings file (userData/config.json, atomic
// writes, also watched so a hand edit applies live; a broken save keeps the last good
// config), the keys, and each guest's load state. The strip decides which guests are
// ALIVE; it reports that here, and here forwards it to the settings window.

const { app, BrowserWindow, ipcMain, webContents, dialog, Menu, clipboard, Tray, nativeImage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { redact } = require('./redact');
const config = require('./config');
const store = require('./store');
const { APP_NAME } = require('./app-info');
const { OsrGuests } = require('./osr');
const { StripWatch } = require('./stripwatch');

// ---------------------------------------------------------------- never die quietly
// Logging can NEVER throw (an app started from a shell that has gone away has a closed
// stdout: writes fail with EPIPE). Every line also goes to <userData>/logs/camreel.log.
let logFile = null;
function appendLogFile(line) {
  try {
    if (!logFile) { logFile = path.join(app.getPath('userData'), 'logs', 'camreel.log'); fs.mkdirSync(path.dirname(logFile), { recursive: true }); }
    try { if (fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, logFile + '.1'); } catch {}
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}
function log(...a) {
  const line = '[camreel] ' + a.map((x) => redact(typeof x === 'string' ? x : x instanceof Error ? (x.stack || x.message) : JSON.stringify(x))).join(' ');
  try { console.log(line); } catch {}
  appendLogFile(line);
}
for (const s of [process.stdout, process.stderr]) { try { s.on('error', () => {}); } catch {} }
process.on('uncaughtException', (e) => { log('uncaught exception (the app keeps running):', e); });
process.on('unhandledRejection', (e) => { log('unhandled rejection (the app keeps running):', e); });

app.setName(APP_NAME);
// Tests point the app at a scratch folder: never at the real settings.
if (process.env.STC_USERDATA) app.setPath('userData', path.resolve(process.env.STC_USERDATA));
// Guests must play video + audio without a click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Paint colours exactly (no display colour profile), so the chroma-key green is really #00ff00.
app.commandLine.appendSwitch('force-color-profile', 'srgb');
// The strip must keep drawing when it is COVERED by another window (the stream captures it
// from the window server) and a hidden guest must keep playing so it can come back: never
// let Chromium treat the strip or a guest as a background page. Measured in
// proof/covered-*.json. Tests can drop each one: STC_OMIT_SWITCHES=a,b · STC_BG_THROTTLE=1 ·
// STC_SABOTAGE=throttle (all of them off).
const THROTTLE_SABOTAGE = process.env.STC_SABOTAGE === 'throttle';
const OMIT = new Set((process.env.STC_OMIT_SWITCHES || '').split(',').filter(Boolean));
const BG_THROTTLE = THROTTLE_SABOTAGE || process.env.STC_BG_THROTTLE === '1'; // tests only
for (const sw of ['disable-renderer-backgrounding', 'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows']) {
  if (!THROTTLE_SABOTAGE && !OMIT.has(sw)) app.commandLine.appendSwitch(sw);
}
// Draw the strip at 1 pixel per point: a 1080-tall strip is exactly 1080 pixels (a 1080p
// stream needs no more), and a Retina Mac draws 4x fewer pixels. STC_SCALE=2 to compare.
app.commandLine.appendSwitch('force-device-scale-factor', process.env.STC_SCALE || '1');

const APP_DIR = path.resolve(__dirname, '..');
const PROOF = process.env.STC_PROOF ? JSON.parse(process.env.STC_PROOF) : null;
const SABOTAGE = process.env.STC_SABOTAGE || '';
let CONFIG_FILE; // set when ready (userData needs the app name)

let cfg;            // the last GOOD config
let configError = null;
let strip = null;
let settings = null;
let tray = null;
let quitting = false;
let lastSig = '';
const guests = new Map();  // webContents id -> { id (card id), name, load }
const pending = new Map(); // webContents id -> latest load state, before the strip registers it
let status = {};           // url -> { live, load } (from the strip; only sent to the settings window)
let osr = null;            // offscreen guests (render mode "offscreen*")
let stripState = 'ok';     // ok | parked | minimized | hidden | closed | unknown (see stripwatch.js)
const watch = new StripWatch({
  log, disabled: SABOTAGE === 'no-watch',
  onChange: (st) => { stripState = st; sendToSettings('stc:strip-state', st); updateTray(); },
});
// How guests are drawn: "offscreen" (fixed 30 fps, GPU texture, like OBS) or "webview"
// (the original: visible <webview>s at the display rate). STC_RENDER overrides config "render".
const renderMode = () => process.env.STC_RENDER || (cfg && cfg.render) || 'webview';

// ---------------------------------------------------------------- settings file
function fileSig() { try { const s = fs.statSync(CONFIG_FILE); return `${s.mtimeMs}:${s.size}`; } catch { return 'missing'; } }

function startConfig() {
  CONFIG_FILE = process.env.STC_CONFIG ? path.resolve(process.env.STC_CONFIG) : path.join(app.getPath('userData'), 'config.json');
  const legacy = process.env.STC_CONFIG || process.env.STC_USERDATA ? null : path.join(APP_DIR, 'config.json');
  const note = store.ensure(CONFIG_FILE, legacy, { sources: [] });
  log(`settings file: ${note}`);
  try {
    // one time: an older settings file moves to the new default look where it still had the old one
    const raw = config.readJson(CONFIG_FILE);
    const changed = config.migrateLook(raw);
    if (changed !== null) {
      config.normalize(JSON.parse(JSON.stringify(raw)), path.dirname(CONFIG_FILE)); // never write a file that would not load
      store.writeAtomic(CONFIG_FILE, JSON.stringify(raw, null, 2) + '\n'); // the old one stays as config.json.bak
      log(`settings: new default look applied (${changed.length ? changed.join(', ') : 'nothing to change'})`);
    }
  } catch (e) { log('settings: look update skipped: ' + redact(e.message)); }
  try {
    cfg = config.load(CONFIG_FILE);
  } catch (e) {
    // Never refuse to start: show an empty strip and say what is wrong in Settings.
    configError = redact(e.message);
    log('settings file has a problem, starting with no sources: ' + configError);
    cfg = config.normalize({ sources: [] });
  }
  lastSig = fileSig();
}

// Live config: poll the file's mtime/size every 400 ms (survives editors that save by
// replacing the file, which fs.watch can lose). A good save is applied; a broken one is
// reported and the last good config stays on screen.
function watchConfig() {
  setInterval(() => {
    const now = fileSig();
    if (now === lastSig) return;
    lastSig = now;
    let next;
    try {
      next = config.load(CONFIG_FILE);
    } catch (e) {
      configError = redact(e.message);
      log('config NOT applied, keeping the last good one: ' + configError);
      broadcast('stc:config-error', configError);
      return;
    }
    configError = null;
    applyConfig(next);
  }, 400);
}

// From the Settings window: validate, save atomically, apply.
function saveFromSettings(raw) {
  let next;
  try {
    next = config.normalize(raw);
  } catch (e) {
    return { ok: false, error: redact(e.message) };
  }
  try {
    if (SABOTAGE !== 'no-persist') store.writeAtomic(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n');
    lastSig = fileSig();
  } catch (e) {
    return { ok: false, error: 'could not save: ' + redact(e.message) };
  }
  configError = null;
  applyConfig(next);
  return { ok: true };
}

function applyConfig(next) {
  const prev = cfg;
  cfg = next;
  log(`config applied: ${cfg.sources.length} source(s), ${cfg.sources.filter((s) => s.enabled).length} on`);
  const W = cfg.window, P = prev.window;
  const isT = (w) => String(w.background).toLowerCase() === 'transparent';
  if (strip && (isT(W) !== isT(P) || W.frameless !== P.frameless || next.render !== prev.render)) {
    log('background/frame changed: re-creating the strip window');
    const old = strip; strip = null; old.destroy(); createStrip();
    sendToSettings('stc:config', cfg);
    return;
  }
  if (strip) {
    if (W.width !== P.width || W.height !== P.height) strip.setContentSize(W.width, W.height);
    if (W.alwaysOnTop !== P.alwaysOnTop || W.keepVisible !== P.keepVisible) applyKeepVisible(strip);
    if (!!W.lockSize !== !!P.lockSize) strip.setResizable(!W.lockSize);
    if (!isT(W)) strip.setBackgroundColor(W.background);
  }
  for (const id of guests.keys()) { const wc = webContents.fromId(id); if (wc && !wc.isDestroyed()) wc.setAudioMuted(!!cfg.audio.muted); }
  if (osr) osr.forEachContents((wc) => wc.setAudioMuted(!!cfg.audio.muted));
  broadcast('stc:config', cfg);
}

function broadcast(channel, data) {
  if (strip && !strip.isDestroyed() && !strip.webContents.isDestroyed()) strip.webContents.send(channel, data);
  sendToSettings(channel, data);
}
function sendToSettings(channel, data) { if (settings && !settings.isDestroyed() && !settings.webContents.isDestroyed()) settings.webContents.send(channel, data); }

// ---------------------------------------------------------------- windows
function createStrip() {
  const W = cfg.window;
  if (osr) osr.closeAll();
  const mode = renderMode();
  osr = mode.startsWith('offscreen') ? new OsrGuests({
    getStrip: () => strip, log, attachKeys, bitmap: mode === 'offscreen-bitmap',
    onLoad: (id, load) => { if (strip && !strip.isDestroyed()) strip.webContents.send('stc:guest-load', { id, load }); },
  }) : null;
  const transparent = String(W.background).toLowerCase() === 'transparent';
  strip = new BrowserWindow({
    width: W.width,
    height: W.height,
    useContentSize: true,
    frame: !W.frameless,
    transparent,
    backgroundColor: transparent ? '#00000000' : W.background,
    hasShadow: false,             // nothing but the cards: the stream captures this window
    alwaysOnTop: !!W.alwaysOnTop,
    resizable: !W.lockSize,       // drag its edges to resize (saved, Settings follows); "Lock size" turns that off
    enableLargerThanScreen: true, // a 1080-tall strip on a smaller laptop screen keeps its size
    title: `${APP_NAME} — Strip`,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      backgroundThrottling: BG_THROTTLE, // false: keep drawing while covered / while Meld has focus
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  const win = strip;
  if (PROOF && PROOF.x !== undefined) win.setPosition(PROOF.x, PROOF.y);

  // Lock every <webview> down: no preload, no node, and the same autoplay rule.
  win.webContents.on('will-attach-webview', (_e, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.backgroundThrottling = BG_THROTTLE;
    prefs.autoplayPolicy = 'no-user-gesture-required';
    params.allowpopups = false;
  });
  win.on('page-title-updated', (e) => e.preventDefault()); // Meld finds it by this title
  placeStrip(win);
  win.on('moved', () => rememberPosition(win));
  win.setMinimumSize(200, 200);
  win.on('resize', () => rememberSize(win));
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    win.setContentSize(cfg.window.width, cfg.window.height);
    applyKeepVisible(win);
    log('strip window shown');
    PROOF ? win.showInactive() : win.show();
    watch.attach(win);
    // measurement only: minimize the strip after it has loaded (STC_TEST_STRIP=minimize)
    if (process.env.STC_TEST_STRIP === 'minimize') setTimeout(() => { if (!win.isDestroyed()) win.minimize(); }, Number(process.env.STC_TEST_STRIP_AFTER || 6000));
  });
  win.on('closed', () => {
    if (strip === win) { strip = null; if (osr) osr.closeAll(); watch.detach(); stripState = 'closed'; sendToSettings('stc:strip-state', 'closed'); updateTray(); log('strip window: closed'); }
  });
  attachKeys(win.webContents);
  return win;
}

function showStrip() { if (strip) strip.show(); else createStrip(); }

// "Bring strip back": un-minimize, show, and give it focus (focus is what takes a window
// out of Stage Manager's side strip; measured in proof/vis-result.json, step E).
function bringStripBack() {
  if (!strip) { createStrip(); return; }
  if (strip.isMinimized()) strip.restore();
  strip.show();
  app.focus({ steal: true });
  strip.focus();
  log('strip window: brought back');
}

// "Keep strip visible": always on top (above other apps, so Stage Manager does not park it)
function applyKeepVisible(win) {
  const on = !!cfg.window.keepVisible;
  win.setAlwaysOnTop(on || !!cfg.window.alwaysOnTop, on ? 'floating' : 'normal');
  win.setVisibleOnAllWorkspaces(on, { visibleOnFullScreen: on });
}

// Remember where the strip was (which display, which spot) and put it back there.
function placeStrip(win) {
  const { screen } = require('electron');
  const { x, y } = cfg.window;
  if (typeof x !== 'number' || typeof y !== 'number') return;
  const onSomeDisplay = screen.getAllDisplays().some((d) => x >= d.bounds.x - 50 && x < d.bounds.x + d.bounds.width && y >= d.bounds.y - 50 && y < d.bounds.y + d.bounds.height);
  if (onSomeDisplay) win.setPosition(Math.round(x), Math.round(y));
}
let moveTimer = null;
function rememberPosition(win) {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    if (win.isDestroyed() || stripState !== 'ok') return; // never remember a parked thumbnail spot
    const [x, y] = win.getPosition();
    if (cfg.window.x === x && cfg.window.y === y) return;
    saveFromSettings({ ...cfg, window: { ...cfg.window, x, y } });
  }, 1000);
}

// Dragged to a new size: save it (the cards already follow the real window size live).
let sizeTimer = null;
function rememberSize(win) {
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(() => {
    if (win.isDestroyed() || stripState !== 'ok' || win.isMinimized()) return; // never save a thumbnail's size
    const [width, height] = win.getContentSize();
    if (cfg.window.width === width && cfg.window.height === height) return;
    log(`strip window resized to ${width}x${height}`);
    saveFromSettings({ ...cfg, window: { ...cfg.window, width, height } });
  }, 400);
}

let trayImages = null;
let trayWarn = false;
function updateTray() {
  if (!tray) return;
  if (!trayImages) trayImages = { ok: nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png')), warn: nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayWarn.png')) };
  const bad = ['parked', 'minimized', 'hidden', 'closed'].includes(stripState);
  tray.setImage(bad ? trayImages.warn : trayImages.ok);
  trayWarn = bad;
  tray.setToolTip(bad ? `${APP_NAME}: strip is ${stripState}: your stream may see only a thumbnail` : APP_NAME);
}

function openSettings() {
  if (settings && !settings.isDestroyed()) { settings.show(); settings.focus(); return settings; }
  settings = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    title: `${APP_NAME} — Settings`,
    backgroundColor: '#15151c',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload-settings.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const win = settings;
  win.on('page-title-updated', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'settings.html'));
  win.once('ready-to-show', () => (PROOF ? win.showInactive() : win.show()));
  win.on('closed', () => { if (settings === win) settings = null; }); // closing never quits
  return win;
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { id: 'settings', label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { id: 'strip', label: 'Show Strip', click: bringStripBack },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : [{
      label: 'File',
      submenu: [
        { id: 'settings', label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { id: 'strip', label: 'Show Strip', click: showStrip },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }]),
    // Without an Edit menu, ⌘V / ⌘C do nothing on a Mac: pasting links needs it.
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ label: 'Reload All Guests', accelerator: 'CmdOrCtrl+Shift+R', click: reloadAll }] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  // right-click the Dock icon: the two windows by name (the Strip has no Dock icon of its own)
  if (isMac && app.dock) app.dock.setMenu(Menu.buildFromTemplate([
    { label: 'Show Strip', click: bringStripBack },
    { label: 'Settings…', click: openSettings },
  ]));
}

function buildTray() {
  try {
    const iconFile = path.join(__dirname, 'assets', 'trayTemplate.png');
    if (!fs.existsSync(iconFile)) return;
    tray = new Tray(nativeImage.createFromPath(iconFile));
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Settings…', click: openSettings },
      { label: 'Show Strip', click: bringStripBack },
      { type: 'separator' },
      { label: `Quit ${APP_NAME}`, click: () => app.quit() },
    ]));
  } catch (e) { log('no tray icon: ' + e.message); }
}

// R / D work whether the strip page or a guest page has keyboard focus. (Esc no longer
// quits: one stray key must never end a broadcast. Quit = the app menu / ⌘Q.)
function attachKeys(wc) {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.meta || input.control || input.alt) return;
    const k = input.key.toLowerCase();
    if (k === 'r') { event.preventDefault(); reloadAll(); }
    else if (k === 'd') { event.preventDefault(); if (strip) strip.webContents.send('stc:toggle-debug'); }
  });
}

function reloadAll() {
  log('reloading all guests');
  if (osr) osr.forEachContents((wc) => wc.reload());
  for (const id of guests.keys()) {
    const wc = webContents.fromId(id);
    if (wc && !wc.isDestroyed()) wc.reload();
  }
}

function setLoad(wcId, load) {
  const g = guests.get(wcId);
  if (!g) { pending.set(wcId, load); return; } // the event raced ahead of the registration
  if (g.load === load) return;
  g.load = load;
  if (strip && !strip.isDestroyed() && !strip.webContents.isDestroyed()) strip.webContents.send('stc:guest-load', { id: g.id, load });
}

app.on('web-contents-created', (_e, wc) => {
  if (wc.getType() !== 'webview') return;
  attachKeys(wc);
  wc.setAudioMuted(!!(cfg && cfg.audio.muted));
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  // A guest page may navigate itself (Twitch redirects); it never opens windows.
  wc.on('did-start-loading', () => setLoad(wc.id, 'loading'));
  wc.on('did-stop-loading', () => setLoad(wc.id, 'loaded'));
  wc.on('did-fail-load', (_ev, code, desc, _url, isMain) => {
    if (!isMain || code === -3) return; // -3 = aborted by a newer navigation
    setLoad(wc.id, `failed ${code} ${desc}`);
    setTimeout(() => { if (!wc.isDestroyed()) wc.reload(); }, 10000); // retry by itself
  });
  wc.on('render-process-gone', (_ev, d) => {
    setLoad(wc.id, `crashed (${d.reason})`);
    setTimeout(() => { if (!wc.isDestroyed()) wc.reload(); }, 3000);
  });
  wc.on('destroyed', () => { guests.delete(wc.id); pending.delete(wc.id); });
  // A guest's console is never forwarded (it could echo its own URL with the token).
});

// ---------------------------------------------------------------- IPC
// Every handler is wrapped: a failing handler logs and the app keeps running.
// (STC_SABOTAGE=no-guard removes the wrap, for the tests.)
if (SABOTAGE !== 'no-guard') {
  const rawOn = ipcMain.on.bind(ipcMain), rawHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.on = (ch, fn) => rawOn(ch, (...a) => { try { fn(...a); } catch (e) { log(`ipc ${ch} failed (ignored):`, e); } });
  ipcMain.handle = (ch, fn) => rawHandle(ch, async (...a) => { try { return await fn(...a); } catch (e) { log(`ipc ${ch} failed (ignored):`, e); return null; } });
}
// tests only: a handler that throws, to prove the guard
ipcMain.on('stc:test-throw', () => { throw new Error('test: a handler threw on purpose'); });
ipcMain.handle('stc:config', () => ({ cfg, configError, restartNote, debugCss: !!process.env.STC_DEBUG_CSS, render: renderMode(), bgThrottle: BG_THROTTLE, sabotage: SABOTAGE, perfOff: process.env.STC_PERF_OFF || '', motionFps: process.env.STC_MOTION_FPS !== undefined ? Number(process.env.STC_MOTION_FPS) : (cfg.layout.motionFps ?? 30) }));
ipcMain.handle('stc:save', (_e, raw) => saveFromSettings(raw));
ipcMain.handle('stc:copy', async (_e, text) => { await clipboard.writeText(String(text)); return true; });
ipcMain.handle('stc:status', () => status);
ipcMain.on('stc:register-guest', (_e, { id, name, webContentsId }) => {
  const target = webContents.fromId(Number(webContentsId));
  if (!target || target.isDestroyed() || target.getType() !== 'webview') { log('register-guest: no such live guest (ignored)'); return; }
  guests.set(webContentsId, { id, name, load: 'loading' });
  setLoad(webContentsId, pending.get(webContentsId) || 'loading');
  pending.delete(webContentsId);
  const wc = webContents.fromId(webContentsId);
  if (wc && !wc.isDestroyed()) wc.setAudioMuted(!!cfg.audio.muted);
});
// offscreen guests: the strip asks, main owns the hidden windows
ipcMain.handle('stc:osr-open', (_e, o) => { if (osr) osr.open({ ...o, muted: !!cfg.audio.muted }); return true; });
ipcMain.on('stc:osr-close', (_e, id) => { if (osr) osr.close(id); });
ipcMain.on('stc:osr-active', (_e, { id, active }) => { if (osr) osr.setActive(id, !!active); });
// Page CSS goes in with USER origin: user !important beats any page !important (Twitch's own
// styled-component class sets "display: flex !important" on its name tag; an author-origin sheet
// inserted by insertCSS loses to it). STC_SABOTAGE=css-author = the 0.2.4 behaviour, for tests.
const CSS_ORIGIN = SABOTAGE === 'css-author' ? 'author' : 'user';
ipcMain.handle('stc:guest-css-insert', async (_e, { wcId, css }) => {
  const wc = webContents.fromId(Number(wcId));
  if (!wc || wc.isDestroyed() || wc.getType() !== 'webview') return null;
  return wc.insertCSS(String(css), { cssOrigin: CSS_ORIGIN });
});
ipcMain.handle('stc:guest-css-remove', async (_e, { wcId, key }) => {
  const wc = webContents.fromId(Number(wcId));
  if (!wc || wc.isDestroyed() || wc.getType() !== 'webview') return false;
  await wc.removeInsertedCSS(String(key)); return true;
});
ipcMain.on('stc:osr-css', (_e, { id, name, css, want }) => { if (osr) osr.setCss(id, String(name), String(css), !!want); });
ipcMain.on('stc:osr-resize', (_e, { width, height }) => { if (osr) osr.resize(width, height); });
ipcMain.handle('stc:osr-exec', async (_e, { id, code }) => { try { return osr ? await osr.exec(id, code) : []; } catch { return []; } });
ipcMain.handle('stc:osr-stats', () => (osr ? { ...osr.stats, guests: osr.map.size } : null));
ipcMain.handle('stc:strip-state', () => ({ state: stripState, detect: process.platform === 'darwin' ? (require('./stripwatch').helperPath() ? 'full' : 'partial') : 'partial' }));
ipcMain.handle('stc:strip-restore', () => { bringStripBack(); return true; });
ipcMain.on('stc:strip-status', (_e, s) => { status = s || {}; sendToSettings('stc:status', status); });
ipcMain.on('stc:log', (_e, msg) => log(String(msg)));

// ---------------------------------------------------------------- crash relaunch
// A native crash cannot be caught inside the process. So a tiny detached watchdog (the
// winwatch helper in --watchdog mode) waits for this process to end: a clean quit leaves a
// marker first; any other end relaunches CamReel with the same settings (they are on disk;
// the strip comes back where it was). At most 3 relaunches in 2 minutes.
let restartNote = null;
const runDir = () => path.join(app.getPath('userData'), 'run');
const markerFile = () => path.join(runDir(), 'clean-exit');
function writeCleanExit() { try { fs.mkdirSync(runDir(), { recursive: true }); fs.writeFileSync(markerFile(), String(Date.now())); } catch {} }
function startWatchdog() {
  try {
    fs.mkdirSync(runDir(), { recursive: true });
    try { fs.unlinkSync(markerFile()); } catch {}
    const note = path.join(runDir(), 'last-crash.txt');
    if (fs.existsSync(note)) {
      const txt = fs.readFileSync(note, 'utf8');
      fs.unlinkSync(note);
      restartNote = txt.startsWith('gave up') ? `CamReel stopped after repeated crashes (${txt}).` : `CamReel restarted itself after an unexpected exit at ${new Date(Number(txt) * 1000).toLocaleTimeString()}. The strip is back.`;
      log('started after an unexpected exit: ' + restartNote);
    }
    const on = (app.isPackaged || process.env.STC_WATCHDOG === '1') && SABOTAGE !== 'no-watchdog';
    const hp = require('./stripwatch').helperPath();
    if (!on || !hp) { log(`crash watchdog: ${on ? 'helper missing' : 'off'}`); return; }
    const args = app.isPackaged ? [] : [APP_DIR];
    spawn(hp, ['--watchdog', String(process.pid), markerFile(), process.execPath, ...args], { detached: true, stdio: 'ignore' }).unref();
    log('crash watchdog: on');
  } catch (e) { log('crash watchdog not started:', e); }
}
process.on('SIGTERM', () => { writeCleanExit(); app.quit(); });

// ---------------------------------------------------------------- updates (src/updater.js)
// Only in a packaged build that carries a feed file. Never restarts the app by itself: an
// update is installed on the "Restart to update" click, or at the user's own next quit.
let updater = null;
function startUpdater() {
  try {
    let autoUpdater = null;
    if (app.isPackaged && !PROOF) { try { ({ autoUpdater } = require('electron-updater')); } catch (e) { log('update: the updater could not be loaded:', e); } }
    const { createUpdater, loadFeed } = require('./updater');
    updater = createUpdater({
      autoUpdater, feed: loadFeed(path.join(__dirname, 'update-feed.json')), packaged: app.isPackaged && !PROOF, currentVersion: app.getVersion(), log,
      onState: (st) => sendToSettings('stc:update-state', st),
      beforeInstall: () => { quitting = true; writeCleanExit(); }, // a wanted exit: the crash watchdog must not start the old app again
    });
    updater.start();
  } catch (e) { log('update: not started:', e); }
}
ipcMain.handle('stc:update-state', () => (updater ? updater.state() : { phase: 'off', current: app.getVersion() }));
ipcMain.handle('stc:update-install', () => (updater ? updater.install() : false));

// ---------------------------------------------------------------- lifecycle
// Diagnostics for the next crash: dumps stay on this Mac (never uploaded), every child or
// renderer process that dies is logged with its reason.
try { require('electron').crashReporter.start({ uploadToServer: false, compress: true }); } catch {}
app.on('child-process-gone', (_e, d) => log(`child process gone: ${d.type} ${d.reason} (exit ${d.exitCode})${d.name ? ' ' + d.name : ''}`));
app.on('render-process-gone', (_e, wc, d) => log(`renderer gone: ${d.reason} (exit ${d.exitCode}) in a ${wc.getType()}`));

app.whenReady().then(() => {
  log(`crash dumps (local only): ${app.getPath('crashDumps')}`);
  startWatchdog();
  startConfig();
  log(`${cfg.sources.length} source(s), window ${cfg.window.width}x${cfg.window.height}, background ${cfg.window.background}, cycle ${cfg.layout.cycleSeconds}s, hideWhenDead ${cfg.hideWhenDead}`);
  buildMenu();
  buildTray();
  createStrip();
  // First run (nothing to show yet): open Settings so he can paste links.
  if (!cfg.sources.length || configError || (PROOF && PROOF.openSettings)) openSettings();
  watchConfig();
  startUpdater();
  if (PROOF && PROOF.mirrorTest) require('./proof-mirror').run({ app, getStrip: () => strip, getSettings: () => settings, log, PROOF, CONFIG_FILE });
  else if (PROOF && PROOF.watchTest) require('./proof-watch').run({ app, getStrip: () => strip, getSettings: () => settings, getState: () => stripState, getTray: () => ({ exists: !!tray, warn: trayWarn }), getGeo: () => watch.geo, log, PROOF, CONFIG_FILE });
  else if (PROOF && PROOF.settingsTest) require('./proof-settings').run({ app, getStrip: () => strip, getSettings: () => settings, openSettings, log, PROOF, CONFIG_FILE });
  else if (PROOF) require('./proof').run({ app, win: strip, cfg, log, PROOF, CONFIG_FILE });
});

app.on('activate', () => openSettings()); // Dock icon click
app.on('before-quit', () => { quitting = true; writeCleanExit(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
