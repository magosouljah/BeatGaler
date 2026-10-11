'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { S3Client } = require('@aws-sdk/client-s3');
const { createProjectS3Store } = require('../project-multipart-s3');
const { PART_BYTES, MAX_BYTES, expectedPartSize, createProjectMultipartService } = require('../project-multipart-service');
const { createProjectMultipartWorker } = require('../project-multipart-worker');
const { installProjectMultipartRoutes } = require('../project-multipart-route');

const clientUploadId = '11111111-1111-4111-8111-111111111111';
const fingerprint = 'a'.repeat(64);
const checksum = Buffer.alloc(32, 7).toString('base64');
function harness() {
  const rows = new Map();
  const parts = [];
  let objectBytes = null;
  let aborts = 0;
  const repo = {
    ownsVault: async (userId, chatId) => userId === 'user-a' && chatId === 'vault-a',
    ownsBeatOrReservation: async (userId, beatId) => userId === 'user-a' && beatId !== 'unreserved',
    recentCreatedCount: async userId => [...rows.values()].filter(row => row.user_id === userId).length,
    byClient: async (userId, beatId, requestId) => [...rows.values()].find(row => row.user_id === userId &&
      row.beat_id === beatId && row.client_upload_id === requestId) || null,
    activeForBeat: async (userId, beatId) => [...rows.values()].find(row => row.user_id === userId &&
      row.beat_id === beatId && ['STARTING', 'UPLOADING', 'READY', 'PROCESSING'].includes(row.state)) || null,
    activeForUser: async userId => [...rows.values()].find(row => row.user_id === userId &&
      ['STARTING', 'UPLOADING', 'READY', 'PROCESSING'].includes(row.state)) || null,
    byId: async (userId, id) => rows.get(id)?.user_id === userId ? rows.get(id) : null,
    async insert(input) {
      if ([...rows.values()].some(row => row.user_id === input.userId &&
          ['STARTING', 'UPLOADING', 'READY', 'PROCESSING'].includes(row.state))) {
        throw Object.assign(new Error('unique'), { code: '23505' });
      }
      rows.set(input.id, { id: input.id, user_id: input.userId, beat_id: input.beatId,
        client_upload_id: input.clientUploadId, chat_id: input.chatId, thread_id: input.threadId,
        filename: input.filename, fingerprint_sha256: input.fingerprint, size_bytes: input.sizeBytes,
        state: 'STARTING', expires_at: new Date(Date.now() + 86_400_000) });
    },
    async setUploading(id, uploadId) { const row = rows.get(id); row.s3_upload_id = uploadId; row.state = 'UPLOADING'; return row; },
    async setReady(id) { const row = rows.get(id); if (row.state !== 'UPLOADING') return null; row.state = 'READY'; return row; },
    async markAborted(id) { const row = rows.get(id); row.state = 'ABORTED'; return true; },
    async markRemoved(id) { rows.get(id).staged_removed_at = new Date(); },
    async retryFailed(id) { const row = rows.get(id); row.state = 'READY'; return row; },
  };
  const store = {
    create: async () => 's3-multipart-1',
    signPart: async (_id, _uploadId, partNumber, sha) => ({ url: `https://example.s3.us-east-1.amazonaws.com/?part=${partNumber}`,
      headers: { 'x-amz-checksum-sha256': sha } }),
    parts: async () => parts,
    complete: async () => { objectBytes = parts.reduce((sum, part) => sum + part.size, 0); },
    head: async () => objectBytes,
    abort: async () => { aborts++; },
    remove: async () => { objectBytes = null; },
  };
  const service = createProjectMultipartService({ repo, store,
    authorizeProject: async ({ userId, declaredBytes }) => {
      if (userId !== 'user-a' || declaredBytes > PART_BYTES + 3) {
        throw Object.assign(new Error('denied'), { code: 'PROJECT_UPLOAD_DENIED', status: 403 });
      }
      return { maxBytes: PART_BYTES + 3 };
    } });
  const input = { userId: 'user-a', beatId: 'beat-a', chatId: 'vault-a', threadId: 42,
    clientUploadId, filename: 'PROJECT.zip', fingerprint, sizeBytes: PART_BYTES + 3 };
  return { rows, parts, repo, store, service, input, get aborts() { return aborts; } };
}

test('multipart session is scoped to one user/vault/beat and resumes by file fingerprint', async () => {
  const h = harness();
  const first = await h.service.start(h.input);
  assert.equal(first.partCount, 2);
  assert.equal((await h.service.start(h.input)).id, first.id);
  assert.equal((await h.service.start({ ...h.input, clientUploadId: crypto.randomUUID() })).id, first.id);
  await assert.rejects(h.service.start({ ...h.input, fingerprint: 'b'.repeat(64),
    clientUploadId: crypto.randomUUID() }), { code: 'PROJECT_UPLOAD_CONFLICT' });
  await assert.rejects(h.service.status({ userId: 'user-b', beatId: 'beat-a', id: first.id }),
    { code: 'PROJECT_UPLOAD_NOT_FOUND' });
  await assert.rejects(h.service.start({ ...h.input, chatId: 'vault-b',
    clientUploadId: crypto.randomUUID() }), { code: 'PROJECT_SCOPE_DENIED' });
  await assert.rejects(h.service.start({ ...h.input, beatId: 'unreserved',
    clientUploadId: crypto.randomUUID() }), { code: 'PROJECT_BEAT_NOT_RESERVED' });
  await assert.rejects(h.service.start({ ...h.input, beatId: 'beat-b',
    clientUploadId: crypto.randomUUID() }), { code: 'PROJECT_UPLOAD_ACTIVE' });
});

test('1.9 GB boundary divides into bounded parts without allocating the file', () => {
  const count = Math.ceil(MAX_BYTES / PART_BYTES);
  assert.equal(count, 114);
  assert.equal(expectedPartSize(MAX_BYTES, count), MAX_BYTES - 113 * PART_BYTES);
  assert.equal(expectedPartSize(MAX_BYTES, 1), PART_BYTES);
  assert.throws(() => expectedPartSize(MAX_BYTES + 1, 1), { code: 'PROJECT_PART_NUMBER_INVALID' });
});

test('new staging sessions are rate limited without charging an idempotent resume', async () => {
  const h = harness();
  const first = await h.service.start(h.input);
  for (let n = 0; n < 11; n++) h.rows.set(`old-${n}`, { user_id: 'user-a', state: 'COMPLETED' });
  assert.equal((await h.service.start(h.input)).id, first.id);
  assert.equal((await h.service.start({ ...h.input, clientUploadId: crypto.randomUUID() })).id, first.id);
  await h.service.abort({ userId: 'user-a', beatId: 'beat-a', id: first.id });
  await assert.rejects(h.service.start({ ...h.input, beatId: 'beat-b',
    clientUploadId: crypto.randomUUID() }), { code: 'PROJECT_UPLOAD_RATE_LIMITED' });
});

test('part checksums and exact sizes are required before S3 completion', async () => {
  const h = harness();
  const { id } = await h.service.start(h.input);
  await assert.rejects(h.service.partUrl({ userId: 'user-a', beatId: 'beat-a', id,
    partNumber: 1, sizeBytes: 3, sha256Base64: checksum }), { code: 'PROJECT_PART_SIZE_INVALID' });
  await assert.rejects(h.service.partUrl({ userId: 'user-a', beatId: 'beat-a', id,
    partNumber: 1, sizeBytes: PART_BYTES, sha256Base64: 'forged' }), { code: 'PROJECT_PART_CHECKSUM_INVALID' });
  const signed = await h.service.partUrl({ userId: 'user-a', beatId: 'beat-a', id,
    partNumber: 2, sizeBytes: 3, sha256Base64: checksum });
  assert.equal(signed.headers['x-amz-checksum-sha256'], checksum);
  h.parts.push({ number: 1, size: PART_BYTES, checksum, etag: 'etag-1' });
  await assert.rejects(h.service.complete({ userId: 'user-a', beatId: 'beat-a', id }),
    { code: 'PROJECT_PARTS_INCOMPLETE' });
  h.parts.push({ number: 2, size: 3, checksum, etag: 'etag-2' });
  assert.deepEqual(await h.service.complete({ userId: 'user-a', beatId: 'beat-a', id }),
    { id, state: 'READY' });
  assert.equal(h.rows.get(id).state, 'READY');
  assert.equal(h.rows.get(id).telegram_message_id, undefined);
});

test('abort releases staging and a later upload can start for the same beat', async () => {
  const h = harness();
  const first = await h.service.start(h.input);
  await h.service.abort({ userId: 'user-a', beatId: 'beat-a', id: first.id });
  assert.equal(h.aborts, 1);
  await assert.rejects(h.service.start(h.input), { code: 'PROJECT_UPLOAD_EXPIRED' });
  assert.equal((await h.service.start({ ...h.input, clientUploadId: crypto.randomUUID(),
    fingerprint: 'b'.repeat(64) })).state, 'UPLOADING');
});

test('signed S3 part binds SHA-256 header and uses the private KMS bucket', async () => {
  const sdk = new S3Client({ region: 'us-east-1',
    credentials: { accessKeyId: 'TESTKEY', secretAccessKey: 'TESTSECRET' } });
  try {
    const store = createProjectS3Store({ env: { PROJECT_STAGING_S3_BUCKET: 'beatgaler-staging-test',
      PROJECT_STAGING_AWS_REGION: 'us-east-1', PROJECT_STAGING_KMS_KEY_ID: 'alias/test' }, client: sdk });
    const signed = await store.signPart(clientUploadId, 'upload_fixture', 1, checksum, PART_BYTES);
    const url = new URL(signed.url);
    assert.match(url.hostname, /\.s3\.us-east-1\.amazonaws\.com$/);
    assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'content-length;host;x-amz-checksum-sha256');
    assert.equal(signed.headers['x-amz-checksum-sha256'], checksum);
  } finally { sdk.destroy(); }
});

test('worker measures streamed bytes before MASTER receipt and cleans temporary disk', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beatgaler-project-test-'));
  const bytes = Buffer.from('real project bytes');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const row = { id: clientUploadId, user_id: 'user-a', beat_id: 'beat-a', chat_id: 'vault-a',
    thread_id: 42, filename: 'PROJECT.zip', size_bytes: bytes.length };
  let claimed = false, completed = false, uploaded = 0, removed = 0;
  const repo = {
    withWorkerSlot: action => action(),
    claim: async () => claimed ? null : (claimed = true, row),
    heartbeat: async () => true,
    completeJob: async (_id, _worker, result) => (completed = result.sha256 === digest),
    releaseJob: async () => { throw new Error('should not release'); },
    markRemoved: async () => {}, expired: async () => [],
  };
  const store = { stream: async () => Readable.from([bytes]), remove: async () => { removed++; } };
  const worker = createProjectMultipartWorker({ repo, store, tempRoot: root, minimumFreeBytes: 0,
    uploadProject: async input => {
      uploaded++;
      assert.equal((await fs.readFile(input.filePath)).toString(), bytes.toString());
      return { bytes: bytes.length, sha256: digest, messageId: 98 };
    } });
  try {
    assert.equal(await worker.processOne(), true);
    assert.equal(completed, true);
    assert.equal(uploaded, 1);
    assert.equal(removed, 1);
    assert.deepEqual(await fs.readdir(root), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('interrupted staging download keeps S3 bytes and retries without browser upload', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beatgaler-project-retry-'));
  const bytes = Buffer.from('complete staged bytes');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const row = { id: clientUploadId, user_id: 'user-a', beat_id: 'beat-a', chat_id: 'vault-a',
    thread_id: 42, filename: 'PROJECT.zip', size_bytes: bytes.length };
  let state = 'READY', reads = 0, uploads = 0, completed = false;
  const repo = {
    withWorkerSlot: action => action(),
    claim: async () => state === 'READY' ? (state = 'PROCESSING', row) : null,
    heartbeat: async () => true,
    releaseJob: async () => { state = 'READY'; },
    completeJob: async () => (state = 'COMPLETED', completed = true),
    markRemoved: async () => {}, expired: async () => [],
  };
  const store = { stream: async () => Readable.from([++reads === 1 ? bytes.subarray(0, 5) : bytes]),
    remove: async () => {} };
  const worker = createProjectMultipartWorker({ repo, store, tempRoot: root, minimumFreeBytes: 0,
    uploadProject: async () => (uploads++, { bytes: bytes.length, sha256: digest, messageId: 91 }) });
  try {
    await worker.processOne();
    assert.equal(state, 'READY');
    assert.equal(uploads, 0);
    await worker.processOne();
    assert.equal(completed, true);
    assert.equal(reads, 2);
    assert.equal(uploads, 1);
    assert.deepEqual(await fs.readdir(root), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('stalled staging stream aborts and removes the partial local copy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beatgaler-project-stall-'));
  const row = { id: clientUploadId, user_id: 'user-a', beat_id: 'beat-a', chat_id: 'vault-a',
    thread_id: 42, filename: 'PROJECT.zip', size_bytes: 5 };
  let released = false;
  const repo = { withWorkerSlot: action => action(), claim: async () => row,
    heartbeat: async () => true, releaseJob: async () => { released = true; },
    expired: async () => [] };
  const store = { stream: async () => new Readable({ read() {} }) };
  const worker = createProjectMultipartWorker({ repo, store, tempRoot: root,
    minimumFreeBytes: 0, stallMs: 25, uploadProject: async () => { throw new Error('unexpected'); } });
  try {
    assert.equal(await worker.processOne(), true);
    assert.equal(released, true);
    assert.deepEqual(await fs.readdir(root), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('route derives tenant and vault from authentication, never from the request body', async () => {
  const routes = new Map();
  let observed;
  installProjectMultipartRoutes({ post: (name, handler) => routes.set(name, handler) }, {
    authenticate: () => ({ user: { id: 'user-a' }, account: { id: 'account-a' } }),
    verifyCapability: async () => {}, capabilityMatches: () => true,
    storageChatId: () => 'vault-a',
    currentService: () => ({ start: async input => (observed = input, { id: clientUploadId }) }),
  });
  let payload;
  await routes.get('/transport/project/multipart/start')({ body: {
    userId: 'user-b', chatId: 'vault-b', beatId: 'beat-a', kind: 'commit_import',
  } }, { json: body => { payload = body; } });
  assert.equal(payload.ok, true);
  assert.equal(observed.userId, 'user-a');
  assert.equal(observed.chatId, 'vault-a');
});
