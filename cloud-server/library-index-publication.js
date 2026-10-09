'use strict';

const { createAccessRuntime } = require('./access-runtime');
const { createLibraryBeatQuota, indexRows, LibraryQuotaError } = require('./library-beat-quota');
const { createProjectAccess } = require('./project-access');
const { createProjectUploadAuthority } = require('./project-upload-authority');

function fail(message, code) { throw new LibraryQuotaError(message, code); }
function messageId(value) {
  const id = Number(value || 0);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}
function directProjectPartId(part) {
  const explicit = messageId(part?.telegram_message_id);
  if (explicit) return explicit;
  const match = /^direct:(\d+)$/.exec(String(part?.telegram_file_id || ''));
  return messageId(match?.[1]);
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
  const projectUploads = transport.publishProjectFile && transport.verifyProjectMessage
    ? createProjectUploadAuthority({ pool, transport }) : null;
  const projects = createProjectAccess({ pool, projectUploads });

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
      await migrateLegacyProjects({ userId: row.user_id, chatId: row.telegram_chat_id });
    }
    const uninitialized = (await pool.query(`SELECT v.user_id,v.telegram_chat_id FROM vaults v
      LEFT JOIN library_quota_state s ON s.user_id=v.user_id WHERE s.user_id IS NULL`)).rows;
    for (const row of uninitialized) {
      await migrateLegacyProjects({ userId: row.user_id, chatId: row.telegram_chat_id });
    }
    return rows.length + uninitialized.length;
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

  async function publish({ userId, chatId, manifest, expectedMessageId, legacyMigration }) {
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

      let previousManifest = { beats: [], trash: [] };
      if (state) {
        if (currentId === expected) previousManifest = current.manifest;
        else {
          const raw = await transport.downloadMessageBuffer(chatId, expected);
          try { previousManifest = JSON.parse(raw.toString('utf8')); }
          catch { fail('Committed INDEX is unreadable.', 'LIBRARY_QUOTA_INDEX_INVALID'); }
          if (indexRows({ messageId: expected, raw, manifest: previousManifest, serverVerified: true }).sha256 !== state.index_sha256) {
            fail('Committed INDEX differs from the quota ledger.', 'LIBRARY_QUOTA_INDEX_CHANGED');
          }
        }
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

      if (legacyMigration?.size) {
        // Only the server's migration path supplies this map. The public INDEX
        // endpoint passes named fields and cannot opt into this exception.
        previousManifest = JSON.parse(JSON.stringify(previousManifest));
        const oldRows = new Map([
          ...(previousManifest.beats || []).map(row => [String(row.id), row]),
          ...(previousManifest.trash || []).map(item => [String(item?.beat?.id), item.beat]),
        ]);
        const newRows = new Map([
          ...(manifest.beats || []).map(row => [String(row.id), row]),
          ...(manifest.trash || []).map(item => [String(item?.beat?.id), item.beat]),
        ]);
        for (const [beatId, copies] of legacyMigration) {
          const oldRow = oldRows.get(beatId), newRow = newRows.get(beatId);
          const oldManifest = oldRow?.project?.manifest;
          const oldParts = oldManifest?.parts || (directProjectPartId(oldManifest)
            ? [{ telegram_message_id: directProjectPartId(oldManifest) }] : null);
          const newParts = newRow?.project?.manifest?.parts;
          if (!Array.isArray(oldParts) || !Array.isArray(newParts) ||
              oldParts.length !== copies.length || newParts.length !== copies.length ||
              newRow.project.manifest.legacy_master_copy !== true) {
            fail('Legacy PROJECT migration is invalid.', 'PROJECT_LEGACY_UNAVAILABLE');
          }
          for (let index = 0; index < copies.length; index += 1) {
            const copy = copies[index];
            if (Number(oldParts[index].telegram_message_id) !== copy.sourceMessageId ||
                Number(newParts[index].telegram_message_id) !== copy.messageId ||
                Number(newParts[index].size) !== copy.sizeBytes) {
              fail('Legacy PROJECT copy does not match INDEX.', 'PROJECT_LEGACY_UNAVAILABLE');
            }
            await transport.verifyLegacyProjectCopy({ chatId, beatId, ...copy });
            await client.query(`INSERT INTO library_legacy_project_copies
              (user_id,beat_id,part_index,source_message_id,message_id,telegram_document_id,size_bytes)
              VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
            [uid, beatId, index, copy.sourceMessageId, copy.messageId, copy.documentId, copy.sizeBytes]);
          }
          oldRow.project = newRow.project;
        }
      }
      await projects.verifyChanges({ client, userId: uid, chatId, previousManifest, candidateManifest: manifest });

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

  async function migrateLegacyProjectsOnce({ userId, chatId }) {
    await recover({ userId, chatId });
    let state = (await pool.query('SELECT index_message_id,index_sha256 FROM library_quota_state WHERE user_id=$1', [userId])).rows[0];
    if (!state) {
      if (!(await pinned(chatId))) return { status: 'uninitialized' };
      await quota.bootstrap(userId);
      state = (await pool.query('SELECT index_message_id,index_sha256 FROM library_quota_state WHERE user_id=$1', [userId])).rows[0];
    }
    const current = await pinned(chatId);
    if (current?.messageId !== Number(state.index_message_id) || current.sha256 !== state.index_sha256) {
      fail('Committed INDEX is required for legacy PROJECT migration.', 'PROJECT_LEGACY_UNAVAILABLE');
    }
    const candidate = JSON.parse(JSON.stringify(current.manifest));
    const rows = [
      ...(candidate.beats || []),
      ...(candidate.trash || []).map(item => item?.beat).filter(Boolean),
    ];
    const legacyMigration = new Map();
    for (const row of rows) {
      const project = row?.project;
      if (!project) continue;
      const manifest = project.manifest;
      const parts = manifest?.parts || (directProjectPartId(manifest) ? [{
        telegram_file_id: manifest.telegram_file_id,
        telegram_message_id: directProjectPartId(manifest),
        size: manifest.original_size,
        filename: manifest.filename,
        index: 0,
      }] : null);
      if (!Array.isArray(parts) || !parts.length) {
        fail('Legacy PROJECT parts are unavailable.', 'PROJECT_LEGACY_UNAVAILABLE');
      }
      manifest.parts = parts;
      const beatId = String(row.id);
      if (project.manifest.legacy_master_copy === true) {
        const receipts = (await pool.query(`SELECT part_index,message_id,size_bytes FROM library_legacy_project_copies
          WHERE user_id=$1 AND beat_id=$2`, [userId, beatId])).rows;
        if (parts.every((part, index) => receipts.some(receipt =>
          Number(receipt.part_index) === index &&
          Number(receipt.message_id) === Number(part.telegram_message_id) &&
          Number(receipt.size_bytes) === Number(part.size)))) continue;
      }
      if (parts.length === 1) {
        const receipt = (await pool.query(`SELECT 1 FROM library_project_uploads
          WHERE user_id=$1 AND beat_id=$2 AND message_id=$3`,
        [userId, beatId, Number(parts[0].telegram_message_id)])).rows[0];
        if (receipt) continue;
      }
      if (!transport.copyLegacyProjectPart || !transport.verifyLegacyProjectCopy) {
        fail('MASTER legacy PROJECT migration is unavailable.', 'PROJECT_LEGACY_UNAVAILABLE');
      }
      const copies = [];
      for (let index = 0; index < parts.length; index += 1) {
        const sourceMessageId = directProjectPartId(parts[index]);
        if (!Number.isSafeInteger(sourceMessageId) || sourceMessageId <= 0) {
          fail('Legacy PROJECT reference is invalid.', 'PROJECT_LEGACY_UNAVAILABLE');
        }
        const copy = await transport.copyLegacyProjectPart({ chatId, beatId, sourceMessageId, partIndex: index });
        if (!Number.isSafeInteger(copy?.messageId) || copy.messageId <= 0 ||
            !Number.isSafeInteger(copy.sizeBytes) || copy.sizeBytes <= 0 || !copy.documentId) {
          fail('MASTER did not copy the legacy PROJECT.', 'PROJECT_LEGACY_UNAVAILABLE');
        }
        copies.push(copy);
        parts[index] = { ...parts[index], telegram_message_id: copy.messageId,
          telegram_file_id: `direct:${copy.messageId}`, size: copy.sizeBytes };
      }
      const total = copies.reduce((sum, copy) => sum + copy.sizeBytes, 0);
      project.manifest.telegram_message_id = copies[0].messageId;
      project.manifest.telegram_file_id = `direct:${copies[0].messageId}`;
      project.manifest.original_size = total;
      project.manifest.legacy_master_copy = true;
      project.size = total;
      legacyMigration.set(beatId, copies);
    }
    if (!legacyMigration.size) return { status: 'current' };
    const result = await publish({ userId, chatId, manifest: candidate,
      expectedMessageId: current.messageId, legacyMigration });
    return { status: 'migrated', beatCount: legacyMigration.size, messageId: result.messageId };
  }

  async function migrateLegacyProjects(input) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await migrateLegacyProjectsOnce(input); }
      catch (error) {
        if (error?.code !== 'LIBRARY_QUOTA_INDEX_CHANGED' || attempt === 2) throw error;
      }
    }
  }

  return Object.freeze({ reserve, ensureBootstrap, recover, recoverAll, migrateLegacyProjects, renew: ({ userId, beatId }) =>
    quota.renew({ userId, reservationId: `new:${beatId}` }),
    cancel: ({ userId, beatId }) => quota.cancel({ userId, reservationId: `new:${beatId}` }),
    authorizeProject: ({ userId, declaredBytes }) => projects.authorize({ userId, declaredBytes }),
    uploadProject: async input => {
      if (!projectUploads) fail('PROJECT MASTER upload is unavailable.', 'PROJECT_ACCESS_UNAVAILABLE');
      const { maxBytes } = await projects.authorize({ userId: input.userId });
      return projectUploads.upload({ ...input, maxBytes });
    },
    publish, pinned, verifyCommitted });
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
  migrateLegacyProjects(input) {
    if (!configured) return { status: 'legacy-json-mode' };
    return configured.migrateLegacyProjects(input);
  },
  renew(input) {
    if (!configured) fail('Library quota requires PostgreSQL.', 'LIBRARY_QUOTA_UNAVAILABLE');
    return configured.renew(input);
  },
  cancel(input) {
    if (!configured) fail('Library quota requires PostgreSQL.', 'LIBRARY_QUOTA_UNAVAILABLE');
    return configured.cancel(input);
  },
  authorizeProject(input) {
    if (!configured) fail('PROJECT Access requires PostgreSQL.', 'PROJECT_ACCESS_UNAVAILABLE');
    return configured.authorizeProject(input);
  },
  uploadProject(input) {
    if (!configured) fail('PROJECT Access requires PostgreSQL.', 'PROJECT_ACCESS_UNAVAILABLE');
    return configured.uploadProject(input);
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
