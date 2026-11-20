'use strict';
// A stand-in for a Twitch Stream Together guest page. It sends the SAME header Twitch
// sends (X-Frame-Options: SAMEORIGIN), so no other page can frame it, and it shows its
// picture through a REAL <video> element (a canvas stream), like a guest camera.
//
//   /guest?n=1&auth=fake      guest N: a live clock in a <video> (XFO on)
//   /widgets/guest-star/<channel>?slot=N&auth=fake   the same, at Twitch's path
//   /open?n=1                 the same page WITHOUT the header (positive control)
//   /novideo?n=1              a page that never has a video (like "Include my camera" off)
//   /canvasonly?n=1           the live picture drawn on a <canvas>, NO <video> (mirror fallback test)
//   /control?n=2&state=S      make guest 2: alive | stop (stream frozen) | remove (video
//                             element removed) | blank (page navigates to an empty page)
//   /states                   every guest's current state (JSON)
//   http://127.0.0.1:8766/control   a page on ANOTHER origin that frames /guest and /open
const http = require('http');

const GUEST_PORT = Number(process.env.STANDIN_PORT || 8777);
const CONTROL_PORT = GUEST_PORT + 1;
const COLORS = ['#ff5a5f', '#2ec4b6', '#ffbf00', '#5b8cff', '#c77dff', '#80ed99', '#ff8fab', '#f4a261'];
const states = {}; // n -> 'alive' | 'stop' | 'remove' | 'blank'
const stateOf = (n) => states[n] || 'alive';

function guestPage(n, canvasOnly = false) {
  const c = COLORS[(n - 1) % COLORS.length];
  return `<!doctype html><html><head><meta charset="utf-8"><title>stand-in guest ${n}</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}video,canvas.shown{width:100%;height:100%;display:block;object-fit:cover}
/* like Twitch's own name tag: HTML text OVER the video (mirroring the video must not flip it) */
/* the class Twitch's own name tag has on a real Stream Together page; a pure-blue pill so a test can see it */
.guest-star-browser-source-nameplate{position:absolute;left:4%;bottom:12%;width:36%;height:14%;background:#0000ff;color:#ffff00;font:bold 4vw/14vh sans-serif;text-align:center;z-index:2}
/* like Twitch's real page (2026-10-28): a hashed styled-component class sets display with !important */
.jRmGvW{display:flex !important;align-items:center;justify-content:center}</style></head>
<body><script>
// like Twitch: the name tag is rendered a moment AFTER the page loads, not in the first HTML
setTimeout(() => { const t = document.createElement('div'); t.className = 'guest-star-browser-source-nameplate jRmGvW'; t.textContent = 'GUEST ${n}'; document.body.prepend(t); }, 2500);
</script><script>
const CANVAS_ONLY = ${canvasOnly ? 'true' : 'false'};
const N = ${n};
window.__frames = 0;
// The picture is drawn on a canvas that is NOT in the page; only the <video> shows it.
const cv = document.createElement('canvas'); cv.width = 640; cv.height = 360;
const x = cv.getContext('2d');
const t0 = performance.now();
function draw(){
  window.__frames++;
  const w = cv.width, h = cv.height, s = (performance.now() - t0) / 1000;
  x.fillStyle = '#101018'; x.fillRect(0,0,w,h);
  x.fillStyle = '${c}'; x.globalAlpha = .35; x.fillRect(((s * 0.5) % 1) * w - w*0.1, 0, w*0.2, h); x.globalAlpha = 1;
  const r = h * 0.32, cx = w*0.25, cy = h*0.5;
  x.strokeStyle = '#fff'; x.lineWidth = 6; x.beginPath(); x.arc(cx,cy,r,0,7); x.stroke();
  x.strokeStyle = '${c}'; x.beginPath(); x.moveTo(cx,cy); x.lineTo(cx + r*0.9*Math.sin(s*2), cy - r*0.9*Math.cos(s*2)); x.stroke();
  x.fillStyle = '${c}'; x.font = 'bold 64px sans-serif'; x.fillText('GUEST ${n}', w*0.47, h*0.4);
  x.fillStyle = '#fff'; x.font = '36px monospace';
  x.fillText(new Date().toISOString().slice(11, 22), w*0.47, h*0.62);
  x.fillText('frame ' + window.__frames, w*0.47, h*0.8);
  // test markers: a pure RED block on the LEFT edge (mirror tests: it must move to the right),
  // and a colour band across the whole BOTTOM (fill test: the card's bottom rows are picture, not black)
  x.fillStyle = '#ff0000'; x.fillRect(0, h*0.35, w*0.07, h*0.3);
  x.fillStyle = '${c}'; x.fillRect(0, h*0.93, w, h*0.07);
}
// A timer, not requestAnimationFrame: a camera keeps producing frames whether or not
// the page is being painted, and so must the stand-in.
setInterval(draw, 1000 / 30); draw();
if (CANVAS_ONLY) { cv.className = 'shown'; document.body.append(cv); } // a page with NO <video>
let stream = null, video = null;
const AUDIO = new URLSearchParams(location.search).get('audio') === '1';
let ac = null;
function start(){
  stream = cv.captureStream(30);
  if (AUDIO) {
    // a guest that also SENDS SOUND (like a real camera + mic): a -60 dB tone, practically silent
    ac = ac || new AudioContext();
    const osc = ac.createOscillator(), gain = ac.createGain(), dest = ac.createMediaStreamDestination();
    gain.gain.value = 0.001; osc.frequency.value = 220; osc.connect(gain).connect(dest); osc.start();
    stream.addTrack(dest.stream.getAudioTracks()[0]);
  }
  video = document.createElement('video');
  video.muted = !AUDIO; video.autoplay = true; video.playsInline = true;
  video.srcObject = stream;
  document.body.append(video);
  video.play().catch(() => {});
}
if (!CANVAS_ONLY) start();
// Poll the control endpoint: this is how the proof makes the guest "leave".
setInterval(async () => {
  let s = 'alive';
  try { s = (await (await fetch('/state?n=' + N, { cache: 'no-store' })).text()).trim(); } catch {}
  if (s === 'stop' && stream && stream.getVideoTracks()[0].readyState === 'live') stream.getVideoTracks().forEach(t => t.stop());
  if (s === 'remove' && video) { video.remove(); video = null; stream.getVideoTracks().forEach(t => t.stop()); stream = null; }
  if (s === 'blank') location.href = '/blank?n=' + N;
  if (s === 'alive' && !CANVAS_ONLY && (!video || !stream || stream.getVideoTracks()[0].readyState !== 'live')) { if (video) video.remove(); start(); }
}, 300);
</script></body></html>`;
}

function blankPage(n) {
  // An empty page that goes back to the guest page once guest N is "alive" again.
  return `<!doctype html><html><head><meta charset="utf-8"><title>blank ${n}</title></head><body style="margin:0;background:#000"><script>
setInterval(async () => { try { if ((await (await fetch('/state?n=${n}', { cache: 'no-store' })).text()).trim() === 'alive') location.href = '/guest?n=${n}'; } catch {} }, 300);
</script></body></html>`;
}

const NOVIDEO = `<!doctype html><html><head><meta charset="utf-8"><title>no video</title></head>
<body style="margin:0;background:#26262c;color:#aaa;font:20px sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
this guest has no camera</body></html>`;

const html = (res, body, extra = {}) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(body); };
const XFO = { 'X-Frame-Options': 'SAMEORIGIN' };

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const n = Math.max(1, Math.min(99, Number(u.searchParams.get('n')) || 1));
  // Twitch's shape: /widgets/guest-star/<channel>?display=single&slot=N&auth=…  → guest N
  if (u.pathname.startsWith('/widgets/guest-star/')) return html(res, guestPage(Math.max(1, Math.min(99, Number(u.searchParams.get('slot')) || 1))), XFO);
  switch (u.pathname) {
    case '/guest': return html(res, guestPage(n), XFO);
    case '/open': return html(res, guestPage(n));
    case '/canvasonly': return html(res, guestPage(n, true), XFO);
    case '/novideo': return html(res, NOVIDEO, XFO);
    case '/blank': return html(res, blankPage(n), XFO);
    case '/state': res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end(stateOf(n));
    case '/control': {
      const s = u.searchParams.get('state');
      if (!['alive', 'stop', 'remove', 'blank'].includes(s)) { res.writeHead(400); return res.end('state must be alive|stop|remove|blank'); }
      states[n] = s; console.log(`guest ${n} -> ${s}`);
      res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(`guest ${n} ${s}`);
    }
    case '/states': res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(states));
  }
  res.writeHead(404); res.end('not found');
}).listen(GUEST_PORT, '127.0.0.1', () => console.log(`stand-in guest on http://127.0.0.1:${GUEST_PORT}/guest?n=1&auth=fake`));

http.createServer((req, res) => {
  html(res, `<!doctype html><html><head><meta charset="utf-8"><title>control</title>
<style>body{margin:0;background:#222;color:#eee;font:20px sans-serif;display:flex;gap:30px;padding:30px}
figure{margin:0}iframe{width:560px;height:315px;border:3px solid #888;background:#fff}</style></head><body>
<figure><figcaption>A: /guest (X-Frame-Options: SAMEORIGIN) in an iframe</figcaption>
<iframe src="http://127.0.0.1:${GUEST_PORT}/guest?n=1&auth=fake"></iframe></figure>
<figure><figcaption>control: /open (same page, no header) in an iframe</figcaption>
<iframe src="http://127.0.0.1:${GUEST_PORT}/open?n=2"></iframe></figure>
</body></html>`);
}).listen(CONTROL_PORT, '127.0.0.1', () => console.log(`control page (another origin) on http://127.0.0.1:${CONTROL_PORT}/control`));
