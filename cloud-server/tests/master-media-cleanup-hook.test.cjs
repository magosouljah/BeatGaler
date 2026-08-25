'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installDirectMediaCleanupHook } = require('../direct-media-cleanup-hook');

(async () => {
  const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert(
    bootstrap.includes('installDirectMediaCleanupHook({ directTransport })'),
    'Cloud bootstrap must activate the MASTER media cleanup hook.'
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-cleanup-test-'));
  const stateFile = path.join(tempDir, 'transport-pool-state.json');
  const oldManifest = {
    schema: 'beatgaler.telegram.library',
    version: 2,
    beats: [{ id: 'beat-1', master: { telegram_message_id: 111 } }],
    trash: [],
  };
  const newManifest = {
    schema: 'beatgaler.telegram.library',
    version: 2,
    beats: [{ id: 'beat-1', master: { telegram_message_id: 222 } }],
    trash: [],
  };

  let pinnedId = 10;
  const deleted = [];
  const directTransport = {
    async beginOperation(args) {
      fs.writeFileSync(stateFile, JSON.stringify({
        operations: {
          op1: {
            operation_id: 'op1',
            session_id: args.sessionId,
            installation_id: args.installationId,
            chat_id: -100123,
          },
        },
      }));
      return { ok: true, operation_id: 'op1' };
    },
    recordIndexPointer(_chatId, pointer) {
      pinnedId = Number(pointer.messageId);
      return { ok: true };
    },
    async getPinnedMessage() {
      return { message_id: pinnedId };
    },
    async downloadMessageBuffer(_chatId, messageId) {
      return Buffer.from(JSON.stringify(Number(messageId) === 10 ? oldManifest : newManifest));
    },
    async deleteMessages(_chatId, ids) {
      deleted.push(...ids);
      return ids.length;
    },
  };

  const hook = installDirectMediaCleanupHook({
    directTransport,
    stateFile,
    logger: { log() {}, warn() {} },
  });

  await directTransport.beginOperation({
    installationId: 'install-1',
    sessionId: 'session-1',
    generation: 1,
    credentialVersion: 1,
    kind: 'replace_index',
  });

  directTransport.recordIndexPointer(-100123, { messageId: 11, fileId: 'new-index' });
  await hook.flush();

  assert.deepStrictEqual(
    deleted,
    [111],
    'MASTER cleanup must delete only the obsolete media message after the new INDEX commits.'
  );

  console.log('PASS master media cleanup hook');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
