'use strict';
// Test-only pixel checks on a captured strip image (BGRA bitmap from capturePage), per card:
//   redLeft / redRight : share of pure-red pixels in the left / right quarter of the picture
//                        (the stand-in draws a red block on its LEFT edge: mirrored = right)
//   bottomFill         : share of NON-black pixels in the picture's bottom 6 rows (a guest page
//                        that does not fill its card leaves black there)
//   stripHash          : md5 of the name strip's pixels (must not change when mirroring)
const crypto = require('crypto');

function analyze(img, snapshot) {
  const { width: W, height: H } = img.getSize();
  const bmp = img.toBitmap();
  const px = (x, y) => { const i = (y * W + x) * 4; return [bmp[i + 2], bmp[i + 1], bmp[i]]; }; // r g b
  const out = {};
  for (const c of snapshot.cards) {
    if (c.mode !== 'shown') continue;
    const p = c.pad || 0; // the card's frame round the picture
    const x0 = Math.max(0, c.rect.x + p + 4), x1 = Math.min(W, c.rect.x + c.rect.w - p - 4);
    const y0 = Math.max(0, c.rect.y + p + 4), y1 = Math.min(H, c.rect.y + p + c.cardH - 2);
    if (x1 - x0 < 20 || y1 - y0 < 20) { out[c.name] = { offscreen: true }; continue; }
    const qw = Math.floor((x1 - x0) / 4);
    const red = (xa, xb) => {
      let n = 0, t = 0;
      for (let y = y0; y < y1; y += 2) for (let x = xa; x < xb; x += 2) { const [r, g, b] = px(x, y); t++; if (r > 200 && g < 60 && b < 60) n++; }
      return t ? n / t : 0;
    };
    let lit = 0, all = 0;
    for (let y = y1 - 6; y < y1; y++) for (let x = x0; x < x1; x++) { const [r, g, b] = px(x, y); all++; if (r + g + b > 120) lit++; }
    const sy0 = Math.min(H, c.rect.y + p + c.cardH + 2), sy1 = Math.min(H, c.rect.y + p + c.cardH + c.strip - 2);
    const h = crypto.createHash('md5');
    for (let y = sy0; y < sy1; y++) h.update(bmp.subarray((y * W + x0) * 4, (y * W + x1) * 4));
    // the stand-in's HTML text tag (left 4-40 %, 74-88 % down the picture): inside it only
    const pw = c.rect.w - 2 * p, ph = c.cardH;
    const lx0 = c.rect.x + p + Math.round(pw * 0.06), lx1 = c.rect.x + p + Math.round(pw * 0.38);
    const ly0 = c.rect.y + p + Math.round(ph * 0.76), ly1 = c.rect.y + p + Math.round(ph * 0.86);
    const lh = crypto.createHash('md5');
    let blue = 0, tot = 0;
    for (let y = ly0; y < ly1 && y < H; y++) {
      lh.update(bmp.subarray((y * W + lx0) * 4, (y * W + lx1) * 4));
      for (let x = lx0; x < lx1; x += 2) { const [r, g, b] = px(x, y); tot++; if (b > 200 && r < 90 && g < 110) blue++; } // raw bitmap colours differ from the PNG export: pure blue reads ~(0,57,254)
    }
    const tagSample = px(Math.round((lx0 + lx1) / 2), Math.round((ly0 + ly1) / 2));
    out[c.name] = { tagSample, labelHash: lh.digest('hex'), tagShare: +(tot ? blue / tot : 0).toFixed(3), mirrorMode: c.mirrorMode, redLeft: +red(x0, x0 + qw).toFixed(3), redRight: +red(x1 - qw, x1).toFixed(3), bottomFill: +(all ? lit / all : 0).toFixed(3),
      stripHash: sy1 > sy0 ? h.digest('hex') : null, mirrored: c.mirrored, rect: c.rect };
  }
  return out;
}

module.exports = { analyze };
