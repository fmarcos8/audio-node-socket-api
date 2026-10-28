/* global io, orbita */
const $ = id => document.getElementById(id);
const SCREEN_PRESETS = {
  performance: { width: 1280, height: 720, fps: 15, bitrate: 1500000 },
  balanced: { width: 1280, height: 720, fps: 25, bitrate: 2500000 },
  quality: { width: 1920, height: 1080, fps: 30, bitrate: 4500000 }
};
const CAMERA_FILTERS = {
  none: 'none', grayscale: 'grayscale(1)', sepia: 'sepia(1)',
  warm: 'sepia(.35) saturate(1.4)', contrast: 'contrast(1.5)', blur: 'blur(2px)'
};
const CAMERA_RESOLUTIONS = {
  '360p': { width: 640, height: 360, bitrate: 800000 },
  '720p': { width: 1280, height: 720, bitrate: 2000000 },
  '1080p': { width: 1920, height: 1080, bitrate: 3500000 }
};
const CAMERA_FRAME_RATES = [15, 24, 30];
const state = {
  socket: null, name: '', channel: 'geral', channels: [], voices: [], messages: {}, avatars: {}, roster: {},
  voice: null, mic: null, screen: null, muted: false, deafened: false, peers: new Map(), peerFailures: new Map(),
  serverUrl: '', code: '', hostInvite: null, iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  identity: '', pendingFile: null, audioContext: null, meters: new Map(), meterTimer: null,
  view: 'text', previousView: 'text', fileLimitMb: 8, theme: 'dark', accent: 'violet', accentColor: '#8171f1', avatar: null, shareQuality: 'performance',
  popoutPeers: new Map(), pendingSignals: [], speakingLevels: new Map(), remoteSpeaking: new Map(),
  volumes: {}, voiceJoinPending: null, joiningRoom: null, rejoinRoom: null, voiceResumeId: 0,
  camera: null, cameraSource: null, cameraInput: null, cameraCanvas: null, cameraTimer: null,
  cameraFilter: 'none', cameraDevice: '', cameraResolution: '360p', cameraFps: 15,
  cameraBusy: false, videoStreams: new Map()
};

function volumeKey(member) { return `${state.serverUrl}:${member.profileId || member.id}`; }
function peerVolume(id) {
  const member = (state.roster[state.voice] || []).find(person => person.id === id);
  return member ? state.volumes[volumeKey(member)] ?? 100 : 100;
}
function setPeerVolume(member, volume) {
  const level = Math.max(0, Math.min(100, Number(volume)));
  state.volumes[volumeKey(member)] = level;
  localStorage.setItem('orbita-volumes', JSON.stringify(state.volumes));
  document.querySelectorAll('audio[data-audio-peer-id]').forEach(audio => {
    if (audio.dataset.audioPeerId === member.id) audio.volume = level / 100;
  });
}

function notify(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.add('hidden'), 4500);
}
async function checkUpdates(manual = false) {
  if (!orbita.checkUpdates) return;
  const button = $('check-update');
  if (manual) button.disabled = true;
  try {
    const result = await orbita.checkUpdates();
    if (result.status === 'available') {
      $('update-title').textContent = `Órbita ${result.version} disponível`;
      $('update-banner').classList.remove('hidden');
    } else if (manual) {
      const messages = {
        current: 'Você já está usando a versão mais recente.',
        'no-release': 'Ainda não há uma versão publicada para baixar.',
        'no-installer': 'A versão nova ainda não tem instalador para este sistema.',
        unsupported: 'Não há instalador de atualização para este sistema.'
      };
      notify(messages[result.status] || 'Não foi possível verificar atualizações.');
    }
  } catch (error) {
    if (manual) notify('Não foi possível verificar atualizações.');
    console.warn('Verificação de atualização:', error);
  } finally { button.disabled = false; }
}
function initials(name) { return [...name.trim()][0]?.toUpperCase() || '?'; }
function time(at) { return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(at); }
function make(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
function icon(name, cls = 'ui-icon') {
  const img = make('img', cls);
  img.src = `icons/${name}.svg`;
  img.alt = '';
  return img;
}
function setAvatar(element, avatar, name) {
  element.replaceChildren();
  if (avatar) { const img = make('img'); img.src = avatar; img.alt = ''; element.append(img); }
  else element.textContent = initials(name);
}
function emitAck(event, ...args) {
  return new Promise((resolve, reject) => {
    state.socket.timeout(event === 'message:send' ? 120000 : 25000).emit(event, ...args, (error, reply) => error ? reject(error) : resolve(reply));
  });
}

function renderChannels() {
  const text = $('text-channels');
  const voice = $('voice-channels');
  text.replaceChildren(); voice.replaceChildren();
  for (const channel of state.channels) {
    const button = make('button', `channel ${state.view === 'text' && channel.id === state.channel ? 'active' : ''}`);
    button.append(icon('hash', 'ui-icon channel-icon'), make('span', '', channel.name));
    button.onclick = () => { state.channel = channel.id; state.view = 'text'; renderChannels(); renderMessages(); renderView(); };
    text.append(button);
  }
  for (const room of state.voices) {
    const button = make('button', `channel ${state.view === 'voice' && state.voice === room.id ? 'active' : ''} ${state.voice === room.id ? 'connected' : ''}`);
    button.append(icon('volume-2', 'ui-icon channel-icon'), make('span', '', room.name));
    button.onclick = () => joinVoice(room.id);
    voice.append(button);
    const list = make('div', 'voice-members');
    for (const member of state.roster[room.id] || []) {
      const row = make('div', 'voice-member');
      row.dataset.peerId = member.id;
      const avatar = make('span', 'mini-avatar'); setAvatar(avatar, member.avatar, member.name);
      row.append(avatar, make('span', '', member.name));
      if (member.sharing) row.append(icon('monitor', 'ui-icon member-state'));
      if (member.cameraStreamId) row.append(icon('video', 'ui-icon member-state'));
      if (member.muted) row.append(icon('mic-off', 'ui-icon member-state'));
      list.append(row);
    }
    voice.append(list);
  }
  renderActivity();
  renderVoiceStage();
}

function renderVoiceStage() {
  const room = state.voices.find(item => item.id === state.voice);
  $('voice-stage').classList.toggle('hidden', !room || state.view !== 'voice');
  if (!room) return;
  const members = state.roster[room.id] || [];
  $('voice-stage-name').textContent = room.name;
  $('voice-stage-count').textContent = `${members.length} ${members.length === 1 ? 'pessoa' : 'pessoas'}`;
  const tiles = $('voice-tiles'); tiles.replaceChildren();
  for (const member of members) {
    const tile = make('div', 'voice-tile'); tile.dataset.peerId = member.id;
    const avatar = make('div', 'voice-tile-avatar'); setAvatar(avatar, member.avatar, member.name);
    const name = make('strong', '', member.name);
    const status = make('small', '', member.sharing ? 'Transmitindo tela' : member.cameraStreamId ? 'Câmera ligada' : member.muted ? 'Microfone desligado' : 'Na sala de voz');
    tile.append(avatar, name, status);
    if (member.sharing) tile.append(icon('monitor', 'ui-icon voice-tile-state'));
    if (member.cameraStreamId) tile.append(icon('video', 'ui-icon voice-tile-state'));
    if (member.id !== state.socket?.id) {
      const control = make('label', 'peer-volume');
      const value = state.volumes[volumeKey(member)] ?? 100;
      const output = make('span', '', `${value}%`);
      const slider = make('input'); slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.value = String(value);
      slider.setAttribute('aria-label', `Volume de ${member.name}`);
      slider.oninput = () => { output.textContent = `${slider.value}%`; setPeerVolume(member, slider.value); };
      control.append(icon('volume-2'), slider, output);
      tile.append(control);
    }
    tiles.append(tile);
  }
  updateSpeaking();
}

function renderView() {
  const voiceView = state.view === 'voice' && !!state.voice;
  const settingsView = state.view === 'settings';
  const room = state.voices.find(item => item.id === state.voice);
  $('app').classList.toggle('text-view', !voiceView);
  $('app').classList.toggle('settings-view', settingsView);
  $('messages').classList.toggle('hidden', voiceView || settingsView);
  $('message-form').classList.toggle('hidden', voiceView || settingsView);
  $('settings-view').classList.toggle('hidden', !settingsView);
  $('attachment-preview').classList.toggle('hidden', voiceView || settingsView || !state.pendingFile);
  $('media-dock').classList.toggle('hidden', !voiceView);
  $('channel-title').textContent = settingsView ? 'Configurações' : voiceView ? room.name : state.channels.find(item => item.id === state.channel)?.name || 'geral';
  $('channel-description').textContent = settingsView ? 'Personalização' : voiceView ? 'Sala de voz' : 'Canal de texto';
  document.querySelector('.top-title img').src = `icons/${settingsView ? 'settings' : voiceView ? 'volume-2' : 'hash'}.svg`;
  renderVoiceStage();
}

function renderMessages() {
  const channel = state.channels.find(item => item.id === state.channel);
  if (!channel) return;
  $('message-input').placeholder = `Mensagem em #${channel.name}`;
  const container = $('messages');
  container.replaceChildren();
  const welcome = make('div', 'welcome');
  welcome.append(make('div', 'welcome-icon', '#'), make('h2', '', `Bem-vindo a #${channel.name}`), make('p', '', 'Este é o começo da conversa. Diga oi!'));
  container.append(welcome);
  for (const message of state.messages[state.channel] || []) appendMessage(message, false);
  container.scrollTop = container.scrollHeight;
}
function appendMessage(message, scroll = true) {
  if (message.channel !== state.channel) return;
  const row = make('article', 'message');
  const avatar = make('div', 'message-avatar');
  const photo = message.profileId && Object.hasOwn(state.avatars, message.profileId) ? state.avatars[message.profileId] : message.avatar;
  setAvatar(avatar, photo, message.author);
  const body = make('div', 'message-body');
  const meta = make('div', 'message-meta');
  meta.append(make('strong', '', message.author), make('span', '', time(message.at)));
  if (message.editedAt) meta.append(make('span', 'edited-note', '(editada)'));
  body.append(meta);
  if (message.content) body.append(make('div', 'message-text', message.content));
  if (message.attachment) {
    const attachment = make('button', 'message-attachment');
    attachment.type = 'button';
    attachment.append(icon('file'), make('span', '', message.attachment.name), make('small', '', formatSize(message.attachment.size)), icon('download'));
    attachment.title = 'Baixar arquivo';
    attachment.onclick = () => downloadAttachment(message);
    body.append(attachment);
  }
  if (message.mine) {
    const actions = make('div', 'message-actions');
    const edit = make('button', 'message-action');
    edit.type = 'button'; edit.title = 'Editar mensagem'; edit.append(icon('pencil'));
    edit.onclick = () => editMessage(message, body);
    const remove = make('button', 'message-action delete-action');
    remove.type = 'button'; remove.title = 'Excluir mensagem'; remove.append(icon('trash-2'));
    remove.onclick = () => deleteMessage(message);
    actions.append(edit, remove); body.append(actions);
  }
  row.append(avatar, body);
  $('messages').append(row);
  if (scroll) $('messages').scrollTop = $('messages').scrollHeight;
}
function formatSize(bytes) { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function editMessage(message, body) {
  const previous = body.querySelector('.inline-edit');
  if (previous) return;
  const form = make('form', 'inline-edit');
  const input = make('textarea');
  input.maxLength = 2000; input.value = message.content;
  const buttons = make('div', 'inline-edit-buttons');
  const cancel = make('button', '', 'Cancelar'); cancel.type = 'button';
  cancel.onclick = () => form.remove();
  const save = make('button', 'save-edit', 'Salvar'); save.type = 'submit';
  buttons.append(cancel, save); form.append(input, buttons); body.append(form); input.focus();
  form.onsubmit = async event => {
    event.preventDefault();
    const content = input.value.trim();
    if (!content) return notify('A mensagem não pode ficar vazia.');
    try {
      save.disabled = true;
      const result = await emitAck('message:edit', { channel: message.channel, id: message.id, content });
      if (!result.ok) throw new Error(result.error);
      form.remove();
    } catch (error) { save.disabled = false; notify(error.message); }
  };
}
async function deleteMessage(message) {
  if (!window.confirm('Excluir esta mensagem?')) return;
  try {
    const result = await emitAck('message:delete', { channel: message.channel, id: message.id });
    if (!result.ok) throw new Error(result.error);
  } catch (error) { notify(error.message); }
}
async function downloadAttachment(message) {
  try {
    notify('Baixando arquivo...');
    const result = await new Promise((resolve, reject) =>
      state.socket.timeout(120000).emit('file:download', {
        channel: message.channel, messageId: message.id, attachmentId: message.attachment.id
      }, (error, reply) => error ? reject(error) : resolve(reply)));
    if (!result.ok) throw new Error(result.error);
    const saved = await orbita.saveFile(message.attachment.name, new Uint8Array(result.data));
    if (saved) notify('Arquivo salvo.');
  } catch (error) { notify(error.message || 'Falha ao baixar o arquivo.'); }
}
function renderActivity() {
  const current = state.roster[state.voice] || [];
  $('room-count').textContent = current.length;
  const box = $('activity-content');
  box.replaceChildren();
  if (!state.voice) {
    box.append(make('p', 'activity-empty', 'Entre em uma sala de voz para ver quem está por lá.'));
    return;
  }
  for (const member of current) {
    const row = make('div', 'activity-person');
    row.dataset.peerId = member.id;
    const info = make('div');
    info.append(make('strong', '', member.name), make('small', '', member.sharing ? '▣ Compartilhando tela' : member.cameraStreamId ? 'Câmera ligada' : member.muted ? 'Microfone desligado' : 'Na conversa'));
    const avatar = make('div', 'avatar'); setAvatar(avatar, member.avatar, member.name);
    row.append(avatar, info);
    box.append(row);
  }
  if (!current.length) box.append(make('p', 'activity-empty', 'Ninguém nesta sala ainda.'));
}

function updateVoiceUi() {
  const room = state.voices.find(item => item.id === state.voice);
  document.querySelector('.call-status').textContent = state.rejoinRoom ? '● RECONECTANDO...' : '● VOZ CONECTADA';
  document.querySelector('.dock-live').textContent = state.rejoinRoom ? '● RECONECTANDO...' : '● AO VIVO';
  $('call-panel').classList.toggle('hidden', !room);
  $('media-dock').classList.toggle('hidden', !room);
  $('mute-btn').disabled = !room;
  $('deafen-btn').disabled = !room;
  $('mute-btn').classList.toggle('active', state.muted);
  $('deafen-btn').classList.toggle('active', state.deafened);
  $('mute-btn').querySelector('img').src = `icons/${state.muted ? 'mic-off' : 'mic'}.svg`;
  $('deafen-btn').querySelector('img').src = `icons/${state.deafened ? 'volume-x' : 'headphones'}.svg`;
  $('mute-btn').title = state.muted ? 'Ativar microfone' : 'Silenciar microfone';
  $('deafen-btn').title = state.deafened ? 'Ativar áudio recebido' : 'Desativar áudio recebido';
  $('share-btn').classList.toggle('active', !!state.screen);
  $('share-btn').querySelector('span').textContent = state.screen ? 'Parar transmissão' : 'Compartilhar tela';
  $('camera-btn').disabled = !room || state.cameraBusy;
  $('camera-btn').classList.toggle('active', !!state.camera);
  $('camera-btn').setAttribute('aria-pressed', String(!!state.camera));
  $('camera-btn').querySelector('span').textContent = state.camera ? 'Desligar câmera' : 'Ligar câmera';
  if (room) { $('call-room').textContent = room.name; $('dock-title').textContent = room.name; }
  renderChannels();
  renderView();
}

function watchAudio(id, stream) {
  if (state.meters.has(id) || !stream.getAudioTracks().length) return;
  try {
    state.audioContext ||= new AudioContext();
    state.audioContext.resume().catch(() => {});
    const source = state.audioContext.createMediaStreamSource(stream);
    const analyser = state.audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    state.meters.set(id, { source, analyser, samples: new Uint8Array(analyser.fftSize) });
    state.meterTimer ||= setInterval(updateSpeaking, 140);
  } catch (error) { console.warn('Indicador de voz indisponível:', error); }
}
function stopWatching(id) {
  state.meters.get(id)?.source.disconnect();
  state.meters.delete(id);
  state.speakingLevels.delete(id);
  state.remoteSpeaking.delete(id);
  if (!state.meters.size && state.meterTimer) { clearInterval(state.meterTimer); state.meterTimer = null; }
}
function updateSpeaking() {
  for (const [id, meter] of state.meters) {
    meter.analyser.getByteTimeDomainData(meter.samples);
    let energy = 0;
    for (const sample of meter.samples) energy += ((sample - 128) / 128) ** 2;
    const speaking = Math.sqrt(energy / meter.samples.length) > 0.035 &&
      (id !== state.socket?.id || !state.muted);
    if (id === state.socket?.id && state.speakingLevels.get(id) !== speaking && state.voice)
      state.socket.emit('voice:speaking', speaking);
    state.speakingLevels.set(id, speaking);
  }
  refreshSpeakingUi();
}
function refreshSpeakingUi() {
  for (const element of document.querySelectorAll('[data-peer-id]')) {
    const id = element.dataset.peerId;
    element.classList.toggle('speaking', !!(state.speakingLevels.get(id) || state.remoteSpeaking.get(id)));
  }
}

async function configureScreenSender(sender) {
  if (sender?.track?.kind !== 'video' || typeof sender.getParameters !== 'function') return;
  try {
    const preset = SCREEN_PRESETS[state.shareQuality];
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    const size = sender.track.getSettings?.() || {};
    const scale = Math.max(1, (size.width || preset.width) / preset.width, (size.height || preset.height) / preset.height);
    for (const encoding of params.encodings) {
      encoding.maxFramerate = preset.fps;
      encoding.maxBitrate = preset.bitrate;
      encoding.scaleResolutionDownBy = scale;
    }
    await sender.setParameters(params);
  }
  catch (error) { console.warn('Limite do vídeo indisponível:', error); }
}

async function configureCameraSender(sender) {
  if (!sender?.track || typeof sender.getParameters !== 'function') return;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    const preset = CAMERA_RESOLUTIONS[state.cameraResolution];
    for (const encoding of params.encodings) {
      encoding.maxFramerate = state.cameraFps;
      encoding.maxBitrate = preset.bitrate;
      encoding.scaleResolutionDownBy = 1;
    }
    await sender.setParameters(params);
  } catch (error) { console.warn('Limite da webcam indisponível:', error); }
}

async function applyScreenQuality() {
  const track = state.screen?.getVideoTracks()[0];
  if (!track) return;
  const preset = SCREEN_PRESETS[state.shareQuality];
  try {
    await track.applyConstraints({
      width: { ideal: preset.width, max: preset.width },
      height: { ideal: preset.height, max: preset.height },
      frameRate: { ideal: preset.fps, max: preset.fps }
    });
  } catch (error) {
    console.warn('Resolução solicitada indisponível; limitando quadros:', error);
    try { await track.applyConstraints({ frameRate: { ideal: preset.fps, max: preset.fps } }); }
    catch (fallbackError) { console.warn('Limite da captura indisponível:', fallbackError); }
  }
  await Promise.all([...state.peers.values()].flatMap(({ pc }) => pc.getSenders()
    .filter(sender => sender.track === track).map(configureScreenSender)));
  await Promise.all([...state.popoutPeers.values()].flatMap(({ pc }) => pc.getSenders()
    .filter(sender => sender.track === track).map(configureScreenSender)));
}

function createPeer(id) {
  if (state.peers.has(id)) return state.peers.get(id);
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  const peer = { pc, makingOffer: false, ignoreOffer: false, isSettingRemoteAnswerPending: false, pending: [], signalQueue: Promise.resolve(), restartTimer: null, recoveryTimer: null };
  state.peers.set(id, peer);
  if (state.mic) for (const track of state.mic.getTracks()) pc.addTrack(track, state.mic);
  if (state.screen) for (const track of state.screen.getTracks()) {
    const sender = pc.addTrack(track, state.screen);
    if (track.kind === 'video') configureScreenSender(sender);
  }
  if (state.camera) for (const track of state.camera.getVideoTracks())
    configureCameraSender(pc.addTrack(track, state.camera));
  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      state.socket.emit('rtc:signal', { to: id, description: pc.localDescription.toJSON() });
    } catch (error) { console.error('Negociação:', error); }
    finally { peer.makingOffer = false; }
  };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) state.socket.emit('rtc:signal', { to: id, candidate: candidate.toJSON() });
  };
  pc.ontrack = ({ track, streams }) => {
    const stream = new MediaStream([track]);
    if (track.kind === 'audio') {
      let audio = [...document.querySelectorAll('audio[data-audio-peer-id]')]
        .find(element => element.dataset.audioPeerId === id && element.dataset.trackId === track.id);
      if (!audio) {
        audio = make('audio'); audio.dataset.audioPeerId = id; audio.dataset.trackId = track.id;
        audio.autoplay = true; document.body.append(audio);
      }
      audio.srcObject = stream;
      audio.muted = state.deafened;
      audio.volume = peerVolume(id) / 100;
      const playAudio = () => audio.play().catch(error => console.warn('Reprodução de áudio:', error));
      track.onunmute = playAudio;
      track.onended = () => audio.remove();
      playAudio();
      if (!state.meters.has(id)) watchAudio(id, stream);
    } else {
      const media = streams?.[0] || stream;
      const videos = state.videoStreams.get(id) || new Map();
      videos.set(media.id, media);
      state.videoStreams.set(id, videos);
      renderRemoteVideo(id, media);
      track.onunmute = () => renderRemoteVideo(id, media);
      track.onended = () => { videos.delete(media.id); hideStream(id, 'camera'); hideStream(id); for (const video of videos.values()) renderRemoteVideo(id, video); };
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      clearTimeout(peer.restartTimer); clearTimeout(peer.recoveryTimer);
      peer.restartTimer = peer.recoveryTimer = null;
      state.peerFailures.delete(id);
      document.querySelectorAll('audio[data-audio-peer-id]').forEach(audio => {
        if (audio.dataset.audioPeerId === id) audio.play().catch(console.warn);
      });
      for (const sender of pc.getSenders()) {
        if (sender.track === state.camera?.getVideoTracks()[0]) configureCameraSender(sender);
        else if (sender.track?.kind === 'video') configureScreenSender(sender);
      }
    }
    if (['disconnected', 'failed'].includes(pc.connectionState) && !peer.restartTimer && !peer.recoveryTimer) {
      peer.restartTimer = setTimeout(() => {
        peer.restartTimer = null;
        if (state.peers.get(id) !== peer || !state.socket?.connected || !state.voice) return;
        try { pc.restartIce(); }
        catch (error) { console.warn('Reinício de mídia indisponível:', error); }
        peer.recoveryTimer = setTimeout(() => {
          peer.recoveryTimer = null;
          if (state.peers.get(id) !== peer || !state.socket?.connected || !state.voice ||
            ['connected', 'closed'].includes(pc.connectionState)) return;
          const attempts = (state.peerFailures.get(id) || 0) + 1;
          if (attempts > 2) return notify('Áudio indisponível. Verifique a rede ou configure um servidor TURN.');
          state.peerFailures.set(id, attempts);
          closePeer(id);
          createPeer(id);
        }, 10000);
      }, pc.connectionState === 'failed' ? 0 : 3000);
    }
  };
  return peer;
}

function receiveSignal(signal) {
  if (!state.voice) { if (state.pendingSignals.length < 100) state.pendingSignals.push(signal); return; }
  const peer = createPeer(signal.from);
  peer.signalQueue = peer.signalQueue.then(() => applySignal(peer, signal)).catch(error => console.error('Sinalização:', error));
}
async function applySignal(peer, { from, description, candidate }) {
  const { pc } = peer;
  if (!state.voice || pc.signalingState === 'closed') return;
  try {
    if (description) {
      const readyForOffer = !peer.makingOffer && (pc.signalingState === 'stable' || peer.isSettingRemoteAnswerPending);
      const collision = description.type === 'offer' && !readyForOffer;
      peer.ignoreOffer = !((state.socket.id || '') > from) && collision;
      if (peer.ignoreOffer) { peer.pending.length = 0; return; }
      peer.isSettingRemoteAnswerPending = description.type === 'answer';
      await pc.setRemoteDescription(description);
      peer.isSettingRemoteAnswerPending = false;
      for (const queued of peer.pending.splice(0)) await pc.addIceCandidate(queued);
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        state.socket.emit('rtc:signal', { to: from, description: pc.localDescription.toJSON() });
      }
    } else if (candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(candidate);
      else peer.pending.push(candidate);
    }
  } catch (error) {
    peer.isSettingRemoteAnswerPending = false;
    if (!peer.ignoreOffer) console.error('Sinalização:', error);
  }
}
function closePeer(id) {
  const peer = state.peers.get(id);
  clearTimeout(peer?.restartTimer); clearTimeout(peer?.recoveryTimer);
  stopWatching(id);
  refreshSpeakingUi();
  peer?.pc.close();
  state.peers.delete(id);
  state.videoStreams.delete(id);
  document.querySelectorAll('audio[data-audio-peer-id]').forEach(audio => {
    if (audio.dataset.audioPeerId === id) audio.remove();
  });
  hideStream(id);
  hideStream(id, 'camera');
}
function renderRemoteVideo(id, stream) {
  const member = (state.roster[state.voice] || []).find(person => person.id === id);
  const kind = member?.cameraStreamId === stream.id ? 'camera' : 'screen';
  if (kind === 'screen' && member && !member.sharing) return;
  const other = document.getElementById(kind === 'camera' ? `stream-${id}` : `camera-${id}`);
  if (other?.querySelector('video')?.srcObject === stream)
    hideStream(id, kind === 'camera' ? 'screen' : 'camera');
  showStream(id, stream, kind);
}
function showStream(id, stream, kind = 'screen') {
  const mediaId = kind === 'camera' ? `camera-${id}` : `stream-${id}`;
  const popoutId = kind === 'camera' ? `camera:${id}` : id;
  let card = document.getElementById(mediaId);
  if (!card) {
    card = make('div', 'stream-card'); card.id = mediaId;
    const footer = make('div', 'stream-footer');
    const maximize = make('button', 'stream-maximize');
    maximize.type = 'button'; maximize.title = 'Abrir em outra janela'; maximize.append(icon('expand'));
    maximize.onclick = async () => {
      try { if (!await orbita.openStream(popoutId)) notify('Não foi possível abrir a transmissão.'); }
      catch (error) { notify(error.message || 'Não foi possível abrir a transmissão.'); }
    };
    footer.append(make('span', '', kind === 'camera' ? 'Webcam' : 'Tela compartilhada'), maximize);
    card.append(make('video'), footer);
    $('streams').append(card);
  }
  const video = card.querySelector('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  const track = stream.getVideoTracks()[0];
  if (video.srcObject !== stream || video.displayedTrack !== track) {
    video.srcObject = null;
    video.srcObject = stream;
    video.displayedTrack = track;
  }
  video.play().catch(error => console.warn('Reprodução de vídeo:', error));
  $('streams').classList.remove('hidden');
  $('voice-hint').classList.add('hidden');
}
function hideStream(id, kind = 'screen') {
  const popoutId = kind === 'camera' ? `camera:${id}` : id;
  state.popoutPeers.get(popoutId)?.pc.close();
  state.popoutPeers.delete(popoutId);
  orbita.closeStream?.(popoutId);
  document.getElementById(kind === 'camera' ? `camera-${id}` : `stream-${id}`)?.remove();
  $('streams').classList.toggle('hidden', !$('streams').children.length);
  $('voice-hint').classList.toggle('hidden', !!$('streams').children.length);
}
function mirrorStream(id) {
  const cardId = id.startsWith('camera:') ? `camera-${id.slice(7)}` : `stream-${id}`;
  const track = document.getElementById(cardId)?.querySelector('video')?.srcObject?.getVideoTracks()[0];
  if (!track) { orbita.closeStream(id); return; }
  state.popoutPeers.get(id)?.pc.close();
  const pc = new RTCPeerConnection();
  const peer = { pc, candidates: [] };
  state.popoutPeers.set(id, peer);
  pc.onicecandidate = ({ candidate }) => { if (candidate) orbita.signalStream(id, { candidate: candidate.toJSON() }); };
  pc.onnegotiationneeded = async () => {
    try { await pc.setLocalDescription(); orbita.signalStream(id, { description: pc.localDescription.toJSON() }); }
    catch (error) { console.warn('Janela de transmissão:', error); }
  };
  pc.addTrack(track, new MediaStream([track]));
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') for (const sender of pc.getSenders()) {
      if (id.startsWith('camera:')) configureCameraSender(sender);
      else configureScreenSender(sender);
    }
  };
}
orbita.onStreamReady?.(mirrorStream);
orbita.onStreamSignal?.(async (id, signal) => {
  const peer = state.popoutPeers.get(id);
  if (!peer) return;
  try {
    if (signal.description?.type === 'answer') {
      await peer.pc.setRemoteDescription(signal.description);
      for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
    } else if (signal.candidate) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(signal.candidate);
      else peer.candidates.push(signal.candidate);
    }
  } catch (error) { console.warn('Janela de transmissão:', error); }
});
orbita.onStreamClosed?.(id => { state.popoutPeers.get(id)?.pc.close(); state.popoutPeers.delete(id); });

async function listCameras() {
  if (!globalThis.navigator?.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const select = $('camera-device');
    const selected = state.cameraDevice;
    const defaultOption = make('option', '', 'Padrão do sistema'); defaultOption.value = '';
    select.replaceChildren(defaultOption);
    for (const [index, device] of devices.filter(item => item.kind === 'videoinput').entries()) {
      const option = make('option', '', device.label || `Câmera ${index + 1}`);
      option.value = device.deviceId; select.append(option);
    }
    select.value = [...select.options].some(option => option.value === selected) ? selected : '';
  } catch (error) { console.warn('Lista de câmeras indisponível:', error); }
}

async function cameraOutput(filter) {
  const rawTrack = state.cameraSource.getVideoTracks()[0];
  if (filter === 'none') return rawTrack;
  const video = state.cameraInput || make('video');
  video.srcObject = state.cameraSource; video.muted = true; video.playsInline = true;
  await video.play();
  const canvas = document.createElement('canvas');
  const size = rawTrack.getSettings?.() || {};
  const preset = CAMERA_RESOLUTIONS[state.cameraResolution];
  canvas.width = size.width || preset.width; canvas.height = size.height || preset.height;
  const context = canvas.getContext('2d');
  if (!context || !canvas.captureStream) throw new Error('Filtros indisponíveis neste dispositivo.');
  state.cameraInput = video; state.cameraCanvas = canvas;
  const draw = () => {
    if (state.cameraCanvas !== canvas) return;
    context.filter = CAMERA_FILTERS[state.cameraFilter];
    if (video.readyState >= 2) context.drawImage(video, 0, 0, canvas.width, canvas.height);
    state.cameraTimer = setTimeout(draw, 1000 / state.cameraFps);
  };
  draw();
  // O limite de captura permanece em 30 FPS; o ritmo do desenho define a taxa escolhida.
  return canvas.captureStream(30).getVideoTracks()[0];
}

async function applyCameraQuality() {
  const track = state.cameraSource?.getVideoTracks()[0];
  if (!track) return;
  const preset = CAMERA_RESOLUTIONS[state.cameraResolution];
  try {
    await track.applyConstraints({
      width: { ideal: preset.width }, height: { ideal: preset.height },
      frameRate: { ideal: state.cameraFps, max: state.cameraFps }
    });
  } catch (error) {
    console.warn('Qualidade da webcam indisponível:', error);
    notify('A webcam não aceitou a qualidade escolhida; usando a mais próxima disponível.');
  }
  if (state.cameraCanvas) {
    const size = track.getSettings?.() || {};
    state.cameraCanvas.width = size.width || preset.width;
    state.cameraCanvas.height = size.height || preset.height;
  }
  await Promise.all([...state.peers.values()].flatMap(({ pc }) => pc.getSenders()
    .filter(sender => sender.track === state.camera?.getVideoTracks()[0]).map(configureCameraSender)));
  await Promise.all([...state.popoutPeers.entries()].filter(([id]) => id.startsWith('camera:'))
    .flatMap(([, { pc }]) => pc.getSenders().map(configureCameraSender)));
}

async function changeCameraFilter(filter) {
  if (!Object.hasOwn(CAMERA_FILTERS, filter)) return;
  state.cameraFilter = filter;
  localStorage.setItem('orbita-camera-filter', filter);
  if (!state.camera) return;
  const previous = state.camera.getVideoTracks()[0];
  clearTimeout(state.cameraTimer); state.cameraTimer = null; state.cameraCanvas = null;
  try {
    const next = await cameraOutput(filter);
    for (const { pc } of state.peers.values()) {
      const sender = pc.getSenders().find(item => item.track === previous);
      if (sender) { await sender.replaceTrack(next); configureCameraSender(sender); }
    }
    state.camera.removeTrack(previous);
    state.camera.addTrack(next);
    if (previous !== state.cameraSource.getVideoTracks()[0]) previous.stop();
    showStream('self', state.camera, 'camera');
  } catch (error) {
    state.cameraFilter = 'none'; $('camera-filter').value = 'none';
    notify(error.message || 'Não foi possível aplicar o filtro.');
  }
}

function stopCamera() {
  if (!state.cameraSource && !state.camera) return;
  const camera = state.camera;
  state.camera = null;
  clearTimeout(state.cameraTimer); state.cameraTimer = null; state.cameraCanvas = null;
  for (const { pc } of state.peers.values())
    for (const sender of pc.getSenders()) if (camera?.getTracks().includes(sender.track)) pc.removeTrack(sender);
  camera?.getVideoTracks().forEach(track => track.stop());
  state.cameraSource?.getTracks().forEach(track => track.stop());
  state.cameraInput?.pause();
  if (state.cameraInput) state.cameraInput.srcObject = null;
  state.cameraInput = null; state.cameraSource = null;
  hideStream('self', 'camera');
  if (state.socket?.connected) state.socket.emit('voice:state', { cameraStreamId: null });
  updateVoiceUi();
}

async function toggleCamera() {
  if (state.cameraBusy || !state.voice) return;
  if (state.camera) { stopCamera(); return; }
  state.cameraBusy = true; updateVoiceUi();
  try {
    const preset = CAMERA_RESOLUTIONS[state.cameraResolution];
    const source = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
      width: { ideal: preset.width }, height: { ideal: preset.height },
      frameRate: { ideal: state.cameraFps, max: state.cameraFps },
      ...(state.cameraDevice ? { deviceId: { exact: state.cameraDevice } } : {})
    } });
    if (!state.voice) { source.getTracks().forEach(track => track.stop()); return; }
    state.cameraSource = source;
    source.getVideoTracks()[0].onended = stopCamera;
    const track = await cameraOutput(state.cameraFilter);
    if (!state.voice) { track.stop(); stopCamera(); return; }
    state.camera = new MediaStream([track]);
    state.socket.emit('voice:state', { cameraStreamId: state.camera.id });
    for (const { pc } of state.peers.values()) configureCameraSender(pc.addTrack(track, state.camera));
    showStream('self', state.camera, 'camera');
    document.querySelector('#camera-self .stream-footer span').textContent = 'Sua webcam';
    await listCameras();
  } catch (error) { stopCamera(); notify(`Não foi possível ligar a webcam: ${error.message}`); }
  finally { state.cameraBusy = false; updateVoiceUi(); }
}

async function joinVoice(room) {
  if (state.voiceJoinPending) {
    if (state.joiningRoom === room) return state.voiceJoinPending;
    await state.voiceJoinPending;
    return joinVoice(room);
  }
  const pending = enterVoice(room);
  state.voiceJoinPending = pending;
  state.joiningRoom = room;
  try { await pending; }
  finally {
    if (state.voiceJoinPending === pending) { state.voiceJoinPending = null; state.joiningRoom = null; }
  }
}
async function enterVoice(room) {
  if (state.voice === room) { state.view = 'voice'; renderChannels(); renderView(); return; }
  if (state.voice) leaveVoice();
  const socket = state.socket;
  try {
    state.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  } catch (error) {
    state.mic = null;
    notify('Microfone indisponível. Você poderá escutar a sala.');
  }
  try {
    if (state.socket !== socket || !socket?.connected) throw new Error('Conexão encerrada.');
    const result = await emitAck('voice:join', room);
    if (!result.ok) throw new Error(result.error);
    if (state.socket !== socket || !socket.connected) throw new Error('Conexão encerrada.');
    state.voice = room;
    state.view = 'voice';
    if (state.mic) watchAudio(state.socket.id, state.mic);
    updateVoiceUi();
    for (const member of result.peers) createPeer(member.id);
    for (const signal of state.pendingSignals.splice(0)) receiveSignal(signal);
  } catch (error) {
    state.mic?.getTracks().forEach(track => track.stop()); state.mic = null;
    notify(error.message || 'Não foi possível entrar na sala.');
  }
}
async function restoreVoice(socket, room) {
  const resumeId = state.voiceResumeId;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (state.socket !== socket || !socket.connected || state.voice !== room || state.voiceResumeId !== resumeId) return;
    try {
      const tracks = state.mic?.getAudioTracks() || [];
      if (tracks.length && tracks.every(track => track.readyState === 'ended')) {
        state.mic.getTracks().forEach(track => track.stop());
        state.mic = null;
        try {
          const replacement = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
          if (state.socket !== socket || !socket.connected || state.voice !== room || state.voiceResumeId !== resumeId) {
            replacement.getTracks().forEach(track => track.stop());
            return;
          }
          state.mic = replacement;
          state.mic.getAudioTracks().forEach(track => { track.enabled = !state.muted; });
        } catch { notify('Microfone indisponível após a reconexão. Você ainda pode ouvir a sala.'); }
      }
      if (state.socket !== socket || !socket.connected || state.voice !== room || state.voiceResumeId !== resumeId) return;
      const result = await emitAck('voice:join', room);
      if (!result.ok) throw new Error(result.error);
      if (state.socket !== socket || !socket.connected || state.voice !== room || state.voiceResumeId !== resumeId) return;
      state.rejoinRoom = null;
      if (state.mic) watchAudio(socket.id, state.mic);
      socket.emit('voice:state', { muted: state.muted, sharing: !!state.screen, cameraStreamId: state.camera?.id || null });
      updateVoiceUi();
      for (const member of result.peers) createPeer(member.id);
      for (const signal of state.pendingSignals.splice(0)) receiveSignal(signal);
      notify('Sala de voz reconectada.');
      return;
    } catch (error) {
      if (state.socket !== socket || !socket.connected || state.voice !== room || state.voiceResumeId !== resumeId) return;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      else { leaveVoice(); notify(error.message || 'Não foi possível reconectar à sala de voz.'); }
    }
  }
}
function stopShare() {
  if (!state.screen) return;
  const screen = state.screen;
  state.screen = null;
  for (const { pc } of state.peers.values()) {
    for (const sender of pc.getSenders()) {
      if (screen.getTracks().includes(sender.track)) pc.removeTrack(sender);
    }
  }
  screen.getTracks().forEach(track => track.stop());
  hideStream('self');
  if (state.socket?.connected) state.socket.emit('voice:state', { sharing: false });
  updateVoiceUi();
}
function leaveVoice() {
  state.rejoinRoom = null;
  state.voiceResumeId++;
  stopShare();
  stopCamera();
  if (state.socket?.connected) state.socket.emit('voice:leave');
  for (const id of [...state.peers.keys()]) closePeer(id);
  stopWatching(state.socket?.id);
  state.audioContext?.close().catch(() => {});
  state.audioContext = null;
  state.mic?.getTracks().forEach(track => track.stop());
  state.mic = null;
  state.voice = null;
  state.pendingSignals.length = 0;
  state.speakingLevels.clear(); state.remoteSpeaking.clear();
  state.peerFailures.clear();
  if (state.view === 'voice') state.view = 'text';
  state.muted = false;
  state.deafened = false;
  updateVoiceUi();
  renderMessages();
}
async function chooseSource() {
  if (state.screen) { stopShare(); return; }
  try {
    const sources = await orbita.sources();
    const list = $('source-list');
    list.replaceChildren();
    for (const source of sources) {
      const button = make('button', 'source-item');
      button.type = 'button';
      const preview = make('img'); preview.src = source.thumbnail; preview.alt = '';
      button.append(preview, make('span', '', source.name));
      button.onclick = () => { $('source-dialog').close(); startShare(source.id); };
      list.append(button);
    }
    $('source-dialog').showModal();
  } catch (error) { notify(`Não foi possível listar telas: ${error.message}`); }
}
async function startShare(sourceId) {
  try {
    if (!await orbita.selectSource(sourceId)) throw new Error('Fonte inválida.');
    const preset = SCREEN_PRESETS[state.shareQuality];
    const withAudio = !!orbita.canShareSystemAudio && $('share-audio').checked;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: preset.width }, height: { ideal: preset.height },
        frameRate: { ideal: preset.fps, max: preset.fps }
      }, audio: withAudio
    });
    state.screen = stream;
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('Nenhuma imagem de tela foi capturada.');
    track.contentHint = 'motion';
    track.onended = stopShare;
    await applyScreenQuality();
    for (const { pc } of state.peers.values()) {
      const sender = pc.addTrack(track, stream);
      configureScreenSender(sender);
      for (const audio of stream.getAudioTracks()) pc.addTrack(audio, stream);
    }
    if (withAudio && !stream.getAudioTracks().length) notify('Áudio do computador indisponível; transmitindo somente a tela.');
    showStream('self', stream);
    document.querySelector('#stream-self .stream-footer span').textContent = 'Sua tela';
    state.socket.emit('voice:state', { sharing: true });
    updateVoiceUi();
  } catch (error) {
    if (state.screen) stopShare();
    notify(`Compartilhamento cancelado: ${error.message}`);
  }
}

function connect(url, name, code) {
  $('login-error').textContent = '';
  if (!name || !code || !url) { $('login-error').textContent = 'Preencha nome, endereço e código.'; return; }
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    url = parsed.origin;
  } catch { $('login-error').textContent = 'Endereço inválido. Use http:// ou https://.'; return; }
  if (state.voice) leaveVoice();
  state.rejoinRoom = null;
  state.voiceResumeId++;
  const previousSocket = state.socket;
  state.socket = null;
  previousSocket?.disconnect();
  state.name = name.slice(0, 32); state.serverUrl = url; state.code = code;
  $('connect-btn').disabled = true;
  $('connect-btn').firstChild.textContent = 'Conectando... ';
  const socket = io(url, { auth: { name: state.name, code, identity: state.identity }, reconnectionAttempts: Infinity, timeout: 10000 });
  state.socket = socket;
  socket.on('init', data => {
    if (state.socket !== socket) return;
    state.channels = data.channels;
    state.voices = data.voices;
    state.messages = data.messages;
    state.avatars = data.avatars || {};
    state.roster = data.roster;
    state.iceServers = Array.isArray(data.iceServers) ? data.iceServers : [];
    state.avatar = data.avatar || null;
    const roomToRestore = state.rejoinRoom;
    if (!roomToRestore) { state.channel = 'geral'; state.view = 'text'; }
    $('profile-name').textContent = state.name;
    $('settings-name').textContent = state.name;
    setAvatar($('profile-avatar'), state.avatar, state.name);
    setAvatar($('settings-avatar'), state.avatar, state.name);
    $('login').classList.add('hidden'); $('app').classList.remove('hidden');
    $('connect-btn').disabled = false;
    $('connect-btn').firstChild.textContent = 'Entrar no servidor ';
    localStorage.setItem('orbita-connection', JSON.stringify({ url, name: state.name, code }));
    renderChannels(); renderMessages(); renderView();
    if (roomToRestore) {
      if (state.voice === roomToRestore) restoreVoice(socket, roomToRestore);
      else { state.rejoinRoom = null; joinVoice(roomToRestore); }
    }
  });
  socket.on('connect_error', error => {
    $('login-error').textContent = error.message;
    $('connect-btn').disabled = false;
    $('connect-btn').firstChild.textContent = 'Entrar no servidor ';
  });
  socket.on('disconnect', reason => {
    if (state.socket !== socket || reason === 'io client disconnect') return;
    state.rejoinRoom = state.voice || state.joiningRoom;
    state.voiceResumeId++;
    for (const id of [...state.peers.keys()]) closePeer(id);
    state.peerFailures.clear();
    for (const id of [...state.meters.keys()]) stopWatching(id);
    state.pendingSignals.length = 0;
    state.speakingLevels.clear(); state.remoteSpeaking.clear();
    updateVoiceUi();
    notify(state.rejoinRoom ? 'Conexão interrompida. Reconectando à sala de voz...' : 'Conexão com o servidor interrompida. Reconectando...');
    if (reason === 'io server disconnect') socket.connect();
  });
  socket.on('presence', count => { $('online-count').textContent = `${count} online`; });
  socket.on('message:new', message => {
    if (message.profileId) state.avatars[message.profileId] = message.avatar;
    (state.messages[message.channel] ||= []).push(message);
    state.messages[message.channel] = state.messages[message.channel].slice(-200);
    appendMessage(message);
  });
  socket.on('message:updated', ({ channel, id, content, editedAt }) => {
    const message = state.messages[channel]?.find(item => item.id === id);
    if (!message) return;
    message.content = content; message.editedAt = editedAt;
    if (state.channel === channel) renderMessages();
  });
  socket.on('message:deleted', ({ channel, id }) => {
    if (!state.messages[channel]) return;
    state.messages[channel] = state.messages[channel].filter(item => item.id !== id);
    if (state.channel === channel) renderMessages();
  });
  socket.on('profile:updated', ({ id, profileId, avatar }) => {
    if (profileId) state.avatars[profileId] = avatar;
    if (id === socket.id) {
      state.avatar = avatar;
      setAvatar($('profile-avatar'), avatar, state.name);
      setAvatar($('settings-avatar'), avatar, state.name);
    }
    const changed = Object.values(state.messages).some(items => items.some(message => message.profileId === profileId));
    if (changed) renderMessages();
  });
  socket.on('voice:roster', roster => {
    state.roster = roster;
    for (const [id] of state.peers) {
      const member = (roster[state.voice] || []).find(person => person.id === id);
      if (member && !member.sharing) hideStream(id);
      if (member && !member.cameraStreamId) hideStream(id, 'camera');
      for (const stream of state.videoStreams.get(id)?.values() || []) renderRemoteVideo(id, stream);
    }
    renderChannels();
  });
  socket.on('voice:peer-joined', ({ id }) => { if (state.voice) createPeer(id); });
  socket.on('voice:peer-left', ({ id }) => { closePeer(id); state.peerFailures.delete(id); });
  socket.on('voice:speaking', ({ id, speaking }) => {
    state.remoteSpeaking.set(id, speaking);
    refreshSpeakingUi();
  });
  socket.on('rtc:signal', receiveSignal);
}

$('connect-btn').onclick = () => connect($('url-input').value.trim(), $('name-input').value.trim(), $('code-input').value);
$('host-btn').onclick = async () => {
  try {
    const details = await orbita.host();
    state.hostInvite = details.invite;
    $('url-input').value = details.url;
    $('code-input').value = details.code;
    if (!$('name-input').value.trim()) $('name-input').focus();
    else connect(details.url, $('name-input').value.trim(), details.code);
    notify(`Servidor criado. Convide usando ${details.invite} e o código ${details.code}`);
  } catch (error) { $('login-error').textContent = error.message; }
};
$('message-form').onsubmit = async event => {
  event.preventDefault();
  const input = $('message-input');
  const content = input.value.trim();
  const selected = state.pendingFile;
  if (!content && !selected) return;
  if (selected && selected.size > state.fileLimitMb * 1024 * 1024) return notify(`O limite atual é ${state.fileLimitMb} MB.`);
  try {
    $('message-form').querySelector('[type="submit"]').disabled = true;
    const attachment = selected ? { name: selected.name, mime: selected.type || 'application/octet-stream', data: new Uint8Array(await selected.arrayBuffer()) } : undefined;
    const result = await emitAck('message:send', { channel: state.channel, content, attachment });
    if (!result.ok) throw new Error(result.error);
    input.value = '';
    if (state.pendingFile === selected) { state.pendingFile = null; $('file-input').value = ''; renderAttachmentPreview(); }
  } catch (error) { notify(error.message); }
  finally { $('message-form').querySelector('[type="submit"]').disabled = false; }
};
$('attachment-btn').onclick = () => $('file-input').click();
$('file-input').onchange = () => {
  const file = $('file-input').files[0];
  if (!file) return;
  if (file.size < 1 || file.size > state.fileLimitMb * 1024 * 1024) {
    $('file-input').value = '';
    return notify(`Escolha um arquivo de até ${state.fileLimitMb} MB.`);
  }
  state.pendingFile = file;
  renderAttachmentPreview();
};
function renderAttachmentPreview() {
  const box = $('attachment-preview'); box.replaceChildren();
  box.classList.toggle('hidden', !state.pendingFile);
  if (!state.pendingFile) return;
  box.append(icon('paperclip'), make('span', '', `${state.pendingFile.name} · ${formatSize(state.pendingFile.size)}`));
  const remove = make('button', '', '×'); remove.title = 'Remover anexo';
  remove.onclick = () => { state.pendingFile = null; $('file-input').value = ''; renderAttachmentPreview(); };
  box.append(remove);
}
$('settings-btn').onclick = () => {
  if (state.view === 'settings') return;
  state.previousView = state.view;
  state.view = 'settings';
  renderChannels(); renderView();
};
$('settings-back').onclick = () => {
  state.view = state.previousView === 'voice' && !state.voice ? 'text' : state.previousView;
  renderChannels(); renderView();
};
$('file-limit').onchange = () => {
  const value = Number($('file-limit').value);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    $('file-limit').value = state.fileLimitMb;
    return notify('Escolha um limite entre 1 e 100 MB.');
  }
  state.fileLimitMb = value;
  localStorage.setItem('orbita-file-limit', String(value));
  $('attachment-btn').title = `Anexar arquivo (até ${value} MB)`;
  if (state.pendingFile && state.pendingFile.size > value * 1024 * 1024) {
    state.pendingFile = null; $('file-input').value = ''; renderAttachmentPreview();
  }
  notify(`Limite de envio ajustado para ${value} MB.`);
};
const ACCENT_PRESETS = { violet: '#8171f1', ocean: '#4b9ce7', rose: '#df75a3' };
const validAccentColor = color => /^#[0-9a-f]{6}$/i.test(color || '');
function applyAppearance() {
  const root = document.documentElement;
  root.classList.toggle('theme-light', state.theme === 'light');
  root.classList.toggle('accent-ocean', state.accent === 'ocean');
  root.classList.toggle('accent-rose', state.accent === 'rose');
  const color = state.accent === 'custom' ? state.accentColor : ACCENT_PRESETS[state.accent];
  const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  // O texto dos botões continua legível mesmo com cores muito claras ou escuras.
  const luminance = [r, g, b].reduce((sum, value, i) => {
    const channel = value / 255;
    return sum + (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i];
  }, 0);
  root.style.setProperty('--accent', color);
  root.style.setProperty('--accent-contrast', luminance > 0.179 ? '#17202c' : '#ffffff');
  root.style.setProperty('--accent-icon-filter', luminance > 0.179 ? 'invert(0%)' : 'invert(100%)');
  $('theme-select').value = state.theme;
  $('accent-select').value = state.accent;
  $('accent-color').value = state.accentColor;
  $('accent-hex').value = state.accentColor.toUpperCase();
}
$('theme-select').onchange = () => {
  state.theme = $('theme-select').value === 'light' ? 'light' : 'dark';
  localStorage.setItem('orbita-theme', state.theme);
  applyAppearance();
};
$('accent-select').onchange = () => {
  const accent = $('accent-select').value;
  if (accent !== 'custom' && !Object.hasOwn(ACCENT_PRESETS, accent)) return;
  state.accent = accent;
  localStorage.setItem('orbita-accent', accent);
  applyAppearance();
};
function chooseCustomAccent(color) {
  if (!validAccentColor(color)) return false;
  state.accentColor = color.toLowerCase();
  state.accent = 'custom';
  localStorage.setItem('orbita-accent-color', state.accentColor);
  localStorage.setItem('orbita-accent', 'custom');
  applyAppearance();
  return true;
}
$('accent-color').oninput = () => chooseCustomAccent($('accent-color').value);
$('accent-hex').onchange = () => {
  if (!chooseCustomAccent($('accent-hex').value.trim())) $('accent-hex').value = state.accentColor.toUpperCase();
};
$('share-quality').onchange = async () => {
  const quality = $('share-quality').value;
  if (!Object.hasOwn(SCREEN_PRESETS, quality)) return;
  state.shareQuality = quality;
  localStorage.setItem('orbita-share-quality', quality);
  if (state.screen) {
    await applyScreenQuality();
    notify('Qualidade da transmissão atualizada.');
  }
};
$('avatar-choose').onclick = () => $('avatar-input').click();
$('avatar-input').onchange = async () => {
  const file = $('avatar-input').files[0];
  if (!file) return;
  try {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024)
      throw new Error('Escolha uma imagem PNG, JPG ou WebP de até 10 MB.');
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const side = Math.min(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
    bitmap.close();
    const avatar = canvas.toDataURL('image/jpeg', 0.78);
    const result = await emitAck('profile:update', { avatar });
    if (!result.ok) throw new Error(result.error);
    notify('Foto atualizada.');
  } catch (error) { notify(error.message || 'Não foi possível atualizar a foto.'); }
  finally { $('avatar-input').value = ''; }
};
$('avatar-remove').onclick = async () => {
  try {
    const result = await emitAck('profile:update', { avatar: null });
    if (!result.ok) throw new Error(result.error);
    notify('Foto removida.');
  } catch (error) { notify(error.message || 'Não foi possível remover a foto.'); }
};
$('disconnect-btn').onclick = leaveVoice;
$('leave-call-btn').onclick = leaveVoice;
$('share-btn').onclick = chooseSource;
$('camera-btn').onclick = toggleCamera;
$('camera-filter').onchange = () => changeCameraFilter($('camera-filter').value);
$('camera-resolution').onchange = async () => {
  const resolution = $('camera-resolution').value;
  if (!Object.hasOwn(CAMERA_RESOLUTIONS, resolution)) return;
  state.cameraResolution = resolution;
  localStorage.setItem('orbita-camera-resolution', resolution);
  await applyCameraQuality();
};
$('camera-fps').onchange = async () => {
  const fps = Number($('camera-fps').value);
  if (!CAMERA_FRAME_RATES.includes(fps)) return;
  state.cameraFps = fps;
  localStorage.setItem('orbita-camera-fps', String(fps));
  await applyCameraQuality();
};
$('camera-device').onchange = async () => {
  state.cameraDevice = $('camera-device').value;
  localStorage.setItem('orbita-camera-device', state.cameraDevice);
  if (state.camera) { stopCamera(); await toggleCamera(); }
};
$('mute-btn').onclick = () => {
  state.muted = !state.muted;
  state.mic?.getAudioTracks().forEach(track => { track.enabled = !state.muted; });
  state.socket.emit('voice:state', { muted: state.muted });
  updateVoiceUi();
};
$('deafen-btn').onclick = () => {
  state.deafened = !state.deafened;
  document.querySelectorAll('audio[data-audio-peer-id]').forEach(audio => { audio.muted = state.deafened; });
  updateVoiceUi();
};
$('leave-server').onclick = () => {
  if (state.voice) leaveVoice();
  state.rejoinRoom = null;
  state.voiceResumeId++;
  const socket = state.socket;
  state.socket = null;
  localStorage.removeItem('orbita-connection');
  $('connect-btn').disabled = false;
  $('connect-btn').firstChild.textContent = 'Entrar no servidor ';
  socket?.disconnect();
  for (const id of [...state.popoutPeers.keys()]) hideStream(id);
  state.view = 'text';
  $('app').classList.add('hidden'); $('login').classList.remove('hidden');
};
$('check-update').onclick = () => checkUpdates(true);
$('update-dismiss').onclick = () => $('update-banner').classList.add('hidden');
$('update-download').onclick = async () => {
  try { if (!await orbita.openUpdate()) notify('Não foi possível abrir a atualização.'); }
  catch { notify('Não foi possível abrir a atualização.'); }
};
document.querySelector('.server-heading').onclick = async () => {
  const invite = state.hostInvite || state.serverUrl;
  const info = `Endereço: ${invite}\nCódigo: ${state.code}`;
  try { await navigator.clipboard.writeText(info); notify('Endereço e código copiados para convidar alguém.'); }
  catch { notify(info.replace('\n', ' · ')); }
};
let savedConnection;
try {
  let identity = localStorage.getItem('orbita-identity');
  if (!identity || !/^[a-f0-9]{64}$/.test(identity)) {
    identity = [...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('orbita-identity', identity);
  }
  state.identity = identity;
  const saved = JSON.parse(localStorage.getItem('orbita-connection') || '{}');
  savedConnection = saved;
  $('name-input').value = saved.name || '';
  $('url-input').value = saved.url || '';
  $('code-input').value = saved.code || '';
  const limit = Number(localStorage.getItem('orbita-file-limit'));
  if (Number.isInteger(limit) && limit >= 1 && limit <= 100) state.fileLimitMb = limit;
  state.theme = localStorage.getItem('orbita-theme') === 'light' ? 'light' : 'dark';
  const savedAccent = localStorage.getItem('orbita-accent');
  if (savedAccent === 'custom' || Object.hasOwn(ACCENT_PRESETS, savedAccent)) state.accent = savedAccent;
  const savedColor = localStorage.getItem('orbita-accent-color');
  if (validAccentColor(savedColor)) state.accentColor = savedColor.toLowerCase();
  const quality = localStorage.getItem('orbita-share-quality');
  if (Object.hasOwn(SCREEN_PRESETS, quality)) state.shareQuality = quality;
  const cameraFilter = localStorage.getItem('orbita-camera-filter');
  if (Object.hasOwn(CAMERA_FILTERS, cameraFilter)) state.cameraFilter = cameraFilter;
  const cameraResolution = localStorage.getItem('orbita-camera-resolution');
  if (Object.hasOwn(CAMERA_RESOLUTIONS, cameraResolution)) state.cameraResolution = cameraResolution;
  const cameraFps = Number(localStorage.getItem('orbita-camera-fps'));
  if (CAMERA_FRAME_RATES.includes(cameraFps)) state.cameraFps = cameraFps;
  state.cameraDevice = localStorage.getItem('orbita-camera-device') || '';
  const volumes = JSON.parse(localStorage.getItem('orbita-volumes') || '{}');
  if (volumes && typeof volumes === 'object' && !Array.isArray(volumes)) state.volumes = volumes;
} catch { /* Sem conexão anterior. */ }
$('file-limit').value = state.fileLimitMb;
$('attachment-btn').title = `Anexar arquivo (até ${state.fileLimitMb} MB)`;
applyAppearance();
$('share-quality').value = state.shareQuality;
$('camera-filter').value = state.cameraFilter;
$('camera-resolution').value = state.cameraResolution;
$('camera-fps').value = String(state.cameraFps);
listCameras();
if (!orbita.canShareSystemAudio) {
  $('share-audio').disabled = true;
  $('share-audio-note').textContent = 'Áudio do computador disponível no Windows.';
}
if (savedConnection?.url && savedConnection?.name && savedConnection?.code)
  connect(savedConnection.url, savedConnection.name, savedConnection.code);
checkUpdates();
