const { app, BrowserWindow, ipcMain, desktopCapturer, session, dialog } = require('electron');
const { join, basename } = require('node:path');
const { writeFile } = require('node:fs/promises');
const { networkInterfaces } = require('node:os');
const { randomBytes } = require('node:crypto');
const { createChatServer } = require('../server/index.cjs');

let window;
let localServer;
let localAddress;
const selectedSources = new Map();
const appPage = join(__dirname, '../renderer/index.html');
const popouts = new Map();

function lanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

async function createWindow() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((contents, permission, callback) => {
    callback(contents === window?.webContents && ['media', 'display-capture'].includes(permission));
  });
  ses.setPermissionCheckHandler((contents, permission) =>
    contents === window?.webContents && ['media', 'display-capture'].includes(permission));
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (request.frame !== window?.webContents?.mainFrame) return callback(null);
      const sourceId = selectedSources.get(window.webContents.id);
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = sources.find(item => item.id === sourceId);
      callback(source ? {
        video: source,
        ...(request.audioRequested && process.platform === 'win32' ? { audio: 'loopback' } : {})
      } : null);
    } catch { callback(null); }
  });

  window = new BrowserWindow({
    width: 1280, height: 820, minWidth: 850, minHeight: 580,
    title: 'Órbita', backgroundColor: '#101117',
    icon: join(__dirname, '../assets/orbita-icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true
    }
  });
  window.setMenuBarVisibility(false);
  window.on('closed', () => { for (const popup of popouts.values()) popup.close(); popouts.clear(); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  await window.loadFile(appPage);
}

app.whenReady().then(() => {
  ipcMain.handle('stream:open', async (event, id) => {
    if (event.sender !== window?.webContents || typeof id !== 'string' || !/^(self|[\w-]{1,64})$/.test(id)) return false;
    const existing = popouts.get(id);
    if (existing && !existing.isDestroyed()) { existing.focus(); existing.maximize(); return true; }
    const popup = new BrowserWindow({
      width: 1100, height: 720, minWidth: 480, minHeight: 320,
      title: 'Tela compartilhada · Órbita', backgroundColor: '#101117',
      icon: join(__dirname, '../assets/orbita-icon.png'),
      webPreferences: { preload: join(__dirname, 'stream-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true }
    });
    popouts.set(id, popup);
    popup.setMenuBarVisibility(false);
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    popup.webContents.on('will-navigate', e => e.preventDefault());
    popup.on('closed', () => { if (popouts.get(id) === popup) popouts.delete(id); if (!window?.isDestroyed()) window.webContents.send('stream:closed', id); });
    await popup.loadFile(join(__dirname, '../renderer/stream.html'), { query: { id } });
    popup.maximize();
    return true;
  });
  ipcMain.on('stream:ready', (event, id) => {
    if (popouts.get(id)?.webContents === event.sender && !window?.isDestroyed()) window.webContents.send('stream:ready', id);
  });
  ipcMain.on('stream:signal', (event, id, signal) => {
    const popup = popouts.get(id);
    if (!popup || popup.isDestroyed() || !signal || typeof signal !== 'object') return;
    if (event.sender === window?.webContents) popup.webContents.send('stream:signal', signal);
    else if (event.sender === popup.webContents && !window?.isDestroyed()) window.webContents.send('stream:signal', id, signal);
  });
  ipcMain.on('stream:close', (event, id) => {
    const popup = popouts.get(id);
    if (event.sender === window?.webContents && popup && !popup.isDestroyed()) popup.close();
  });
  ipcMain.handle('server:host', async () => {
    if (localAddress) return localAddress;
    const code = randomBytes(12).toString('base64url');
    const server = createChatServer({ port: 0, password: code, dataDir: join(app.getPath('userData'), 'host-data') });
    const address = await server.listen();
    localServer = server;
    localAddress = { url: `http://127.0.0.1:${address.port}`, invite: `http://${lanAddress()}:${address.port}`, code };
    return localAddress;
  });
  ipcMain.handle('capture:sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 300, height: 180 } });
    return sources.map(source => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() }));
  });
  ipcMain.handle('capture:select', (event, id) => {
    if (typeof id !== 'string' || !/^(screen|window):/.test(id)) return false;
    selectedSources.set(window.webContents.id, id);
    return true;
  });
  ipcMain.handle('file:save', async (event, name, data) => {
    if (event.sender !== window?.webContents) throw new Error('Janela inválida.');
    if (typeof name !== 'string' || !data || !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer))
      throw new Error('Arquivo inválido.');
    const bytes = Buffer.from(data);
    if (bytes.length < 1 || bytes.length > 100 * 1024 * 1024) throw new Error('Arquivo maior que 100 MB.');
    const safeName = basename(name.replace(/[\\/]/g, '_')).slice(0, 120);
    const result = await dialog.showSaveDialog(window, { defaultPath: safeName });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, bytes);
    return true;
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { localServer?.close().catch(console.error); });
