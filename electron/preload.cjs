const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orbita', {
  canShareSystemAudio: process.platform === 'win32',
  host: () => ipcRenderer.invoke('server:host'),
  sources: () => ipcRenderer.invoke('capture:sources'),
  selectSource: id => ipcRenderer.invoke('capture:select', id),
  saveFile: (name, data) => ipcRenderer.invoke('file:save', name, data),
  openStream: id => ipcRenderer.invoke('stream:open', id),
  closeStream: id => ipcRenderer.send('stream:close', id),
  signalStream: (id, signal) => ipcRenderer.send('stream:signal', id, signal),
  onStreamReady: handler => ipcRenderer.on('stream:ready', (_event, id) => handler(id)),
  onStreamSignal: handler => ipcRenderer.on('stream:signal', (_event, id, signal) => handler(id, signal)),
  onStreamClosed: handler => ipcRenderer.on('stream:closed', (_event, id) => handler(id))
});
