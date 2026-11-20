'use strict';
// The Settings window: the sources table + layout. Every change is saved at once (main
// validates, writes userData/config.json atomically and updates the strip live).
// Links are secret: shown masked, revealed only on the eye button, never logged.

(async () => {
  const $ = (s) => document.querySelector(s);
  const boot = await window.camreel.config();
  let cfg = clone(boot.cfg);
  let status = await window.camreel.status();
  const SABOTAGE = boot.sabotage || '';
  const revealed = new Set(); // links shown in clear (this window only, not saved)
  if (boot.configError) banner(`Your settings file has a problem: ${boot.configError}`);
  else if (boot.restartNote) banner(boot.restartNote);

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function canon(o) { return JSON.stringify(o, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((a, k) => ((a[k] = v[k]), a), {}) : v)); }
  function banner(msg) { const b = $('#banner'); b.hidden = !msg; b.textContent = msg || ''; }
  function pasteError(msg, warn) { const e = $('#pasteError'); e.hidden = !msg; e.textContent = msg || ''; e.className = warn ? 'inline-error inline-warn' : 'inline-error'; }

  async function save() {
    const r = await window.camreel.save(cfg);
    if (!r.ok) { banner(`Not saved: ${r.error}`); return false; }
    banner('');
    return true;
  }

  // ---------------------------------------------------------------- sources table
  function stateOf(src) {
    if (!src.enabled) return ['off', 'off'];
    const s = status[src.url];
    if (!s || s.live === 'loading') return ['loading', 'loading'];
    if (s.live === 'alive') return ['live', 'live'];
    return ['novideo', 'no video'];
  }

  function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k in e) e[k] = v;
      else e.setAttribute(k, v);
    }
    e.append(...kids);
    return e;
  }

  function renderRows() {
    const tbody = $('#rows');
    tbody.textContent = '';
    cfg.sources.forEach((src, i) => {
      const [stKey, stText] = stateOf(src);
      const tr = el('tr', { class: src.enabled ? '' : 'off', 'data-i': String(i) });
      const toggle = el('input', { type: 'checkbox', class: 'toggle', checked: !!src.enabled, title: 'Show this guest (off = not loaded at all)',
        onchange: () => { src.enabled = toggle.checked; save(); renderRows(); } });
      const name = el('input', { class: 'name', value: src.name, maxLength: 60, spellcheck: false,
        onchange: () => { const v = name.value.trim() || `Guest ${i + 1}`; if (v !== src.name) { src.name = v; save(); } },
        onkeydown: (e) => { if (e.key === 'Enter') name.blur(); } });
      const isOpen = revealed.has(src.url);
      const linkBox = el('div', { class: 'link' },
        isOpen ? el('input', { class: 'revealed', value: src.url, readOnly: true, spellcheck: false }) : el('span', { class: 'masked', text: '••••••••••••••••' }),
        el('button', { class: 'icon eye', title: isOpen ? 'Hide link' : 'Show link', text: isOpen ? '🙈' : '👁',
          onclick: () => { isOpen ? revealed.delete(src.url) : revealed.add(src.url); renderRows(); } }),
        el('button', { class: 'icon copy', title: 'Copy link', text: 'Copy',
          onclick: async (e) => { await window.camreel.copy(src.url); e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = 'Copy'), 1200); } }));
      const st = el('span', { class: `status st-${stKey}` }, el('span', { class: 'dot' }), stText);
      const npNote = el('div', { class: 'np-note', text: "Twitch's name tag not found: Twitch may have changed its page" });
      npNote.hidden = !(status[src.url] && status[src.url].nameplateMissing);
      // ⇋ shows the EFFECTIVE state (this source's own choice, else "Mirror all cameras");
      // a click makes it this source's own choice, the opposite of what it shows now
      const mirrored = (src.mirror ?? cfg.layout.mirrorAll) === true;
      const mirror = el('button', { class: `icon mirror${mirrored ? ' on' : ''}`, title: 'Mirror this camera (left ↔ right)', text: '⇋',
        'aria-pressed': String(mirrored), onclick: () => { src.mirror = !mirrored; save(); renderRows(); } });
      const up = el('button', { class: 'icon up', title: 'Move up', text: '▲', disabled: i === 0, onclick: () => move(i, -1) });
      const down = el('button', { class: 'icon down', title: 'Move down', text: '▼', disabled: i === cfg.sources.length - 1, onclick: () => move(i, 1) });
      const del = el('button', { class: 'icon del', title: 'Delete', text: '✕', onclick: () => { cfg.sources.splice(i, 1); revealed.delete(src.url); save(); renderRows(); } });
      tr.append(el('td', {}, toggle), el('td', {}, name), el('td', {}, linkBox), el('td', {}, st, npNote), el('td', {}, mirror), el('td', {}, up, down), el('td', {}, del));
      tbody.append(tr);
    });
    // the always-empty last row: paste a link here, again and again
    const pasteKey = /Mac/i.test(navigator.platform) ? '⌘V' : 'Ctrl+V';
    const paste = el('input', { id: 'paste', placeholder: cfg.sources.length >= 20 ? 'The list is full (20 guests)' : cfg.sources.length ? `Add a guest: paste a Stream Together link here (${pasteKey})` : `Start here: paste ONE Stream Together link (${pasteKey})`, spellcheck: false, disabled: cfg.sources.length >= 20,
      onpaste: (e) => { if (SABOTAGE === 'paste-noop') return; e.preventDefault(); add((e.clipboardData || window.clipboardData).getData('text')); },
      onkeydown: (e) => { if (e.key === 'Enter') add(paste.value); } });
    const plus = el('button', { class: 'plus', title: 'Add a guest: paste a link', text: '+', disabled: cfg.sources.length >= 20, onclick: () => paste.focus() });
    tbody.append(el('tr', { class: 'empty' }, el('td', {}, plus), el('td', { colSpan: 6 }, paste)));
    const live = cfg.sources.filter((s) => stateOf(s)[0] === 'live').length;
    $('#count').textContent = cfg.sources.length ? `· ${cfg.sources.length} guests · ${cfg.sources.filter((s) => s.enabled).length} on · ${live} live` : '';
    renderSeatOffer();
  }

  function move(i, d) {
    const j = i + d;
    if (j < 0 || j >= cfg.sources.length) return;
    [cfg.sources[i], cfg.sources[j]] = [cfg.sources[j], cfg.sources[i]];
    save(); renderRows();
  }

  function autoName(url) {
    const m = /\/guest-star\/([^/?#]+)/i.exec(url);
    const ch = m ? decodeURIComponent(m[1]) : '';
    if (ch && !cfg.sources.some((s) => s.name.toLowerCase() === ch.toLowerCase())) return ch;
    let n = cfg.sources.length + 1;
    while (cfg.sources.some((s) => s.name === `Guest ${n}`)) n++;
    return `Guest ${n}`;
  }

  async function add(text) {
    const url = String(text || '').trim();
    if (!url) return;
    let ok = false;
    try { const u = new URL(url); ok = (u.protocol === 'https:' || u.protocol === 'http:') && !!u.host; } catch {}
    if (!ok) { pasteError('That is not a link. Copy the Browser Source URL from Stream Together (it starts with https://).'); $('#paste').value = ''; return; }
    const dup = cfg.sources.findIndex((s) => s.url === url);
    if (dup >= 0) { pasteError(`That link is already in the list (row ${dup + 1}, "${cfg.sources[dup].name}"). Not added.`, true); $('#paste').value = ''; seatFrom = url; renderSeatOffer(); return; }
    if (cfg.sources.length >= 20) { pasteError('The list is full (20 guests).'); return; }
    pasteError('');
    cfg.sources.push({ url, name: autoName(url), enabled: true });
    if (!(await save())) { cfg.sources.pop(); renderRows(); return; }
    seatFrom = url;
    renderRows();
    const nameInput = document.querySelector(`tr[data-i="${cfg.sources.length - 1}"] .name`);
    nameInput.focus(); nameInput.select(); // type a better name, or just paste the next link
  }

  // ---------------------------------------------------------------- guest seats from one link
  // One person's Twitch links differ only in the seat number (src/seats.js), so after a
  // seat link is pasted CamReel offers that person's other guest seats: one paste, not five.
  // Nothing is added until the button is clicked. The offer never shows the link.
  let seatFrom = null; // the pasted link the offer is for (this window only, not saved)
  let seatNoThanks = false; // "No thanks" on an offer made from links already in the list (this window only)
  // Also offer seats for links ALREADY in the list (a link pasted in an older version, or yesterday):
  // otherwise the button only ever appeared right after a paste, and people who had a link never saw it.
  function seatSource() {
    const urls = cfg.sources.map((s) => s.url);
    // the link just pasted wins, but only if it IS a seat link with seats missing (a plain link must not block the rest)
    if (seatFrom && urls.includes(seatFrom) && window.CamReelSeats.missingSeats(seatFrom, urls).length) return seatFrom;
    if (seatNoThanks) return null;
    const src = cfg.sources.find((s) => window.CamReelSeats.parse(s.url) && window.CamReelSeats.missingSeats(s.url, urls).length);
    return src ? src.url : null;
  }
  function seatName(n, channel) {
    const taken = (name) => cfg.sources.some((s) => s.name === name);
    if (!taken(`Guest ${n}`)) return `Guest ${n}`;
    let name = `Guest ${n} (${channel})`.slice(0, 60);
    for (let k = 2; taken(name); k++) name = `Guest ${n} (${k})`;
    return name;
  }
  function seatsToAdd() {
    const from = seatSource();
    if (!from) return [];
    return window.CamReelSeats.missingSeats(from, cfg.sources.map((s) => s.url)).slice(0, Math.max(0, 20 - cfg.sources.length));
  }
  function renderSeatOffer() {
    const box = $('#seatOffer');
    const seats = seatsToAdd();
    box.textContent = '';
    box.hidden = !seats.length;
    if (!seats.length) return;
    const p = window.CamReelSeats.parse(seatSource());
    const list = seats.length === 1 ? `Guest ${seats[0].slot}` : `Guest ${seats.map((s) => s.slot).join(', ')}`;
    box.append(
      el('span', { class: 'seat-text' }, el('b', { text: 'Add the rest of your guests? ' }), `From your link CamReel can make ${list}. Seats nobody sits in stay hidden.`),
      el('button', { id: 'seatAdd', text: seats.length === 1 ? 'Add 1 guest seat' : `Add ${seats.length} guest seats`, onclick: addSeats }),
      el('button', { id: 'seatNo', class: 'quiet', text: 'No thanks', onclick: () => { seatFrom = null; seatNoThanks = true; renderSeatOffer(); } }));
  }
  async function addSeats() {
    const seats = seatsToAdd();
    if (!seats.length) return;
    const p = window.CamReelSeats.parse(seatSource());
    const before = cfg.sources.length;
    for (const s of seats) cfg.sources.push({ url: s.url, name: seatName(s.slot, p.channel), enabled: true });
    if (!(await save())) { cfg.sources.length = before; renderRows(); return; }
    seatFrom = null;
    pasteError('');
    renderRows();
  }

  // ---------------------------------------------------------------- style tiles
  const TILE = {
    pingpong: ['Up and down', 'turns round at the ends', '<path d="M16 4v24M10 10l6-6 6 6M10 22l6 6 6-6"/>'],
    loop: ['Endless loop', 'never rests · costs more', '<path d="M24 11a9 9 0 1 0 1 8"/><path d="M25 4v7h-7"/>'],
    step: ['Step and hold', 'moves, then rests', '<path d="M5 27h7v-7h7v-7h7V6"/>'],
    fade: ['Fade', 'one at a time', '<rect x="5" y="9" width="14" height="14" rx="2"/><rect x="13" y="9" width="14" height="14" rx="2" opacity=".45"/>'],
    deck: ['Deck of cards', 'front flies off', '<rect x="7" y="12" width="18" height="13" rx="2"/><path d="M9 9h14M11 6h10"/>'],
    drum: ['3D drum', 'a turning wheel', '<ellipse cx="16" cy="16" rx="11" ry="5"/><path d="M5 16v0M5 10c0 3 5 5 11 5s11-2 11-5M5 22c0 3 5 5 11 5s11-2 11-5"/>'],
    still: ['Still', 'no motion · cheapest', '<path d="M11 7v18M21 7v18"/>'],
  };
  function buildTiles() {
    const box = $('#styleTiles');
    const sel = $('[data-k="layout.style"]');
    for (const [style, [name, sub, icon]] of Object.entries(TILE)) {
      const b = el('button', { class: 'tile', type: 'button', 'data-style': style, title: STYLE_INFO[style] || name,
        onclick: () => { sel.value = style; sel.dispatchEvent(new Event('change')); } });
      b.innerHTML = `<svg viewBox="0 0 32 32" aria-hidden="true">${icon}</svg><b></b><small></small>`;
      b.querySelector('b').textContent = name; b.querySelector('small').textContent = sub;
      box.append(b);
    }
  }

  // ---------------------------------------------------------------- live preview + "which part does this change"
  let currentHL = null, lastLive = -1;
  function wireHighlights() {
    for (const node of document.querySelectorAll('[data-hl]')) {
      const on = () => setHL(node.dataset.hl, node.dataset.tip);
      node.addEventListener('mouseenter', on);
      node.addEventListener('focusin', (e) => { e.stopPropagation(); on(); });
      node.addEventListener('mouseleave', () => { if (!node.contains(document.activeElement)) setHL(null); });
      node.addEventListener('focusout', () => setHL(null));
    }
  }
  function setHL(key, tip) {
    if (key && document.body.classList.contains('simple')) return; // Simple view: a calm preview, no lighting up
    if (key === currentHL && (!tip || $('#pvTip').textContent === tip)) return;
    currentHL = key;
    $('#pvTip').textContent = tip || 'Point at any setting: the part of the strip it changes lights up here.';
    $('#pvTip').classList.toggle('on', !!key);
    drawPreview();
  }

  // The same geometry the strip uses (renderer.js applyLayout + the smart rule), from the settings alone.
  function model() {
    const W = cfg.window, L = cfg.layout;
    const winW = W.width, winH = W.height;
    const live = cfg.sources.filter((s) => stateOf(s)[0] === 'live').length;
    const on = cfg.sources.filter((s) => s.enabled).length;
    const n = live || on || 3;
    const margin = L.margin, vM = L.verticalMargin >= 0 ? L.verticalMargin : L.margin;
    const cardW = Math.max(40, L.cardWidth > 0 ? L.cardWidth : winW - 2 * margin);
    const pad = L.cardPadding, picW = cardW - 2 * pad, picH = Math.round(picW * 9 / 16);
    const strip = L.nameStrip ? (L.nameHeight > 0 ? L.nameHeight : Math.max(20, Math.round(Math.min(cardW, 600) * 0.08))) : 0;
    const H = picH + strip + 2 * pad, gap = L.gap, P = H + gap;
    const T = n * H + (n - 1) * gap;
    const fits = T <= winH - 2 * vM;
    const x = L.side === 'right' ? winW - margin - cardW : margin;
    let motion = L.style;
    if (L.style !== 'still' && L.smartFit !== false) {
      if (fits) motion = 'still';
      else if ((L.style === 'loop' || L.style === 'step') && Math.max(n * P, winH + H + 2) > n * P) motion = 'pingpong';
    }
    return { winW, winH, n, live, on, margin, vM, cardW, pad, picW, picH, strip, H, gap, T, fits, x, y0: winH / 2 - T / 2, motion };
  }

  function drawPreview() {
    const svg = $('#preview');
    if (!svg) return;
    const L = cfg.layout, m = model();
    const u = Math.max(m.winW, m.winH) / 160;                      // 1 "preview pixel" in window pixels
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const bg = String(cfg.window.background).toLowerCase();
    const hl = currentHL, HL = 'fill="#f2b84b" fill-opacity=".55" stroke="#ffcf5c" stroke-width="' + u * 0.8 + '"';
    const names = cfg.sources.filter((s) => s.enabled).map((s) => s.name);
    const parts = [];
    parts.push(`<defs><pattern id="chk" width="${u * 8}" height="${u * 8}" patternUnits="userSpaceOnUse"><rect width="${u * 8}" height="${u * 8}" fill="#2a2a34"/><rect width="${u * 4}" height="${u * 4}" fill="#3a3a46"/><rect x="${u * 4}" y="${u * 4}" width="${u * 4}" height="${u * 4}" fill="#3a3a46"/></pattern>
      <linearGradient id="nm" x1="0" x2="1"><stop offset="0" stop-color="${esc(L.accent)}"/><stop offset=".7" stop-color="#1b1b22"/></linearGradient>
      <clipPath id="win"><rect width="${m.winW}" height="${m.winH}"/></clipPath>
      <filter id="sh" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="${u * 3}" stdDeviation="${u * 3}" flood-opacity=".6"/></filter></defs>`);
    parts.push(`<rect width="${m.winW}" height="${m.winH}" fill="${bg === 'transparent' ? 'url(#chk)' : esc(cfg.window.background)}"/>`);
    parts.push('<g clip-path="url(#win)">');
    const cards = [];
    for (let i = 0; i < m.n; i++) {
      const y = m.y0 + i * (m.H + m.gap);
      cards.push(y);
      const r = Math.min(L.cornerRadius, m.H / 2, m.cardW / 2);
      parts.push(`<rect class="pv-cardbox" x="${m.x}" y="${y}" width="${m.cardW}" height="${m.H}" rx="${r}" fill="${esc(L.frameColor)}"${L.shadow ? ' filter="url(#sh)"' : ''}${L.outline ? ` stroke="${esc(L.accent)}" stroke-width="${Math.max(2, u * 0.8)}"` : ''}/>`);
      const px = m.x + m.pad, py = y + m.pad;
      parts.push(`<rect x="${px}" y="${py}" width="${m.picW}" height="${m.picH}" fill="#3b4150" rx="${m.pad ? r / 3 : 0}"/>`);
      // a person: head + shoulders, mirrored-agnostic
      const cx = px + m.picW * (L.mirrorAll ? 0.62 : 0.38), cy = py + m.picH * 0.42, hr = m.picH * 0.16;
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${hr}" fill="#6b7386"/><path d="M${cx - hr * 2.2} ${py + m.picH} q${hr * 2.2} ${-hr * 3.6} ${hr * 4.4} 0z" fill="#6b7386"/>`);
      if (!L.hideTwitchName) parts.push(`<rect class="pv-tag" x="${px + m.picW * 0.04}" y="${py + m.picH * 0.76}" width="${m.picW * 0.3}" height="${m.picH * 0.11}" rx="${m.picH * 0.03}" fill="#2f5fd0"/>`);
      if (m.strip) {
        const sy = py + m.picH, fs = L.nameSize > 0 ? L.nameSize : m.strip * 0.5;
        const anchor = L.nameAlign === 'center' ? 'middle' : L.nameAlign === 'right' ? 'end' : 'start';
        const tx = L.nameAlign === 'center' ? px + m.picW / 2 : L.nameAlign === 'right' ? px + m.picW - L.namePadding : px + L.namePadding;
        parts.push(`<rect class="pv-name" x="${px}" y="${sy}" width="${m.picW}" height="${m.strip}" fill="url(#nm)"/>`);
        parts.push(`<text x="${tx}" y="${sy + m.strip / 2}" dominant-baseline="central" text-anchor="${anchor}" font-size="${fs}" font-weight="700" fill="#fff" font-family="-apple-system, sans-serif">${esc(names[i] || `Guest ${i + 1}`)}</text>`);
      }
    }
    // what the pointed-at setting changes
    const mark = (shape) => parts.push(shape.replace('<rect ', `<rect class="pv-hl" ${HL} `).replace('<path ', `<path class="pv-hl" ${HL} `));
    const cardPath = (y) => `M${m.x} ${y}h${m.cardW}v${m.H}h${-m.cardW}z`;
    if (hl === 'guests' || hl === 'card' || hl === 'outline') for (const y of cards) mark(`<rect x="${m.x}" y="${y}" width="${m.cardW}" height="${m.H}" fill-opacity=".3" rx="${L.cornerRadius}"/>`);
    if (hl === 'picture') for (const y of cards) mark(`<rect x="${m.x + m.pad}" y="${y + m.pad}" width="${m.picW}" height="${m.picH}"/>`);
    if (hl === 'name') for (const y of cards) mark(`<rect x="${m.x + m.pad}" y="${y + m.pad + m.picH}" width="${m.picW}" height="${Math.max(m.strip, u * 2)}"/>`);
    if (hl === 'twitchname') for (const y of cards) mark(`<rect x="${m.x + m.pad + m.picW * 0.04}" y="${y + m.pad + m.picH * 0.76}" width="${m.picW * 0.3}" height="${m.picH * 0.11}"/>`);
    if (hl === 'frame') for (const y of cards) mark(`<path fill-rule="evenodd" d="${cardPath(y)}M${m.x + m.pad} ${y + m.pad}v${m.picH + m.strip}h${m.picW}v${-(m.picH + m.strip)}z"/>`);
    if (hl === 'gap') for (const y of cards.slice(0, -1)) mark(`<rect x="${m.x}" y="${y + m.H}" width="${m.cardW}" height="${Math.max(m.gap, u * 1.5)}"/>`);
    if (hl === 'margin-side') { mark(`<rect x="0" y="0" width="${Math.max(m.x, u)}" height="${m.winH}"/>`); mark(`<rect x="${Math.min(m.x + m.cardW, m.winW - u)}" y="0" width="${Math.max(m.winW - m.x - m.cardW, u)}" height="${m.winH}"/>`); }
    if (hl === 'margin-v') { mark(`<rect x="0" y="0" width="${m.winW}" height="${Math.max(m.vM, u)}"/>`); mark(`<rect x="0" y="${m.winH - Math.max(m.vM, u)}" width="${m.winW}" height="${Math.max(m.vM, u)}"/>`); }
    if (hl === 'bg') mark(`<path fill-rule="evenodd" fill-opacity=".35" d="M0 0h${m.winW}v${m.winH}h${-m.winW}z${cards.map(cardPath).join('')}"/>`);
    if (hl === 'motion') {
      const ax = Math.min(m.winW - u * 10, m.x + m.cardW - u * 2) - u * 6, my = m.winH / 2, len = m.winH * 0.32;
      const arrow = { pingpong: `M${ax} ${my - len}v${len * 2}m${-u * 5} ${-u * 6}l${u * 5} ${u * 6}l${u * 5} ${-u * 6}M${ax - u * 5} ${my - len + u * 6}l${u * 5} ${-u * 6}l${u * 5} ${u * 6}`,
        loop: `M${ax} ${my + len}v${-len * 2}m${-u * 5} ${u * 6}l${u * 5} ${-u * 6}l${u * 5} ${u * 6}`,
        step: `M${ax} ${my + len}v${-len * 2}m${-u * 5} ${u * 6}l${u * 5} ${-u * 6}l${u * 5} ${u * 6}` }[m.motion];
      if (arrow) parts.push(`<path class="pv-hl" d="${arrow}" fill="none" stroke="#ffcf5c" stroke-width="${u * 2}" stroke-linecap="round" stroke-linejoin="round"/>`);
      else for (const y of cards) mark(`<rect x="${m.x}" y="${y}" width="${m.cardW}" height="${m.H}" fill-opacity=".25"/>`);
    }
    parts.push('</g>');
    parts.push(`<rect width="${m.winW}" height="${m.winH}" fill="none" stroke="${hl === 'window' ? '#ffcf5c' : '#555b6e'}" stroke-width="${u * (hl === 'window' ? 2 : 0.8)}" ${hl === 'window' ? 'class="pv-hl"' : ''}/>`);
    svg.setAttribute('viewBox', `0 0 ${m.winW} ${m.winH}`);
    svg.innerHTML = parts.join('');
    $('#pvSize').textContent = `${m.winW} × ${m.winH} · ${m.live ? `${m.live} live` : m.on ? `${m.on} on` : '3 example'} guest${m.n === 1 ? '' : 's'}`;
    const chosen = TILE[L.style][0];
    $('#pvMotion').textContent = m.motion === L.style
      ? (L.style === 'still' ? 'Stands still.' : `${chosen}: ${m.fits ? 'moving' : `${m.n} guests don't all fit, so they move`}.`)
      : m.motion === 'still' ? `Stands still, centred: ${m.n === 1 ? 'the guest fits' : `all ${m.n} guests fit`} (${chosen} starts when more are live than fit).`
        : `Up and down for now: too few guests for the ${chosen.toLowerCase()} without an empty stretch.`;
  }

  // ---------------------------------------------------------------- layout
  const get = (path) => path.split('.').reduce((o, k) => o[k], cfg);
  const set = (path, v) => { const ks = path.split('.'); const last = ks.pop(); ks.reduce((o, k) => o[k], cfg)[last] = v; };
  let saveTimer = null;
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 200); };

  // What each style does (shown under the picker).
  const STYLE_INFO = {
    pingpong: 'Scrolls down to the last guest, then back up. Moves all the time.',
    loop: 'Always moves the same way: a guest that leaves the top comes back in at the bottom. With too few guests to loop without an empty stretch, it moves up and down instead (while "Move only when they don\'t all fit" is on).',
    step: 'Shows the guests still, then moves one guest on. Rests between moves.',
    fade: 'One guest at a time, dissolving into the next. Rests between changes.',
    deck: 'The front guest flies off and the next comes up from behind. Rests between changes.',
    drum: 'The guests sit on a turning 3D wheel. Rests between turns.',
    still: 'No motion: the guests stand in a column. The cheapest.',
  };
  // Measured 2026-10-28 (docs/perf-2026-10-28.md, 1 real guest, Apple M4): moving cost ≈ 9 % of one core
  // over standing still, on top of the video. The loop moves every frame, all the time.
  const LOOP_WARNING = '⚠️ Costs more: the endless loop never rests. It redraws every frame for as long as it runs, which cost about 9 % of one CPU core more than standing still in our measurement (1 guest, Apple M4), on top of the guests\' video. Step and hold, Fade, Deck and 3D drum only pay that while they change guests (with the defaults, about 1 second in 8). If your fan spins up or your stream drops frames, pick one of those, or Still.';

  function renderAnim() {
    const st = cfg.layout.style;
    for (const lab of document.querySelectorAll('#anim [data-for]')) lab.hidden = !lab.dataset.for.split(' ').includes(st);
    $('#perGuestLabel').textContent = st === 'loop' ? 'Seconds per guest (speed)' : 'Seconds on each guest';
    $('#styleNote').textContent = STYLE_INFO[st] || '';
    const warn = $('#loopWarn');
    warn.hidden = st !== 'loop';
    if (st === 'loop') warn.textContent = LOOP_WARNING;
    for (const t of document.querySelectorAll('#styleTiles .tile')) t.classList.toggle('on', t.dataset.style === st);
  }

  function renderLayout() {
    renderAnim();
    drawPreview();
    for (const inp of document.querySelectorAll('[data-k]')) {
      if (document.activeElement === inp) continue;
      const v = get(inp.dataset.k);
      if (inp.type === 'checkbox') inp.checked = !!v; else inp.value = v;
    }
    const bg = String(cfg.window.background).toLowerCase();
    $('#bgMode').value = bg === 'transparent' ? 'transparent' : bg === '#00ff00' ? 'green' : 'custom';
    $('#bgColor').hidden = $('#bgMode').value !== 'custom';
    if ($('#bgMode').value === 'custom') $('#bgColor').value = cfg.window.background;
    $('#bgSimple').value = $('#bgMode').value;
    $('#winSize').textContent = `now ${cfg.window.width}×${cfg.window.height}`;
  }

  for (const inp of document.querySelectorAll('[data-k]')) {
    inp.addEventListener(inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'input', () => {
      let v = inp.type === 'checkbox' ? inp.checked : inp.value;
      if ('num' in inp.dataset) {
        v = Number(v);
        if (!isFinite(v) || inp.value === '') return;
        v = Math.min(Number(inp.max), Math.max(Number(inp.min), v));
      }
      set(inp.dataset.k, v);
      if (inp.dataset.k === 'layout.style') renderAnim();
      drawPreview();
      saveSoon();
    });
  }
  $('#bgMode').addEventListener('change', () => {
    const m = $('#bgMode').value;
    cfg.window.background = m === 'green' ? '#00ff00' : m === 'transparent' ? 'transparent' : ($('#bgColor').value || '#000000');
    renderLayout(); save();
  });
  // "Meld box": the strip window takes EXACTLY the size Meld shows (Meld's numbers are pixels of its canvas,
  // so 1:1 is already pixel-sharp; a bigger window would only cost more to draw).
  $('#matchMeld').addEventListener('click', () => {
    const w = Math.round(Number($('#meldW').value)), h = Math.round(Number($('#meldH').value));
    if (!(w >= 50 && h >= 50)) { $('#matchNote').textContent = 'type both numbers Meld shows, e.g. 432 × 830'; return; }
    cfg.window.width = Math.min(3840, Math.max(200, w)); cfg.window.height = Math.min(2160, Math.max(200, h));
    $('#matchNote').textContent = `strip is now ${cfg.window.width} × ${cfg.window.height}, the same as Meld's box`;
    renderLayout(); save();
  });
  $('#bgColor').addEventListener('input', () => { cfg.window.background = $('#bgColor').value; saveSoon(); });
  for (const b of document.querySelectorAll('[data-size]')) {
    b.addEventListener('click', () => { const [w, h] = b.dataset.size.split('x').map(Number); cfg.window.width = w; cfg.window.height = h; renderLayout(); save(); });
  }

  // ---------------------------------------------------------------- updates from main
  window.camreel.onConfig((next) => {
    if (canon(next) === canon(cfg)) return; // our own save coming back
    cfg = clone(next);
    banner('');
    const active = document.activeElement;
    const keep = active && active.closest('tr') ? [active.closest('tr').dataset.i, active.className] : null;
    renderRows(); renderLayout();
    if (keep) { const again = document.querySelector(`tr[data-i="${keep[0]}"] .${keep[1].split(' ')[0]}`); if (again) again.focus(); }
  });
  window.camreel.onConfigError((msg) => banner(`Your settings file has a problem (still using the last good settings): ${msg}`));
  window.camreel.onStatus((st) => {
    status = st;
    // only the status cells + count change: never rebuild rows while he is typing
    cfg.sources.forEach((src, i) => {
      const cell = document.querySelector(`tr[data-i="${i}"] .status`);
      if (!cell) return;
      const [k, t] = stateOf(src);
      if (cell.className !== `status st-${k}`) { cell.className = `status st-${k}`; cell.lastChild.textContent = t; }
      const note = document.querySelector(`tr[data-i="${i}"] .np-note`);
      if (note) note.hidden = !(status[src.url] && status[src.url].nameplateMissing);
    });
    const live = cfg.sources.filter((s) => stateOf(s)[0] === 'live').length;
    if (live !== lastLive) { lastLive = live; drawPreview(); }
    if (cfg.sources.length) $('#count').textContent = `· ${cfg.sources.length} guests · ${cfg.sources.filter((s) => s.enabled).length} on · ${live} live`;
  });

  // ---------------------------------------------------------------- is the strip drawn full size?
  const STRIP_MSG = {
    parked: '⚠️ Strip is parked (Stage Manager): your stream sees only a thumbnail.',
    minimized: '⚠️ Strip is minimized: your stream sees only a thumbnail.',
    hidden: '⚠️ Strip is hidden: your stream sees nothing.',
    closed: '⚠️ The strip window is closed: your stream sees nothing.',
  };
  function showStripState(st) {
    const msg = STRIP_MSG[st];
    $('#stripBanner').hidden = !msg;
    $('#stripMsg').textContent = msg || '';
  }
  $('#bringBack').addEventListener('click', () => window.camreel.restoreStrip());

  // ---------------------------------------------------------------- Simple / Advanced
  // Simple (the default) = the guest list + background. Advanced = every setting. Remembered per computer.
  const VIEW_KEY = 'camreel.view';
  function setView(v) {
    const view = v === 'advanced' ? 'advanced' : 'simple';
    document.body.classList.toggle('simple', view === 'simple');
    for (const b of document.querySelectorAll('#viewSwitch button')) b.setAttribute('aria-selected', String(b.dataset.view === view));
    if (view === 'simple') setHL(null);
    try { localStorage.setItem(VIEW_KEY, view); } catch {}
    return view;
  }
  let savedView = 'simple';
  try { savedView = localStorage.getItem(VIEW_KEY) || 'simple'; } catch {}
  setView(savedView);
  for (const b of document.querySelectorAll('#viewSwitch button')) b.addEventListener('click', () => setView(b.dataset.view));
  $('#toAdvanced').addEventListener('click', (e) => { e.preventDefault(); setView('advanced'); });
  $('#bgSimple').addEventListener('change', () => { $('#bgMode').value = $('#bgSimple').value; $('#bgMode').dispatchEvent(new Event('change')); });
  $('#showStripSimple').addEventListener('click', () => window.camreel.restoreStrip());

  // ---------------------------------------------------------------- updates
  // Nothing installs by itself: the bar only SAYS a new version is downloaded. The strip goes
  // away for a few seconds during the restart, so the button asks once more.
  let updateArmed = false;
  function showUpdate(st) {
    const ready = st && st.phase === 'ready';
    const loading = st && st.phase === 'downloading';
    $('#updateBar').hidden = !(ready || loading);
    $('#updateNow').hidden = !ready;
    if (!ready) updateArmed = false;
    $('#updateNow').textContent = updateArmed ? 'Yes, restart now' : 'Restart to update';
    $('#updateMsg').textContent = ready
      ? (updateArmed ? 'The strip disappears from your stream for a few seconds while CamReel restarts. Your guests and settings stay.' : `CamReel ${st.version} is ready (you have ${st.current}). It installs when you restart CamReel: not while you are live.`)
      : loading ? `Downloading CamReel ${st.version}… ${st.percent || 0} %` : '';
  }
  let lastUpdate = null;
  $('#updateNow').addEventListener('click', () => {
    if (!updateArmed) { updateArmed = true; showUpdate(lastUpdate); return; }
    window.camreel.installUpdate();
  });
  window.camreel.onUpdateState((st) => { lastUpdate = st; showUpdate(st); });
  lastUpdate = await window.camreel.updateState();
  showUpdate(lastUpdate);
  window.camreel.onStripState(showStripState);
  const ss = await window.camreel.stripState();
  showStripState(ss.state);
  $('#stripHint').hidden = ss.detect === 'full'; // cannot detect parking: say so, always

  buildTiles();
  wireHighlights();
  renderRows();
  renderLayout();
  if (!cfg.sources.length) $('#paste').focus();

  // used by the proof script only
  window.__settings = {
    rows: () => [...document.querySelectorAll('#rows tr')].map((tr) => tr.classList.contains('empty')
      ? { empty: true, value: tr.querySelector('#paste').value }
      : { npNote: !tr.querySelector('.np-note').hidden, name: tr.querySelector('.name').value, on: tr.querySelector('.toggle').checked, mirror: tr.querySelector('.mirror').getAttribute('aria-pressed') === 'true', status: tr.querySelector('.status').textContent, masked: !!tr.querySelector('.masked') }),
    active: () => { const a = document.activeElement; const tr = a && a.closest('tr'); return { cls: a ? a.className : '', id: a ? a.id : '', row: tr ? tr.dataset.i ?? 'empty' : null }; },
    error: () => ($('#pasteError').hidden ? '' : $('#pasteError').textContent),
    seatOffer: () => ($('#seatOffer').hidden ? null : { text: $('#seatOffer .seat-text').textContent, button: $('#seatAdd').textContent }),
    banner: () => ($('#banner').hidden ? '' : $('#banner').textContent),
    meld: () => $('#matchNote').textContent,
    preview: () => ({ hl: currentHL, tip: $('#pvTip').textContent, motion: $('#pvMotion').textContent, size: $('#pvSize').textContent,
      cards: document.querySelectorAll('#preview .pv-cardbox').length, marks: document.querySelectorAll('#preview .pv-hl').length,
      frames: [...document.querySelectorAll('#preview .pv-cardbox')].map((r) => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') })) }),
    hover: (sel) => { const e = document.querySelector(sel); e.dispatchEvent(new Event('mouseenter')); return currentHL; },
    anim: () => ({ style: $('[data-k="layout.style"]').value, shown: [...document.querySelectorAll('#anim [data-for]')].filter((l) => !l.hidden).map((l) => l.querySelector('[data-k]').dataset.k),
      note: $('#styleNote').textContent, warning: $('#loopWarn').hidden ? '' : $('#loopWarn').textContent }),
    view: (v) => (v ? setView(v) : (document.body.classList.contains('simple') ? 'simple' : 'advanced')),
    visible: (sel) => { const e = document.querySelector(sel); return !!(e && e.offsetParent !== null); },
    stripBanner: () => ($('#stripBanner').hidden ? '' : $('#stripMsg').textContent),
    updateBar: () => ($('#updateBar').hidden ? null : { text: $('#updateMsg').textContent, button: $('#updateNow').hidden ? null : $('#updateNow').textContent }),
    showUpdate: (st) => { lastUpdate = st; showUpdate(st); }, // the proof script shows a state without a real update
  };
})();
