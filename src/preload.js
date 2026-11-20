'use strict';
const electron = require('electron');
const { contextBridge, ipcRenderer } = electron;

// Offscreen guests: each frame arrives as a GPU texture and is drawn straight into the
// card's <canvas id="g-<id>"> (this preload world shares the page's DOM), then released.
const ctxs = new Map();
function ctxFor(id) {
  let c = ctxs.get(id);
  if (!c || !c.canvas.isConnected) {
    const canvas = document.getElementById('g-' + id);
    if (!canvas) return null;
    c = canvas.getContext('2d', { alpha: false, desynchronized: true });
    ctxs.set(id, c);
  }
  return c;
}
let framesDrawn = 0;
let textureReceiver = false;
try {
  if (electron.sharedTexture && electron.sharedTexture.setSharedTextureReceiver) {
    electron.sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, id) => {
      try {
        const ctx = ctxFor(id);
        if (ctx) {
          const vf = importedSharedTexture.getVideoFrame();
          try { ctx.drawImage(vf, 0, 0, ctx.canvas.width, ctx.canvas.height); framesDrawn++; } finally { vf.close(); }
        }
      } finally { importedSharedTexture.release(); }
    });
    textureReceiver = true;
  }
} catch (e) { textureReceiver = 'error: ' + e.message; }

// the CPU path (render "offscreen-bitmap"): BGRA bytes over IPC
ipcRenderer.on('stc:osr-bitmap', (_e, { id, width, height, data }) => {
  const ctx = ctxFor(id);
  if (!ctx) return;
  const px = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < px.length; i += 4) { const b = px[i]; px[i] = px[i + 2]; px[i + 2] = b; } // BGRA -> RGBA
  ctx.putImageData(new ImageData(px, width, height), 0, 0);
  framesDrawn++;
});

contextBridge.exposeInMainWorld('stc', {
  config: () => ipcRenderer.invoke('stc:config'),
  registerGuest: (id, name, webContentsId) => ipcRenderer.send('stc:register-guest', { id, name, webContentsId }),
  log: (msg) => ipcRenderer.send('stc:log', msg),
  sendStatus: (st) => ipcRenderer.send('stc:strip-status', st),
  guestCss: {
    insert: (wcId, css) => ipcRenderer.invoke('stc:guest-css-insert', { wcId, css }),
    remove: (wcId, key) => ipcRenderer.invoke('stc:guest-css-remove', { wcId, key }),
  },
  onConfig: (fn) => ipcRenderer.on('stc:config', (_e, cfg) => fn(cfg)),
  onConfigError: (fn) => ipcRenderer.on('stc:config-error', (_e, msg) => fn(msg)),
  onGuestLoad: (fn) => ipcRenderer.on('stc:guest-load', (_e, d) => fn(d)),
  onToggleDebug: (fn) => ipcRenderer.on('stc:toggle-debug', () => fn()),
  osr: {
    open: (o) => ipcRenderer.invoke('stc:osr-open', o),
    close: (id) => ipcRenderer.send('stc:osr-close', id),
    active: (id, active) => ipcRenderer.send('stc:osr-active', { id, active }),
    resize: (width, height) => ipcRenderer.send('stc:osr-resize', { width, height }),
    css: (id, name, css, want) => ipcRenderer.send('stc:osr-css', { id, name, css, want }),
    exec: (id, code) => ipcRenderer.invoke('stc:osr-exec', { id, code }),
    stats: async () => ({ main: await ipcRenderer.invoke('stc:osr-stats'), framesDrawn, textureReceiver }),
  },
});
