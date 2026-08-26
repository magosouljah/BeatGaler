'use strict';

const path = require('path');

function normalize(filePath) {
  return path.resolve(String(filePath));
}

function serialize(value) {
  return JSON.stringify(value, null, 2);
}

function installLegacyJsonCompatibility({ fsModule, runtime, authPath, persistentPath, initialAuth, initialPersistent }) {
  if (!fsModule) throw new Error('fsModule is required.');
  if (!runtime) throw new Error('PostgreSQL runtime is required.');

  const auth = normalize(authPath);
  const persistent = normalize(persistentPath);
  const authTmp = `${auth}.tmp`;
  const persistentTmp = `${persistent}.tmp`;
  const tracked = new Set([auth, persistent, authTmp, persistentTmp]);
  const staged = new Map();
  const current = new Map([
    [auth, serialize(initialAuth)],
    [persistent, serialize(initialPersistent)],
  ]);

  const originals = {
    existsSync: fsModule.existsSync,
    readFileSync: fsModule.readFileSync,
    writeFileSync: fsModule.writeFileSync,
    renameSync: fsModule.renameSync,
  };

  function trackedPath(filePath) {
    const resolved = normalize(filePath);
    return tracked.has(resolved) ? resolved : null;
  }

  fsModule.existsSync = function existsSync(filePath) {
    const resolved = trackedPath(filePath);
    if (resolved) return resolved === auth || resolved === persistent || staged.has(resolved);
    return originals.existsSync.apply(this, arguments);
  };

  fsModule.readFileSync = function readFileSync(filePath, options) {
    const resolved = trackedPath(filePath);
    if (!resolved) return originals.readFileSync.apply(this, arguments);
    const value = staged.has(resolved) ? staged.get(resolved) : current.get(resolved);
    if (value == null) throw Object.assign(new Error(`ENOENT: no such virtual control-plane file, open '${resolved}'`), { code: 'ENOENT' });
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding ? Buffer.from(value, 'utf8').toString(encoding) : Buffer.from(value, 'utf8');
  };

  fsModule.writeFileSync = function writeFileSync(filePath, data, options) {
    const resolved = trackedPath(filePath);
    if (!resolved) return originals.writeFileSync.apply(this, arguments);
    const encoding = typeof options === 'string' ? options : options?.encoding || 'utf8';
    const value = Buffer.isBuffer(data) ? data.toString(encoding) : String(data);
    // Validate before accepting a virtual write. A malformed in-memory snapshot
    // must fail synchronously instead of poisoning PostgreSQL later.
    JSON.parse(value);
    staged.set(resolved, value);
    return undefined;
  };

  fsModule.renameSync = function renameSync(oldPath, newPath) {
    const oldResolved = trackedPath(oldPath);
    const newResolved = trackedPath(newPath);
    const isAuthCommit = oldResolved === authTmp && newResolved === auth;
    const isPersistentCommit = oldResolved === persistentTmp && newResolved === persistent;
    if (!isAuthCommit && !isPersistentCommit) return originals.renameSync.apply(this, arguments);
    if (!staged.has(oldResolved)) {
      throw new Error(`Virtual control-plane temp state is missing: ${oldResolved}`);
    }
    const raw = staged.get(oldResolved);
    const parsed = JSON.parse(raw);
    current.set(newResolved, raw);
    staged.delete(oldResolved);
    if (isAuthCommit) runtime.saveAuthSnapshot(parsed);
    else runtime.savePersistentSnapshot(parsed);
    return undefined;
  };

  return function uninstall() {
    fsModule.existsSync = originals.existsSync;
    fsModule.readFileSync = originals.readFileSync;
    fsModule.writeFileSync = originals.writeFileSync;
    fsModule.renameSync = originals.renameSync;
  };
}

function installExpressDurabilityBarrier(expressModule, runtime, { logger = console } = {}) {
  if (!expressModule?.response?.send) throw new Error('Express response prototype is unavailable.');
  const response = expressModule.response;
  const originalSend = response.send;

  response.send = function beatGalerDurableSend(body) {
    if (this.locals?.beatGalerDurabilityBypass) {
      return originalSend.call(this, body);
    }
    const res = this;
    void runtime.flush().then(() => {
      if (!res.writableEnded) originalSend.call(res, body);
    }).catch(error => {
      logger.error('[postgres] control-plane durability barrier failed:', error?.message || error);
      if (res.headersSent) {
        try { res.destroy(error); } catch (_) {}
        return;
      }
      res.statusCode = 503;
      res.locals = res.locals || {};
      res.locals.beatGalerDurabilityBypass = true;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      originalSend.call(res, JSON.stringify({ error: 'Control-plane persistence unavailable. Request was not acknowledged.' }));
    });
    return res;
  };

  return function uninstall() {
    response.send = originalSend;
  };
}

module.exports = {
  installLegacyJsonCompatibility,
  installExpressDurabilityBarrier,
};
