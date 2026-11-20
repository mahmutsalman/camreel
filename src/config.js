'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const MAX_SOURCES = 20;
// pingpong = up, then back down (the original) · loop = endless, always the same way, a card that leaves
// comes back in at the other end · step = holds a card, then moves one card on · fade = one guest at a
// time, dissolving · deck = the front card flies off, the next comes up from behind · drum = a turning 3D
// wheel · still = no motion
const STYLES = ['pingpong', 'loop', 'step', 'fade', 'deck', 'drum', 'still'];
const DEFAULTS = {
  lookVersion: 2,           // see migrateLook()
  sources: [],
  hideWhenDead: true,       // a card shows only while its guest has live, moving video
  deadAfterSeconds: 4,      // how long a video must be still/gone before its card hides
  showAfterSeconds: 1,      // how long it must be live before its card shows
  layout: {
    side: 'right',          // 'left' | 'right'
    cardWidth: 0,           // px; 0 = fill the window (its width minus the side margins); height follows 16:9
    gap: 24,                // px between cards
    margin: 0,              // px from the window's side edge
    tiltDegrees: 0,         // rotateY; 0 = flat (Meld's Corner Pin does the tilt)
    perspective: 1400,      // px; smaller = stronger 3D
    style: 'loop',          // how the cards move: see STYLES above (default 'loop' since 0.3.5, his ask; was 'pingpong')
    cycleSeconds: 24,       // pingpong: one full up-and-down loop; 0 = no motion
    secondsPerGuest: 6,     // loop: time to move one card along; step/fade/deck/drum: time each guest stays
    slideSeconds: 0.8,      // step/fade/deck/drum: time to move on to the next guest
    direction: 'up',        // loop/step: 'up' | 'down'
    smartFit: true,         // every live guest fits in the window → no motion, centred; the style moves only when they don't
    cycleDistance: 0,       // px of travel; 0 = automatic
    cornerRadius: 18,
    shadow: false,          // a drop shadow under every card
    outline: false,         // a thin accent-coloured line round every card
    verticalMargin: -1,     // px above the first / below the last card; -1 = the same as margin
    cardPadding: 0,         // px of frame round the camera picture, inside the card
    frameColor: '#111111',  // the colour of that frame (and behind a loading picture)
    nameStrip: true,
    nameHeight: 0,          // px; 0 = automatic (8 % of the card width)
    namePadding: 14,        // px between the strip's edge and the name
    nameSize: 0,            // px font size; 0 = automatic (half the strip)
    nameAlign: 'left',      // 'left' | 'center' | 'right'
    accent: '#9b5cff',
    mirrorAll: false,       // the default for every source that has no "mirror" of its own
    hideTwitchName: false,  // hide the name Twitch draws inside the video (CamReel's own strip stays)
  },
  window: {
    width: 920,             // the STRIP: the column Meld captures (fixed: only Settings changes it)
    height: 1080,
    frameless: true,
    background: 'transparent', // 'transparent', or a solid colour for chroma key ('#00ff00')
    alwaysOnTop: false,
    keepVisible: false,     // always on top + every desktop, so Stage Manager does not park it
    lockSize: false,        // true = the strip cannot be resized by dragging its edges (only here)
    // x, y: where the strip was last placed (written by the app when you move it)
  },
  audio: { muted: false },
  render: undefined,        // "offscreen" | "webview"; undefined = the app's default
};

function merge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], v);
    else out[k] = v;
  }
  return out;
}

// A source may be an https/http/file URL or a local file path.
function toUrl(raw, baseDir) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('a source has no url');
  if (/^(https?|file):\/\//i.test(s)) return s;
  if (/^PASTE-/i.test(s)) throw new Error('config.json still has a placeholder: paste your Stream Together Browser Source URL in place of ' + s);
  const p = path.isAbsolute(s) ? s : path.resolve(baseDir, s.replace(/^~(?=\/)/, process.env.HOME || '~'));
  if (!fs.existsSync(p)) throw new Error('local file not found: ' + p);
  return pathToFileURL(p).href;
}

function load(file) {
  const baseDir = path.dirname(file);
  return normalize(readJson(file), baseDir);
}

function readJson(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  // Never echo the file's text: it holds the secret links. Only say where it broke.
  catch (e) { throw new Error('config.json is not valid JSON' + (/position \d+/.exec(e.message) ? ' (at ' + /position \d+/.exec(e.message)[0] + ')' : '')); }
  return raw;
}

function normalize(raw, baseDir) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config: expected an object');
  const cfg = merge(DEFAULTS, raw);
  if (!Array.isArray(cfg.sources)) throw new Error(`config: "sources" must be a list of 0 to ${MAX_SOURCES} guests`);
  if (cfg.sources.length > MAX_SOURCES) throw new Error(`config: at most ${MAX_SOURCES} sources (got ${cfg.sources.length})`);
  if (cfg.render !== undefined && !['offscreen', 'offscreen-bitmap', 'webview'].includes(cfg.render)) throw new Error('config: render must be "offscreen" or "webview"');
  if (typeof cfg.hideWhenDead !== 'boolean') throw new Error('config: hideWhenDead must be true or false');
  for (const k of ['deadAfterSeconds', 'showAfterSeconds']) {
    if (typeof cfg[k] !== 'number' || !(cfg[k] >= 0) || cfg[k] > 600) throw new Error(`config: ${k} must be a number of seconds`);
  }
  cfg.sources = cfg.sources.map((s, i) => {
    const o = typeof s === 'string' ? { url: s } : s;
    const out = { url: toUrl(o.url, baseDir || process.cwd()), name: String(o.name || `Guest ${i + 1}`).slice(0, 60), enabled: o.enabled !== false };
    // mirror: true / false = this source's own choice; absent = follow layout.mirrorAll
    if (o.mirror !== undefined && o.mirror !== null) {
      if (typeof o.mirror !== 'boolean') throw new Error(`config: sources[${i}].mirror must be true or false`);
      out.mirror = o.mirror;
    }
    return out;
  });
  const L = cfg.layout;
  const urls = cfg.sources.map((s) => s.url);
  if (new Set(urls).size !== urls.length) throw new Error('config: the same link is in the list twice');
  if (typeof L.mirrorAll !== 'boolean') throw new Error('config: layout.mirrorAll must be true or false');
  if (typeof L.hideTwitchName !== 'boolean') throw new Error('config: layout.hideTwitchName must be true or false');
  if (!STYLES.includes(L.style)) throw new Error(`config: layout.style must be one of ${STYLES.join(', ')}`);
  if (typeof L.smartFit !== 'boolean') throw new Error('config: layout.smartFit must be true or false');
  if (!['up', 'down'].includes(L.direction)) throw new Error('config: layout.direction must be "up" or "down"');
  if (typeof L.secondsPerGuest !== 'number' || !(L.secondsPerGuest >= 0.5) || L.secondsPerGuest > 600) throw new Error('config: layout.secondsPerGuest must be 0.5 to 600 seconds');
  if (typeof L.slideSeconds !== 'number' || !(L.slideSeconds >= 0.1) || L.slideSeconds > 10) throw new Error('config: layout.slideSeconds must be 0.1 to 10 seconds');
  if (!['left', 'right'].includes(L.side)) throw new Error('config: layout.side must be "left" or "right"');
  for (const k of ['cardWidth', 'gap', 'margin', 'tiltDegrees', 'perspective', 'cycleSeconds', 'cycleDistance', 'cornerRadius', 'verticalMargin', 'cardPadding', 'nameHeight', 'namePadding', 'nameSize']) {
    if (typeof L[k] !== 'number' || !isFinite(L[k])) throw new Error(`config: layout.${k} must be a number`);
  }
  for (const k of ['shadow', 'outline']) if (typeof L[k] !== 'boolean') throw new Error(`config: layout.${k} must be true or false`);
  if (L.cardWidth < 0) throw new Error('config: layout.cardWidth must be 0 (fill the window) or more');
  if (cardWidthOf(cfg) < 120) throw new Error('config: the cards would be narrower than 120 px (window width minus the side margins)');
  if (L.cardPadding < 0 || L.cardPadding * 2 > cardWidthOf(cfg) - 40) throw new Error('config: layout.cardPadding must be 0 or more and leave room for the picture');
  for (const k of ['nameHeight', 'namePadding', 'nameSize']) if (L[k] < 0 || L[k] > 400) throw new Error(`config: layout.${k} must be 0 to 400`);
  if (!['left', 'center', 'right'].includes(L.nameAlign)) throw new Error('config: layout.nameAlign must be "left", "center" or "right"');
  if (!/^#[0-9a-f]{6}$/i.test(String(L.frameColor))) throw new Error('config: layout.frameColor must be a colour like #111111');
  return cfg;
}

// config.json next to the app; STC_CONFIG overrides (used by the proof scripts).
function locate(appDir) {
  if (process.env.STC_CONFIG) return path.resolve(process.env.STC_CONFIG);
  return path.join(appDir, 'config.json');
}

// The card width in px: layout.cardWidth, or 0 = the window's width minus both side margins.
const cardWidthOf = (cfg) => (cfg.layout.cardWidth > 0 ? cfg.layout.cardWidth : cfg.window.width - 2 * cfg.layout.margin);

// 0.3.1 changed the default look (his friend's stream): transparent, a 920 px window, cards filling it
// edge to edge, no margin. A settings file from before (no lookVersion) moves to the new look ONLY
// where it still holds the OLD default: a value somebody chose stays. Shadow and outline are new
// switches, so they start off. Returns the keys it changed (for the log), or null when the file is already new.
const OLD_LOOK = [['window', 'width', 480, 920], ['layout', 'cardWidth', 420, 0], ['layout', 'margin', 30, 0], ['window', 'background', '#00ff00', 'transparent']];
function migrateLook(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw.lookVersion || 1) >= 2) return null; // nothing to do
  const changed = [];
  for (const [part, key, was, now] of OLD_LOOK) {
    const box = raw[part];
    if (!box || box[key] === undefined) continue;  // absent: the new default applies anyway
    if (String(box[key]).toLowerCase() === String(was)) { box[key] = now; changed.push(`${part}.${key}`); }
  }
  raw.lookVersion = 2;
  return changed;
}

// The rule, in one place: a source's own choice wins, else the global default.
const isMirrored = (source, layout) => (source.mirror ?? layout.mirrorAll) === true;

module.exports = { STYLES, cardWidthOf, migrateLook, readJson, isMirrored, load, normalize, locate, DEFAULTS, MAX_SOURCES };
