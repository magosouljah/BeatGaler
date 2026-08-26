'use strict';

const crypto = require('crypto');

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
}

function normalizeUsers(authData) {
  const users = Array.isArray(authData.users) ? authData.users : [];
  const ids = new Set();
  return users.map((user, index) => {
    assertPlainObject(user, `auth.users[${index}]`);
    const id = String(user.id || '').trim();
    if (!id) throw new Error(`auth.users[${index}] is missing id.`);
    if (ids.has(id)) throw new Error(`Duplicate legacy user id: ${id}`);
    ids.add(id);
    return {
      id,
      email: user.email == null ? null : String(user.email).trim().toLowerCase(),
      has_password_hash: Boolean(user.passwordHash || user.password_hash),
      has_mfa_secret: Boolean(user.mfaSecret || user.mfa_secret),
      provider_count: Array.isArray(user.providers) ? user.providers.length : 0,
      storage_chat_id: user.storageChatId == null ? null : String(user.storageChatId),
      base_plan_id: user.planState?.basePlanId || user.plan_state?.base_plan_id || 'free',
      grant_count: Array.isArray(user.planState?.grants) ? user.planState.grants.length : 0,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeSessionCount(authData) {
  const sessions = authData.sessions || {};
  assertPlainObject(sessions, 'auth.sessions');
  return Object.keys(sessions).length;
}

function planLegacyImport(authData, persistentData) {
  assertPlainObject(authData, 'auth');
  assertPlainObject(persistentData, 'persistent');
  const users = normalizeUsers(authData);
  const linkedAccounts = persistentData.linkedAccounts || {};
  assertPlainObject(linkedAccounts, 'persistent.linkedAccounts');

  const unknownLinkedUsers = Object.keys(linkedAccounts)
    .map(String)
    .filter(id => !users.some(user => user.id === id))
    .sort();
  if (unknownLinkedUsers.length) {
    throw new Error(`Legacy linkedAccounts reference unknown users: ${unknownLinkedUsers.join(', ')}`);
  }

  const plan = {
    version: 1,
    counts: {
      users: users.length,
      auth_sessions: normalizeSessionCount(authData),
      linked_accounts: Object.keys(linkedAccounts).length,
      uploaded_files: Array.isArray(persistentData.uploadedFiles) ? persistentData.uploadedFiles.length : Object.keys(persistentData.uploadedFiles || {}).length,
      beat_topics: Object.keys(persistentData.beatTopics || {}).length,
      pending_topic_deletes: Object.keys(persistentData.pendingTopicDeletes || {}).length,
      message_redirects: Object.keys(persistentData.messageRedirects || {}).length,
    },
    users,
  };
  const canonical = stableStringify(plan);
  return Object.freeze({
    ...plan,
    plan_sha256: sha256(canonical),
  });
}

function parseLegacyJson(raw, label) {
  try {
    return JSON.parse(String(raw));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function snapshotManifest(entries) {
  const files = Object.entries(entries).map(([name, raw]) => ({
    name,
    bytes: Buffer.byteLength(String(raw), 'utf8'),
    sha256: sha256(String(raw)),
  })).sort((a, b) => a.name.localeCompare(b.name));
  return Object.freeze({
    version: 1,
    files,
    manifest_sha256: sha256(stableStringify(files)),
  });
}

module.exports = {
  stableStringify,
  sha256,
  parseLegacyJson,
  snapshotManifest,
  planLegacyImport,
};
