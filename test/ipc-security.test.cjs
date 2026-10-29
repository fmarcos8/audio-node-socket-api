const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isTrustedSender } = require('../electron/ipc-security.cjs');

test('IPC aceita somente a janela e o frame principal', () => {
  const mainFrame = {};
  const contents = { mainFrame, isDestroyed: () => false };
  assert.equal(isTrustedSender({ sender: contents, senderFrame: mainFrame }, contents), true);
  assert.equal(isTrustedSender({ sender: contents, senderFrame: {} }, contents), false);
  assert.equal(isTrustedSender({ sender: {}, senderFrame: mainFrame }, contents), false);
  assert.equal(isTrustedSender({ sender: contents, senderFrame: mainFrame }, { ...contents, isDestroyed: () => true }), false);
});
