function isTrustedSender(event, contents) {
  return !!contents && !contents.isDestroyed() && event?.sender === contents && event.senderFrame === contents.mainFrame;
}

module.exports = { isTrustedSender };
