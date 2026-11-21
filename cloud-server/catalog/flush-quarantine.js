'use strict';
// T05-N — Cuarentena por usuario del flush del control-plane (NATIVO r2.1 §6.2).
// 1. Pre-comprobación antes de BEGIN: las filas de vaults nativos en conflicto (chat o id distintos de SQL sin rebind
//    OPEN) salen de la transacción y quedan en control_plane_flush_quarantine. El resto hace COMMIT.
// 2. Respaldo del trigger 0027 (SQLSTATE BGR03 con DETAIL user_id=...): el flusher pone en cuarentena a ese usuario y
//    reintenta UNA sola vez sin él. Si vuelve a fallar o la cuarentena supera el umbral, el flush entero se detiene
//    (fail-closed sistémico, STOP-ENV).
// 3. La base del delta no avanza para los usuarios en cuarentena: se reintentan en cada flush hasta resolverse.

const crypto = require('crypto');
const { SQLSTATE } = require('./authority');

const DEFAULT_MAX_QUARANTINED_USERS = 25; // umbral provisional; T16 fija el valor operativo.
const sha256Hex = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest('hex');

class ControlPlaneFlushHalted extends Error {
  constructor(message, detail = {}) { super(`CONTROL_PLANE_FLUSH_HALTED: ${message}`); this.code = 'CONTROL_PLANE_FLUSH_HALTED'; this.detail = detail; }
}

// Devuelve los conflictos de las filas de vaults propuestas frente a SQL para usuarios con biblioteca POSTGRES.
async function precheckVaultRows(client, rows) {
  const proposed = (rows || []).filter((row) => row && row.user_id);
  if (!proposed.length) return [];
  const ids = proposed.map((row) => String(row.user_id));
  const r = await client.query(`SELECT v.user_id, v.id, v.telegram_chat_id,
      EXISTS (SELECT 1 FROM catalog_libraries l WHERE l.user_id = v.user_id AND l.authority = 'POSTGRES') AS native,
      (SELECT to_chat_id FROM catalog_chat_rebinds rb WHERE rb.user_id = v.user_id AND rb.state = 'OPEN') AS open_rebind_to
    FROM vaults v WHERE v.user_id = ANY($1::text[]) /* flush-quarantine */`, [ids]);
  const current = new Map((r.rows || []).map((row) => [String(row.user_id), row]));
  const conflicts = [];
  for (const row of proposed) {
    const sql = current.get(String(row.user_id));
    if (!sql || sql.native !== true) continue;
    // El upsert por user_id solo puede cambiar telegram_chat_id y title (nunca id: no está en el SET). La divergencia
    // de vaults.id JSON↔SQL (R12) la reporta T17-N inspect; aquí solo cuenta el campo que el flush escribiría.
    if (String(row.telegram_chat_id) !== String(sql.telegram_chat_id) && String(sql.open_rebind_to || '') !== String(row.telegram_chat_id)) {
      conflicts.push({ userId: String(row.user_id), field: 'telegram_chat_id', value: String(row.telegram_chat_id) });
    }
  }
  return conflicts;
}

async function recordQuarantine(client, conflicts) {
  for (const c of conflicts) {
    await client.query(`INSERT INTO control_plane_flush_quarantine(user_id, field, value_sha256)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, field) DO UPDATE SET last_seen_at = now(), attempts = control_plane_flush_quarantine.attempts + 1,
        value_sha256 = EXCLUDED.value_sha256, resolved_at = NULL, resolution = NULL`, [c.userId, c.field, sha256Hex(c.value)]);
  }
  return conflicts.length;
}

async function countOpenQuarantine(client) {
  const r = await client.query('SELECT count(DISTINCT user_id)::int AS n FROM control_plane_flush_quarantine WHERE resolved_at IS NULL');
  return Number(r.rows?.[0]?.n || 0);
}

function triggerQuarantineUser(error) {
  if (!error || error.code !== SQLSTATE.VAULT_REBIND_FORBIDDEN) return null;
  const m = /user_id=(\S+)/.exec(String(error.detail || ''));
  return m ? m[1] : null;
}

module.exports = { DEFAULT_MAX_QUARANTINED_USERS, ControlPlaneFlushHalted, precheckVaultRows, recordQuarantine, countOpenQuarantine, triggerQuarantineUser, sha256Hex };
