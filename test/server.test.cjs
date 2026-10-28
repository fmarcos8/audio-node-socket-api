const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { io } = require('socket.io-client');
const { createChatServer } = require('../server/index.cjs');

function once(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${event}`)), 2500);
    socket.once(event, (...args) => { clearTimeout(timer); resolve(args[0]); });
  });
}
function ack(socket, event, payload) {
  return new Promise(resolve => socket.emit(event, payload, resolve));
}
function client(url, name, code, identity) {
  return io(url, { auth: { name, code, identity }, reconnection: false, transports: ['websocket'] });
}

test('autenticação, chat, salas, sinalização e persistência', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'orbita-test-'));
  const server = createChatServer({ port: 0, host: '127.0.0.1', password: 'codigo-seguro', dataDir });
  const sockets = [];
  try {
    const address = await server.listen();
    const url = `http://127.0.0.1:${address.port}`;
    const denied = client(url, 'Intruso', 'errado'); sockets.push(denied);
    assert.match((await once(denied, 'connect_error')).message, /inválido/);
    const identity = 'a'.repeat(64);
    const ana = client(url, 'Ana', 'codigo-seguro', identity); sockets.push(ana);
    const anaInit = await once(ana, 'init');
    assert.equal(anaInit.channels.length, 3);
    const bia = client(url, 'Bia', 'codigo-seguro'); sockets.push(bia);
    await once(bia, 'init');

    const msgPromise = once(bia, 'message:new');
    assert.deepEqual(await ack(ana, 'message:send', { channel: 'geral', content: 'Olá!' }), { ok: true });
    const first = await msgPromise;
    assert.equal(first.content, 'Olá!');
    assert.equal(first.mine, false);
    assert.equal(first.ownerKey, undefined);
    const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlMYxYAAAAASUVORK5CYII=';
    assert.equal((await ack(ana, 'profile:update', { avatar: 'data:image/svg+xml;base64,PHN2Zz4=' })).ok, false);
    const photoEvent = once(bia, 'profile:updated');
    assert.equal((await ack(ana, 'profile:update', { avatar: photo })).ok, true);
    assert.deepEqual((await photoEvent).avatar, photo);
    assert.equal((await ack(bia, 'profile:update', { avatar: null })).ok, true);
    assert.equal((await ack(bia, 'message:edit', { channel: 'geral', id: first.id, content: 'Falso' })).ok, false);
    const updatePromise = once(bia, 'message:updated');
    assert.equal((await ack(ana, 'message:edit', { channel: 'geral', id: first.id, content: 'Olá, editada!' })).ok, true);
    assert.equal((await updatePromise).content, 'Olá, editada!');
    assert.equal((await ack(ana, 'message:send', { channel: 'inexistente', content: 'x' })).ok, false);
    assert.equal((await ack(ana, 'message:send', { channel: 'geral', content: 'x'.repeat(2001) })).ok, false);
    await new Promise(resolve => setTimeout(resolve, 420));
    const fileArrived = once(bia, 'message:new');
    assert.equal((await ack(ana, 'message:send', { channel: 'geral', content: '', attachment: {
      name: '../notas.txt', mime: 'text/plain', data: Buffer.from('Conteúdo de teste')
    } })).ok, true);
    const fileMessage = await fileArrived;
    assert.equal(fileMessage.attachment.name, '.._notas.txt');
    const downloaded = await ack(bia, 'file:download', {
      channel: 'geral', messageId: fileMessage.id, attachmentId: fileMessage.attachment.id
    });
    assert.equal(downloaded.data.toString(), 'Conteúdo de teste');
    assert.equal((await ack(bia, 'message:delete', { channel: 'geral', id: fileMessage.id })).ok, false);
    const deleted = once(bia, 'message:deleted');
    assert.equal((await ack(ana, 'message:delete', { channel: 'geral', id: fileMessage.id })).ok, true);
    assert.equal((await deleted).id, fileMessage.id);
    assert.equal((await ack(bia, 'file:download', {
      channel: 'geral', messageId: fileMessage.id, attachmentId: fileMessage.attachment.id
    })).ok, false);

    await new Promise(resolve => setTimeout(resolve, 420));
    const largerFileArrived = once(bia, 'message:new');
    assert.equal((await ack(ana, 'message:send', { channel: 'geral', content: '', attachment: {
      name: '9-mb.bin', mime: 'application/octet-stream', data: Buffer.alloc(9 * 1024 * 1024)
    } })).ok, true);
    const largerFile = await largerFileArrived;
    assert.equal(largerFile.attachment.size, 9 * 1024 * 1024);
    assert.equal((await ack(bia, 'file:download', {
      channel: 'geral', messageId: largerFile.id, attachmentId: largerFile.attachment.id
    })).data.length, 9 * 1024 * 1024);
    assert.equal((await ack(ana, 'message:delete', { channel: 'geral', id: largerFile.id })).ok, true);

    assert.equal((await ack(ana, 'voice:join', 'sala-geral')).ok, true);
    assert.equal((await ack(bia, 'voice:join', 'sala-2')).peers.length, 0);
    let leaked = false;
    bia.once('rtc:signal', () => { leaked = true; });
    ana.emit('rtc:signal', { to: bia.id, candidate: { candidate: 'teste' } });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(leaked, false);
    const joined = once(ana, 'voice:peer-joined');
    assert.equal((await ack(bia, 'voice:join', 'sala-geral')).peers.length, 1);
    assert.equal((await joined).id, bia.id);
    let repeatedEvents = 0;
    bia.on('voice:peer-left', () => { repeatedEvents++; });
    bia.on('voice:peer-joined', () => { repeatedEvents++; });
    assert.equal((await ack(ana, 'voice:join', 'sala-geral')).peers[0].id, bia.id);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(repeatedEvents, 0);
    assert.equal(typeof anaInit.roster['sala-geral'], 'object');
    const speaking = once(ana, 'voice:speaking');
    bia.emit('voice:speaking', true);
    assert.deepEqual(await speaking, { id: bia.id, speaking: true });
    const signal = once(bia, 'rtc:signal');
    ana.emit('rtc:signal', { to: bia.id, candidate: { candidate: 'teste' } });
    assert.equal((await signal).from, ana.id);
    let rosterUpdate = once(bia, 'voice:roster');
    ana.emit('voice:state', { cameraStreamId: 'camera-stream-1' });
    assert.equal((await rosterUpdate)['sala-geral'].find(member => member.id === ana.id).cameraStreamId, 'camera-stream-1');
    rosterUpdate = once(bia, 'voice:roster');
    ana.emit('voice:state', { cameraStreamId: null });
    assert.equal((await rosterUpdate)['sala-geral'].find(member => member.id === ana.id).cameraStreamId, null);
    ana.emit('voice:leave');
    assert.equal((await once(bia, 'voice:peer-left')).id, ana.id);

    for (const socket of sockets) socket.disconnect();
    await server.close();
    const again = createChatServer({ port: 0, host: '127.0.0.1', password: 'codigo-seguro', dataDir });
    try {
      const next = await again.listen();
      const persisted = client(`http://127.0.0.1:${next.port}`, 'Ana', 'codigo-seguro', identity);
      sockets.push(persisted);
      const init = await once(persisted, 'init');
      assert.equal(init.messages.geral[0].content, 'Olá, editada!');
      assert.equal(init.messages.geral[0].mine, true);
      assert.equal(init.avatar, photo);
      assert.equal(init.messages.geral[0].avatar, undefined);
      assert.equal(init.avatars[init.messages.geral[0].profileId], photo);
      assert.equal(init.messages.geral[0].ownerKey, undefined);
    } finally { await again.close(); }
  } finally {
    for (const socket of sockets) socket.disconnect();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('histórico anterior continua visível, sem conceder edição por nome', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'orbita-legacy-'));
  writeFileSync(join(dataDir, 'messages.json'), JSON.stringify({ geral: [{
    id: 'antiga', channel: 'geral', author: 'Ana', authorId: 'conexao-antiga', content: 'Mensagem antiga', at: Date.now()
  }] }));
  const server = createChatServer({ port: 0, host: '127.0.0.1', password: 'codigo-seguro', dataDir });
  let socket;
  try {
    const address = await server.listen();
    socket = client(`http://127.0.0.1:${address.port}`, 'Ana', 'codigo-seguro', 'a'.repeat(64));
    const data = await once(socket, 'init');
    assert.equal(data.messages.geral[0].content, 'Mensagem antiga');
    assert.equal(data.messages.geral[0].mine, false);
    assert.equal((await ack(socket, 'message:edit', { channel: 'geral', id: 'antiga', content: 'Alterada' })).ok, false);
  } finally { socket?.disconnect(); await server.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
