'use strict';
// Drives the Settings window with REAL input events (mouse clicks, typed characters,
// ⌘A / ⌘V / Enter via sendInputEvent) and records what the Settings window, the strip
// and the file on disk show. Phase 1 = a fresh install; phase 2 = the restart.
// Never used on stream. The system clipboard is borrowed for the paste and restored.
const fs = require('fs');
const path = require('path');
const { clipboard, Menu } = require('electron');
const { redact } = require('./redact');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ app, getStrip, getSettings, log, PROOF, CONFIG_FILE }) {
  const out = path.resolve(PROOF.out || 'proof');
  const prefix = PROOF.prefix || 'settings';
  fs.mkdirSync(out, { recursive: true });
  const r = { phase: PROOF.phase, steps: {} };
  const S = () => getSettings().webContents;
  const js = (wc, code) => wc.executeJavaScript(code);
  const rows = () => js(S(), 'window.__settings.rows()');
  const strip = () => js(getStrip().webContents, 'window.__stc.snapshot()');
  const disk = () => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { return { error: e.message }; } };
  const shownNames = async () => (await strip()).cards.filter((c) => c.mode === 'shown').map((c) => c.name);

  async function waitFor(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(150); } return false; }
  async function click(selector, index = 0) {
    const pt = await js(S(), `(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
    if (!pt) throw new Error('nothing to click: ' + selector + ' #' + index);
    S().sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
    S().sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    S().sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await sleep(250);
  }
  const key = async (keyCode, modifiers = []) => { S().sendInputEvent({ type: 'keyDown', keyCode, modifiers }); S().sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await sleep(120); };
  async function type(text) { for (const ch of text) S().sendInputEvent({ type: 'char', keyCode: ch }); await sleep(200); }

  // ⌘V into the empty row. The clipboard is borrowed and given back.
  async function paste(text) {
    let saved = [];
    try { saved = await clipboard.read(); } catch {}
    let how = 'cmd-v';
    try {
      await clipboard.writeText(text);
      await click('#paste');
      const look = async () => JSON.stringify([(await rows()).map((x) => x.name || x.value), await js(S(), 'window.__settings.error()')]);
      const before = await look();
      await key('V', [process.platform === 'darwin' ? 'meta' : 'control']);
      await sleep(500);
      if ((await look()) === before) {
        // ⌘V sent straight to the page is not the menu's Paste; use the Edit menu's action
        how = 'edit-menu-paste';
        S().paste();
        await sleep(500);
      }
    } finally {
      try { if (saved.length) await clipboard.write(saved); else clipboard.clear(); } catch (e) { log('could not restore the clipboard: ' + e.message); }
    }
    return { how, rows: await rows(), active: await js(S(), 'window.__settings.active()'), error: await js(S(), 'window.__settings.error()') };
  }
  async function shots(tag) {
    for (const [name, w] of [['settings', getSettings()], ['strip', getStrip()]]) {
      if (!w) continue;
      const img = await w.webContents.capturePage();
      fs.writeFileSync(path.join(out, `${prefix}-${tag}-${name}.png`), img.toPNG());
    }
  }

  try {
    const L = PROOF.links; // fake-token stand-in links
    if (PROOF.phase === 'seats') {
      // Seats from one link: paste ONE seat link, click the real button, look at table, disk and strip.
      // The paste is a paste EVENT on the field (the same handler ⌘V reaches); the system clipboard is not used.
      await waitFor(async () => getSettings() && !(await S().isLoading()) && (await js(S(), '!!window.__settings')), 10000);
      const pasteEvent = async (text) => { await js(S(), `(() => { const p = document.querySelector('#paste'); const dt = new DataTransfer(); dt.setData('text', ${JSON.stringify(text)}); p.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`); await sleep(600); };
      const offer = () => js(S(), 'window.__settings.seatOffer()');
      const look = async () => ({ rows: (await rows()).filter((x) => !x.empty).map((x) => x.name), offer: await offer(), error: await js(S(), 'window.__settings.error()'),
        diskSeats: (disk().sources || []).map((x) => { const u = new URL(x.url); return `${u.pathname.split('/').pop()}:${u.searchParams.get('display')}:${u.searchParams.get('slot')}:${u.searchParams.get('auth') === new URL(L[0]).searchParams.get('auth') ? 'same-key' : 'OTHER-KEY'}`; }) });
      const vis = (sel) => js(S(), `window.__settings.visible(${JSON.stringify(sel)})`);
      const viewLook = async () => ({ view: await js(S(), 'window.__settings.view()'), guests: await vis('#sec-guests'), simpleBox: await vis('#sec-simple'),
        motion: await vis('#sec-motion'), windowSec: await vis('#sec-window'), mirrorCol: await vis('#sources th:nth-child(5)'), jump: await vis('#jump'),
        hoverHL: await js(S(), "window.__settings.hover('#sec-guests')") });
      r.steps.viewFirst = await viewLook();            // a first start: Simple
      await click('#viewSwitch [data-view="advanced"]'); await sleep(300);
      r.steps.viewAdvanced = await viewLook();
      await click('#viewSwitch [data-view="simple"]'); await sleep(300);
      r.steps.viewSimpleAgain = await viewLook();
      await js(S(), "(() => { const s = document.querySelector('#bgSimple'); s.value = 'green'; s.dispatchEvent(new Event('change')); })()"); await sleep(800);
      r.steps.bgGreen = { disk: (disk().window || {}).background, advancedSelect: await js(S(), "document.querySelector('#bgMode').value") };
      await js(S(), "(() => { const s = document.querySelector('#bgSimple'); s.value = 'transparent'; s.dispatchEvent(new Event('change')); })()"); await sleep(800);
      r.steps.bgBack = { disk: (disk().window || {}).background };
      r.steps.grab = await js(getStrip().webContents, "(() => { const g = document.querySelector('#grab'); if (!g) return null; const cs = getComputedStyle(g); const b = g.getBoundingClientRect(); return { region: cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region'), cover: b.width >= innerWidth - 12 && b.height >= innerHeight - 12, onTop: Number(cs.zIndex) > 1000, see: cs.backgroundColor }; })()");
      r.steps.start = { offer: await offer(), placeholder: await js(S(), "document.querySelector('#paste').placeholder"), plus: await js(S(), "!!document.querySelector('.plus')") };
      await click('.plus');                         // the + puts the cursor in the paste field
      await sleep(300);
      r.steps.plusFocus = await js(S(), "document.activeElement && document.activeElement.id");
      await pasteEvent(L[0]);
      r.steps.pasted = await look();
      await click('#seatAdd');
      await sleep(700);
      r.steps.added = await look();
      r.steps.defaultStyle = (disk().layout || {}).style;
      await pasteEvent(L[0]);                       // already in the list, all seats there → no offer
      r.steps.again = await look();
      await click('.del', 2);                       // delete "Guest 3"
      await sleep(600);
      await pasteEvent(L[0]);                       // the offer comes back, for the one missing seat
      r.steps.oneMissing = await look();
      await click('#seatAdd');
      await sleep(700);
      r.steps.refilled = await look();
      await pasteEvent(L[1]);                       // not a seat link → added as before, no offer
      r.steps.plain = await look();
      // a seat link ALREADY in the list (no paste in this window): the offer must still come (his case, 2026-11-20)
      const seatRow = (await rows()).filter((x) => !x.empty).findIndex((x) => /^Guest [2-5]$/.test(x.name));
      await click('.del', seatRow);
      await sleep(600);
      r.steps.existing = await look();
      await click('#seatNo');                       // "No thanks" → gone, and stays gone while the window lives
      await sleep(400);
      r.steps.noThanks = await look();
      await click('.name', 0); await sleep(200); await key('Return'); await sleep(400);  // any re-render
      r.steps.noThanksAfterRender = await look();
      await pasteEvent(L[0]);                       // pasting it again brings the offer back on purpose
      await click('#seatAdd');
      await sleep(700);
      r.steps.back = await look();
      r.steps.stripCards = (await waitFor(async () => (await strip()).cards.length === 6, 15000)) ? (await strip()).cards.map((c) => c.name) : (await strip()).cards.map((c) => c.name);
      await shots('seats');
    } else if (PROOF.phase === 1) {
      await waitFor(async () => getSettings() && !(await S().isLoading()) && (await js(S(), '!!window.__settings')), 10000);
      r.settingsOpenAtFirstRun = !!getSettings();
      r.stripTitle = getStrip().getTitle();
      r.settingsTitle = getSettings().getTitle();
      r.steps.paste1 = await paste(L[0]);
      r.steps.paste2 = await paste(L[1]);
      r.steps.paste3 = await paste(L[2]);
      r.steps.dup = await paste(L[0]);
      r.steps.notUrl = await paste('hello this is not a link');
      // rename row 3
      await click('.name', 2); S().selectAll(); await sleep(100); await type('Cem'); await key('Return');
      await sleep(400);
      r.steps.rename = { rows: await rows(), diskNames: (disk().sources || []).map((s) => s.name) };
      r.steps.allShown = await waitFor(async () => (await shownNames()).length === 3, 20000);
      r.steps.stripBefore = await shownNames();
      await shots('1-three');
      // toggle row 2 off
      await click('.toggle', 1);
      await waitFor(async () => (await shownNames()).length === 2, 8000);
      const sn = await strip();
      r.steps.toggleOff = { rows: await rows(), stripCards: sn.cards.map((c) => c.name), stripShown: sn.cards.filter((c) => c.mode === 'shown').map((c) => c.name) };
      await shots('2-toggled-off');
      // reorder: row 3 (Cem) up
      await click('.up', 2);
      await sleep(1500);
      r.steps.reorder = { rows: await rows(), stripShown: await shownNames(), diskNames: (disk().sources || []).map((s) => s.name) };
      // delete row 1
      await click('.del', 0);
      await sleep(800);
      r.steps.del = { rows: await rows(), diskNames: (disk().sources || []).map((s) => s.name) };
      // toggle storm: the first row OFF/ON 20 times through real clicks (the 14:24 crash was an
      // OFF -> ON of a source); the app must stay up and the guest must come back
      for (let i = 0; i < 20; i++) { await click('.toggle', 0); await sleep(250); }
      r.steps.storm = { appAlive: !getStrip().isDestroyed(), rows: await rows(),
        back: await waitFor(async () => (await shownNames()).includes((await rows())[0].name), 15000), stripShown: await shownNames() };
      // layout: cycle seconds -> 0 (typed)
      await click('input[data-k="layout.cycleSeconds"]'); S().selectAll(); await sleep(100); await type('0'); await sleep(700);
      r.steps.layout = { diskCycle: (disk().layout || {}).cycleSeconds };
      // animation: pick a style (a <select> opens a native menu: set it + fire "change"), then type padding
      const pick = async (style) => { await js(S(), `(() => { const e = document.querySelector('[data-k="layout.style"]'); e.value = ${JSON.stringify(style)}; e.dispatchEvent(new Event('change')); })()`); await sleep(700); };
      await pick('loop');
      await shots('4-loop');
      r.steps.animLoop = { ui: await js(S(), 'window.__settings.anim()'), disk: (disk().layout || {}).style,
        strip: await waitFor(async () => (await strip()).chosen === 'loop', 5000) };
      await pick('step');
      r.steps.animStep = { ui: await js(S(), 'window.__settings.anim()'), disk: (disk().layout || {}).style,
        strip: await waitFor(async () => (await strip()).chosen === 'step', 5000) };
      await click('input[data-k="layout.cardPadding"]'); S().selectAll(); await sleep(100); await type('12'); await sleep(900);
      r.steps.padding = { disk: (disk().layout || {}).cardPadding, strip: await waitFor(async () => (await strip()).cards.every((c) => c.pad === 12), 5000) };
      // the preview: pointing at "Card padding" lights up the FRAME; at "Gap" the gaps; the preview's cards follow the settings
      const pv = () => js(S(), 'window.__settings.preview()');
      const hover = (k) => js(S(), `window.__settings.hover('label:has([data-k="${k}"])')`);
      await hover('layout.cardPadding'); const pPad = await pv();
      await hover('layout.nameHeight'); const pName = await pv();
      await hover('layout.margin'); const pMargin = await pv();
      await click('#styleTiles .tile[data-style="fade"]'); await sleep(700);
      r.steps.preview = { pad: pPad, name: pName, margin: pMargin, tileDisk: (disk().layout || {}).style, tileOn: await js(S(), "document.querySelector('#styleTiles .tile.on').dataset.style"), after: await pv() };
      await shots('5-preview');
      await pick('pingpong');
      // Meld box: type 432 × 830 (what Meld showed), click Match → the strip window takes that shape
      await click('#meldW'); await type('432'); await click('#meldH'); await type('830'); await click('#matchMeld'); await sleep(1200);
      const avail = await js(S(), '({ w: Math.min(3840, screen.availWidth), h: Math.min(2160, screen.availHeight) })');
      r.steps.meld = { note: await js(S(), 'window.__settings.meld()'), disk: disk().window, avail, stripSize: getStrip().getContentSize() };
      await shots('3-after-edits');
      r.disk = disk();
      r.bakExists = fs.existsSync(CONFIG_FILE + '.bak');
      r.tmpLeft = fs.existsSync(CONFIG_FILE + '.tmp');
      // closing Settings must not quit; the Dock click opens it again
      getSettings().close();
      await sleep(800);
      r.afterCloseAppAlive = !!getStrip() && !getStrip().isDestroyed();
      app.emit('activate');
      r.dockReopensSettings = await waitFor(() => getSettings() && !getSettings().isDestroyed(), 4000);
    } else {
      r.settingsOpenAtStart = !!getSettings();
      Menu.getApplicationMenu().getMenuItemById('settings').click(); // the real menu item (⌘,)
      await waitFor(async () => getSettings() && (await js(S(), '!!window.__settings')), 8000);
      r.menuOpensSettings = !!getSettings();
      await sleep(500);
      r.rows = await rows();
      r.disk = disk();
      r.stripAlive = await waitFor(async () => (await shownNames()).length >= 1, 20000);
      r.stripShown = await shownNames();
      r.stripCards = (await strip()).cards.map((c) => c.name);
      await shots('4-after-restart');
    }
  } catch (e) {
    r.error = redact(e);
  }
  fs.writeFileSync(path.join(out, `${prefix}-phase${PROOF.phase}.json`), redact(JSON.stringify(r, null, 2)));
  log(`settings test phase ${PROOF.phase} done`);
  app.quit();
}

module.exports = { run };
