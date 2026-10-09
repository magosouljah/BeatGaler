'use strict';

const crypto = require('node:crypto');
const { createAccessRuntime } = require('./access-runtime');

const RESERVATION_TTL_MS = 15 * 60_000;

class LibraryQuotaError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LibraryQuotaError';
    this.code = code;
  }
}

function requiredId(value, label) {
  const id = String(value || '').trim();
  if (!id || id.length > 256) throw new LibraryQuotaError(`${label} is required.`, 'LIBRARY_QUOTA_INVALID_INPUT');
  return id;
}

function indexRows(observation) {
  const messageId = Number(observation?.messageId);
  if (observation?.serverVerified !== true || !Number.isSafeInteger(messageId) || messageId <= 0) {
    throw new LibraryQuotaError('A server-verified pinned INDEX is required.', 'LIBRARY_QUOTA_INDEX_UNVERIFIED');
  }
  const manifest = observation.manifest;
  if (!manifest || manifest.schema !== 'beatgaler.telegram.library' || !Array.isArray(manifest.beats)
    || (manifest.trash !== undefined && !Array.isArray(manifest.trash))) {
    throw new LibraryQuotaError('Pinned INDEX has an invalid library shape.', 'LIBRARY_QUOTA_INDEX_INVALID');
  }
  const rows = new Map();
  for (const item of manifest.beats) {
    const id = requiredId(item?.id, 'INDEX beat ID');
    if (rows.has(id)) throw new LibraryQuotaError('Beat appears more than once in INDEX.', 'LIBRARY_QUOTA_INDEX_INVALID');
    rows.set(id, 'ACTIVE');
  }
  for (const item of manifest.trash || []) {
    const id = requiredId(item?.beat?.id, 'INDEX Trash beat ID');
    if (rows.has(id)) throw new LibraryQuotaError('Beat appears more than once in INDEX.', 'LIBRARY_QUOTA_INDEX_INVALID');
    rows.set(id, 'TRASH');
  }
  const bytes = observation.raw || Buffer.from(JSON.stringify(manifest));
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return { messageId, sha256, rows };
}

async function readTelegramLibraryIndex(userId, { client, transport = require('./direct-transport-control') }) {
  const vault = (await client.query('SELECT telegram_chat_id FROM vaults WHERE user_id=$1', [userId])).rows[0];
  if (!vault?.telegram_chat_id) throw new LibraryQuotaError('User vault is unavailable.', 'LIBRARY_QUOTA_INDEX_UNVERIFIED');
  const chatId = vault.telegram_chat_id;
  const pinned = transport.readPinnedIndexBuffer
    ? await transport.readPinnedIndexBuffer(chatId)
    : await transport.getPinnedMessage(chatId);
  const caption = String(pinned?.caption || '');
  if (!pinned?.message_id || !(caption === 'BEATGALER_LIBRARY_INDEX_V1' || caption.startsWith('BEATGALER_LIBRARY_INDEX_V1\n'))) {
    throw new LibraryQuotaError('Pinned library INDEX is unavailable.', 'LIBRARY_QUOTA_INDEX_UNVERIFIED');
  }
  const raw = pinned.raw || await transport.downloadMessageBuffer(chatId, pinned.message_id);
  if (!pinned.raw) {
    const checked = await transport.getPinnedMessage(chatId);
    if (Number(checked?.message_id) !== Number(pinned.message_id) || String(checked?.caption || '') !== caption) {
      throw new LibraryQuotaError('Pinned INDEX changed during bootstrap.', 'LIBRARY_QUOTA_INDEX_CHANGED');
    }
  }
  let manifest;
  try { manifest = JSON.parse(raw.toString('utf8')); }
  catch { throw new LibraryQuotaError('Pinned INDEX is unreadable.', 'LIBRARY_QUOTA_INDEX_INVALID'); }
  return { messageId: Number(pinned.message_id), raw, manifest, serverVerified: true };
}

function createLibraryBeatQuota({ pool, readIndex = readTelegramLibraryIndex, now = Date.now, reservationTtlMs = RESERVATION_TTL_MS } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('PostgreSQL pool is required for library quota.');
  if (typeof readIndex !== 'function' || !Number.isSafeInteger(reservationTtlMs) || reservationTtlMs <= 0) {
    throw new Error('Valid server INDEX reader and reservation TTL are required.');
  }

  function instant() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('Valid server time is required.');
    return date;
  }

  async function transaction(userId, callback) {
    const uid = requiredId(userId, 'userId');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client, uid);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function stateLock(client, userId) {
    const row = (await client.query('SELECT * FROM library_quota_state WHERE user_id=$1 FOR UPDATE', [userId])).rows[0];
    if (!row) throw new LibraryQuotaError('Library quota is not initialized.', 'LIBRARY_QUOTA_UNINITIALIZED');
    return row;
  }

  async function expire(client, userId, at) {
    await client.query(`UPDATE library_beat_reservations SET state='EXPIRED',updated_at=$2
      WHERE user_id=$1 AND state='PENDING' AND expires_at <= $2`, [userId, at]);
  }

  async function snapshot(client, userId, at, ready = true) {
    const access = await createAccessRuntime({ pool: client, now: () => at }).resolveUserAccess({ id: userId });
    const limit = access.quotas.max_beats;
    if (!ready) return { ready: false, initialized: false, used: 0, active: 0, trash: 0, pending: 0,
      occupied: 0, limit, remaining: 0, overQuota: false };
    const beats = (await client.query(`SELECT count(*)::int AS used,
      count(*) FILTER (WHERE state='ACTIVE')::int AS active,
      count(*) FILTER (WHERE state='TRASH')::int AS trash
      FROM library_beats WHERE user_id=$1`, [userId])).rows[0];
    const pending = Number((await client.query("SELECT count(*)::int AS n FROM library_beat_reservations WHERE user_id=$1 AND state='PENDING'", [userId])).rows[0].n);
    const used = Number(beats.used);
    const occupied = used + pending;
    return { ready: true, initialized: true, used, active: Number(beats.active), trash: Number(beats.trash),
      pending, occupied, limit, remaining: limit === null ? null : Math.max(0, limit - occupied),
      overQuota: limit !== null && occupied > limit };
  }

  async function bootstrap(userId) {
    return transaction(userId, async (client, uid) => {
      // The user row serializes concurrent first bootstraps, including the case
      // where library_quota_state has no row to lock yet.
      const user = await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [uid]);
      if (!user.rows[0]) throw new LibraryQuotaError('User does not exist.', 'LIBRARY_QUOTA_INVALID_INPUT');
      const observation = await readIndex(uid, { client });
      const index = indexRows(observation);
      const existing = (await client.query('SELECT * FROM library_quota_state WHERE user_id=$1 FOR UPDATE', [uid])).rows[0];
      if (existing) {
        if (Number(existing.index_message_id) !== index.messageId || existing.index_sha256 !== index.sha256) {
          throw new LibraryQuotaError('INDEX changed after quota bootstrap; reconciliation is required.', 'LIBRARY_QUOTA_INDEX_CHANGED');
        }
        await expire(client, uid, instant());
        return snapshot(client, uid, instant());
      }
      await client.query('INSERT INTO library_quota_state(user_id,index_message_id,index_sha256) VALUES($1,$2,$3)',
        [uid, index.messageId, index.sha256]);
      for (const [beatId, state] of index.rows) {
        await client.query('INSERT INTO library_beats(user_id,beat_id,state) VALUES($1,$2,$3)', [uid, beatId, state]);
      }
      for (const row of observation.manifest?.deleted || []) {
        const beatId = requiredId(row?.beat_id || row?.id, 'INDEX tombstone ID');
        if (index.rows.has(beatId)) throw new LibraryQuotaError('Tombstoned beat is still in INDEX.', 'LIBRARY_QUOTA_INDEX_INVALID');
        await client.query(`INSERT INTO library_trash_purges
          (user_id,beat_id,operation_id,state,asset_message_ids,beat_sha256)
          VALUES($1,$2,$3,'LEGACY_TOMBSTONE',ARRAY[]::bigint[],$4) ON CONFLICT DO NOTHING`,
        [uid, beatId, `purge:${beatId}`, crypto.createHash('sha256').update(JSON.stringify(null)).digest('hex')]);
      }
      return snapshot(client, uid, instant());
    });
  }

  async function usage(userId) {
    return transaction(userId, async (client, uid) => {
      const row = (await client.query('SELECT user_id FROM library_quota_state WHERE user_id=$1 FOR UPDATE', [uid])).rows[0];
      const at = instant();
      if (row) await expire(client, uid, at);
      return snapshot(client, uid, at, Boolean(row));
    });
  }

  async function reserve({ userId, beatId, reservationId, retryDenied = false }) {
    const bid = requiredId(beatId, 'beatId');
    const rid = requiredId(reservationId, 'reservationId');
    const result = await transaction(userId, async (client, uid) => {
      await stateLock(client, uid);
      if ((await client.query('SELECT 1 FROM library_trash_purges WHERE user_id=$1 AND beat_id=$2', [uid, bid])).rows[0]) {
        throw new LibraryQuotaError('Permanently purged beat identity cannot be reused.', 'LIBRARY_PURGE_TOMBSTONE');
      }
      const at = instant();
      await expire(client, uid, at);
      const existing = (await client.query('SELECT * FROM library_beat_reservations WHERE user_id=$1 AND id=$2', [uid, rid])).rows[0];
      if (existing) {
        if (existing.beat_id !== bid) {
          throw new LibraryQuotaError('Reservation identity belongs to another beat or user.', 'LIBRARY_QUOTA_IDENTITY_CONFLICT');
        }
        if (existing.state === 'DENIED' && !retryDenied) {
          return { reservationId: rid, beatId: bid, status: 'DENIED' };
        }
        if (existing.state === 'PENDING' || existing.state === 'COMMITTED') {
          return { reservationId: rid, beatId: bid, status: existing.state, expiresAt: existing.expires_at,
            usage: await snapshot(client, uid, at) };
        }
      }
      const beat = (await client.query('SELECT beat_id FROM library_beats WHERE user_id=$1 AND beat_id=$2', [uid, bid])).rows[0];
      if (beat) throw new LibraryQuotaError('Beat identity already exists.', 'LIBRARY_QUOTA_BEAT_EXISTS');
      const pendingBeat = (await client.query("SELECT id FROM library_beat_reservations WHERE user_id=$1 AND beat_id=$2 AND state='PENDING'", [uid, bid])).rows[0];
      if (pendingBeat) throw new LibraryQuotaError('Beat identity is already reserved.', 'LIBRARY_QUOTA_BEAT_RESERVED');
      const before = await snapshot(client, uid, at);
      if (before.limit !== null && before.occupied >= before.limit) {
        if (existing) await client.query(`UPDATE library_beat_reservations SET state='DENIED',expires_at=$3,
          denial_reason='LIBRARY_QUOTA_EXCEEDED',updated_at=$3 WHERE user_id=$1 AND id=$2`, [uid, rid, at]);
        else await client.query(`INSERT INTO library_beat_reservations(id,user_id,beat_id,state,expires_at,denial_reason)
          VALUES($1,$2,$3,'DENIED',$4,'LIBRARY_QUOTA_EXCEEDED')`, [rid, uid, bid, at]);
        return { reservationId: rid, beatId: bid, status: 'DENIED' };
      }
      const expiresAt = new Date(at.getTime() + reservationTtlMs);
      if (existing) await client.query(`UPDATE library_beat_reservations SET state='PENDING',expires_at=$3,
        denial_reason=NULL,updated_at=$4 WHERE user_id=$1 AND id=$2`, [uid, rid, expiresAt, at]);
      else await client.query(`INSERT INTO library_beat_reservations(id,user_id,beat_id,state,expires_at)
        VALUES($1,$2,$3,'PENDING',$4)`, [rid, uid, bid, expiresAt]);
      return { reservationId: rid, beatId: bid, status: 'PENDING', expiresAt, usage: await snapshot(client, uid, at) };
    });
    if (result.status === 'DENIED') throw new LibraryQuotaError('Beat quota exceeded.', 'LIBRARY_QUOTA_EXCEEDED');
    return result;
  }

  async function renew({ userId, reservationId }) {
    const rid = requiredId(reservationId, 'reservationId');
    return transaction(userId, async (client, uid) => {
      await stateLock(client, uid);
      const at = instant();
      await expire(client, uid, at);
      const row = (await client.query('SELECT beat_id,state FROM library_beat_reservations WHERE user_id=$1 AND id=$2 FOR UPDATE', [uid, rid])).rows[0];
      if (!row || row.state !== 'PENDING') throw new LibraryQuotaError('Reservation is no longer pending.', 'LIBRARY_QUOTA_RESERVATION_CLOSED');
      const expiresAt = new Date(at.getTime() + reservationTtlMs);
      await client.query('UPDATE library_beat_reservations SET expires_at=$3,updated_at=$4 WHERE user_id=$1 AND id=$2',
        [uid, rid, expiresAt, at]);
      return { reservationId: rid, beatId: row.beat_id, status: 'PENDING', expiresAt };
    });
  }

  async function confirm({ userId, reservationId }) {
    const rid = requiredId(reservationId, 'reservationId');
    const result = await transaction(userId, async (client, uid) => {
      await stateLock(client, uid);
      const at = instant();
      await expire(client, uid, at);
      const row = (await client.query('SELECT * FROM library_beat_reservations WHERE user_id=$1 AND id=$2 FOR UPDATE', [uid, rid])).rows[0];
      if (!row) throw new LibraryQuotaError('Reservation not found.', 'LIBRARY_QUOTA_RESERVATION_NOT_FOUND');
      if (row.state === 'COMMITTED') return { reservationId: rid, beatId: row.beat_id, status: row.state, usage: await snapshot(client, uid, at) };
      if (row.state === 'DENIED') throw new LibraryQuotaError('Beat quota exceeded.', 'LIBRARY_QUOTA_EXCEEDED');
      if (row.state !== 'PENDING') throw new LibraryQuotaError('Reservation is no longer pending.', 'LIBRARY_QUOTA_RESERVATION_CLOSED');
      const before = await snapshot(client, uid, at);
      if (before.limit !== null && (before.used >= before.limit || before.occupied > before.limit)) {
        await client.query("UPDATE library_beat_reservations SET state='DENIED',denial_reason='LIBRARY_QUOTA_EXCEEDED',updated_at=$2 WHERE id=$1 AND user_id=$3", [rid, at, uid]);
        return { reservationId: rid, beatId: row.beat_id, status: 'DENIED' };
      }
      await client.query(`INSERT INTO library_beats(user_id,beat_id,state,reservation_id)
        VALUES($1,$2,'ACTIVE',$3)`, [uid, row.beat_id, rid]);
      await client.query("UPDATE library_beat_reservations SET state='COMMITTED',updated_at=$2 WHERE id=$1 AND user_id=$3", [rid, at, uid]);
      return { reservationId: rid, beatId: row.beat_id, status: 'COMMITTED', usage: await snapshot(client, uid, at) };
    });
    if (result.status === 'DENIED') throw new LibraryQuotaError('Beat quota exceeded.', 'LIBRARY_QUOTA_EXCEEDED');
    return result;
  }

  async function cancel({ userId, reservationId }) {
    const rid = requiredId(reservationId, 'reservationId');
    return transaction(userId, async (client, uid) => {
      await stateLock(client, uid);
      const at = instant();
      await expire(client, uid, at);
      const row = (await client.query('SELECT * FROM library_beat_reservations WHERE user_id=$1 AND id=$2 FOR UPDATE', [uid, rid])).rows[0];
      if (!row) throw new LibraryQuotaError('Reservation not found.', 'LIBRARY_QUOTA_RESERVATION_NOT_FOUND');
      if (row.state === 'PENDING') await client.query("UPDATE library_beat_reservations SET state='CANCELED',updated_at=$2 WHERE id=$1 AND user_id=$3", [rid, at, uid]);
      else if (row.state === 'COMMITTED') throw new LibraryQuotaError('Committed beat cannot be canceled.', 'LIBRARY_QUOTA_RESERVATION_CLOSED');
      return { reservationId: rid, beatId: row.beat_id, status: row.state === 'PENDING' ? 'CANCELED' : row.state,
        usage: await snapshot(client, uid, at) };
    });
  }

  async function setBeatState({ userId, beatId, state }) {
    const bid = requiredId(beatId, 'beatId');
    return transaction(userId, async (client, uid) => {
      await stateLock(client, uid);
      const result = await client.query('UPDATE library_beats SET state=$3,updated_at=$4 WHERE user_id=$1 AND beat_id=$2 RETURNING beat_id',
        [uid, bid, state, instant()]);
      if (!result.rows[0]) throw new LibraryQuotaError('Beat identity not found.', 'LIBRARY_QUOTA_BEAT_NOT_FOUND');
      return snapshot(client, uid, instant());
    });
  }

  return Object.freeze({ bootstrap, usage, reserve, renew, confirm, cancel,
    moveToTrash: input => setBeatState({ ...input, state: 'TRASH' }),
    restore: input => setBeatState({ ...input, state: 'ACTIVE' }),
  });
}

module.exports = { LibraryQuotaError, createLibraryBeatQuota, readTelegramLibraryIndex, indexRows, RESERVATION_TTL_MS };
