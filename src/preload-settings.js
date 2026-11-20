'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('camreel', {
  config: () => ipcRenderer.invoke('stc:config'),
  save: (cfg) => ipcRenderer.invoke('stc:save', cfg),
  copy: (text) => ipcRenderer.invoke('stc:copy', text),
  status: () => ipcRenderer.invoke('stc:status'),
  onConfig: (fn) => ipcRenderer.on('stc:config', (_e, cfg) => fn(cfg)),
  onConfigError: (fn) => ipcRenderer.on('stc:config-error', (_e, msg) => fn(msg)),
  onStatus: (fn) => ipcRenderer.on('stc:status', (_e, st) => fn(st)),
  stripState: () => ipcRenderer.invoke('stc:strip-state'),
  restoreStrip: () => ipcRenderer.invoke('stc:strip-restore'),
  onStripState: (fn) => ipcRenderer.on('stc:strip-state', (_e, st) => fn(st)),
  updateState: () => ipcRenderer.invoke('stc:update-state'),
  installUpdate: () => ipcRenderer.invoke('stc:update-install'),
  onUpdateState: (fn) => ipcRenderer.on('stc:update-state', (_e, st) => fn(st)),
});
