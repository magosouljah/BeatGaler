'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MIN_FREE_RESERVE_BYTES = 2 * 1024 * 1024 * 1024;
const DOWNLOAD_STALL_MS = 2 * 60_000;
const ORPHAN_TEMP_AGE_MS = 24 * 60 * 60_000;
const TERMINAL_CODES = new Set(['PROJECT_UPLOAD_DENIED', 'PROJECT_TOO_LARGE',
  'PROJECT_SCOPE_DENIED', 'LIBRARY_PURGE_PENDING']);
function safeCode(error) {
  const code = String(error?.code || 'PROJECT_STAGING_WORKER_FAILED');
  return /^PROJECT_[A-Z0-9_]{1,90}$/.test(code) || code === 'LIBRARY_PURGE_PENDING'
    ? code : 'PROJECT_STAGING_WORKER_FAILED';
}

async function receiveStagedFile({ store, id, expectedBytes, root,
  minimumFreeBytes = MIN_FREE_RESERVE_BYTES, stallMs = DOWNLOAD_STALL_MS }) {
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const space = await fsp.statfs(root, { bigint: true });
  if (space.bavail * space.bsize < BigInt(expectedBytes) + BigInt(minimumFreeBytes)) {
    throw Object.assign(new Error('PROJECT_STAGING_DISK_FULL'), { code: 'PROJECT_STAGING_DISK_FULL' });
  }
  const directory = await fsp.mkdtemp(path.join(root, 'project-'));
  const filePath = path.join(directory, 'project.zip');
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const controller = new AbortController();
  let watchdog;
  const resetWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => controller.abort(new Error('PROJECT_STAGING_DOWNLOAD_STALLED')), stallMs);
  };
  try {
    resetWatchdog();
    const source = await store.stream(id, controller.signal);
    const measured = new Transform({ transform(chunk, _encoding, callback) {
      resetWatchdog();
      bytes += chunk.length;
      if (bytes > expectedBytes) return callback(new Error('PROJECT_STAGING_SIZE_MISMATCH'));
      hash.update(chunk);
      callback(null, chunk);
    } });
    await pipeline(source, measured, fs.createWriteStream(filePath, { mode: 0o600, flags: 'wx' }),
      { signal: controller.signal });
    if (bytes !== expectedBytes) throw new Error('PROJECT_STAGING_SIZE_MISMATCH');
    return { filePath, directory, bytes, sha256: hash.digest('hex') };
  } catch (error) {
    await fsp.rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    clearTimeout(watchdog);
  }
}

function createProjectMultipartWorker({ repo, store, uploadProject, tempRoot, pollMs = 5000,
  minimumFreeBytes = MIN_FREE_RESERVE_BYTES, stallMs = DOWNLOAD_STALL_MS,
  onError = () => {} } = {}) {
  if (!repo?.claim || !store?.stream || typeof uploadProject !== 'function' || !tempRoot ||
      !Number.isInteger(pollMs) || pollMs < 100) throw new Error('PROJECT_STAGING_WORKER_CONFIG_INVALID');
  const workerId = `project_${crypto.randomUUID()}`;
  let running = false;
  let timer = null;
  let active = null;
  let lastCleanup = 0;
  let lastOrphanCleanup = 0;
  let healthy = true;

  async function processClaimed() {
    const row = await repo.claim(workerId);
    if (!row) return false;
    let received = null;
    let lostLease = false;
    const heartbeat = setInterval(() => {
      void repo.heartbeat(row.id, workerId).then(ok => { if (!ok) lostLease = true; })
        .catch(() => { lostLease = true; });
    }, 30_000);
    heartbeat.unref?.();
    try {
      received = await receiveStagedFile({ store, id: row.id,
        expectedBytes: Number(row.size_bytes), root: tempRoot, minimumFreeBytes, stallMs });
      if (lostLease) throw new Error('PROJECT_STAGING_LEASE_LOST');
      const result = await uploadProject({ userId: row.user_id, beatId: row.beat_id,
        chatId: row.chat_id, threadId: Number(row.thread_id), filename: row.filename,
        filePath: received.filePath });
      if (result.bytes !== received.bytes || result.sha256 !== received.sha256) {
        throw new Error('PROJECT_STAGING_SIZE_MISMATCH');
      }
      if (!(await repo.completeJob(row.id, workerId, result))) throw new Error('PROJECT_STAGING_LEASE_LOST');
      await store.remove(row.id);
      await repo.markRemoved(row.id);
      healthy = true;
    } catch (error) {
      const code = safeCode(error);
      healthy = false;
      await repo.releaseJob(row.id, workerId, code, TERMINAL_CODES.has(code)).catch(() => {});
      try { onError(code); } catch (_) {}
    } finally {
      clearInterval(heartbeat);
      if (received) await fsp.rm(received.directory, { recursive: true, force: true });
    }
    return true;
  }
  async function cleanupOrphanTemp() {
    await fsp.mkdir(tempRoot, { recursive: true, mode: 0o700 });
    const entries = await fsp.readdir(tempRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^project-[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
      const directory = path.join(tempRoot, entry.name);
      const stat = await fsp.stat(directory);
      if (Date.now() - stat.mtimeMs > ORPHAN_TEMP_AGE_MS) {
        await fsp.rm(directory, { recursive: true, force: true });
      }
    }
  }
  async function processOne() {
    return repo.withWorkerSlot(async () => {
      if (Date.now() - lastOrphanCleanup >= 60 * 60_000) {
        await cleanupOrphanTemp();
        lastOrphanCleanup = Date.now();
      }
      return processClaimed();
    });
  }

  async function cleanupExpired() {
    let failed = false;
    for (const row of await repo.expired()) {
      try {
        if (['UPLOADING', 'ABORTED'].includes(row.state) && row.s3_upload_id) {
          await store.abort(row.id, row.s3_upload_id);
        }
        if (row.state !== 'STARTING') await store.remove(row.id);
        if (row.state !== 'COMPLETED') await repo.markAborted(row.id);
        await repo.markRemoved(row.id);
      } catch (error) { failed = true; try { onError(safeCode(error)); } catch (_) {} }
    }
    if (failed) throw new Error('PROJECT_STAGING_CLEANUP_FAILED');
  }

  async function tick() {
    if (Date.now() - lastCleanup >= 60_000) {
      lastCleanup = Date.now();
      await store.check();
      const cleaned = await repo.withWorkerSlot(() => cleanupExpired());
      if (cleaned !== false) healthy = true;
    }
    if (running) await processOne();
  }
  function schedule() {
    if (!running) return;
    timer = setTimeout(() => {
      active = tick().catch(error => { healthy = false; try { onError(safeCode(error)); } catch (_) {} })
        .finally(() => { active = null; schedule(); });
    }, pollMs);
    timer.unref?.();
  }
  function start() { if (!running) { running = true; schedule(); } }
  async function stop() { running = false; if (timer) clearTimeout(timer); if (active) await active; }
  return Object.freeze({ start, stop, processOne, cleanupExpired,
    status: () => ({ running, healthy, active: Boolean(active) }) });
}

module.exports = { MIN_FREE_RESERVE_BYTES, receiveStagedFile, createProjectMultipartWorker };
