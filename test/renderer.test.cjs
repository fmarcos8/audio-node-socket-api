const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { webcrypto } = require('node:crypto');
const vm = require('node:vm');

test('navegação, miniatura da tela em janela separada e configurações', async () => {
  const { Window } = await import('happy-dom');
  const window = new Window({ url: 'http://localhost' });
  window.document.write(readFileSync(join(__dirname, '../renderer/index.html'), 'utf8'));
  const stylesheet = window.document.createElement('style');
  stylesheet.textContent = readFileSync(join(__dirname, '../renderer/style.css'), 'utf8');
  window.document.head.append(stylesheet);
  window.HTMLVideoElement.prototype.play = async function () { this.playCalled = true; };
  const context = vm.createContext({
    document: window.document, window, localStorage: window.localStorage,
    crypto: webcrypto, Intl, URL, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    io: () => { throw new Error('Conexão inesperada'); }, orbita: { openStream: async id => { context.openedStream = id; return true; } }
  });
  vm.runInContext(readFileSync(join(__dirname, '../renderer/app.js'), 'utf8'), context);
  vm.runInContext(`
    state.socket = { id: 'eu' };
    state.channels = [{ id: 'geral', name: 'geral' }];
    state.voices = [{ id: 'sala-geral', name: 'Sala geral' }];
    state.roster = { 'sala-geral': [{ id: 'eu', name: 'Ana', sharing: false, muted: false }, { id: 'outro', profileId: 'bia-perfil', name: 'Bia', sharing: true, muted: false }] };
    state.voice = 'sala-geral'; state.view = 'voice';
    renderChannels(); renderView();
  `, context);
  const $ = id => window.document.getElementById(id);
  assert.equal($('messages').classList.contains('hidden'), true);
  assert.equal($('message-form').classList.contains('hidden'), true);
  assert.equal($('voice-stage').classList.contains('hidden'), false);
  assert.equal($('channel-title').textContent, 'Sala geral');
  const slider = window.document.querySelector('.voice-tile[data-peer-id="outro"] input[type="range"]');
  assert.equal(slider.value, '100');
  const remoteAudio = window.document.createElement('audio');
  remoteAudio.dataset.audioPeerId = 'outro'; window.document.body.append(remoteAudio);
  slider.value = '35'; slider.oninput();
  assert.equal(remoteAudio.volume, 0.35);
  assert.equal(JSON.parse(window.localStorage.getItem('orbita-volumes'))[':bia-perfil'], 35);
  vm.runInContext('renderVoiceStage()', context);
  assert.equal(window.document.querySelector('.voice-tile[data-peer-id="outro"] input').value, '35');
  remoteAudio.remove();

  context.fakeStream = new window.MediaStream();
  vm.runInContext(`state.remoteSpeaking.set('outro', true); refreshSpeakingUi(); showStream('outro', fakeStream);`, context);
  assert.equal(window.document.querySelector('.voice-tile[data-peer-id="outro"]').classList.contains('speaking'), true);
  assert.equal($('stream-outro').querySelector('video').playCalled, true);
  const maximize = $('stream-outro').querySelector('.stream-maximize');
  maximize.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(context.openedStream, 'outro');
  assert.equal($('stream-outro').classList.contains('expanded'), false);

  $('settings-btn').click();
  assert.equal($('settings-view').classList.contains('hidden'), false);
  assert.equal(window.getComputedStyle($('app')).maxWidth, '');
  assert.equal(window.getComputedStyle($('settings-view')).maxWidth, '930px');
  assert.equal(window.getComputedStyle($('settings-view')).overflow, 'auto');
  assert.equal($('voice-stage').classList.contains('hidden'), true);
  $('file-limit').value = '100'; $('file-limit').onchange();
  assert.equal(window.localStorage.getItem('orbita-file-limit'), '100');
  $('accent-select').value = 'ocean'; $('accent-select').onchange();
  assert.equal(window.document.documentElement.classList.contains('accent-ocean'), true);
  assert.equal(window.localStorage.getItem('orbita-accent'), 'ocean');
  $('theme-select').value = 'light'; $('theme-select').onchange();
  assert.equal(window.document.documentElement.classList.contains('theme-light'), true);
  assert.equal(window.localStorage.getItem('orbita-theme'), 'light');
  $('accent-color').value = '#ffff00'; $('accent-color').oninput();
  assert.equal($('accent-select').value, 'custom');
  assert.equal(window.document.documentElement.style.getPropertyValue('--accent'), '#ffff00');
  assert.equal(window.document.documentElement.style.getPropertyValue('--accent-contrast'), '#17202c');
  assert.equal(window.localStorage.getItem('orbita-accent-color'), '#ffff00');
  $('accent-hex').value = '#080808'; $('accent-hex').onchange();
  assert.equal(window.document.documentElement.style.getPropertyValue('--accent-contrast'), '#ffffff');
  $('accent-hex').value = 'invalida'; $('accent-hex').onchange();
  assert.equal($('accent-hex').value, '#080808');
  $('theme-select').value = 'dark'; $('theme-select').onchange();
  assert.equal(window.document.documentElement.classList.contains('theme-light'), false);
  context.videoTrack = {
    kind: 'video', getSettings: () => ({ width: 1920, height: 1080 }),
    applyConstraints: async constraints => { context.captureLimits = constraints; }, stop: () => {}
  };
  context.videoSender = {
    track: context.videoTrack, getParameters: () => ({ encodings: [{}] }),
    setParameters: async params => { context.encodingLimits = params.encodings[0]; }
  };
  vm.runInContext(`state.screen = { getVideoTracks: () => [videoTrack] }; state.peers.set('teste', { pc: { getSenders: () => [videoSender] } });`, context);
  await vm.runInContext('applyScreenQuality()', context);
  assert.equal(context.captureLimits.width.max, 1280);
  assert.equal(context.captureLimits.frameRate.max, 15);
  assert.equal(context.encodingLimits.maxBitrate, 1500000);
  assert.equal(context.encodingLimits.scaleResolutionDownBy, 1.5);
  $('share-quality').value = 'balanced'; await $('share-quality').onchange();
  assert.equal(context.captureLimits.frameRate.max, 25);
  assert.equal(context.encodingLimits.maxBitrate, 2500000);
  assert.equal(window.localStorage.getItem('orbita-share-quality'), 'balanced');
  context.orbita.selectSource = async () => true;
  context.orbita.canShareSystemAudio = true;
  $('share-audio').checked = true;
  context.audioTrack = { kind: 'audio', id: 'system-audio', stop: () => {} };
  context.captureStream = new window.MediaStream();
  context.captureStream.getVideoTracks = () => [context.videoTrack];
  context.captureStream.getAudioTracks = () => [context.audioTrack];
  context.captureStream.getTracks = () => [context.videoTrack, context.audioTrack];
  context.navigator = { mediaDevices: { getDisplayMedia: async options => {
    context.captureRequest = options;
    return context.captureStream;
  } } };
  context.addedTracks = [];
  context.capturePeer = { pc: {
    getSenders: () => [], addTrack: track => { context.addedTracks.push(track); return context.videoSender; }
  } };
  vm.runInContext(`state.peers.clear(); state.peers.set('outro', capturePeer); state.screen = null; state.socket.emit = () => {};`, context);
  await vm.runInContext('startShare("screen:1")', context);
  assert.equal(context.captureRequest.video.frameRate.max, 25);
  assert.equal(context.captureRequest.audio, true);
  assert.deepEqual(context.addedTracks, [context.videoTrack, context.audioTrack]);
  assert.ok($('stream-self'), $('toast').textContent);
  assert.equal($('stream-self').querySelector('video').playCalled, true);
  context.RTCPeerConnection = class {
    constructor() { this.added = []; this.connectionState = 'new'; }
    addTrack(track) { this.added.push(track); return context.videoSender; }
    getSenders() { return []; }
    restartIce() { this.restartCalls = (this.restartCalls || 0) + 1; }
    close() {}
  };
  context.MediaStream = window.MediaStream;
  window.HTMLAudioElement.prototype.play = async function () { this.playCalled = true; };
  vm.runInContext(`state.meters.set('outro', {
    source: { disconnect: () => {} }, analyser: { getByteTimeDomainData: samples => samples.fill(128) },
    samples: new Uint8Array(512)
  });`, context);
  vm.runInContext(`state.peers.clear(); createPeer('outro');`, context);
  assert.deepEqual(vm.runInContext(`state.peers.get('outro').pc.added`, context), [context.videoTrack, context.audioTrack]);
  context.voiceTrack = { kind: 'audio', id: 'voice-track' };
  vm.runInContext(`state.peers.get('outro').pc.ontrack({ track: voiceTrack });
    state.peers.get('outro').pc.ontrack({ track: audioTrack });`, context);
  const audioElements = [...window.document.querySelectorAll('audio[data-audio-peer-id="outro"]')];
  assert.equal(audioElements.length, 2);
  assert.ok(audioElements.every(audio => audio.volume === 0.35));
  context.voiceTrack.onended();
  assert.equal(window.document.querySelectorAll('audio[data-audio-peer-id="outro"]').length, 1);
  const peerPc = vm.runInContext("state.peers.get('outro').pc", context);
  vm.runInContext('state.socket.connected = true', context);
  peerPc.connectionState = 'failed'; peerPc.onconnectionstatechange();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(peerPc.restartCalls, 1);
  peerPc.connectionState = 'connected'; peerPc.onconnectionstatechange();
  $('settings-back').click();
  assert.equal($('voice-stage').classList.contains('hidden'), false);

  $('text-channels').querySelector('button').click();
  assert.equal($('messages').classList.contains('hidden'), false);
  assert.equal($('voice-stage').classList.contains('hidden'), true);
  assert.equal($('channel-title').textContent, 'geral');
  vm.runInContext(`state.view = 'voice'; renderChannels(); renderView();`, context);
  assert.equal($('stream-outro').classList.contains('hidden'), false);
  context.mediaStream = { getAudioTracks: () => [], getTracks: () => [] };
  context.joinCalls = 0;
  context.navigator.mediaDevices.getUserMedia = async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return context.mediaStream;
  };
  vm.runInContext(`state.voice = null; state.screen = null; state.peers.clear(); state.socket = {
    id: 'eu', connected: true,
    timeout: () => ({ emit: (_event, _room, reply) => { joinCalls++; reply(null, { ok: true, peers: [] }); } }),
    emit: () => {}
  };`, context);
  await Promise.all([vm.runInContext('joinVoice("sala-geral")', context), vm.runInContext('joinVoice("sala-geral")', context)]);
  assert.equal(context.joinCalls, 1);
  context.rawCameraTrack = { kind: 'video', getSettings: () => ({ width: 640, height: 360 }), stop: () => { context.cameraStopped = true; } };
  context.filteredTrack = { kind: 'video', stop: () => {} };
  context.cameraSource = { getVideoTracks: () => [context.rawCameraTrack], getTracks: () => [context.rawCameraTrack] };
  context.navigator.mediaDevices.getUserMedia = async () => context.cameraSource;
  context.navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'videoinput', deviceId: 'cam-1', label: 'Webcam USB' }];
  context.MediaStream = class {
    constructor(tracks, id = 'camera-stream') { this.tracks = tracks; this.id = id; }
    getVideoTracks() { return this.tracks; }
    getTracks() { return this.tracks; }
    removeTrack(track) { this.tracks = this.tracks.filter(item => item !== track); }
    addTrack(track) { this.tracks.push(track); }
  };
  Object.defineProperty(window.HTMLVideoElement.prototype, 'srcObject', {
    configurable: true, get() { return this.testStream || null; }, set(stream) { this.testStream = stream; }
  });
  context.cameraSender = { track: context.rawCameraTrack, replaceTrack: async track => { context.cameraSender.track = track; } };
  context.cameraPeer = { pc: { addTrack: () => context.cameraSender, getSenders: () => [context.cameraSender], removeTrack: () => {} } };
  window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage: () => {}, filter: 'none' });
  window.HTMLCanvasElement.prototype.captureStream = () => ({ getVideoTracks: () => [context.filteredTrack] });
  vm.runInContext(`state.peers.clear(); state.peers.set('outro', cameraPeer);`, context);
  await vm.runInContext('toggleCamera()', context);
  assert.ok($('camera-self'), $('toast').textContent);
  assert.equal($('camera-btn').getAttribute('aria-pressed'), 'true');
  $('camera-filter').value = 'sepia'; await $('camera-filter').onchange();
  assert.equal(context.cameraSender.track, context.filteredTrack);
  assert.equal(window.localStorage.getItem('orbita-camera-filter'), 'sepia');
  context.remoteCamera = new context.MediaStream([context.filteredTrack]);
  context.remoteScreen = new context.MediaStream([context.videoTrack], 'screen-stream');
  vm.runInContext(`state.roster['sala-geral'] = [
    { id: 'eu', name: 'Ana' },
    { id: 'outro', name: 'Bia', cameraStreamId: 'camera-stream', sharing: true }
  ]; renderRemoteVideo('outro', remoteCamera); renderRemoteVideo('outro', remoteScreen);`, context);
  assert.ok($('camera-outro'));
  assert.equal($('stream-outro').querySelector('video').srcObject, context.remoteScreen);
  vm.runInContext('stopCamera()', context);
  assert.equal($('camera-self'), null);
  assert.equal(context.cameraStopped, true);
  await window.happyDOM.abort();
});

test('queda temporária restaura a sala de voz sem encerrar microfone e transmissão', async () => {
  const { Window } = await import('happy-dom');
  const window = new Window({ url: 'http://localhost' });
  window.document.write(readFileSync(join(__dirname, '../renderer/index.html'), 'utf8'));
  const events = new Map();
  const emitted = [];
  const socket = {
    id: 'antigo', connected: true,
    on: (event, handler) => { events.set(event, handler); },
    timeout: () => ({ emit: (event, room, reply) => { emitted.push([event, room]); reply(null, { ok: true, peers: [] }); } }),
    emit: (event, data) => emitted.push([event, data]),
    connect: () => {}, disconnect: () => {}
  };
  let micStopped = 0;
  let screenStopped = 0;
  const context = vm.createContext({
    document: window.document, window, localStorage: window.localStorage,
    crypto: webcrypto, Intl, URL, console, setTimeout, clearTimeout, setInterval, clearInterval,
    io: (_url, options) => { context.socketOptions = options; return socket; }, orbita: {}
  });
  vm.runInContext(readFileSync(join(__dirname, '../renderer/app.js'), 'utf8'), context);
  const init = () => events.get('init')({
    channels: [{ id: 'geral', name: 'geral' }], voices: [{ id: 'sala-geral', name: 'Sala geral' }],
    messages: { geral: [] }, roster: { 'sala-geral': [] }, iceServers: []
  });
  vm.runInContext("connect('https://chat.exemplo.test', 'Ana', 'codigo')", context);
  init();
  context.microphone = { getTracks: () => [{ stop: () => { micStopped++; } }], getAudioTracks: () => [] };
  context.screenStream = { getTracks: () => [{ stop: () => { screenStopped++; } }] };
  vm.runInContext("state.voice = 'sala-geral'; state.view = 'voice'; state.muted = true; state.mic = microphone; state.screen = screenStream; updateVoiceUi()", context);
  socket.connected = false;
  events.get('disconnect')('transport close');
  assert.equal(vm.runInContext('state.voice', context), 'sala-geral');
  assert.equal(vm.runInContext('state.rejoinRoom', context), 'sala-geral');
  assert.match(window.document.querySelector('.call-status').textContent, /RECONECTANDO/);
  assert.equal(micStopped, 0);
  assert.equal(screenStopped, 0);
  assert.equal(emitted.some(([event]) => event === 'voice:leave'), false);

  socket.id = 'novo'; socket.connected = true;
  init();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(context.socketOptions.reconnectionAttempts, Infinity);
  assert.equal(emitted.filter(([event]) => event === 'voice:join').length, 1);
  assert.equal(emitted.find(([event]) => event === 'voice:state')[1].sharing, true);
  assert.equal(emitted.find(([event]) => event === 'voice:state')[1].muted, true);
  assert.equal(vm.runInContext('state.rejoinRoom', context), null);
  assert.equal(vm.runInContext('state.voice', context), 'sala-geral');
  assert.equal(window.document.getElementById('voice-stage').classList.contains('hidden'), false);
  assert.equal(micStopped, 0);
  assert.equal(screenStopped, 0);

  const oldTrack = { readyState: 'ended', stop: () => { micStopped++; } };
  const newTrack = { readyState: 'live', enabled: true, stop: () => { micStopped++; } };
  context.expiredMicrophone = { getAudioTracks: () => [oldTrack], getTracks: () => [oldTrack] };
  context.newMicrophone = { getAudioTracks: () => [newTrack], getTracks: () => [newTrack] };
  context.AudioContext = class {
    resume() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { fftSize: 512, getByteTimeDomainData: samples => samples.fill(128) }; }
    close() { return Promise.resolve(); }
  };
  context.navigator = { mediaDevices: { getUserMedia: async () => context.newMicrophone } };
  vm.runInContext('state.mic = expiredMicrophone', context);
  socket.connected = false;
  events.get('disconnect')('transport close');
  socket.id = 'mais-novo'; socket.connected = true;
  init();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(micStopped, 1);
  assert.equal(newTrack.enabled, false);
  assert.equal(vm.runInContext('state.mic === newMicrophone', context), true);
  assert.equal(emitted.filter(([event]) => event === 'voice:join').length, 2);

  socket.connected = false;
  events.get('disconnect')('transport close');
  vm.runInContext('leaveVoice()', context);
  assert.equal(micStopped, 2);
  assert.equal(screenStopped, 1);
  socket.connected = true;
  init();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(emitted.filter(([event]) => event === 'voice:join').length, 2);
  await window.happyDOM.abort();
});

test('reconecta automaticamente à conexão salva e troca de servidor limpa a sessão', async () => {
  const { Window } = await import('happy-dom');
  const window = new Window({ url: 'http://localhost' });
  window.document.write(readFileSync(join(__dirname, '../renderer/index.html'), 'utf8'));
  window.localStorage.setItem('orbita-connection', JSON.stringify({ url: 'https://chat.exemplo.test', name: 'Ana', code: 'codigo' }));
  window.localStorage.setItem('orbita-theme', 'light');
  window.localStorage.setItem('orbita-accent', 'custom');
  window.localStorage.setItem('orbita-accent-color', '#23aabb');
  let connection;
  let openedUpdate = false;
  const socket = { on: () => {}, disconnect: () => { socket.disconnected = true; } };
  const context = vm.createContext({ document: window.document, window, localStorage: window.localStorage,
    crypto: webcrypto, Intl, URL, console, setTimeout, clearTimeout, setInterval, clearInterval,
    io: (url, options) => { connection = { url, options }; return socket; },
    orbita: { checkUpdates: async () => ({ status: 'available', version: '0.3.3' }),
      openUpdate: async () => { openedUpdate = true; return true; } } });
  vm.runInContext(readFileSync(join(__dirname, '../renderer/app.js'), 'utf8'), context);
  assert.equal(window.document.documentElement.classList.contains('theme-light'), true);
  assert.equal(window.document.getElementById('accent-select').value, 'custom');
  assert.equal(window.document.documentElement.style.getPropertyValue('--accent'), '#23aabb');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(window.document.getElementById('update-banner').classList.contains('hidden'), false);
  assert.match(window.document.getElementById('update-title').textContent, /0\.3\.3/);
  window.document.getElementById('update-download').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(openedUpdate, true);
  assert.equal(connection.url, 'https://chat.exemplo.test');
  assert.equal(connection.options.auth.name, 'Ana');
  assert.equal(connection.options.auth.code, 'codigo');
  window.document.getElementById('leave-server').click();
  assert.equal(socket.disconnected, true);
  assert.equal(window.localStorage.getItem('orbita-connection'), null);
  await window.happyDOM.abort();
});
