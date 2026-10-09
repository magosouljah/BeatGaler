'use strict';

const { createAccessRuntime } = require('./access-runtime');
const { createLibraryBeatQuota, indexRows, LibraryQuotaError } = require('./library-beat-quota');
const { createProjectAccess } = require('./project-access');
const { createProjectUploadAuthority } = require('./project-upload-authority');
const { beatAssets, beatHash, messageIds } = require('./library-trash-assets');

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
    // Existing vaults must enter the quota-state lock directly: reading a pin
    // during an in-flight purge could observe Telegram before PostgreSQL COMMIT.
    if (!(await pool.query('SELECT 1 FROM library_quota_state WHERE user_id=$1', [String(userId || '').trim()])).rows[0]) {
      await quota.bootstrap(userId);
    }
    return quota.reserve({ userId, beatId, reservationId: `new:${beatId}`, retryDenied: true });
  }

  async function ensureBootstrap(userId) {
    const state = (await pool.query('SELECT 1 FROM library_quota_state WHERE user_id=$1', [String(userId || '').trim()])).rows[0];
    if (!state) await quota.bootstrap(userId);
  }

  async function preserveLegacyTombstones(client, userId, manifest) {
    for (const id of deletedIds(manifest)) {
      if ([...(manifest.beats || []).map(row => String(row?.id)),
        ...(manifest.trash || []).map(item => String(item?.beat?.id))].includes(id)) {
        fail('Tombstoned beat is still in INDEX.', 'LIBRARY_QUOTA_INDEX_INVALID');
      }
      await client.query(`INSERT INTO library_trash_purges
        (user_id,beat_id,operation_id,state,asset_message_ids,beat_sha256)
        VALUES($1,$2,$3,'LEGACY_TOMBSTONE',ARRAY[]::bigint[],$4) ON CONFLICT DO NOTHING`,
      [userId, id, `purge:${id}`, beatHash(null)]);
    }
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
        await preserveLegacyTombstones(client, uid, current.manifest);
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
      await preserveLegacyTombstones(client, uid, manifest);
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
      const pending = (await pool.query("SELECT beat_id FROM library_trash_purges WHERE user_id=$1 AND state='PENDING'",
        [row.user_id])).rows.map(item => item.beat_id);
      if (pending.length) {
        try { await purgeTrash({ userId: row.user_id, chatId: row.telegram_chat_id, beatIds: pending }); }
        catch (error) { console.warn('[library-purge] pending purge remains retryable:', row.user_id, error?.code || error?.message); }
      }
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

  async function publish({ userId, chatId, manifest, expectedMessageId, legacyMigration, purgeIds }) {
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
      const priorTombstones = deletedIds(previousManifest);
      const requestedPurges = new Set(purgeIds || []);
      const removed = [...old.keys()].filter(id => !candidate.rows.has(id));
      if (removed.length !== requestedPurges.size || removed.some(id => !requestedPurges.has(id))) {
        fail('Only a server-verified purge may remove a beat.', 'LIBRARY_PURGE_REQUIRED');
      }
      for (const id of priorTombstones) if (!tombstones.has(id)) {
        fail('INDEX cannot discard a permanent tombstone.', 'LIBRARY_PURGE_TOMBSTONE');
      }
      for (const id of tombstones) if (!priorTombstones.has(id) && !requestedPurges.has(id)) {
        fail('Only a confirmed purge may add a tombstone.', 'LIBRARY_PURGE_TOMBSTONE');
      }
      const purgeRows = (await client.query('SELECT beat_id,state,asset_message_ids,beat_sha256 FROM library_trash_purges WHERE user_id=$1 FOR UPDATE', [uid])).rows;
      const purgeById = new Map(purgeRows.map(row => [String(row.beat_id), row]));
      for (const id of candidate.rows.keys()) if (
          (purgeById.get(id) && purgeById.get(id).state !== 'PENDING') || priorTombstones.has(id)) {
        fail('Permanently purged beat cannot reappear.', 'LIBRARY_PURGE_TOMBSTONE');
      }
      const beforeRows = new Map([...(previousManifest.beats || []).map(row => [String(row.id), row]),
        ...(previousManifest.trash || []).map(item => [String(item.beat.id), item.beat])]);
      const afterRows = new Map([...(manifest.beats || []).map(row => [String(row.id), row]),
        ...(manifest.trash || []).map(item => [String(item.beat.id), item.beat])]);
      for (const [id, row] of purgeById) if (row.state === 'PENDING' && !requestedPurges.has(id) &&
          (candidate.rows.get(id) !== 'TRASH' || beatHash(beforeRows.get(id)) !== beatHash(afterRows.get(id)))) {
        fail('Pending purge beat cannot be changed or restored.', 'LIBRARY_PURGE_PENDING');
      }
      for (const [id, row] of purgeById) if (row.state === 'PENDING') {
        for (const [otherId, beat] of afterRows) if (otherId !== id &&
            row.asset_message_ids.some(asset => messageIds(beat).has(Number(asset)))) {
          fail('Pending purge asset cannot be attached to another beat.', 'LIBRARY_PURGE_ASSETS_UNVERIFIED');
        }
      }
      for (const id of old.keys()) {
        if (!candidate.rows.has(id) && (!tombstones.has(id) || old.get(id) !== 'TRASH' ||
            purgeById.get(id)?.state !== 'PENDING' ||
            beatHash(beforeRows.get(id)) !== purgeById.get(id).beat_sha256)) {
          fail('Only a tombstoned Trash beat may leave the INDEX.', 'LIBRARY_QUOTA_INDEX_INVALID');
        }
      }
      const fresh = [...candidate.rows.keys()].filter(id => !old.has(id));
      for (const id of fresh) if (purgeById.has(id) || priorTombstones.has(id)) {
        fail('Permanently purged beat identity cannot be reused.', 'LIBRARY_PURGE_TOMBSTONE');
      }
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

      for (const id of removed) {
        if (typeof transport.deleteAndVerifyMessages !== 'function') {
          fail('MASTER deletion verification is unavailable.', 'LIBRARY_PURGE_UNVERIFIED');
        }
        await transport.deleteAndVerifyMessages(chatId, purgeById.get(id).asset_message_ids.map(Number));
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
        await client.query('DELETE FROM library_project_uploads WHERE user_id=$1 AND beat_id=$2', [uid, id]);
        await client.query('DELETE FROM library_legacy_project_copies WHERE user_id=$1 AND beat_id=$2', [uid, id]);
        await client.query("UPDATE library_trash_purges SET state='CONFIRMED',confirmed_at=now(),last_error=NULL WHERE user_id=$1 AND beat_id=$2", [uid, id]);
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

  async function purgeTrash({ userId, chatId, beatIds }) {
    const uid = String(userId || '').trim();
    const ids = [...new Set((beatIds || []).map(id => String(id || '').trim()))];
    if (!ids.length || ids.some(id => !id || id.length > 256)) fail('Trash beat IDs are required.', 'LIBRARY_PURGE_INVALID_INPUT');
    await recover({ userId: uid, chatId });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = (await client.query('SELECT id FROM vaults WHERE user_id=$1 AND telegram_chat_id=$2 FOR UPDATE',
        [uid, String(chatId)])).rows[0];
      if (!owner) fail('Vault ownership could not be verified.', 'LIBRARY_QUOTA_INDEX_UNVERIFIED');
      const state = (await client.query('SELECT index_message_id,index_sha256 FROM library_quota_state WHERE user_id=$1 FOR UPDATE', [uid])).rows[0];
      const current = await pinned(chatId);
      if (!state || current?.messageId !== Number(state.index_message_id) || current.sha256 !== state.index_sha256) {
        fail('Committed library INDEX is unavailable.', 'LIBRARY_QUOTA_INDEX_CHANGED');
      }
      const trash = new Map((current.manifest.trash || []).map(item => [String(item?.beat?.id || ''), item?.beat]));
      const allOther = [...(current.manifest.beats || []), ...(current.manifest.trash || []).map(item => item.beat)];
      const previous = (await client.query('SELECT beat_id,state,asset_message_ids,beat_sha256 FROM library_trash_purges WHERE user_id=$1 AND beat_id=ANY($2::text[]) FOR UPDATE',
        [uid, ids])).rows;
      const byId = new Map(previous.map(row => [String(row.beat_id), row]));
      for (const id of ids) {
        if (byId.get(id)?.state === 'CONFIRMED') continue;
        const beat = trash.get(id);
        if (!beat) fail('Beat is not in Trash.', 'LIBRARY_PURGE_INVALID_INPUT');
        const assets = beatAssets(beat);
        const receipts = await client.query(`SELECT message_id FROM library_project_uploads WHERE user_id=$1 AND beat_id=$2
          UNION SELECT message_id FROM library_legacy_project_copies WHERE user_id=$1 AND beat_id=$2
          UNION SELECT source_message_id AS message_id FROM library_legacy_project_copies WHERE user_id=$1 AND beat_id=$2`, [uid, id]);
        for (const row of receipts.rows) assets.push(Number(row.message_id));
        assets.splice(0, assets.length, ...new Set(assets));
        assets.sort((a, b) => a - b);
        const receiptConflict = await client.query(`SELECT 1 FROM library_project_uploads
          WHERE user_id=$1 AND beat_id<>$2 AND message_id=ANY($3::bigint[])
          UNION SELECT 1 FROM library_legacy_project_copies
          WHERE user_id=$1 AND beat_id<>$2 AND
            (message_id=ANY($3::bigint[]) OR source_message_id=ANY($3::bigint[])) LIMIT 1`,
        [uid, id, assets]);
        if (receiptConflict.rows[0]) fail('Beat shares an asset receipt with another beat.', 'LIBRARY_PURGE_ASSETS_UNVERIFIED');
        if (assets.includes(current.messageId)) fail('Beat references the pinned INDEX.', 'LIBRARY_PURGE_ASSETS_UNVERIFIED');
        for (const other of allOther) if (String(other?.id) !== id) {
          const shared = messageIds(other);
          if (assets.some(asset => shared.has(asset))) fail('Beat shares an asset with another beat.', 'LIBRARY_PURGE_ASSETS_UNVERIFIED');
        }
        const hash = beatHash(beat);
        const existing = byId.get(id);
        if (existing && (existing.beat_sha256 !== hash ||
            JSON.stringify(existing.asset_message_ids.map(Number).sort((a,b) => a-b)) !== JSON.stringify(assets))) {
          fail('Pending purge asset snapshot changed.', 'LIBRARY_PURGE_PENDING');
        }
        if (!existing) await client.query(`INSERT INTO library_trash_purges
          (user_id,beat_id,operation_id,state,asset_message_ids,beat_sha256)
          VALUES($1,$2,$3,'PENDING',$4,$5)`, [uid, id, `purge:${id}`, assets, hash]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }

    const remaining = (await pool.query(`SELECT beat_id FROM library_trash_purges
      WHERE user_id=$1 AND beat_id=ANY($2::text[]) AND state='PENDING'`, [uid, ids])).rows.map(row => String(row.beat_id));
    if (!remaining.length) return { status: 'confirmed', deleted: ids.length, operationIds: ids.map(id => `purge:${id}`) };
    try {
      const current = await pinned(chatId);
      const manifest = current.manifest;
      const requested = new Set(remaining);
      const assets = (await pool.query(`SELECT asset_message_ids FROM library_trash_purges
        WHERE user_id=$1 AND beat_id=ANY($2::text[]) AND state='PENDING'`, [uid, remaining])).rows;
      const deletedAssets = new Set(assets.flatMap(row => row.asset_message_ids.map(Number)));
      const candidate = { ...manifest, updated_at: Math.floor(Date.now() / 1000),
        trash: (manifest.trash || []).filter(item => !requested.has(String(item?.beat?.id))),
        deleted: [...(manifest.deleted || []), ...remaining.map(beat_id => ({ beat_id, deleted_at: Math.floor(Date.now() / 1000) }))],
        ...(Array.isArray(manifest.garbage) ? { garbage: manifest.garbage.filter(item => !deletedAssets.has(Number(item?.message_id))) } : {}) };
      const result = await publish({ userId: uid, chatId, manifest: candidate,
        expectedMessageId: current.messageId, purgeIds: remaining });
      return { ...result, status: 'confirmed', deleted: ids.length, operationIds: ids.map(id => `purge:${id}`) };
    } catch (error) {
      const count = Number((await pool.query(`SELECT count(*)::int AS n FROM library_trash_purges
        WHERE user_id=$1 AND beat_id=ANY($2::text[]) AND state='CONFIRMED'`, [uid, ids])).rows[0].n);
      if (count === ids.length) return { status: 'confirmed', deleted: ids.length, operationIds: ids.map(id => `purge:${id}`) };
      await pool.query(`UPDATE library_trash_purges SET last_error=$3 WHERE user_id=$1 AND beat_id=ANY($2::text[]) AND state='PENDING'`,
        [uid, ids, String(error?.code || error?.message || 'PURGE_FAILED').slice(0, 500)]).catch(() => {});
      throw error;
    }
  }

  async function assertPurged({ userId, beatIds }) {
    const ids = [...new Set((beatIds || []).map(id => String(id || '').trim()))];
    if (!ids.length || ids.some(id => !id || id.length > 256)) fail('Beat IDs are required.', 'LIBRARY_PURGE_INVALID_INPUT');
    const count = Number((await pool.query(`SELECT count(*)::int AS n FROM library_trash_purges
      WHERE user_id=$1 AND beat_id=ANY($2::text[]) AND state='CONFIRMED'`, [String(userId || '').trim(), ids])).rows[0].n);
    if (count !== ids.length) fail('Topic cleanup requires confirmed purge.', 'LIBRARY_PURGE_REQUIRED');
    return true;
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

  return Object.freeze({ reserve, ensureBootstrap, recover, recoverAll, purgeTrash, assertPurged, migrateLegacyProjects, renew: ({ userId, beatId }) =>
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
  purgeTrash(input) {
    if (!configured) fail('Library purge requires PostgreSQL.', 'LIBRARY_QUOTA_UNAVAILABLE');
    return configured.purgeTrash(input);
  },
  assertPurged(input) {
    if (!configured) fail('Library purge requires PostgreSQL.', 'LIBRARY_QUOTA_UNAVAILABLE');
    return configured.assertPurged(input);
  },
  verifyCommitted(input) {
    if (!configured) fail('Library quota requires PostgreSQL.', 'LIBRARY_QUOTA_UNAVAILABLE');
    return configured.verifyCommitted(input);
  },
  _resetForTests() { configured = null; },
};
