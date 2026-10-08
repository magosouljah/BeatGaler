'use strict';

const assert = require('assert');
const path = require('path');
const { installLegacyJsonCompatibility, installExpressDurabilityBarrier } = require('../control-plane-json-compat.js');

const passthrough = [];
const fsModule = {
  existsSync(file) { passthrough.push(['exists', file]); return false; },
  readFileSync(file) { passthrough.push(['read', file]); return 'disk'; },
  writeFileSync(file, data) { passthrough.push(['write', file, String(data)]); },
  renameSync(from, to) { passthrough.push(['rename', from, to]); },
};
const saved = { auth: [], persistent: [] };
const runtime = {
  saveAuthSnapshot(value) { saved.auth.push(value); return Promise.resolve(); },
  savePersistentSnapshot(value) { saved.persistent.push(value); return Promise.resolve(); },
};

const authPath = path.resolve('/virtual/accounts-data.json');
const persistentPath = path.resolve('/virtual/cloud-data.json');
const uninstall = installLegacyJsonCompatibility({
  fsModule,
  runtime,
  authPath,
  persistentPath,
  initialAuth: { users: [{ id: 'u1' }], sessions: {} },
  initialPersistent: { linkedAccounts: {}, uploadedFiles: {}, beatTopics: {}, pendingTopicDeletes: {}, messageRedirects: {} },
});

assert.equal(fsModule.existsSync(authPath), true);
assert.equal(JSON.parse(fsModule.readFileSync(authPath, 'utf8')).users[0].id, 'u1');

const nextAuth = { users: [{ id: 'u1', email: 'new@example.com' }], sessions: { abc: { userId: 'u1' } } };
fsModule.writeFileSync(`${authPath}.tmp`, JSON.stringify(nextAuth), 'utf8');
assert.throws(() => fsModule.writeFileSync(`${persistentPath}.tmp`, '{broken', 'utf8'), /JSON/);
fsModule.renameSync(`${authPath}.tmp`, authPath);
assert.deepEqual(saved.auth, [nextAuth]);
assert.deepEqual(JSON.parse(fsModule.readFileSync(authPath, 'utf8')), nextAuth);
assert.equal(passthrough.length, 0, 'tracked state must never touch disk in PostgreSQL authority mode');

fsModule.writeFileSync('/other/file.txt', 'ok', 'utf8');
assert.equal(passthrough.length, 1, 'untracked filesystem writes must pass through unchanged');

uninstall();
assert.equal(fsModule.existsSync(authPath), false);

console.log('PASS control-plane JSON compatibility: PostgreSQL-backed virtual state, no disk dual-write');

// Routes backed exclusively by their own awaited durable stores can respond
// without waiting for unrelated legacy snapshot writes from other requests.
(async () => {
  let releaseFlush;
  const flush = new Promise(resolve => { releaseFlush = resolve; });
  const express = { response: { send(body) { this.body = body; this.writableEnded = true; return this; } } };
  const restore = installExpressDurabilityBarrier(express, { flush: () => flush });
  const directResponse = { locals: { beatGalerDurabilityBypass: true }, writableEnded: false };
  const legacyResponse = { locals: {}, writableEnded: false };
  express.response.send.call(directResponse, 'direct');
  express.response.send.call(legacyResponse, 'legacy');
  assert.equal(directResponse.body, 'direct');
  assert.equal(legacyResponse.body, undefined);
  releaseFlush();
  await flush;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(legacyResponse.body, 'legacy');
  restore();
  console.log('PASS control-plane durability barrier: Direct bypass is independent of legacy writes');
})().catch(error => { console.error(error); process.exitCode = 1; });
