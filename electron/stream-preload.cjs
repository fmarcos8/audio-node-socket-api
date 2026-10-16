const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('streamWindow', {
  ready: id => ipcRenderer.send('stream:ready', id),
  signal: (id, payload) => ipcRenderer.send('stream:signal', id, payload),
  onSignal: handler => ipcRenderer.on('stream:signal', (_event, signal) => handler(signal))
});
