'use strict';
// T03 — Repositorio base del catálogo. Reglas (TAREAS T03 §4):
//  - Toda operación sobre un snapshot exige {userId, generationId}; las de biblioteca exigen userId.
//  - withTransaction usa un único cliente para toda la transacción y lo libera siempre en finally.
//  - No recibe ni importa transporte (Telegram/Direct): solo SQL.
// No importa INDEX ni cambia autoridad: eso es T04/T05. Las bibliotecas nacen LEGACY (default de la DB).

const crypto = require('crypto');
const { requireScope, requireUserId, GENERATION_STATUS, CatalogContractError } = require('./contract');

const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');

function bind(client) {
  const q = (text, params) => client.query(text, params);
  return Object.freeze({
    async createLibrary({ userId, vaultId }) {
      requireUserId(userId);
      if (typeof vaultId !== 'string' || !vaultId) throw new CatalogContractError('CATALOG_VAULT_REQUIRED', 'vaultId requerido');
      const r = await q('INSERT INTO catalog_libraries(user_id, vault_id) VALUES ($1, $2) RETURNING user_id, vault_id, authority, migration_state, cleanup_enabled, restore_hold, revision::text AS revision', [userId, vaultId]);
      return r.rows[0];
    },
    async getLibrary(userId, { forUpdate = false } = {}) {
      requireUserId(userId);
      const r = await q(`SELECT user_id, vault_id, authority, migration_state, authority_era, authority_epoch::text AS authority_epoch,
        revision::text AS revision, active_generation_id, cleanup_enabled, restore_hold FROM catalog_libraries WHERE user_id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [userId]);
      return r.rows[0] || null;
    },
    async createGeneration(scope, { snapshotId, rawIndex = null }) {
      const s = requireScope(scope);
      const raw = rawIndex == null ? null : Buffer.from(rawIndex);
      const r = await q(`INSERT INTO catalog_generations(user_id, generation_id, snapshot_id, raw_index, raw_index_sha256)
        VALUES ($1, $2, $3, $4, $5) RETURNING user_id, generation_id, status`, [s.userId, s.generationId, snapshotId, raw, raw ? sha256Hex(raw) : null]);
      return r.rows[0];
    },
    async setGenerationStatus(scope, { status, sourceHash = null }) {
      const s = requireScope(scope);
      if (!GENERATION_STATUS.includes(status)) throw new CatalogContractError('CATALOG_STATUS_INVALID', status);
      const r = await q(`UPDATE catalog_generations SET status = $3,
          source_hash = COALESCE($4, source_hash),
          validated_at = CASE WHEN $3 = 'STAGING' THEN validated_at ELSE COALESCE(validated_at, now()) END
        WHERE user_id = $1 AND generation_id = $2 RETURNING status`, [s.userId, s.generationId, status, sourceHash]);
      if (!r.rows.length) throw new CatalogContractError('CATALOG_GENERATION_NOT_FOUND', s.generationId);
      return r.rows[0];
    },
    async insertBeat(scope, beat) {
      const s = requireScope(scope);
      const legacyJson = String(beat.legacyJson);
      // Proyecciones display/search (0028) desde el propio beat si el llamador no las trae (misma semántica JS que legacy-codec.projectBeat).
      const nameDisplay = beat.nameDisplay ?? ((typeof beat.name === 'string' ? beat.name : 'Untitled').trim() || 'Untitled');
      const keyDisplay = beat.keyDisplay ?? (typeof beat.keyText === 'string' ? beat.keyText : '');
      const r = await q(`INSERT INTO catalog_beats(user_id, generation_id, beat_id, state, name, bpm_text, key_text, rating, color, color2,
          bpm_sort_class, bpm_sort, sort_order, manual_rank, telegram_topic_id, has_artwork, legacy_json, legacy_sha256, legacy_export_bytes,
          name_display, name_search, key_display, key_search, bpm_display, rating_display)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
        RETURNING beat_id, state, version::text AS version, direct_scope_compatible`,
      [s.userId, s.generationId, beat.beatId, beat.state || 'ACTIVE', beat.name ?? null, beat.bpmText ?? null, beat.keyText ?? null,
        beat.rating ?? null, beat.color ?? null, beat.color2 ?? null, beat.bpmSortClass ?? 3, beat.bpmSort ?? null, beat.sortOrder ?? null,
        String(beat.manualRank), beat.telegramTopicId ?? null, Boolean(beat.hasArtwork), legacyJson, sha256Hex(Buffer.from(legacyJson, 'utf8')),
        Buffer.byteLength(legacyJson, 'utf8'),
        nameDisplay, beat.nameSearch ?? nameDisplay.toLowerCase(), keyDisplay, beat.keySearch ?? keyDisplay.toLowerCase(),
        beat.bpmDisplay ?? (typeof beat.bpmText === 'string' ? beat.bpmText : ''), beat.ratingDisplay ?? Math.max(0, Math.min(255, Math.trunc(Number(beat.rating) || 0)))]);
      return r.rows[0];
    },
    async getBeat(scope, beatId) {
      const s = requireScope(scope);
      const r = await q(`SELECT beat_id, state, version::text AS version, name, manual_rank::text AS manual_rank, legacy_sha256, direct_scope_compatible
        FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3`, [s.userId, s.generationId, beatId]);
      return r.rows[0] || null;
    },
    async insertTags(scope, beatId, tags) {
      const s = requireScope(scope);
      for (const t of tags) {
        await q(`INSERT INTO catalog_beat_tags(user_id, generation_id, beat_id, position, label, norm_key, search_key) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [s.userId, s.generationId, beatId, t.position, t.label, t.normKey ?? t.label.trim().toLowerCase(), t.searchKey ?? t.label.toLowerCase()]);
      }
      return tags.length;
    },
    query: q,
  });
}

function createCatalogRepository({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new CatalogContractError('CATALOG_POOL_REQUIRED', 'pool con connect() requerido');
  async function withTransaction(fn, { isolation = 'READ COMMITTED' } = {}) {
    if (!['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'].includes(isolation)) throw new CatalogContractError('CATALOG_ISOLATION_INVALID', isolation);
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const result = await fn(bind(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* el error original manda */ }
      throw error;
    } finally {
      client.release();
    }
  }
  return Object.freeze({ withTransaction });
}

module.exports = { createCatalogRepository };
