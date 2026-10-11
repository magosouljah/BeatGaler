#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createProjectUploadHandlers } = require('../project-upload-route');

const PAYLOAD_BYTES = 3 * 1024 * 1024;
const PLAN_MAX_BYTES = 4 * 1024 * 1024;

function waitForEmpty(dir, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      let entries;
      try { entries = fs.readdirSync(dir); }
      catch (error) { return reject(error); }
      if (entries.length === 0) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`PROJECT tempdir did not clean up: ${entries.join(', ')}`));
      setTimeout(check, 20);
    };
    check();
  });
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-step15-project-route-'));
  const app = express();
  let mode = 'success';
  let publishCalls = 0;

  app.post('/transport/project/upload', ...createProjectUploadHandlers({
    tempDir,
    authenticate: () => ({ user: { id: 'step15-user' }, account: { chatId: 'step15-vault' } }),
    async verifyCapability(req) {
      if (req.body.operationId !== 'step15-operation' || req.body.beatId !== 'step15-beat') {
        throw Object.assign(new Error('Unexpected smoke capability.'), { status: 403, code: 'SMOKE_CAPABILITY_MISMATCH' });
      }
    },
    async authorizeProject() {
      return { maxBytes: PLAN_MAX_BYTES };
    },
    async uploadProject(input) {
      publishCalls += 1;
      const bytes = fs.statSync(input.filePath).size;
      if (bytes !== PAYLOAD_BYTES) throw new Error(`Expected ${PAYLOAD_BYTES} bytes, got ${bytes}.`);
      if (mode === 'fail') {
        throw Object.assign(new Error('Simulated MASTER publication failure.'), {
          status: 503,
          code: 'STEP15_MASTER_FAILURE_SMOKE',
        });
      }
      return { messageId: 1515, bytes };
    },
    storageChatId: account => account.chatId,
  }));

  app.use((error, _req, res, _next) => {
    res.status(error?.code === 'LIMIT_FILE_SIZE' ? 413 : Number(error?.status || 500))
      .json({ code: error?.code || 'STEP15_PROJECT_ROUTE_SMOKE_FAILED' });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const url = `http://127.0.0.1:${server.address().port}/transport/project/upload`;

  async function send(size) {
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(size, 0x53)]), 'step15-project.zip');
    return fetch(url, {
      method: 'POST',
      headers: {
        'X-BeatGaler-Project-Beat': 'step15-beat',
        'X-BeatGaler-Project-Kind': 'commit_import',
        'X-BeatGaler-Project-Operation': 'step15-operation',
        'X-BeatGaler-Project-Session': 'step15-session',
        'X-BeatGaler-Project-Generation': '1',
        'X-BeatGaler-Project-Thread': '42',
      },
      body: form,
    });
  }

  try {
    const success = await send(PAYLOAD_BYTES);
    const successBody = await success.json();
    if (success.status !== 200 || successBody.original_size !== PAYLOAD_BYTES) {
      throw new Error(`PROJECT success smoke failed HTTP ${success.status}: ${JSON.stringify(successBody)}`);
    }
    await waitForEmpty(tempDir);

    mode = 'fail';
    const failed = await send(PAYLOAD_BYTES);
    const failedBody = await failed.json();
    if (failed.status !== 503 || failedBody.code !== 'STEP15_MASTER_FAILURE_SMOKE') {
      throw new Error(`PROJECT failure smoke failed HTTP ${failed.status}: ${JSON.stringify(failedBody)}`);
    }
    await waitForEmpty(tempDir);

    mode = 'success';
    const tooLarge = await send(PLAN_MAX_BYTES + 1);
    const tooLargeBody = await tooLarge.json();
    if (tooLarge.status !== 413 || tooLargeBody.code !== 'LIMIT_FILE_SIZE') {
      throw new Error(`PROJECT limit smoke failed HTTP ${tooLarge.status}: ${JSON.stringify(tooLargeBody)}`);
    }
    await waitForEmpty(tempDir);

    if (publishCalls !== 2) throw new Error(`Expected 2 publish attempts, got ${publishCalls}.`);

    console.log(JSON.stringify({
      kind: 'STEP15_PROJECT_ROUTE_SMOKE',
      result: 'PASS',
      payloadBytes: PAYLOAD_BYTES,
      planMaxBytes: PLAN_MAX_BYTES,
      successStatus: success.status,
      simulatedMasterFailureStatus: failed.status,
      overLimitStatus: tooLarge.status,
      tempdirCleanAfterEachCase: true,
      externalServicesUsed: false,
    }, null, 2));
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
