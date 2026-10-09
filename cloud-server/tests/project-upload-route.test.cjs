'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createProjectUploadHandlers } = require('../project-upload-route');

test('PROJECT multipart route checks a beat capability before parsing and limits received bytes', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-project-http-'));
  const app = express();
  let uploaded = 0;
  let access = true;
  app.post('/transport/project/upload', ...createProjectUploadHandlers({
    tempDir,
    authenticate: () => ({ user: { id: 'user-a' }, account: { chatId: 'chat-a' } }),
    async verifyCapability(req) {
      assert.equal(req.body.kind, 'commit_import');
      assert.deepEqual(req.body.scope, { objectType: 'beat', objectIds: ['beat-a'] });
      assert.equal(req.body.operationId, 'operation-a');
    },
    async authorizeProject() {
      if (!access) throw Object.assign(new Error('Free cannot upload PROJECT.'),
        { status: 403, code: 'PROJECT_UPLOAD_DENIED' });
      return { maxBytes: 4 };
    },
    async uploadProject(input) {
      assert.equal(input.userId, 'user-a');
      assert.equal(input.beatId, 'beat-a');
      assert.equal(input.chatId, 'chat-a');
      uploaded += 1;
      return { messageId: 123, bytes: fs.statSync(input.filePath).size };
    },
    storageChatId: account => account.chatId,
  }));
  app.use((error, _req, res, _next) => res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 500)
    .json({ code: error.code }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/transport/project/upload`;
  async function send(size) {
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(size)]), 'renamed.mp3');
    return fetch(url, { method: 'POST', headers: {
      'X-BeatGaler-Project-Beat': 'beat-a',
      'X-BeatGaler-Project-Kind': 'commit_import',
      'X-BeatGaler-Project-Operation': 'operation-a',
      'X-BeatGaler-Project-Session': 'session-a',
      'X-BeatGaler-Project-Generation': '1',
    }, body: form });
  }
  try {
    const exact = await send(4);
    assert.equal(exact.status, 200);
    assert.equal((await exact.json()).original_size, 4);
    assert.equal(uploaded, 1);
    const tooLarge = await send(5);
    assert.equal(tooLarge.status, 413);
    assert.equal(uploaded, 1);
    access = false;
    const free = await send(2);
    assert.equal(free.status, 403);
    assert.equal((await free.json()).code, 'PROJECT_UPLOAD_DENIED');
    assert.equal(uploaded, 1);
    assert.deepEqual(fs.readdirSync(tempDir), []);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
