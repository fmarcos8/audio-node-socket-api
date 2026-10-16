const { createServer } = require('node:http');
const { randomBytes, createHash } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');
const { Server } = require('socket.io');

const CHANNELS = [
  { id: 'geral', name: 'geral' },
  { id: 'projetos', name: 'projetos' },
  { id: 'jogos', name: 'jogos' }
];
const VOICES = [
  { id: 'sala-geral', name: 'Sala geral' },
  { id: 'sala-2', name: 'Sala 2' }
];
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_AVATAR_SIZE = 512 * 1024;
function validAvatar(avatar) {
  if (typeof avatar !== 'string' || avatar.length > Math.ceil(MAX_AVATAR_SIZE * 4 / 3) + 64) return false;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(avatar);
  if (!match) return false;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_AVATAR_SIZE) return false;
  if (match[1] === 'png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (match[1] === 'jpeg') return bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

function createChatServer({ port = 3000, host = '0.0.0.0', password, dataDir = join(process.cwd(), 'data'), iceServers = [{ urls: 'stun:stun.l.google.com:19302' }] } = {}) {
  if (!password || password.length < 8) throw new Error('Defina um código de acesso de pelo menos 8 caracteres.');
  mkdirSync(dataDir, { recursive: true });
  const uploadsDir = join(dataDir, 'attachments');
  mkdirSync(uploadsDir, { recursive: true });
  const file = join(dataDir, 'messages.json');
  const profilesFile = join(dataDir, 'profiles.json');
  let profiles = {};
  try {
    const saved = JSON.parse(readFileSync(profilesFile, 'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) profiles = saved;
  }
  catch (error) { if (error.code !== 'ENOENT') console.warn('Perfis inválidos:', error.message); }
  let messages = Object.fromEntries(CHANNELS.map(({ id }) => [id, []]));
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    for (const { id } of CHANNELS) if (Array.isArray(saved[id])) messages[id] = saved[id].slice(-200);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Histórico inválido; iniciando histórico vazio:', error.message);
  }
  const httpServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Órbita online');
  });
  const io = new Server(httpServer, { maxHttpBufferSize: MAX_FILE_SIZE + 1024 * 1024, cors: { origin: '*' } });
  const users = new Map();
  const persist = () => {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(messages));
    renameSync(temp, file);
  };
  const persistProfiles = () => {
    const temp = `${profilesFile}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(profiles));
    renameSync(temp, profilesFile);
  };
  const avatarFor = key => typeof profiles[key]?.avatar === 'string' ? profiles[key].avatar : null;
  const profileIdFor = key => key ? createHash('sha256').update(`profile:${key}`).digest('hex') : null;
  const publicMessage = (message, socket, includeAvatar = true) => {
    const { ownerKey, ...visible } = message;
    return { ...visible, profileId: profileIdFor(ownerKey), ...(includeAvatar ? { avatar: avatarFor(ownerKey) } : {}), mine: !!ownerKey && ownerKey === socket?.data.ownerKey };
  };
  const findMessage = (channel, id) =>
    Object.hasOwn(messages, channel) ? messages[channel].find(message => message.id === id) : null;
  const removeAttachment = message => {
    if (!message?.attachment?.id || !/^[a-f0-9]{32}$/.test(message.attachment.id)) return;
    try { unlinkSync(join(uploadsDir, message.attachment.id)); }
    catch (error) { if (error.code !== 'ENOENT') console.error('Falha ao remover anexo:', error); }
  };
  const members = room => [...users.entries()].filter(([, user]) => user.voice === room)
    .map(([id, user]) => ({ id, name: user.name, profileId: profileIdFor(user.ownerKey), avatar: avatarFor(user.ownerKey), sharing: user.sharing, muted: user.muted }));
  const roster = () => Object.fromEntries(VOICES.map(({ id }) => [id, members(id)]));
  const leaveVoice = socket => {
    const user = users.get(socket.id);
    if (!user?.voice) return;
    const room = user.voice;
    socket.leave(`voice:${room}`);
    user.voice = null;
    user.sharing = false;
    io.to(`voice:${room}`).emit('voice:peer-left', { id: socket.id });
    io.emit('voice:roster', roster());
  };

  io.use((socket, next) => {
    const { name, code, identity } = socket.handshake.auth || {};
    if (code !== password) return next(new Error('Código de acesso inválido.'));
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 32)
      return next(new Error('Use um nome de 1 a 32 caracteres.'));
    socket.data.name = name.trim();
    const credential = typeof identity === 'string' && /^[a-f0-9]{64}$/.test(identity)
      ? identity : randomBytes(32).toString('hex');
    socket.data.ownerKey = createHash('sha256').update(credential).digest('hex');
    next();
  });

  io.on('connection', socket => {
    console.info(`[${new Date().toISOString()}] ${socket.data.name} conectado (${socket.id})`);
    users.set(socket.id, { name: socket.data.name, ownerKey: socket.data.ownerKey, voice: null, sharing: false, muted: false, lastMessage: 0 });
    const visible = Object.fromEntries(CHANNELS.map(({ id }) =>
      [id, messages[id].map(message => publicMessage(message, socket, false))]));
    const avatars = {};
    for (const items of Object.values(messages)) for (const message of items) {
      if (message.ownerKey) avatars[profileIdFor(message.ownerKey)] = avatarFor(message.ownerKey);
    }
    socket.emit('init', { id: socket.id, channels: CHANNELS, voices: VOICES, messages: visible, avatars, roster: roster(), iceServers, avatar: avatarFor(socket.data.ownerKey) });
    io.emit('presence', users.size);

    socket.on('profile:update', (payload, ack) => {
      const done = typeof ack === 'function' ? ack : () => {};
      const avatar = payload?.avatar;
      if (avatar !== null && !validAvatar(avatar))
        return done({ ok: false, error: 'Foto inválida ou maior que 512 KB.' });
      const key = socket.data.ownerKey;
      const previous = profiles[key];
      if (avatar === null) delete profiles[key];
      else profiles[key] = { avatar };
      try { persistProfiles(); }
      catch (error) {
        console.error('Falha ao salvar foto:', error);
        if (previous) profiles[key] = previous; else delete profiles[key];
        return done({ ok: false, error: 'Não foi possível salvar a foto.' });
      }
      io.emit('profile:updated', { id: socket.id, profileId: profileIdFor(key), avatar });
      io.emit('voice:roster', roster());
      done({ ok: true });
    });

    socket.on('message:send', (payload, ack) => {
      const done = typeof ack === 'function' ? ack : () => {};
      const user = users.get(socket.id);
      const channel = payload?.channel;
      const content = typeof payload?.content === 'string' ? payload.content.trim() : '';
      const upload = payload?.attachment;
      if (!Object.hasOwn(messages, channel) || (!content && !upload) || content.length > 2000)
        return done({ ok: false, error: 'Mensagem inválida.' });
      if (upload && (!Buffer.isBuffer(upload.data) || upload.data.length < 1 || upload.data.length > MAX_FILE_SIZE ||
        typeof upload.name !== 'string' || !upload.name.trim() || typeof upload.mime !== 'string'))
        return done({ ok: false, error: 'Arquivo inválido ou maior que 100 MB.' });
      if (Date.now() - user.lastMessage < 400) return done({ ok: false, error: 'Espere um instante antes de enviar outra mensagem.' });
      user.lastMessage = Date.now();
      const message = { id: randomBytes(12).toString('hex'), channel, author: user.name, content, at: Date.now(), ownerKey: socket.data.ownerKey };
      if (upload) {
        const id = randomBytes(16).toString('hex');
        message.attachment = {
          id, name: upload.name.replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 120),
          size: upload.data.length, mime: upload.mime.slice(0, 100)
        };
        try { writeFileSync(join(uploadsDir, id), upload.data, { flag: 'wx' }); }
        catch (error) { console.error('Falha ao salvar anexo:', error); return done({ ok: false, error: 'Não foi possível salvar o arquivo.' }); }
      }
      messages[channel].push(message);
      const trimmed = messages[channel].slice(0, -200);
      messages[channel] = messages[channel].slice(-200);
      try { persist(); }
      catch (error) {
        console.error('Falha ao salvar mensagem:', error);
        messages[channel] = [...trimmed, ...messages[channel]].filter(item => item !== message);
        removeAttachment(message);
        return done({ ok: false, error: 'Não foi possível salvar a mensagem.' });
      }
      for (const old of trimmed) removeAttachment(old);
      socket.emit('message:new', publicMessage(message, socket));
      socket.broadcast.emit('message:new', publicMessage(message, null));
      done({ ok: true });
    });

    socket.on('message:edit', (payload, ack) => {
      const done = typeof ack === 'function' ? ack : () => {};
      const message = findMessage(payload?.channel, payload?.id);
      const content = typeof payload?.content === 'string' ? payload.content.trim() : '';
      if (!message || !message.ownerKey || message.ownerKey !== socket.data.ownerKey)
        return done({ ok: false, error: 'Você não pode editar esta mensagem.' });
      if (!content || content.length > 2000) return done({ ok: false, error: 'Escreva uma mensagem de até 2000 caracteres.' });
      const previous = { content: message.content, editedAt: message.editedAt };
      message.content = content;
      message.editedAt = Date.now();
      try { persist(); }
      catch (error) { Object.assign(message, previous); return done({ ok: false, error: 'Não foi possível salvar a edição.' }); }
      io.emit('message:updated', { channel: message.channel, id: message.id, content, editedAt: message.editedAt });
      done({ ok: true });
    });

    socket.on('message:delete', (payload, ack) => {
      const done = typeof ack === 'function' ? ack : () => {};
      const message = findMessage(payload?.channel, payload?.id);
      if (!message || !message.ownerKey || message.ownerKey !== socket.data.ownerKey)
        return done({ ok: false, error: 'Você não pode excluir esta mensagem.' });
      const items = messages[message.channel];
      const index = items.indexOf(message);
      items.splice(index, 1);
      try { persist(); }
      catch (error) { items.splice(index, 0, message); return done({ ok: false, error: 'Não foi possível excluir a mensagem.' }); }
      removeAttachment(message);
      io.emit('message:deleted', { channel: message.channel, id: message.id });
      done({ ok: true });
    });

    socket.on('file:download', (payload, ack) => {
      const done = typeof ack === 'function' ? ack : () => {};
      const message = findMessage(payload?.channel, payload?.messageId);
      if (!message?.attachment || message.attachment.id !== payload?.attachmentId)
        return done({ ok: false, error: 'Arquivo não encontrado.' });
      try { done({ ok: true, data: readFileSync(join(uploadsDir, message.attachment.id)) }); }
      catch { done({ ok: false, error: 'Arquivo indisponível.' }); }
    });

    socket.on('voice:join', (room, ack) => {
      const done = typeof ack === 'function' ? ack : () => {};
      if (!VOICES.some(voice => voice.id === room)) return done({ ok: false, error: 'Sala inválida.' });
      if (users.get(socket.id)?.voice === room)
        return done({ ok: true, peers: members(room).filter(member => member.id !== socket.id) });
      leaveVoice(socket);
      const peers = members(room);
      users.get(socket.id).voice = room;
      socket.join(`voice:${room}`);
      done({ ok: true, peers });
      socket.to(`voice:${room}`).emit('voice:peer-joined', { id: socket.id, name: socket.data.name });
      io.emit('voice:roster', roster());
    });
    socket.on('voice:leave', () => leaveVoice(socket));
    socket.on('voice:state', state => {
      const user = users.get(socket.id);
      if (!user?.voice) return;
      if (typeof state?.sharing === 'boolean') user.sharing = state.sharing;
      if (typeof state?.muted === 'boolean') user.muted = state.muted;
      io.emit('voice:roster', roster());
    });
    socket.on('voice:speaking', speaking => {
      const user = users.get(socket.id);
      if (!user?.voice || typeof speaking !== 'boolean') return;
      socket.to(`voice:${user.voice}`).emit('voice:speaking', { id: socket.id, speaking: speaking && !user.muted });
    });
    socket.on('rtc:signal', ({ to, description, candidate } = {}) => {
      const sender = users.get(socket.id);
      const receiver = users.get(to);
      if (!sender?.voice || sender.voice !== receiver?.voice) return;
      if (description && !['offer', 'answer'].includes(description.type)) return;
      if (!description && !candidate) return;
      io.to(to).emit('rtc:signal', { from: socket.id, description, candidate });
    });
    socket.on('disconnect', reason => {
      console.info(`[${new Date().toISOString()}] ${socket.data.name} desconectado (${socket.id}): ${reason}`);
      leaveVoice(socket);
      users.delete(socket.id);
      io.emit('presence', users.size);
    });
  });

  return {
    listen: () => new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => { httpServer.off('error', reject); resolve(httpServer.address()); });
    }),
    close: () => new Promise(resolve => io.close(resolve)),
    io
  };
}

if (require.main === module) {
  const server = createChatServer({
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || '0.0.0.0',
    password: process.env.ORBITA_CODE,
    dataDir: process.env.DATA_DIR || join(process.cwd(), 'data'),
    iceServers: process.env.ICE_SERVERS ? JSON.parse(process.env.ICE_SERVERS) : undefined
  });
  server.listen().then(address => console.log(`Órbita online na porta ${address.port}`)).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { createChatServer };
