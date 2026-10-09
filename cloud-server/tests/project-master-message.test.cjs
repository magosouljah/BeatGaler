'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Api } = require('telegram');
const { verifyProjectMediaFromClient, copyLegacyProjectPartFromClient,
  directBotAdminRights } = require('../direct-transport-control');

const SHA = 'a'.repeat(64);
const input = { messageId: 101, beatId: 'beat-a', sha256: SHA, documentId: '55', sizeBytes: 3 };
function document(id = 55, size = 3) {
  return new Api.Document({ id, accessHash: 5, fileReference: Buffer.alloc(0), size });
}
function client(doc = document(), caption = `BEATGALER_PROJECT_V1 beat=beat-a sha256=${SHA}`) {
  return { async getMessages(_vault, request) {
    assert.deepEqual(request, { ids: [101] });
    return [{ out: true, message: caption, media: { document: doc } }];
  } };
}

test('MASTER receipt verifies the persisted document identity and measured size', async () => {
  assert.equal(await verifyProjectMediaFromClient(client(), 'vault', input), true);
  await assert.rejects(verifyProjectMediaFromClient(client(document(55, 4)), 'vault', input),
    { code: 'PROJECT_BYTES_UNVERIFIED' });
  await assert.rejects(verifyProjectMediaFromClient(client(document(56)), 'vault', input),
    { code: 'PROJECT_BYTES_UNVERIFIED' });
  await assert.rejects(verifyProjectMediaFromClient(client(document(), 'generic upload'), 'vault', input),
    { code: 'PROJECT_BYTES_UNVERIFIED' });
});

test('legacy PROJECT copy uses the original Telegram document and reuses a MASTER copy on retry', async () => {
  const source = { id: 101, out: false, media: { document: document(55, 300) } };
  const messages = new Map([[101, source]]);
  let sends = 0;
  const fake = {
    async getMessages(_vault, request) { return request.ids.map(id => messages.get(id)); },
    async *iterMessages(_vault, options) {
      for (const message of messages.values()) {
        if (options.search && !String(message.message || '').includes(options.search)) continue;
        yield message;
      }
    },
    async sendFile(_vault, options) {
      assert.equal(options.file, source.media);
      sends += 1;
      const sent = { id: 202, out: true, message: options.caption,
        media: { document: document(55, 300) } };
      messages.set(202, sent);
      return sent;
    },
  };
  const input = { beatId: 'beat-a', sourceMessageId: 101, partIndex: 0 };
  const first = await copyLegacyProjectPartFromClient(fake, 'vault', input);
  assert.deepEqual(first, { sourceMessageId: 101, messageId: 202,
    documentId: '55', sizeBytes: 300, partIndex: 0 });
  const retry = await copyLegacyProjectPartFromClient(fake, 'vault', input);
  assert.equal(retry.messageId, 202);
  assert.equal(sends, 1);
});

test('Direct bot cannot edit, delete or pin MASTER-owned PROJECT and INDEX documents', () => {
  const rights = directBotAdminRights();
  assert.equal(rights.deleteMessages, false);
  assert.equal(rights.editMessages, false);
  assert.equal(rights.pinMessages, false);
});
