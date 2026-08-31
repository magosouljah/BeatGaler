'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_FILE = path.join(__dirname, 'durable-user-waitlist.json');
const ALLOWED_KEYS = new Set(['id', 'tenant_id', 'user_id', 'enqueued_at', 'claimed_at']);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function text(value, field) {
  const out = String(value ?? '').trim();
  if (!out || out.length > 200) fail('WAITLIST_INVALID_RECORD', `Invalid ${field}.`);
  return out;
}

function normalizeRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('WAITLIST_INVALID_RECORD', 'Waitlist record must be an object.');
  for (const key of Object.keys(input)) if (!ALLOWED_KEYS.has(key)) fail('WAITLIST_UNSAFE_RECORD', `Waitlist record contains forbidden field: ${key}.`);
  const record = {
    id: text(input.id, 'id'),
    tenant_id: text(input.tenant_id, 'tenant_id'),
    user_id: text(input.user_id, 'user_id'),
    enqueued_at: Number(input.enqueued_at),
    claimed_at: input.claimed_at == null ? null : Number(input.claimed_at),
  };
  if (!Number.isSafeInteger(record.enqueued_at) || record.enqueued_at <= 0) fail('WAITLIST_INVALID_RECORD', 'Invalid enqueued_at.');
  if (record.claimed_at != null && (!Number.isSafeInteger(record.claimed_at) || record.claimed_at < record.enqueued_at)) fail('WAITLIST_INVALID_RECORD', 'Invalid claimed_at.');
  return record;
}

function createDurableUserWaitlist(options = {}) {
  const file = path.resolve(options.file || process.env.BEATGALER_DURABLE_WAITLIST_FILE || DEFAULT_FILE);
  const now = typeof options.now === 'function' ? options.now : Date.now;

  function emptyState() { return { version: 1, entries: [] }; }
  function readState() {
    if (!fs.existsSync(file)) return emptyState();
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { fail('WAITLIST_CORRUPT', 'Durable waitlist state is unreadable.'); }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) fail('WAITLIST_CORRUPT', 'Durable waitlist state has an unsupported shape.');
    const entries = parsed.entries.map(normalizeRecord);
    const ids = new Set();
    const subjects = new Set();
    for (const entry of entries) {
      if (ids.has(entry.id) || subjects.has(`${entry.tenant_id}\u0000${entry.user_id}`)) fail('WAITLIST_CORRUPT', 'Durable waitlist contains duplicate identity.');
      ids.add(entry.id);
      subjects.add(`${entry.tenant_id}\u0000${entry.user_id}`);
    }
    return { version: 1, entries };
  }
  function writeState(state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  function enqueue({ tenantId, userId }) {
    const tenant_id = text(tenantId, 'tenantId');
    const user_id = text(userId, 'userId');
    const state = readState();
    const existing = state.entries.find(entry => entry.tenant_id === tenant_id && entry.user_id === user_id);
    if (existing) return { entry: existing, inserted: false };
    const entry = normalizeRecord({ id: crypto.randomUUID(), tenant_id, user_id, enqueued_at: Number(now()), claimed_at: null });
    state.entries.push(entry);
    writeState(state);
    return { entry, inserted: true };
  }
  function claimNext({ tenantId }) {
    const tenant_id = text(tenantId, 'tenantId');
    const state = readState();
    const entry = state.entries.find(item => item.tenant_id === tenant_id && item.claimed_at == null);
    if (!entry) return null;
    entry.claimed_at = Number(now());
    normalizeRecord(entry);
    writeState(state);
    return entry;
  }
  function recoverClaims({ olderThanMs = 60_000 } = {}) {
    const cutoff = Number(now()) - Math.max(0, Number(olderThanMs) || 0);
    const state = readState();
    let recovered = 0;
    for (const entry of state.entries) {
      if (entry.claimed_at != null && entry.claimed_at <= cutoff) { entry.claimed_at = null; recovered += 1; }
    }
    if (recovered) writeState(state);
    return recovered;
  }
  function dequeue({ id, tenantId }) {
    const wantedId = text(id, 'id');
    const tenant_id = text(tenantId, 'tenantId');
    const state = readState();
    const index = state.entries.findIndex(entry => entry.id === wantedId && entry.tenant_id === tenant_id);
    if (index < 0) return false;
    state.entries.splice(index, 1);
    writeState(state);
    return true;
  }
  function list({ tenantId }) {
    const tenant_id = text(tenantId, 'tenantId');
    return readState().entries.filter(entry => entry.tenant_id === tenant_id);
  }
  return { enqueue, claimNext, recoverClaims, dequeue, list, readState };
}

module.exports = { createDurableUserWaitlist };
