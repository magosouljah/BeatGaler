'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function atomicWriteJson(file, value) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const tmp = `${resolved}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, resolved);
}

function markLifecycleEmailVerified(runtime, userId, email, { verifiedAt = new Date().toISOString() } = {}) {
  const id = String(userId || '').trim();
  const normalized = normalizeEmail(email);
  const state = runtime?._test?.stateSnapshot?.();
  const stateFile = runtime?._test?.stateFile;
  if (!id || !normalized || !state || !stateFile) {
    const error = new Error('Lifecycle runtime, stable user id and email are required to activate verified email state.');
    error.code = 'LIFECYCLE_EMAIL_ACTIVATION_INPUT_INVALID';
    throw error;
  }
  if (!state.email_verified || typeof state.email_verified !== 'object' || Array.isArray(state.email_verified)) {
    state.email_verified = {};
  }
  state.email_verified[id] = {
    email_hash: sha256(normalized),
    verified_at: String(verifiedAt),
  };
  atomicWriteJson(stateFile, state);
  return { userId: id, emailHash: state.email_verified[id].email_hash, verifiedAt: state.email_verified[id].verified_at };
}

module.exports = {
  sha256,
  normalizeEmail,
  atomicWriteJson,
  markLifecycleEmailVerified,
};
