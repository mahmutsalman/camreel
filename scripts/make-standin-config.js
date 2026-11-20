'use strict';
// node scripts/make-standin-config.js <N> <out.json> [cardWidth] [cycleSeconds]
const fs = require('fs');
const [n, out, w, cyc] = process.argv.slice(2);
const sources = Array.from({ length: Number(n) }, (_, i) => ({ url: `http://127.0.0.1:8777/guest?n=${i + 1}&auth=FAKE-TOKEN-${i + 1}`, name: `G${i + 1}` }));
fs.writeFileSync(out, JSON.stringify({ sources, layout: { cardWidth: Number(w || 420), cycleSeconds: Number(cyc ?? 24), tiltDegrees: Number(process.env.TILT ?? 18), margin: Number(process.env.MARGIN ?? 60) }, window: { width: Number(process.env.WIN_W || 1920), height: 1080, background: '#00ff00' } }, null, 2));
