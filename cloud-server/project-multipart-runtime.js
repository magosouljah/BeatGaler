'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { createProjectS3Store } = require('./project-multipart-s3');
const { createProjectMultipartRepository } = require('./project-multipart-repository');
const { createProjectMultipartService } = require('./project-multipart-service');
const { createProjectMultipartWorker, MIN_FREE_RESERVE_BYTES } = require('./project-multipart-worker');

let service = null;
let worker = null;
let failureCode = 'PROJECT_STAGING_NOT_INITIALIZED';
let store = null;
let tempRoot = null;
let preflightReady = false;

function configure({ pool, authority, authorizeProject, uploadProject, env = process.env,
  storeFactory = createProjectS3Store } = {}) {
  service = null;
  worker = null;
  store = null;
  tempRoot = null;
  preflightReady = false;
  failureCode = 'PROJECT_STAGING_DISABLED';
  if (env.PROJECT_MULTIPART_ENABLED !== 'true') return status();
  try {
    if (authority !== 'postgres' || !pool || Number(pool.options?.max) < 2) {
      throw new Error('PROJECT_STAGING_POSTGRES_REQUIRED');
    }
    tempRoot = String(env.PROJECT_STAGING_TEMP_DIR || '').trim();
    if (!path.isAbsolute(tempRoot) || path.parse(tempRoot).root === tempRoot) {
      throw new Error('PROJECT_STAGING_TEMP_DIR_INVALID');
    }
    const repo = createProjectMultipartRepository(pool);
    store = storeFactory({ env });
    service = createProjectMultipartService({ repo, store, authorizeProject });
    worker = createProjectMultipartWorker({ repo, store, uploadProject, tempRoot,
      onError: code => console.error(`[project-staging] worker code=${code}`) });
    failureCode = null;
  } catch (error) {
    service = null;
    worker = null;
    store = null;
    tempRoot = null;
    failureCode = /^PROJECT_[A-Z0-9_]{1,90}$/.test(error?.message || '')
      ? error.message : 'PROJECT_STAGING_UNAVAILABLE';
  }
  return status();
}
async function preflight() {
  if (!service || !worker) return status();
  try {
    await store.check();
    await fsp.mkdir(tempRoot, { recursive: true, mode: 0o700 });
    const space = await fsp.statfs(tempRoot, { bigint: true });
    if (space.bavail * space.bsize < BigInt(1_900_000_000 + MIN_FREE_RESERVE_BYTES)) {
      throw new Error('PROJECT_STAGING_DISK_FULL');
    }
    preflightReady = true;
    failureCode = null;
  } catch (error) {
    preflightReady = false;
    failureCode = /^PROJECT_[A-Z0-9_]{1,90}$/.test(error?.message || '')
      ? error.message : 'PROJECT_STAGING_PREFLIGHT_FAILED';
  }
  return status();
}
function status() { return { ready: Boolean(service && worker && preflightReady && worker.status().healthy),
  running: Boolean(worker?.status().running), failureCode }; }
function current() { return service; }
function start() { worker?.start(); return status(); }
async function stop() { if (worker) await worker.stop(); return status(); }

module.exports = { configure, preflight, status, current, start, stop };
