const REPOSITORY = 'fmarcos8/audio-node-socket-api';
const LATEST_RELEASE = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;

function versionParts(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version || '');
  return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(candidate, installed) {
  const next = versionParts(candidate);
  const current = versionParts(installed);
  if (!next || !current) return false;
  for (let i = 0; i < 3; i++) {
    if (next[i] !== current[i]) return next[i] > current[i];
  }
  return false;
}

async function checkForUpdates(installedVersion, { fetchImpl = fetch, platform = process.platform } = {}) {
  const response = await fetchImpl(LATEST_RELEASE, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Orbita-Desktop' },
    signal: AbortSignal.timeout(8000), cache: 'no-store'
  });
  if (response.status === 404) return { status: 'no-release' };
  if (!response.ok) throw new Error(`GitHub respondeu HTTP ${response.status}`);

  const release = await response.json();
  if (!isNewerVersion(release.tag_name, installedVersion)) return { status: 'current' };
  const extension = platform === 'win32' ? '.exe' : platform === 'linux' ? '.AppImage' : null;
  if (!extension) return { status: 'unsupported' };
  const asset = release.assets?.find(item => typeof item.name === 'string' && item.name.endsWith(extension));
  if (!asset?.browser_download_url) return { status: 'no-installer' };

  const download = new URL(asset.browser_download_url);
  if (download.protocol !== 'https:' || download.host !== 'github.com' ||
      !download.pathname.startsWith(`/${REPOSITORY}/releases/download/`))
    throw new Error('Endereço da atualização inválido.');
  return { status: 'available', version: release.tag_name.replace(/^v/, ''), url: download.href };
}

module.exports = { checkForUpdates, isNewerVersion };
