'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const PART_BYTES = 16 * 1024 * 1024;
const MAX_BYTES = 1_900_000_000;

class ProjectMultipartError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
function fail(code, status) { throw new ProjectMultipartError(code, status); }
function validId(value) { return typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value); }
function checksum(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value) ||
      Buffer.from(value, 'base64').length !== 32) fail('PROJECT_PART_CHECKSUM_INVALID');
  return value;
}
function expectedPartSize(total, partNumber) {
  if (!Number.isInteger(total) || total < 1 || total > MAX_BYTES ||
      !Number.isInteger(partNumber) || partNumber < 1 || partNumber > Math.ceil(total / PART_BYTES)) {
    fail('PROJECT_PART_NUMBER_INVALID');
  }
  return Math.min(PART_BYTES, total - (partNumber - 1) * PART_BYTES);
}
function publicResult(row) {
  const messageId = Number(row.telegram_message_id);
  return { telegram_file_id: `direct:${messageId}`, telegram_message_id: messageId,
    original_size: Number(row.size_bytes), filename: row.filename,
    parts: [{ telegram_file_id: `direct:${messageId}`, telegram_message_id: messageId,
      index: 0, size: Number(row.size_bytes), filename: row.filename }], transport: 'direct-web' };
}

function createProjectMultipartService({ repo, store, authorizeProject, now = () => Date.now() }) {
  if (!repo || !store || typeof authorizeProject !== 'function') throw new Error('PROJECT_STAGING_DEPENDENCIES_INVALID');
  async function owned(userId, id, beatId) {
    if (!validId(id)) fail('PROJECT_UPLOAD_ID_INVALID');
    const row = await repo.byId(userId, id);
    if (!row || row.beat_id !== beatId) fail('PROJECT_UPLOAD_NOT_FOUND', 404);
    if (new Date(row.expires_at).getTime() <= now() && row.state !== 'COMPLETED') fail('PROJECT_UPLOAD_EXPIRED', 410);
    return row;
  }
  async function authorize(userId, bytes) {
    const allowed = await authorizeProject({ userId, declaredBytes: bytes });
    if (!Number.isSafeInteger(allowed?.maxBytes) || bytes > allowed.maxBytes) fail('PROJECT_TOO_LARGE', 413);
  }
  async function start({ userId, beatId, chatId, threadId, clientUploadId, filename, fingerprint, sizeBytes }) {
    if (!validId(clientUploadId) || typeof beatId !== 'string' || !beatId.trim() ||
        !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_BYTES ||
        !Number.isSafeInteger(threadId) || threadId < 1 ||
        typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) fail('PROJECT_UPLOAD_INVALID');
    const safeName = path.basename(String(filename || '')).trim();
    if (!safeName || safeName !== filename || safeName.length > 255 ||
        /[\\/\x00-\x1f]/.test(safeName) || !safeName.toLowerCase().endsWith('.zip')) {
      fail('PROJECT_FILENAME_INVALID');
    }
    await authorize(userId, sizeBytes);
    if (!(await repo.ownsVault(userId, chatId))) fail('PROJECT_SCOPE_DENIED', 403);
    if (!(await repo.ownsBeatOrReservation(userId, beatId))) fail('PROJECT_BEAT_NOT_RESERVED', 403);
    let existing = await repo.byClient(userId, beatId, clientUploadId);
    if (existing) {
      if (existing.state === 'ABORTED' ||
          (new Date(existing.expires_at).getTime() <= now() && existing.state !== 'COMPLETED')) {
        fail('PROJECT_UPLOAD_EXPIRED', 410);
      }
      if (existing.filename !== safeName || existing.fingerprint_sha256 !== fingerprint ||
          Number(existing.size_bytes) !== sizeBytes ||
          existing.chat_id !== String(chatId) || Number(existing.thread_id) !== threadId) fail('PROJECT_UPLOAD_CONFLICT', 409);
      return { id: existing.id, state: existing.state, partBytes: PART_BYTES,
        partCount: Math.ceil(sizeBytes / PART_BYTES) };
    }
    existing = await repo.activeForUser(userId);
    if (existing) {
      if (new Date(existing.expires_at).getTime() <= now()) fail('PROJECT_UPLOAD_EXPIRED', 410);
      if (existing.beat_id !== beatId) fail('PROJECT_UPLOAD_ACTIVE', 409);
      if (existing.filename !== safeName || existing.fingerprint_sha256 !== fingerprint ||
          Number(existing.size_bytes) !== sizeBytes ||
          existing.chat_id !== String(chatId) || Number(existing.thread_id) !== threadId) fail('PROJECT_UPLOAD_CONFLICT', 409);
      return { id: existing.id, state: existing.state, partBytes: PART_BYTES,
        partCount: Math.ceil(sizeBytes / PART_BYTES) };
    }
    if (await repo.recentCreatedCount(userId) >= 12) fail('PROJECT_UPLOAD_RATE_LIMITED', 429);
    const id = crypto.randomUUID();
    try { await repo.insert({ id, userId, beatId, clientUploadId, chatId, threadId,
      filename: safeName, fingerprint, sizeBytes }); }
    catch (error) {
      if (error?.code !== '23505') throw error;
      existing = await repo.byClient(userId, beatId, clientUploadId) ||
        await repo.activeForUser(userId);
      if (!existing) fail('PROJECT_UPLOAD_ACTIVE', 409);
      if (existing.beat_id !== beatId) fail('PROJECT_UPLOAD_ACTIVE', 409);
      if (existing.filename !== safeName || existing.fingerprint_sha256 !== fingerprint ||
          Number(existing.size_bytes) !== sizeBytes ||
          existing.chat_id !== String(chatId) || Number(existing.thread_id) !== threadId) fail('PROJECT_UPLOAD_CONFLICT', 409);
      return { id: existing.id, state: existing.state, partBytes: PART_BYTES,
        partCount: Math.ceil(sizeBytes / PART_BYTES) };
    }
    let uploadId = null;
    try {
      uploadId = await store.create(id);
      if (!(await repo.setUploading(id, uploadId))) fail('PROJECT_UPLOAD_STATE_CHANGED', 409);
      return { id, state: 'UPLOADING', partBytes: PART_BYTES,
        partCount: Math.ceil(sizeBytes / PART_BYTES) };
    } catch (error) {
      if (uploadId) await store.abort(id, uploadId).catch(() => {});
      await repo.markAborted(id).catch(() => {});
      // A process crash between S3 creation and persistence is still collected
      // by the bucket's AbortIncompleteMultipartUpload lifecycle rule.
      throw error;
    }
  }
  async function status({ userId, beatId, id }) {
    const row = await owned(userId, id, beatId);
    const result = { id, state: row.state, partBytes: PART_BYTES,
      partCount: Math.ceil(Number(row.size_bytes) / PART_BYTES), sizeBytes: Number(row.size_bytes),
      failureCode: row.failure_code || null };
    if (row.state === 'UPLOADING' && row.s3_upload_id) {
      result.parts = (await store.parts(id, row.s3_upload_id)).map(part => ({
        number: part.number, size: part.size, checksum: part.checksum,
      }));
    }
    if (row.state === 'COMPLETED') result.upload = publicResult(row);
    return result;
  }
  async function partUrl({ userId, beatId, id, partNumber, sizeBytes, sha256Base64 }) {
    const row = await owned(userId, id, beatId);
    if (row.state !== 'UPLOADING' || !row.s3_upload_id) fail('PROJECT_UPLOAD_NOT_UPLOADING', 409);
    await authorize(userId, Number(row.size_bytes));
    if (sizeBytes !== expectedPartSize(Number(row.size_bytes), partNumber)) fail('PROJECT_PART_SIZE_INVALID');
    const signed = await store.signPart(id, row.s3_upload_id, partNumber, checksum(sha256Base64), sizeBytes);
    return { ...signed, expiresInSeconds: 600 };
  }
  async function complete({ userId, beatId, id }) {
    const row = await owned(userId, id, beatId);
    if (row.state === 'COMPLETED') return { id, state: 'COMPLETED', upload: publicResult(row) };
    if (['READY', 'PROCESSING'].includes(row.state)) return { id, state: row.state };
    if (row.state !== 'UPLOADING' || !row.s3_upload_id) fail('PROJECT_UPLOAD_NOT_UPLOADING', 409);
    await authorize(userId, Number(row.size_bytes));
    const existingBytes = await store.head(id);
    if (existingBytes === null) {
      const parts = await store.parts(id, row.s3_upload_id);
      const count = Math.ceil(Number(row.size_bytes) / PART_BYTES);
      if (parts.length !== count || parts.some((part, index) =>
        part.number !== index + 1 || part.size !== expectedPartSize(Number(row.size_bytes), index + 1) ||
        !part.etag || !part.checksum)) fail('PROJECT_PARTS_INCOMPLETE', 409);
      try { await store.complete(id, row.s3_upload_id, parts); }
      catch (error) {
        // Completion may have succeeded remotely before its response was lost.
        if (await store.head(id) !== Number(row.size_bytes)) throw error;
      }
    }
    const confirmedBytes = await store.head(id);
    if (confirmedBytes !== Number(row.size_bytes)) fail('PROJECT_STAGING_SIZE_MISMATCH', 503);
    const ready = await repo.setReady(id);
    if (!ready) {
      const current = await repo.byId(userId, id);
      if (['READY', 'PROCESSING', 'COMPLETED'].includes(current?.state)) return { id, state: current.state };
      fail('PROJECT_UPLOAD_STATE_CHANGED', 409);
    }
    return { id, state: 'READY' };
  }
  async function abort({ userId, beatId, id }) {
    const row = await owned(userId, id, beatId);
    if (row.state === 'ABORTED') return { id, state: 'ABORTED' };
    const previousState = row.state;
    if (!(await repo.markAborted(id))) fail('PROJECT_UPLOAD_NOT_ABORTABLE', 409);
    if (row.s3_upload_id && previousState === 'UPLOADING') await store.abort(id, row.s3_upload_id);
    else if (previousState === 'READY') await store.remove(id);
    await repo.markRemoved(id);
    return { id, state: 'ABORTED' };
  }
  async function retry({ userId, beatId, id }) {
    const row = await owned(userId, id, beatId);
    if (row.state !== 'FAILED') fail('PROJECT_UPLOAD_NOT_RETRYABLE', 409);
    await authorize(userId, Number(row.size_bytes));
    if (await store.head(id) !== Number(row.size_bytes)) fail('PROJECT_STAGING_SIZE_MISMATCH', 503);
    if (!(await repo.retryFailed(id))) fail('PROJECT_UPLOAD_STATE_CHANGED', 409);
    return { id, state: 'READY' };
  }
  return Object.freeze({ start, status, partUrl, complete, abort, retry, owned, publicResult });
}

module.exports = { PART_BYTES, MAX_BYTES, ProjectMultipartError, expectedPartSize,
  createProjectMultipartService };
