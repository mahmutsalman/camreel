'use strict';
// The cards. Three jobs:
//  1. LIVENESS: once a second, ask every guest page whether it has a live, MOVING video.
//     A card shows after `showAfterSeconds` alive and hides after `deadAfterSeconds` dead.
//  2. LAYOUT: visible cards stack in config order. Style "pingpong" (and "still") moves the
//     whole column up and down over exactly the visible set; when the set changes, the travel
//     eases to its new size (the phase never jumps). The other styles (loop, step, fade, deck,
//     drum: styles.js) place EVERY card each frame. A hidden card is PARKED: still rendered, transparent.
//  3. LIVE CONFIG: a new config adds/removes/renames cards and re-lays them out.
// A guest's <webview> is never moved in the DOM (moving it would reload the page).

(async () => {
  const PROBE_MS = 1000;
  const EASE_S = 0.8;      // how fast the cycle adapts to a new visible set
  const OUT_MS = 500;      // fade-out time before a hidden card is parked
  const FOLLOW_S = 0.15;   // driven styles: how fast a card follows its spot (a jump to the far end snaps)
  const STY = window.CamReelStyles;

  const boot = await window.stc.config();
  let cfg = boot.cfg;
  let configError = boot.configError;
  const SABOTAGE = boot.sabotage; // tests only: 'always-alive'
  window.__stcDebugCss = !!boot.debugCss;
  const PERF_OFF = boot.perfOff || ''; // measurements only: 'idle', 'park' switch an optimisation off
  const MOTION_FPS = boot.motionFps ?? 30;
  const OSR = String(boot.render || '').startsWith('offscreen'); // guests drawn offscreen into <canvas>
  if (!PERF_OFF.includes('park')) document.body.classList.add('small-park');

  const rootStyle = document.documentElement.style;
  const column = document.getElementById('column');
  const track = document.getElementById('track');
  const dbg = document.getElementById('debug');

  const cards = new Map(); // key (the url, never shown or logged) -> card
  let nextId = 1;
  let dims = {};

  // ---------- layout constants from the config ----------
  function applyLayout() {
    const L = cfg.layout, W = cfg.window;
    // a card = padding + the picture (16:9) + the name strip + padding, cardWidth wide
    const pad = L.cardPadding;
    // the window's REAL size (he may be dragging its edge right now; the config follows a moment later)
    const winW = window.innerWidth || W.width, winH = window.innerHeight || W.height;
    const cardW = Math.max(40, L.cardWidth > 0 ? L.cardWidth : winW - 2 * L.margin); // 0 = fill the window
    const picW = cardW - 2 * pad;
    const cardH = Math.round(picW * 9 / 16);
    const strip = L.nameStrip ? (L.nameHeight > 0 ? L.nameHeight : Math.max(20, Math.round(Math.min(cardW, 600) * 0.08))) : 0;
    const vMargin = L.verticalMargin >= 0 ? L.verticalMargin : L.margin;
    dims = { cardH, picW, pad, strip, H: cardH + strip + 2 * pad, gap: L.gap, winH, margin: vMargin };
    const transparent = String(W.background).toLowerCase() === 'transparent';
    rootStyle.setProperty('--bg', transparent ? 'transparent' : W.background);
    rootStyle.setProperty('--card-w', cardW + 'px');
    rootStyle.setProperty('--shadow', L.shadow ? '0 18px 40px rgba(0,0,0,.45)' : '0 0 #0000');
    rootStyle.setProperty('--outline', L.outline ? '0 0 0 2px ' + L.accent : '0 0 #0000');
    rootStyle.setProperty('--card-h', cardH + 'px');
    rootStyle.setProperty('--pic-w', picW + 'px');
    rootStyle.setProperty('--pad', pad + 'px');
    rootStyle.setProperty('--frame', L.frameColor);
    rootStyle.setProperty('--name-pad', L.namePadding + 'px');
    rootStyle.setProperty('--name-size', (L.nameSize > 0 ? L.nameSize : Math.round(strip * 0.5)) + 'px');
    rootStyle.setProperty('--name-align', L.nameAlign);
    rootStyle.setProperty('--strip', strip + 'px');
    rootStyle.setProperty('--margin', L.margin + 'px');
    rootStyle.setProperty('--radius', L.cornerRadius + 'px');
    rootStyle.setProperty('--accent', L.accent);
    rootStyle.setProperty('--perspective', L.perspective + 'px');
    // The column turns its inner edge away, so the cards face the centre of the screen.
    rootStyle.setProperty('--tilt', (L.side === 'right' ? -1 : 1) * L.tiltDegrees + 'deg');
    column.classList.toggle('right', L.side === 'right');
    column.classList.toggle('left', L.side === 'left');
    for (const c of cards.values()) {
      c.nameEl.style.display = L.nameStrip ? '' : 'none';
      if (c.canvas && (c.canvas.width !== picW || c.canvas.height !== cardH)) { c.canvas.width = picW; c.canvas.height = cardH; }
    }
    if (OSR) window.stc.osr.resize(picW, cardH);
  }

  // ---------- cards ----------
  function makeCard(src) {
    const id = nextId++;
    const el = document.createElement('div');
    el.className = 'card parked';
    el.style.setProperty('--o', '0');
    let wv = null, canvas = null;
    if (OSR) {
      // the guest page lives in a hidden offscreen window (main process); its frames are drawn here
      canvas = document.createElement('canvas');
      canvas.id = 'g-' + id;
      canvas.className = 'guest';
      canvas.width = dims.picW; canvas.height = dims.cardH;
    } else {
      wv = document.createElement('webview');
      wv.setAttribute('partition', 'persist:guests'); // keeps Twitch cookies between runs
      wv.setAttribute('webpreferences', `contextIsolation=yes, backgroundThrottling=${boot.bgThrottle ? 'yes' : 'no'}`);
      wv.setAttribute('src', src.url);
      if (SABOTAGE === 'webview-block') wv.style.display = 'block'; // tests only: the 0.2.1 regression
    }
    const statusEl = document.createElement('div');
    statusEl.className = 'status';
    statusEl.textContent = 'connecting…';
    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    nameEl.textContent = src.name;
    if (!cfg.layout.nameStrip) nameEl.style.display = 'none';
    el.append(wv || canvas, statusEl, nameEl);
    track.append(el);
    const c = { id, name: src.name, el, wv, canvas, statusEl, nameEl, load: 'loading', live: 'loading', ready: false,
      aliveSince: null, deadSince: null, prev: new Map(), video: '', mode: 'parked', y: 0, outTimer: null, wantShow: false };
    if (OSR) {
      c.ready = true;
      window.stc.osr.open({ id, url: src.url, width: dims.picW, height: dims.cardH });
      return c;
    }
    wv.addEventListener('dom-ready', () => {
      c.ready = true; window.stc.registerGuest(id, c.name, wv.getWebContentsId());
      // a navigation drops inserted CSS: put back every rule this card wants
      c.sheetKey = null; for (const [name, want] of Object.entries(c.cssWant || {})) if (want) setPageCss(c, name, true); // a new document
      c.npLoadAt = performance.now(); c.npSeen = false; c.npHiddenLogged = false; // a new document: check its name tag again
    });
    wv.addEventListener('did-stop-loading', () => el.classList.add('loaded'));
    wv.addEventListener('did-fail-load', (e) => {
      if (!e.isMainFrame || e.errorCode === -3) return;
      el.classList.remove('loaded');
      statusEl.textContent = `${c.name}: could not load (${e.errorDescription || e.errorCode}), retrying…`;
    });
    wv.addEventListener('render-process-gone', () => { el.classList.remove('loaded'); statusEl.textContent = `${c.name}: crashed, reloading…`; });
    return c;
  }

  function syncCards() {
    // An OFF source has no card at all: its page is unloaded, it costs nothing.
    const wanted = new Map(cfg.sources.filter((s) => s.enabled !== false).map((s) => [s.url, s]));
    for (const [key, c] of cards) {
      if (!wanted.has(key)) {
        clearTimeout(c.outTimer);
        if (OSR) window.stc.osr.close(c.id);
        c.el.remove(); // destroys the guest page
        cards.delete(key);
        window.stc.log(`guest "${c.name}" removed or switched off`);
      }
    }
    const ordered = new Map();
    for (const [key, s] of wanted) {
      let c = cards.get(key);
      if (!c) { c = makeCard(s); window.stc.log(`guest "${s.name}" added`); }
      else if (c.name !== s.name) { window.stc.log(`guest "${c.name}" renamed to "${s.name}"`); c.name = s.name; c.nameEl.textContent = s.name; }
      applyMirror(c, (s.mirror ?? cfg.layout.mirrorAll) === true);
      c.twitch = /(^|\.)twitch\.tv$/i.test((() => { try { return new URL(s.url).hostname; } catch { return ''; } })()) && /\/guest-star\//.test(s.url);
      const hide = cfg.layout.hideTwitchName === true;
      if (!!(c.cssWant && c.cssWant.hidename) !== hide) { setPageCss(c, 'hidename', hide); c.hideSince = performance.now(); c.nameplateMissing = false; window.stc.log(`guest "${c.name}": hide Twitch's name tag ${hide ? 'on' : 'off'}`); }
      ordered.set(key, c);
    }
    cards.clear();
    for (const [k, c] of ordered) cards.set(k, c); // config order = stacking order
  }

  // ---------- MIRROR: only the VIDEO inside the guest page flips (text over it stays readable) ----------
  // On: insert `video { transform: scaleX(-1) }` into the page. The liveness probe then confirms a
  // <video> really is flipped; if none is within 3 s (a page with no <video>), the whole picture
  // element flips instead (the 0.2.3 way) and says so in the log. Never silently nothing.
  // ONE stylesheet per guest document, inserted with USER origin (beats the page's own
  // "!important", e.g. Twitch's name tag class), whose rules only apply while CamReel's attribute is
  // on the page's <html>. Switching = setting / removing that attribute: nothing ever has to be
  // removed from the page (in our test, removing an inserted user-origin sheet did not take effect).
  const PAGE_SHEET = 'html[data-camreel-mirror] video { transform: scaleX(-1) !important; } ' +
    // Twitch's own name tag: ONLY its stable semantic class, never the hashed ones
    (SABOTAGE === 'css-author'
      // tests only: the 0.2.4 situation (author origin + a selector no more specific than the page's own class)
      ? ':where(html[data-camreel-hidename]) .guest-star-browser-source-nameplate { display: none !important; }'
      : 'html[data-camreel-hidename] .guest-star-browser-source-nameplate { display: none !important; }');
  async function ensureSheet(c) {
    if (c.sheetKey) return true;
    if (OSR) { window.stc.osr.css(c.id, 'camreel', PAGE_SHEET, true); c.sheetKey = 'offscreen'; return true; }
    if (!c.ready) return false;                              // dom-ready puts it in
    try { c.sheetKey = await window.stc.guestCss.insert(c.wv.getWebContentsId(), PAGE_SHEET); } catch { c.sheetKey = null; }
    return !!c.sheetKey;
  }
  async function setPageCss(c, name, want) {
    c.cssWant = c.cssWant || {};
    c.cssWant[name] = !!want;
    if (SABOTAGE === `${name}-no-css`) return;               // tests only: mirror-no-css / hidename-no-css
    if (want && !(await ensureSheet(c))) return;
    const code = `document.documentElement.toggleAttribute('data-camreel-${name}', ${!!want})`;
    try { await (OSR ? window.stc.osr.exec(c.id, code) : c.wv.executeJavaScript(code)); } catch {}
  }
  const setPageMirror = (c, want) => setPageCss(c, 'mirror', want);
  function applyMirror(c, want) {
    if (SABOTAGE === 'mirror-ignored') want = false;         // tests only
    if (c.mirrorWant === want) return;
    c.mirrorWant = want;
    if (want) { c.mirrorMode = 'pending'; c.mirrorSince = performance.now(); setPageMirror(c, true); }
    else { c.mirrorMode = 'none'; c.el.classList.remove('mirrored'); setPageMirror(c, false); }
    window.stc.log(`guest "${c.name}" mirror ${want ? 'on' : 'off'}`);
  }
  function mirrorTick(c, vids) {
    if (!c.mirrorWant) return;
    if (vids.some((v) => v.fx)) {                            // the page's video is flipped: the good way
      if (c.mirrorMode !== 'css') {
        c.mirrorMode = 'css'; c.el.classList.remove('mirrored');
        window.stc.log(`guest "${c.name}" mirror: the video inside the page is mirrored (text stays readable)`);
      }
      return;
    }
    if (c.mirrorMode === 'css') {                            // lost it (navigation, new video): again
      if (!OSR) c.sheetKey = null; c.mirrorMode = 'pending'; c.mirrorSince = performance.now(); setPageMirror(c, true);
      return;
    }
    if (c.mirrorMode === 'pending' && performance.now() - c.mirrorSince > 3000 && SABOTAGE !== 'mirror-no-fallback') {
      c.mirrorMode = 'element'; c.el.classList.add('mirrored');
      window.stc.log(`guest "${c.name}" mirror: page has no video, flipping the whole card`);
    }
  }

  window.stc.onGuestLoad(({ id, load }) => {
    for (const c of cards.values()) {
      if (c.id !== id) continue;
      c.load = load;
      if (OSR) {
        c.el.classList.toggle('loaded', load === 'loaded');
        if (/^(failed|crashed)/.test(load)) c.statusEl.textContent = `${c.name}: ${load}, retrying…`;
      }
    }
  });

  // ---------- 1. liveness ----------
  // Runs inside the guest page. Finds <video> elements in the document, in open shadow
  // roots and in same-origin iframes (cross-origin ones are skipped: fail safe = dead).
  const PROBE = `(() => {
    const vids = [];
    const scan = (root, depth) => {
      if (!root || depth > 4) return;
      try { root.querySelectorAll('video').forEach((v) => vids.push(v)); } catch { return; }
      try {
        const all = root.querySelectorAll('*');
        if (all.length < 6000) for (const el of all) if (el.shadowRoot) scan(el.shadowRoot, depth + 1);
      } catch {}
      try { root.querySelectorAll('iframe,frame').forEach((f) => { try { if (f.contentDocument) scan(f.contentDocument, depth + 1); } catch {} }); } catch {}
    };
    scan(document, 0);
    const W = window.__stcVid || (window.__stcVid = { n: 0 });
    return vids.slice(0, 16).map((v) => {
      if (!v.__stcId) {
        v.__stcId = ++W.n; v.__stcF = 0;
        if (v.requestVideoFrameCallback) { const cb = () => { v.__stcF++; v.requestVideoFrameCallback(cb); }; v.requestVideoFrameCallback(cb); }
      }
      let fx = false;
      try { const t = (v.ownerDocument.defaultView || window).getComputedStyle(v).transform; const m = /^matrix(?:3d)?\\(\\s*([-\\d.e]+)/.exec(t); fx = !!m && parseFloat(m[1]) < 0; } catch {}
      return { id: v.__stcId, rs: v.readyState, p: v.paused, e: v.ended, t: v.currentTime, f: v.__stcF, w: v.videoWidth, fx };
    });
  })()`;

  async function probe(c) {
    let vids = [];
    if (c.ready) {
      try {
        vids = await Promise.race([OSR ? window.stc.osr.exec(c.id, PROBE) : c.wv.executeJavaScript(PROBE), new Promise((r) => setTimeout(() => r(null), PROBE_MS - 100))]) || [];
      } catch { vids = []; } // page navigating / not ready: counts as no video
    }
    let moving = false;
    const seen = new Map();
    for (const v of vids) {
      const before = c.prev.get(v.id);
      const ok = v.rs >= 2 && !v.p && !v.e && v.w > 0;
      if (ok && before && (v.t > before.t + 0.01 || v.f > before.f)) moving = true;
      seen.set(v.id, { t: v.t, f: v.f });
    }
    c.prev = seen;
    mirrorTick(c, vids);
    // "Hide Twitch's name tag": VERIFY it, like the mirror. Visible while hide is on → put the rule in
    // again; hidden → say so once; never there for 20 s since the page loaded → the row says so
    // (Twitch pages only: other links have no such tag, nothing to say).
    if (c.cssWant && c.cssWant.hidename && c.ready) {
      const CHECK = "(() => { const e = document.querySelector('.guest-star-browser-source-nameplate'); return e ? getComputedStyle(e).display : null; })()";
      let display = null;
      try { display = await (OSR ? window.stc.osr.exec(c.id, CHECK) : c.wv.executeJavaScript(CHECK)); } catch {}
      const now = performance.now();
      if (display !== null && typeof display === 'string') {
        c.npSeen = true;
        if (display === 'none') {
          if (!c.npHiddenLogged) { c.npHiddenLogged = true; window.stc.log(`guest "${c.name}": name tag hidden`); }
        } else if (!c.npRetryAt || now - c.npRetryAt > 5000) {
          c.npRetryAt = now; c.npHiddenLogged = false;
          window.stc.log(`guest "${c.name}": name tag still visible (${display}), putting the rule in again`);
          if (!OSR) c.sheetKey = null;                        // the sheet may be gone too: put both back
          setPageCss(c, 'hidename', true);
        }
        c.nameplateMissing = false;
      } else {
        const since = Math.max(c.hideSince || 0, c.npLoadAt || 0);
        const missing = !!c.twitch && !c.npSeen && c.load === 'loaded' && now - since > 20000;
        if (missing && !c.nameplateMissing) window.stc.log(`guest "${c.name}": Twitch's name tag not found (Twitch may have changed its page)`);
        c.nameplateMissing = missing;
      }
    } else c.nameplateMissing = false;
    if (SABOTAGE === 'always-alive') moving = true;
    const best = vids.find((v) => v.rs >= 2) || vids[0];
    c.video = vids.length ? `${vids.length} video, ready ${best.rs}${best.p ? ' paused' : ''} t=${best.t.toFixed(1)} f=${best.f}` : 'no video';
    judge(c, moving, performance.now());
  }

  function judge(c, moving, now) {
    const was = c.live;
    if (moving) {
      c.deadSince = null;
      if (c.aliveSince === null) c.aliveSince = now;
      if (c.live !== 'alive' && now - c.aliveSince >= cfg.showAfterSeconds * 1000 - 50) c.live = 'alive';
    } else {
      c.aliveSince = null;
      if (c.deadSince === null) c.deadSince = now;
      const settled = c.live === 'alive' || c.load !== 'loading';
      if (c.live !== 'dead' && settled && now - c.deadSince >= cfg.deadAfterSeconds * 1000 - 50) c.live = 'dead';
    }
    if (c.live !== was) window.stc.log(`guest "${c.name}": ${was} -> ${c.live}`);
  }

  setInterval(() => {
    for (const c of cards.values()) probe(c);
    // tell the Settings window each source's state (keyed by link; stays in this app)
    const st = {};
    for (const [key, c] of cards) st[key] = { live: c.live, load: c.load, shown: c.mode === 'shown', nameplateMissing: !!c.nameplateMissing };
    window.stc.sendStatus(st);
  }, PROBE_MS);

  // ---------- 2. layout + cycle ----------
  const motion = { phase: 0, center: null, dist: 0, last: performance.now(), offset: 0 };

  function targets(n) {
    const { H, gap, winH, margin } = dims;
    if (n === 0) return { center: winH / 2, dist: 0 };
    const T = n * H + (n - 1) * gap;
    const auto = Math.max(T - (winH - 2 * margin), Math.round(H * 0.5));
    return { center: winH / 2 - T / 2, dist: cfg.layout.cycleDistance > 0 ? cfg.layout.cycleDistance : auto };
  }

  let frameRuns = 0;
  // a card's driven-only properties, off (a parked card, or back to pingpong)
  function clearDriven(c) {
    for (const k of ['--rx', '--zr', '--tz']) c.el.style.removeProperty(k);
    c.el.style.zIndex = ''; c.dd = null; c.vs = null;
  }
  let lastStyle = null;
  function useStyle(style) {
    const driven = STY.DRIVEN.includes(style);
    document.body.classList.toggle('driven', driven);
    for (const st of STY.DRIVEN.concat(['pingpong', 'still'])) document.body.classList.toggle('style-' + st, st === style);
    for (const c of cards.values()) {
      clearDriven(c); c.y = null;
      // back to pingpong/still: a driven style may have left a card shrunk or INVISIBLE (deck, drum, fade)
      if (!driven && c.mode === 'shown') { c.el.style.setProperty('--s', '1'); c.el.style.setProperty('--o', '1'); }
    }
    motion.center = null; motion.u = 0; motion.stepT = 0;
    const why = style === 'still' ? 'every guest fits, so they stand still' : 'too few guests to loop without an empty stretch, so up and down';
    if (lastStyle !== null) window.stc.log(`strip: motion ${style}${style !== cfg.layout.style ? ` (${cfg.layout.style} chosen; ${why})` : ''}`);
    lastStyle = style;
  }
  // driven styles: every visible card to its spot. Returns true while a card is still catching up.
  // Each card sits EXACTLY on its spot (no lag: a lagging loop card would still show when it changes ends).
  // Only a SUDDEN change of spot (a guest joins or leaves, so the others move up or down one place) is
  // smoothed: the jump becomes an offset that fades out in FOLLOW_S. Changing ends (the reel wrapping) snaps.
  const SUDDEN = { y: 30, s: 0.03, rx: 12, zr: 20 };      // more than this in one frame is not the motion itself
  const WRAP = { y: () => dims.winH / 2, s: () => 1, rx: () => 120, zr: () => 1e9 };
  function placeDriven(visible, dt, style) {
    const L = cfg.layout, n = visible.length;
    const u = STY.advance(motion, dt, { ...L, style }, n);
    const decay = Math.exp(-dt / FOLLOW_S);
    let catching = false;
    visible.forEach((c, i) => {
      const p = STY.place(style, i, n, u, dims, SABOTAGE);
      let d = c.dd;
      if (!d) d = c.dd = { ...p, t: { ...p }, off: { y: 0, s: 0, rx: 0, zr: 0 } }; // new: starts on its spot
      else {
        for (const key of ['y', 's', 'rx', 'zr']) {
          const jump = p[key] - d.t[key];
          if (Math.abs(jump) > WRAP[key]()) d.off[key] = 0;                  // changing ends: snap
          else if (Math.abs(jump) > SUDDEN[key]) d.off[key] -= jump;          // moved a place: keep it where it is …
          d.off[key] *= decay;                                                // … and let it glide over
          if (Math.abs(d.off[key]) < (key === 's' ? 0.0005 : 0.05)) d.off[key] = 0; else catching = true;
          d[key] = p[key] + d.off[key];
        }
        d.t = { ...p }; d.o = p.o; d.z = p.z;
      }
      const vs = { '--y': d.y.toFixed(1) + 'px', '--s': d.s.toFixed(4), '--o': d.o.toFixed(3), '--rx': d.rx.toFixed(2) + 'deg',
        '--zr': d.zr.toFixed(1) + 'px', '--tz': (d.z * 0.01).toFixed(2) + 'px', z: String(d.z) };
      const old = c.vs || {};
      for (const [key, v] of Object.entries(vs)) {
        if (old[key] === v) continue;
        if (key === 'z') c.el.style.zIndex = v; else c.el.style.setProperty(key, v);
      }
      c.vs = vs;
    });
    return catching;
  }

  // SMART (his friend's idea): when every live guest fits in the window, nothing needs to move: they stand
  // still, centred. A style's motion starts only when there are more guests than fit.
  function fitsAll(n) {
    if (n === 0) return true;
    const { H, gap, winH, margin } = dims;
    return n * H + (n - 1) * gap <= winH - 2 * margin;
  }
  // and the loop / step with too few guests to fill the reel would leave an empty stretch after the last
  // one (a guest must be fully gone before it comes back at the other end): Up and down never has one
  function leavesGap(n) {
    const { L, P } = STY.loopLength(n, dims);
    return L > n * P;
  }
  function styleNow(n) {
    const L = cfg.layout;
    if (L.style === 'still' || L.smartFit === false) return L.style;
    if (fitsAll(n)) return 'still';
    if ((L.style === 'loop' || L.style === 'step') && leavesGap(n) && SABOTAGE !== 'no-gap-fallback') return 'pingpong'; // tests: sabotage = the 0.3.1 gap
    return L.style;
  }

  function frame(now) {
    frameRuns++;
    // after a planned rest (a driven style holding a guest) the clock keeps the whole gap
    const dt = Math.min(motion.resting ? 1 : 0.1, (now - motion.last) / 1000);
    motion.last = now; motion.resting = false;
    const list = [...cards.values()];
    for (const c of list) c.wantShow = !cfg.hideWhenDead || c.live === 'alive';
    const style = styleNow(list.filter((c) => c.wantShow).length);
    if (style !== lastStyle) useStyle(style);
    const driven = STY.DRIVEN.includes(style);
    const visible = list.filter((c) => c.wantShow);
    const { H, gap, winH } = dims;

    // place the visible cards in their slots
    visible.forEach((c, i) => {
      const y = i * (H + gap);
      if (c.mode !== 'shown') {           // entering: appear at its slot, then fade + grow in
        clearTimeout(c.outTimer);
        c.el.classList.remove('parked');
        c.parkY = null;
        if (OSR) window.stc.osr.active(c.id, true);
        c.el.classList.add('snap');
        if (!driven) c.el.style.setProperty('--y', y + 'px');
        c.dd = null; c.vs = null;         // driven: starts exactly at its spot
        c.el.style.setProperty('--s', '0.85');
        c.el.style.setProperty('--o', '0');
        void c.el.offsetWidth;
        c.el.classList.remove('snap');
        c.el.style.setProperty('--s', '1');
        c.el.style.setProperty('--o', '1');
        c.mode = 'shown';
      } else if (!driven && c.y !== y) {
        c.el.style.setProperty('--y', y + 'px'); // slides (CSS transition): the gap closes
      }
      c.y = driven ? null : y;
    });
    // cards leaving: fade out where they are, then park
    for (const c of list) {
      if (c.wantShow || c.mode !== 'shown') continue;
      c.mode = 'leaving';
      c.el.style.setProperty('--o', '0');
      c.el.style.setProperty('--s', '0.85');
      c.outTimer = setTimeout(() => { if (c.mode === 'leaving') { c.mode = 'parked'; c.el.classList.add('parked'); clearDriven(c); if (OSR) window.stc.osr.active(c.id, false); } }, OUT_MS);
    }

    if (driven) return frameDriven(now, list, visible, dt, style);

    // the cycle: ease centre + travel toward the visible set's; the phase is continuous
    const t = targets(visible.length);
    if (motion.center === null) { motion.center = t.center; motion.dist = t.dist; }
    const k = 1 - Math.exp(-dt / EASE_S);
    motion.center += (t.center - motion.center) * k;
    motion.dist += (t.dist - motion.dist) * k;
    // arrive exactly (an ease never quite does): then a still strip really is still and idles
    if (Math.abs(t.center - motion.center) < 0.5) motion.center = t.center;
    if (Math.abs(t.dist - motion.dist) < 0.5) motion.dist = t.dist;
    const period = style === 'still' ? 0 : cfg.layout.cycleSeconds;
    if (period > 0) motion.phase = (motion.phase + dt / period) % 1;
    motion.offset = period > 0 ? motion.center + (motion.dist / 2) * Math.cos(2 * Math.PI * motion.phase) : motion.center;
    const tf = `translate3d(0, ${motion.offset.toFixed(1)}px, 0)`;
    if (tf !== motion.tf) { track.style.transform = tf; motion.tf = tf; } // no style work when unchanged

    // parked cards: kept in the middle of the window (rendered, invisible)
    const parkY = winH / 2 - H / 2 - motion.offset;
    for (const c of list) {
      if (c.mode !== 'parked') continue;
      const py = parkY.toFixed(0) + 'px';
      if (c.parkY !== py) { c.el.style.setProperty('--y', py); c.parkY = py; }
    }

    tickDebug(now);
    // Nothing moving (still strip, no easing, no fade, overlay hidden) = no per-frame work:
    // look again 4x a second for a changed visible set.
    const settling = Math.abs(t.center - motion.center) > 0.3 || Math.abs(t.dist - motion.dist) > 0.3 || list.some((c) => c.mode === 'leaving');
    const active = period > 0 || settling || !dbg.hidden || PERF_OFF.includes('idle');
    // Motion is STEPPED: MOTION_FPS transform writes a second (default 30, like the
    // guests' video), not one per display refresh. 0 = every display frame (the old way).
    if (active && MOTION_FPS > 0) setTimeout(() => requestAnimationFrame(frame), Math.max(0, 1000 / MOTION_FPS - 9));
    else if (active) requestAnimationFrame(frame);
    else setTimeout(() => { motion.last = performance.now(); requestAnimationFrame(frame); }, 250);
  }

  function frameDriven(now, list, visible, dt, style) {
    const L = { ...cfg.layout, style };
    motion.offset = 0;
    const tf = 'translate3d(0, 0px, 0)';
    if (tf !== motion.tf) { track.style.transform = tf; motion.tf = tf; }
    const catching = placeDriven(visible, dt, style);
    const parkY = (dims.winH / 2 - dims.H / 2).toFixed(0) + 'px';
    for (const c of list) if (c.mode === 'parked' && c.parkY !== parkY) { c.el.style.setProperty('--y', parkY); c.parkY = parkY; }
    tickDebug(now);
    // Moving = a slide is on (loop: always). Holding still = no per-frame work: wake when the
    // next slide starts (or in 250 ms, to notice a changed visible set); the clock keeps the gap.
    const canMove = visible.length >= (L.style === 'loop' || L.style === 'step' ? 1 : 2);
    const active = (canMove && STY.sliding(motion, L)) || catching || list.some((c) => c.mode === 'leaving') || !dbg.hidden || PERF_OFF.includes('idle');
    if (active && MOTION_FPS > 0) setTimeout(() => requestAnimationFrame(frame), Math.max(0, 1000 / MOTION_FPS - 9));
    else if (active) requestAnimationFrame(frame);
    else {
      motion.resting = true;
      const untilSlide = canMove ? STY.untilSlide(motion, L) * 1000 : Infinity;
      setTimeout(() => requestAnimationFrame(frame), Math.max(0, Math.min(250, untilSlide - 9)));
    }
  }

  // ---------- debug overlay (D) ----------
  let frames = 0, fps = 0, fpsAt = performance.now(), dbgAt = 0;
  function tickDebug(now) {
    frames++;
    if (now - fpsAt >= 1000) { fps = Math.round(frames * 1000 / (now - fpsAt)); frames = 0; fpsAt = now; }
    if (!dbg.hidden && now - dbgAt > 250) { dbgAt = now; drawDebug(); }
  }
  function drawDebug() {
    const list = [...cards.values()];
    const shown = list.filter((c) => c.mode === 'shown').length;
    const L = cfg.layout;
    const motionText = STY.DRIVEN.includes(L.style) ? `${L.style} ${L.secondsPerGuest}s/guest` : `${L.style} ${L.cycleSeconds}s (${Math.round(motion.dist)}px)`;
    const head = `fps ${fps}   guests ${list.length}   shown ${shown}   hideWhenDead ${cfg.hideWhenDead}   ${motionText}`;
    const rows = list.map((c, i) => {
      const live = c.live === 'dead' ? (cfg.hideWhenDead ? 'dead (hidden)' : 'dead') : c.live;
      return `${String(i + 1).padStart(2)}. ${c.name.slice(0, 18).padEnd(18)} ${live.padEnd(14)} ${String(c.load).slice(0, 24).padEnd(24)} ${c.video}`;
    });
    const esc = (s) => s.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
    dbg.innerHTML = [esc(head), ...rows.map(esc),
      configError ? `<span class="err">config.json: ${esc(configError)} (still showing the last good config)</span>` : 'config.json OK (edit + save: applies within a second)',
      'R reload all · D hide this · Esc quit'].join('\n');
  }
  window.stc.onToggleDebug(() => { dbg.hidden = !dbg.hidden; if (!dbg.hidden) drawDebug(); });

  // ---------- 3. live config ----------
  window.stc.onConfig((next) => {
    window.stc.log(`strip: config received (hideTwitchName ${next.layout.hideTwitchName === true})`);
    cfg = next; configError = null;
    try { applyLayout(); syncCards(); } catch (e) { window.stc.log('strip: applying the config failed: ' + (e && e.message)); }
  });
  window.stc.onConfigError((msg) => { configError = msg; });

  applyLayout();
  syncCards();
  requestAnimationFrame(frame);
  let resizeRaf = 0;
  window.addEventListener('resize', () => { cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(() => { try { applyLayout(); } catch {} }); });

  // ---------- used by the proof script only (never a URL) ----------
  window.__stc = {
    snapshot: () => ({
      settled: STY.DRIVEN.includes(lastStyle) ? [...cards.values()].every((c) => c.mode !== 'shown' || !c.dd || !c.vs || c.vs['--y'] === c.dd.y.toFixed(1) + 'px')
        : (() => { const t = targets([...cards.values()].filter((c) => c.wantShow).length); return t.center === motion.center && t.dist === motion.dist; })(),
      style: lastStyle, chosen: cfg.layout.style, u: motion.u || 0, winH: dims.winH,
      fps, frameRuns, wall: Date.now(), offset: Math.round(motion.offset), dist: Math.round(motion.dist), configError,
      cards: [...cards.values()].map((c) => {
        const r = c.el.getBoundingClientRect();
        return { name: c.name, mirrored: c.el.classList.contains('mirrored'), mirrorMode: c.mirrorMode || 'none', cardH: dims.cardH, strip: dims.strip, pad: dims.pad, live: c.live, load: c.load, mode: c.mode, video: c.video, slotY: c.y,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          boxShadow: getComputedStyle(c.el).boxShadow,
          driven: c.dd ? { y: Math.round(c.dd.y), o: +c.dd.o.toFixed(3), rx: +c.dd.rx.toFixed(1), z: c.dd.z } : null,
          opacity: getComputedStyle(c.el).opacity };
      }),
    }),
    showDebug: (on) => { dbg.hidden = !on; if (on) drawDebug(); },
    render: boot.render,
    cssState: () => [...cards.values()].map((c) => ({ name: c.name, twitch: !!c.twitch, ready: !!c.ready, load: c.load, want: c.cssWant || {}, sheet: !!c.sheetKey, nameplateMissing: !!c.nameplateMissing })),
    osrStats: () => (OSR ? window.stc.osr.stats() : null),
  };
})();
