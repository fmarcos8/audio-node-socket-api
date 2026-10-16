const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkForUpdates, isNewerVersion } = require('../electron/updates.cjs');

const asset = url => ({ name: 'Orbita-Setup-0.3.3.exe', browser_download_url: url });
const download = 'https://github.com/fmarcos8/audio-node-socket-api/releases/download/v0.3.3/Orbita-Setup-0.3.3.exe';
const release = (tag, assets = [asset(download)]) => ({
  status: 200, ok: true, json: async () => ({ tag_name: tag, assets })
});

test('compara as versões numericamente e avisa somente quando há instalador novo', async () => {
  assert.equal(isNewerVersion('v0.3.10', '0.3.9'), true);
  assert.equal(isNewerVersion('v0.3.2', '0.3.3'), false);
  assert.equal(isNewerVersion('invalid', '0.3.2'), false);
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/fmarcos8/audio-node-socket-api/releases/latest');
    assert.equal(options.headers.Accept, 'application/vnd.github+json');
    return release('v0.3.3');
  };
  assert.deepEqual(await checkForUpdates('0.3.2', { fetchImpl, platform: 'win32' }),
    { status: 'available', version: '0.3.3', url: download });
  assert.deepEqual(await checkForUpdates('0.3.3', { fetchImpl, platform: 'win32' }), { status: 'current' });
});

test('sem Release ou instalador, não indica atualização baixável', async () => {
  assert.deepEqual(await checkForUpdates('0.3.2', {
    fetchImpl: async () => ({ status: 404 }), platform: 'win32'
  }), { status: 'no-release' });
  assert.deepEqual(await checkForUpdates('0.3.2', {
    fetchImpl: async () => release('v0.3.3', []), platform: 'win32'
  }), { status: 'no-installer' });
  await assert.rejects(checkForUpdates('0.3.2', {
    fetchImpl: async () => release('v0.3.3', [asset('https://outro.exemplo/setup.exe')]), platform: 'win32'
  }), /inválido/);
});
