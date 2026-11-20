'use strict';
// CamReel updates itself (the Deskmate way: a small feed file next to the downloads on the
// site, the login built into the app at build time, a publish script the maintainer runs himself).
// electron-updater does the download and the install; this file decides WHEN, and never more.
//
// What must never happen:
//   U1 the app restarts BY ITSELF. The strip may be on a live stream. A downloaded update is
//      installed only when the user clicks "Restart to update", or the next time they quit.
//   U2 an update check in a build that has no feed (a dev run, a test, a build made without
//      the feed file): then the updater is simply off.
//   U3 the update login in a log line or in the Settings window.
//   U4 a failed check bothers anybody (a friend who is offline): it is logged, nothing is shown.
//   U5 a downgrade.
// The updater object is passed IN, so scripts/test-updater.js runs this file with a fake one.
const fs = require('fs');

const HOUR = 60 * 60 * 1000;

// the feed file is written into src/ by the build script and is never committed
function loadFeed(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!raw || typeof raw.url !== 'string' || !/^https:\/\/[^/]+\/.+/.test(raw.url)) return null; // https only
  const feed = { url: raw.url.replace(/\/+$/, '') + '/' };
  if (typeof raw.user === 'string' && typeof raw.pass === 'string' && raw.user && raw.pass) { feed.user = raw.user; feed.pass = raw.pass; }
  return feed;
}

function createUpdater({ autoUpdater, feed, packaged, currentVersion, log, onState, beforeInstall, firstCheckMs = 15000, everyMs = 6 * HOUR, setTimer = setTimeout, setEvery = setInterval }) {
  let st = { phase: 'off', current: currentVersion };
  // never let the login reach a log line, whatever text an error carries
  const secrets = feed ? [feed.pass, feed.user && feed.pass ? Buffer.from(`${feed.user}:${feed.pass}`).toString('base64') : null].filter(Boolean) : [];
  const clean = (x) => { let s = String(x instanceof Error ? x.message : x); for (const k of secrets) s = s.split(k).join('[REDACTED]'); return s; };
  const say = (m) => { try { log('update: ' + clean(m)); } catch {} };
  const set = (next) => { st = { ...next, current: currentVersion }; try { onState && onState(state()); } catch {} };
  const state = () => ({ ...st });

  function start() {
    if (!packaged) { say('off (not a packaged build)'); return false; }                      // U2
    if (!feed) { say('off (this build has no update feed)'); return false; }                  // U2
    if (!autoUpdater) { say('off (the updater is missing from this build)'); return false; }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;   // installed at the user's own next quit
    autoUpdater.allowDowngrade = false;        // U5
    autoUpdater.logger = null;                 // its own logger would print request details (U3)
    if (feed.user) autoUpdater.requestHeaders = { Authorization: 'Basic ' + Buffer.from(`${feed.user}:${feed.pass}`).toString('base64') };
    autoUpdater.setFeedURL({ provider: 'generic', url: feed.url });
    autoUpdater.on('checking-for-update', () => { if (st.phase !== 'ready') set({ phase: 'checking' }); });
    autoUpdater.on('update-not-available', () => { if (st.phase !== 'ready') set({ phase: 'idle' }); });
    autoUpdater.on('update-available', (i) => { say(`${i && i.version} is out, downloading`); if (st.phase !== 'ready') set({ phase: 'downloading', version: i && i.version, percent: 0 }); });
    autoUpdater.on('download-progress', (p) => { if (st.phase === 'downloading') set({ ...st, percent: Math.round((p && p.percent) || 0) }); });
    autoUpdater.on('update-downloaded', (i) => { say(`${i && i.version} is downloaded, waiting for the user`); set({ phase: 'ready', version: i && i.version }); }); // U1: nothing else happens here
    autoUpdater.on('error', (e) => { say('check failed: ' + clean(e)); if (st.phase !== 'ready') set({ phase: 'idle' }); });                                    // U4
    set({ phase: 'idle' });
    setTimer(check, firstCheckMs);
    setEvery(check, everyMs);
    say('on');
    return true;
  }

  function check() {
    if (st.phase === 'off' || st.phase === 'ready' || st.phase === 'downloading') return;
    try { Promise.resolve(autoUpdater.checkForUpdates()).catch((e) => say('check failed: ' + clean(e))); } catch (e) { say('check failed: ' + clean(e)); }
  }

  // ONLY from the user's click (Settings → "Restart to update")
  function install() {
    if (st.phase !== 'ready') return false;
    say(`installing ${st.version} (the user asked)`);
    try { beforeInstall && beforeInstall(); } catch {}
    autoUpdater.quitAndInstall(false, true); // then start CamReel again
    return true;
  }

  return { start, check, install, state };
}

module.exports = { loadFeed, createUpdater };
