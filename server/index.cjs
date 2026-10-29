const { createServer } = require('node:http');
const { randomBytes, createHash } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, statSync } = require('node:fs');
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
const MAX_AVATAR_PIXELS = 1024;
function imageDimensions(bytes, format) {
  if (format === 'png') {
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (format === 'webp') {
    if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      if (bytes[20] & 2) return null; // animated WebP
      return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    }
    if (kind === 'VP8 ' && bytes.length >= 30 && bytes.toString('hex', 23, 26) === '9d012a') return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) return [1 + (((bytes[22] & 0x3f) << 8) | bytes[21]), 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | (bytes[22] >> 6))];
    return null;
  }
  if (!bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    let marker = bytes[offset++];
    while (marker === 0xff && offset < bytes.length) marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > bytes.length) return null;
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length) return null;
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      if (size < 7) return null;
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += size;
  }
  return null;
}
function validAvatar(avatar) {
  if (typeof avatar !== 'string' || avatar.length > Math.ceil(MAX_AVATAR_SIZE * 4 / 3) + 64) return false;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(avatar);
  if (!match) return false;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_AVATAR_SIZE) return false;
  const dimensions = imageDimensions(bytes, match[1]);
  return !!dimensions && dimensions.every(n => n > 0 && n <= MAX_AVATAR_PIXELS);
}

function cleanRtcSignal({ description, candidate } = {}) {
  if (description !== undefined && description !== null) {
    if (!['offer', 'answer'].includes(description?.type) || typeof description.sdp !== 'string' || description.sdp.length > 256 * 1024) return null;
    return { description: { type: description.type, sdp: description.sdp } };
  }
  if (!candidate || typeof candidate.candidate !== 'string' || candidate.candidate.length > 4096 ||
    (candidate.sdpMid != null && (typeof candidate.sdpMid !== 'string' || candidate.sdpMid.length > 128)) ||
    (candidate.sdpMLineIndex != null && (!Number.isInteger(candidate.sdpMLineIndex) || candidate.sdpMLineIndex < 0 || candidate.sdpMLineIndex > 256))) return null;
  return { candidate: { candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? null, sdpMLineIndex: candidate.sdpMLineIndex ?? null } };
}

function withinRate(user, action, limit, period = 10000) {
  const now = Date.now();
  const entry = user.rates[action];
  if (!entry || now - entry.start >= period) { user.rates[action] = { start: now, count: 1 }; return true; }
  return ++entry.count <= limit;
}

function createChatServer({ port = 3000, host = '0.0.0.0', password, dataDir = join(process.cwd(), 'data'), iceServers = [{ urls: 'stun:stun.l.google.com:19302' }], maxAttachmentBytes = 1024 * 1024 * 1024, maxAvatarBytes = 64 * 1024 * 1024 } = {}) {
  if (!password || password.length < 8) throw new Error('Defina um código de acesso de pelo menos 8 caracteres.');
  if (!Number.isSafeInteger(maxAttachmentBytes) || maxAttachmentBytes < 1 || !Number.isSafeInteger(maxAvatarBytes) || maxAvatarBytes < 1) throw new Error('Limites de armazenamento inválidos.');
  mkdirSync(dataDir, { recursive: true });
  const uploadsDir = join(dataDir, 'attachments');
  mkdirSync(uploadsDir, { recursive: true });
  let attachmentBytes = readdirSync(uploadsDir).filter(name => /^[a-f0-9]{32}$/.test(name))
    .reduce((sum, name) => sum + statSync(join(uploadsDir, name)).size, 0);
  const file = join(dataDir, 'messages.json');
  const profilesFile = join(dataDir, 'profiles.json');
  let profiles = {};
  try {
    const saved = JSON.parse(readFileSync(profilesFile, 'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) profiles = saved;
  }
  catch (error) { if (error.code !== 'ENOENT') console.warn('Perfis inválidos:', error.message); }
  let avatarBytes = Object.values(profiles).reduce((sum, profile) => sum + (typeof profile?.avatar === 'string' ? Buffer.byteLength(profile.avatar) : 0), 0);
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
    try { unlinkSync(join(uploadsDir, message.attachment.id)); attachmentBytes = Math.max(0, attachmentBytes - (message.attachment.size || 0)); }
    catch (error) { if (error.code !== 'ENOENT') console.error('Falha ao remover anexo:', error); }
  };
  const members = room => [...users.entries()].filter(([, user]) => user.voice === room)
    .map(([id, user]) => ({ id, name: user.name, profileId: profileIdFor(user.ownerKey), avatar: avatarFor(user.ownerKey), sharing: user.sharing, cameraStreamId: user.cameraStreamId, cameraTrackId: user.cameraTrackId, muted: user.muted }));
  const roster = () => Object.fromEntries(VOICES.map(({ id }) => [id, members(id)]));
  const leaveVoice = socket => {
    const user = users.get(socket.id);
    if (!user?.voice) return;
    const room = user.voice;
    socket.leave(`voice:${room}`);
    user.voice = null;
    user.sharing = false;
    user.cameraStreamId = null;
    user.cameraTrackId = null;
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
    users.set(socket.id, { name: socket.data.name, ownerKey: socket.data.ownerKey, voice: null, sharing: false, cameraStreamId: null, cameraTrackId: null, muted: false, lastMessage: 0, rates: {} });
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
      if (!withinRate(users.get(socket.id), 'profile', 5)) return done({ ok: false, error: 'Espere antes de alterar a foto.' });
      const avatar = payload?.avatar;
      if (avatar !== null && !validAvatar(avatar))
        return done({ ok: false, error: 'Foto inválida ou maior que 512 KB.' });
      const key = socket.data.ownerKey;
      const previous = profiles[key];
      const nextAvatarBytes = avatarBytes - (typeof previous?.avatar === 'string' ? Buffer.byteLength(previous.avatar) : 0) + (typeof avatar === 'string' ? Buffer.byteLength(avatar) : 0);
      if (nextAvatarBytes > maxAvatarBytes) return done({ ok: false, error: 'Espaço para fotos esgotado.' });
      if (avatar === null) delete profiles[key];
      else profiles[key] = { avatar };
      try { persistProfiles(); }
      catch (error) {
        console.error('Falha ao salvar foto:', error);
        if (previous) profiles[key] = previous; else delete profiles[key];
        return done({ ok: false, error: 'Não foi possível salvar a foto.' });
      }
      avatarBytes = nextAvatarBytes;
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
      if (upload && attachmentBytes + upload.data.length > maxAttachmentBytes)
        return done({ ok: false, error: 'Espaço de anexos esgotado.' });
      if (Date.now() - user.lastMessage < 400) return done({ ok: false, error: 'Espere um instante antes de enviar outra mensagem.' });
      user.lastMessage = Date.now();
      const message = { id: randomBytes(12).toString('hex'), channel, author: user.name, content, at: Date.now(), ownerKey: socket.data.ownerKey };
      if (upload) {
        const id = randomBytes(16).toString('hex');
        message.attachment = {
          id, name: upload.name.replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 120),
          size: upload.data.length, mime: upload.mime.slice(0, 100)
        };
        try { writeFileSync(join(uploadsDir, id), upload.data, { flag: 'wx' }); attachmentBytes += upload.data.length; }
        catch (error) {
          if (error.code !== 'EEXIST') { try { unlinkSync(join(uploadsDir, id)); } catch {} }
          console.error('Falha ao salvar anexo:', error); return done({ ok: false, error: 'Não foi possível salvar o arquivo.' });
        }
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
      if (!withinRate(users.get(socket.id), 'edit', 20)) return done({ ok: false, error: 'Muitas edições.' });
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
      if (!withinRate(users.get(socket.id), 'delete', 20)) return done({ ok: false, error: 'Muitas exclusões.' });
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
      if (!withinRate(users.get(socket.id), 'download', 10)) return done({ ok: false, error: 'Muitos downloads.' });
      const message = findMessage(payload?.channel, payload?.messageId);
      if (!message?.attachment || !/^[a-f0-9]{32}$/.test(message.attachment.id) || message.attachment.id !== payload?.attachmentId)
        return done({ ok: false, error: 'Arquivo não encontrado.' });
      try { done({ ok: true, data: readFileSync(join(uploadsDir, message.attachment.id)) }); }
      catch { done({ ok: false, error: 'Arquivo indisponível.' }); }
    });

    socket.on('voice:join', (room, ack) => {
      const done = typeof ack === 'function' ? ack : () => {};
      if (!withinRate(users.get(socket.id), 'join', 10)) return done({ ok: false, error: 'Muitas entradas em sala.' });
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
      if (!withinRate(user, 'state', 30)) return;
      if (typeof state?.sharing === 'boolean') user.sharing = state.sharing;
      if (state?.cameraStreamId === null || (typeof state?.cameraStreamId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(state.cameraStreamId)))
        user.cameraStreamId = state.cameraStreamId;
      if (state?.cameraTrackId === null || (typeof state?.cameraTrackId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(state.cameraTrackId)))
        user.cameraTrackId = state.cameraTrackId;
      if (typeof state?.muted === 'boolean') user.muted = state.muted;
      io.emit('voice:roster', roster());
    });
    socket.on('voice:speaking', speaking => {
      const user = users.get(socket.id);
      if (!user?.voice || typeof speaking !== 'boolean') return;
      if (!withinRate(user, 'speaking', 100)) return;
      socket.to(`voice:${user.voice}`).emit('voice:speaking', { id: socket.id, speaking: speaking && !user.muted });
    });
    socket.on('rtc:signal', payload => {
      const { to, description, candidate } = payload && typeof payload === 'object' ? payload : {};
      const sender = users.get(socket.id);
      const receiver = users.get(to);
      if (!sender?.voice || sender.voice !== receiver?.voice) return;
      if (!withinRate(sender, 'rtc', 100)) return;
      const signal = cleanRtcSignal({ description, candidate });
      if (!signal) return;
      io.to(to).emit('rtc:signal', { from: socket.id, ...signal });
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
    iceServers: process.env.ICE_SERVERS ? JSON.parse(process.env.ICE_SERVERS) : undefined,
    maxAttachmentBytes: Number(process.env.ORBITA_STORAGE_LIMIT_MB || 1024) * 1024 * 1024
  });
  server.listen().then(address => console.log(`Órbita online na porta ${address.port}`)).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { createChatServer, validAvatar };
