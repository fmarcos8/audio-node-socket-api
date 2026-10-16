/* global streamWindow */
const id = new URLSearchParams(location.search).get('id');
const video = document.querySelector('video');
const status = document.getElementById('status');
const pc = new RTCPeerConnection();
const candidates = [];
pc.ontrack = ({ track }) => {
  if (track.kind !== 'video') return;
  video.srcObject = new MediaStream([track]);
  track.onunmute = () => video.play().catch(console.warn);
  video.play().catch(console.warn);
  status.hidden = true;
};
pc.onicecandidate = ({ candidate }) => { if (candidate) streamWindow.signal(id, { candidate: candidate.toJSON() }); };
pc.onconnectionstatechange = () => {
  if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') status.textContent = 'Transmissão interrompida.';
};
streamWindow.onSignal(async signal => {
  try {
    if (signal.description?.type === 'offer') {
      await pc.setRemoteDescription(signal.description);
      for (const candidate of candidates.splice(0)) await pc.addIceCandidate(candidate);
      await pc.setLocalDescription();
      streamWindow.signal(id, { description: pc.localDescription.toJSON() });
    } else if (signal.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate);
      else candidates.push(signal.candidate);
    }
  } catch (error) { status.textContent = `Falha na transmissão: ${error.message}`; }
});
streamWindow.ready(id);
window.addEventListener('beforeunload', () => pc.close());
