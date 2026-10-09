'use strict';

const { createAccessRuntime } = require('./access-runtime');
const { createLibraryBeatQuota, indexRows, LibraryQuotaError } = require('./library-beat-quota');

function fail(message, code) { throw new LibraryQuotaError(message, code); }
function messageId(value) {
  const id = Number(value || 0);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}
function deletedIds(manifest) {
  return new Set((Array.isArray(manifest.deleted) ? manifest.deleted : [])
    .map(row => String(row?.beat_id || row?.id || '').trim()).filter(Boolean));
}

function createLibraryIndexPublication({ pool, transport, readIndex } = {}) {
  if (!pool?.connect || !transport?.getPinnedMessage || !transport?.publishIndexBuffer || !transport?.downloadMessageBuffer) {
    throw new Error('PostgreSQL and MASTER INDEX transport are required.');
  }
  const quota = createLibraryBeatQuota({ pool, ...(readIndex ? { readIndex } : {}) });

  async function pinned(chatId) {
    const pin = transport.readPinnedIndexBuffer
      ? await transport.readPinnedIndexBuffer(chatId)
      : await transport.getPinnedMessage(chatId);
    if (!pin) return null;
    const id = messageId(pin.message_id);
    const caption = String(pin.caption || '');
    if (!id || !(caption === 'BEATGALER_LIBRARY_INDEX_V1' || caption.startsWith('BEATGALER_LIBRARY_INDEX_V1\n'))) {
      fail('Pinned INDEX is not a valid library document.', 'LIBRARY_QUOTA_INDEX_UNVERIFIED');
    }
    const raw = pin.raw || await transport.downloadMessageBuffer(chatId, id);
    if (!pin.raw) {
      const checked = await transport.getPinnedMessage(chatId);
      if (messageId(checked?.message_id) !== id || String(checked?.caption || '') !== String(pin.caption || '')) {
        fail('Pinned INDEX changed while it was being read.', 'LIBRARY_QUOTA_INDEX_CHANGED');
      }
    }
    let manifest;
    try { manifest = JSON.parse(raw.toString('utf8')); }
    catch { fail('Pinned INDEX is unreadable.', 'LIBRARY_QUOTA_INDEX_INVALID'); }
    return { ...indexRows({ messageId: id, raw, manifest, serverVerified: true }), manifest };
  }

  async function cleanupPrevious(chatId, previousId, currentId) {
    if (!previousId || previousId === currentId) return;
    try { await transport.deleteMessages(chatId, [previousId]); }
    catch (error) {
      // Telegram may have deleted the copy before the acknowledgement was lost.
      try { await transport.downloadMessageBuffer(chatId, previousId); }
      catch (checkError) {
        if (/no downloadable media|not found|message.*missing|MESSAGE_ID_INVALID/i.test(String(checkError?.message || ''))) return;
        throw error;
      }
      throw error;
    }
  }

  async function reserve({ userId, beatId }) {
    // A brand-new vault has no INDEX yet. Its empty INDEX is initialized by
    // publish; imports wait for that bootstrap to finish.
    await quota.bootstrap(userId);
    return quota.reserve({ userId, beatId, reservationId: `new:${beatId}`, retryDenied: true });
  }

  async function ensureBootstrap(userId) {
    const state = (await pool.query('SELECT 1 FROM library_quota_state WHERE user_id=$1', [String(userId || '').trim()])).rows[0];
    if (!state) await quota.bootstrap(userId);
  }

  async function recover({ userId, chatId }) {
    const uid = String(userId || '').trim();
    const client = await pool.connect();
    let orphanId = 0;
    let storedId = 0;
    try {
      await client.query('BEGIN');
      const owner = (await client.query('SELECT id FROM vaults WHERE user_id=$1 AND telegram_chat_id=$2 FOR UPDATE',
        [uid, String(chatId)])).rows[0];
      if (!owner) fail('Vault ownership could not be verified.', 'LIBRARY_QUOTA_INDEX_UNVERIFIED');
      const state = (await client.query('SELECT index_message_id,index_sha256 FROM library_quota_state WHERE user_id=$1 FOR UPDATE',
        [uid])).rows[0];
      if (!state) { await client.query('COMMIT'); return { status: 'uninitialized' }; }
      storedId = Number(state.index_message_id);
      let current = null;
      try { current = await pinned(chatId); }
      catch (error) {
        if (!['LIBRARY_QUOTA_INDEX_UNVERIFIED', 'LIBRARY_QUOTA_INDEX_INVALID'].includes(error?.code)) throw error;
      }
      if (current?.messageId === Number(state.index_message_id) && current.sha256 === state.index_sha256) {
        await client.query('COMMIT');
        return { status: 'current' };
      }
      if (typeof transport.pinExistingIndexMessage !== 'function') {
        fail('MASTER cannot restore the previous INDEX.', 'LIBRARY_QUOTA_INDEX_CHANGED');
      }
      const raw = await transport.downloadMessageBuffer(chatId, Number(state.index_message_id));
      let manifest;
      try { manifest = JSON.parse(raw.toString('utf8')); }
      catch { fail('Stored INDEX is unreadable.', 'LIBRARY_QUOTA_INDEX_INVALID'); }
      const stored = indexRows({ messageId: Number(state.index_message_id), raw, manifest, serverVerified: true });
      if (stored.sha256 !== state.index_sha256) {
        fail('Stored INDEX differs from quota ledger.', 'LIBRARY_QUOTA_INDEX_CHANGED');
      }
      orphanId = current?.messageId || 0;
      await transport.pinExistingIndexMessage(chatId, Number(state.index_message_id));
      const restored = await pinned(chatId);
      if (restored?.messageId !== Number(state.index_message_id) || restored.sha256 !== state.index_sha256) {
        fail('INDEX restore could not be verified.', 'LIBRARY_QUOTA_INDEX_CHANGED');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
    if (orphanId && orphanId !== storedId) {
      await transport.deleteMessages(chatId, [orphanId]).catch(() => {});
    }
    return { status: 'restored' };
  }

  async function recoverAll() {
    const rows = (await pool.query(`SELECT s.user_id,v.telegram_chat_id,s.index_message_id,
      p.predecessor_message_id FROM library_quota_state s JOIN vaults v ON v.user_id=s.user_id
      LEFT JOIN vault_index_pointers p ON p.vault_id=v.id`)).rows;
    for (const row of rows) {
      await recover({ userId: row.user_id, chatId: row.telegram_chat_id });
      await cleanupPrevious(row.telegram_chat_id, Number(row.predecessor_message_id || 0), Number(row.index_message_id));
    }
    return rows.length;
  }

  async function verifyCommitted({ userId, chatId, messageId: requested }) {
    const current = await pinned(chatId);
    const state = (await pool.query('SELECT index_message_id,index_sha256 FROM library_quota_state WHERE user_id=$1',
      [String(userId || '').trim()])).rows[0];
    if (!state || current?.messageId !== messageId(requested) ||
        Number(state.index_message_id) !== current.messageId || state.index_sha256 !== current.sha256) {
      fail('INDEX is not committed in the quota ledger.', 'LIBRARY_QUOTA_INDEX_CHANGED');
    }
  }

  async function publish({ userId, chatId, manifest, expectedMessageId }) {
    if (!manifest || manifest.version !== 2) fail('Invalid library INDEX version.', 'LIBRARY_QUOTA_INDEX_INVALID');
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (!bytes.length || bytes.length > 16 * 1024 * 1024) fail('Library INDEX is too large.', 'LIBRARY_QUOTA_INDEX_INVALID');
    const candidate = indexRows({ messageId: 1, raw: bytes, manifest, serverVerified: true });
    const expected = messageId(expectedMessageId);
    const uid = String(userId || '').trim();
    if (!(await pool.query('SELECT 1 FROM library_quota_state WHERE user_id=$1', [uid])).rows[0]) {
      if (await pinned(chatId)) await quota.bootstrap(uid);
    }
    const client = await pool.connect();
    let publishedId = 0;
    let previousId = 0;
    try {
      await client.query('BEGIN');
      const owner = (await client.query('SELECT id,telegram_chat_id FROM vaults WHERE user_id=$1 FOR UPDATE', [uid])).rows[0];
      if (!owner || String(owner.telegram_chat_id) !== String(chatId)) {
        fail('Vault ownership could not be verified.', 'LIBRARY_QUOTA_INDEX_UNVERIFIED');
      }
      const state = (await client.query('SELECT * FROM library_quota_state WHERE user_id=$1 FOR UPDATE', [uid])).rows[0];
      const current = await pinned(chatId);
      const currentId = current?.messageId || 0;
      if (state && state.index_sha256 === candidate.sha256 && Number(state.index_message_id) === currentId) {
        const prior = (await client.query('SELECT predecessor_message_id FROM vault_index_pointers WHERE vault_id=$1',
          [owner.id])).rows[0];
        const knownPreviousId = Number(prior?.predecessor_message_id || 0);
        await client.query('COMMIT');
        await cleanupPrevious(chatId, knownPreviousId, currentId);
        return { messageId: currentId, previousMessageId: knownPreviousId, beatCount: manifest.beats.length, status: 'same' };
      }
      if (state) {
        if (Number(state.index_message_id) !== expected) fail('Library INDEX changed.', 'LIBRARY_QUOTA_INDEX_CHANGED');
        // If MASTER pinned and the process died before SQL COMMIT, a retry may
        // finish the same candidate; no second Telegram document is created.
        if (currentId !== expected && current?.sha256 !== candidate.sha256) {
          fail('Pinned INDEX changed outside this publication.', 'LIBRARY_QUOTA_INDEX_CHANGED');
        }
        if (currentId === expected && current.sha256 !== state.index_sha256) {
          fail('Pinned INDEX differs from the quota ledger.', 'LIBRARY_QUOTA_INDEX_CHANGED');
        }
      } else if (expected || currentId || candidate.rows.size) {
        fail('Library quota bootstrap is required.', 'LIBRARY_QUOTA_UNINITIALIZED');
      }

      const old = new Map((await client.query('SELECT beat_id,state FROM library_beats WHERE user_id=$1', [uid])).rows
        .map(row => [String(row.beat_id), String(row.state)]));
      const tombstones = deletedIds(manifest);
      for (const id of old.keys()) {
        if (!candidate.rows.has(id) && (!tombstones.has(id) || old.get(id) !== 'TRASH')) {
          fail('Only a tombstoned Trash beat may leave the INDEX.', 'LIBRARY_QUOTA_INDEX_INVALID');
        }
      }
      const fresh = [...candidate.rows.keys()].filter(id => !old.has(id));
      if (fresh.length) {
        const access = await createAccessRuntime({ pool: client }).resolveUserAccess({ id: uid });
        const limit = access.quotas.max_beats;
        const pending = Number((await client.query(`SELECT count(*)::int AS n FROM library_beat_reservations
          WHERE user_id=$1 AND state='PENDING' AND expires_at>now()`, [uid])).rows[0].n);
        if (limit !== null && (old.size >= limit || old.size + fresh.length > limit || old.size + pending > limit)) {
          fail('Beat quota exceeded.', 'LIBRARY_QUOTA_EXCEEDED');
        }
        for (const id of fresh) {
          const reservation = (await client.query(`SELECT state,expires_at FROM library_beat_reservations
            WHERE user_id=$1 AND id=$2 AND beat_id=$3 FOR UPDATE`, [uid, `new:${id}`, id])).rows[0];
          if (!reservation || reservation.state !== 'PENDING' || new Date(reservation.expires_at) <= new Date()) {
            fail('New INDEX identity has no live reservation.', 'LIBRARY_QUOTA_RESERVATION_NOT_FOUND');
          }
        }
      }

      previousId = expected;
      if (current?.sha256 === candidate.sha256 && currentId !== expected) {
        publishedId = currentId;
      } else {
        const written = await transport.publishIndexBuffer({ chatId, bytes, caption: 'BEATGALER_LIBRARY_INDEX_V1' });
        publishedId = messageId(written?.messageId);
        if (!publishedId) fail('MASTER returned no INDEX message.', 'LIBRARY_QUOTA_INDEX_UNVERIFIED');
        const verified = await pinned(chatId);
        if (verified?.messageId !== publishedId || verified.sha256 !== candidate.sha256) {
          fail('Published INDEX could not be verified.', 'LIBRARY_QUOTA_INDEX_UNVERIFIED');
        }
      }
      if (!state) {
        await client.query('INSERT INTO library_quota_state(user_id,index_message_id,index_sha256) VALUES($1,$2,$3)',
          [uid, publishedId, candidate.sha256]);
      } else {
        await client.query('UPDATE library_quota_state SET index_message_id=$2,index_sha256=$3 WHERE user_id=$1',
          [uid, publishedId, candidate.sha256]);
      }
      for (const [id, status] of candidate.rows) {
        if (old.has(id)) {
          if (old.get(id) !== status) await client.query('UPDATE library_beats SET state=$3,updated_at=now() WHERE user_id=$1 AND beat_id=$2', [uid, id, status]);
        } else {
          await client.query('INSERT INTO library_beats(user_id,beat_id,state,reservation_id) VALUES($1,$2,$3,$4)',
            [uid, id, status, `new:${id}`]);
          await client.query("UPDATE library_beat_reservations SET state='COMMITTED',updated_at=now() WHERE user_id=$1 AND id=$2", [uid, `new:${id}`]);
        }
      }
      for (const id of old.keys()) if (!candidate.rows.has(id)) {
        await client.query('DELETE FROM library_beats WHERE user_id=$1 AND beat_id=$2', [uid, id]);
      }
      await client.query(`INSERT INTO vault_index_pointers(vault_id,index_message_id,predecessor_message_id,revision,source)
        VALUES($1,$2,$3,1,'publish') ON CONFLICT(vault_id) DO UPDATE SET
        index_message_id=$2,predecessor_message_id=$3,revision=vault_index_pointers.revision+1,
        source='publish',verified_at=now(),updated_at=now()`, [owner.id, publishedId, expected || null]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
    // Old copies are removed only after the quota ledger and pointer commit.
    await cleanupPrevious(chatId, previousId, publishedId);
    return { messageId: publishedId, previousMessageId: previousId, beatCount: manifest.beats.length, status: 'published' };
  }

  return Object.freeze({ reserve, ensureBootstrap, recover, recoverAll, renew: ({ userId, beatId }) =>
    quota.renew({ userId, reservationId: `new:${beatId}` }), publish, pinned, verifyCommitted });
}

let configured = null;
module.exports = {
  createLibraryIndexPublication,
  configure({ pool, transport }) {
    configured = pool ? createLibraryIndexPublication({ pool, transport }) : null;
  },
  reserve(input) {
    if (!configured) fail('Library quota requires PostgreSQL.', 'LIBRARY_QUOTA_UNAVAILABLE');
    return configured.reserve(input);
  },
  ensureBootstrap(userId) {
    if (!configured) fail('Library quota requires PostgreSQL.', 'LIBRARY_QUOTA_UNAVAILABLE');
    return configured.ensureBootstrap(userId);
  },
  recover(input) {
    if (!configured) fail('Library quota requires PostgreSQL.', 'LIBRARY_QUOTA_UNAVAILABLE');
    return configured.recover(input);
  },
  recoverAll() {
    if (!configured) fail('Library quota requires PostgreSQL.', 'LIBRARY_QUOTA_UNAVAILABLE');
    return configured.recoverAll();
  },
  renew(input) {
    if (!configured) fail('Library quota requires PostgreSQL.', 'LIBRARY_QUOTA_UNAVAILABLE');
    return configured.renew(input);
  },
  publish(input) {
    if (!configured) fail('Library quota requires PostgreSQL.', 'LIBRARY_QUOTA_UNAVAILABLE');
    return configured.publish(input);
  },
  verifyCommitted(input) {
    if (!configured) fail('Library quota requires PostgreSQL.', 'LIBRARY_QUOTA_UNAVAILABLE');
    return configured.verifyCommitted(input);
  },
  _resetForTests() { configured = null; },
};
