'use strict';
// Twitch Stream Together SEAT links, as PURE functions (no DOM): Settings (settings.js)
// and the node test (scripts/test-seats.js) run the same code.
//
// One person's Browser Source links all carry the same channel and the same key; only the
// seat changes (seen 2026-11-19 on a live session):
//   You       …/widgets/guest-star/<channel>?display=single&slot=0#auth=<key>
//   Guest 1   …/widgets/guest-star/<channel>?display=single&slot=1#auth=<key>
//   Group     …/widgets/guest-star/<channel>?display=group#auth=<key>
// So from ANY one of them the guest seats 1..5 can be made. Nothing here logs or returns
// the key on its own: a link goes in, links come out.
(function (root) {
  const GUEST_SEATS = 5; // Twitch: "up to 5 guests and the call host"

  // → { channel, slot (0 = You, 1..n = a guest, null = no seat), group, origin } or null
  function parse(url) {
    let u;
    try { u = new URL(String(url || '').trim()); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const m = /^\/widgets\/guest-star\/([^/]+)\/?$/i.exec(u.pathname);
    if (!m) return null;
    const hasKey = /(^|[#&])auth=[^&]+/.test(u.hash) || !!u.searchParams.get('auth');
    if (!hasKey) return null; // without the key the seats would all be Twitch's error page
    const raw = u.searchParams.get('slot');
    const slot = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
    let channel = m[1];
    try { channel = decodeURIComponent(m[1]); } catch {}
    return { channel, slot, group: u.searchParams.get('display') === 'group', origin: u.origin };
  }

  // the same link, pointed at seat n (the key stays where it was: #auth=… or &auth=…)
  function seatUrl(url, n) {
    if (!parse(url)) return null;
    const u = new URL(String(url).trim());
    u.searchParams.set('display', 'single');
    u.searchParams.set('slot', String(n));
    return u.toString();
  }

  // the guest seats 1..count of this link's owner that are NOT in the list yet
  function missingSeats(url, existingUrls, count = GUEST_SEATS) {
    const me = parse(url);
    if (!me) return [];
    const same = (p) => p && p.origin === me.origin && p.channel.toLowerCase() === me.channel.toLowerCase();
    const have = new Set((existingUrls || []).map(parse).filter(same).map((p) => p.slot));
    const out = [];
    for (let n = 1; n <= count; n++) if (!have.has(n)) out.push({ slot: n, url: seatUrl(url, n) });
    return out;
  }

  const api = { GUEST_SEATS, parse, seatUrl, missingSeats };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CamReelSeats = api;
})(typeof window !== 'undefined' ? window : globalThis);
