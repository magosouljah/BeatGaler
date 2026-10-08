'use strict';

const crypto = require('node:crypto');
const { buildLegacyRows } = require('./legacy-import-executor');

const WELCOME_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function welcomeId(userId) {
  return `welcome_${crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 24)}`;
}

async function issueWelcomeGrant(pool, userId, { now = new Date() } = {}) {
  const id = String(userId || '').trim();
  const startsAt = now instanceof Date ? now : new Date(now);
  if (!id || !Number.isFinite(startsAt.getTime())) throw new Error('Valid user and server time are required for welcome.');
  const expiresAt = new Date(startsAt.getTime() + WELCOME_DAYS * DAY_MS);

  // Both the deterministic ID and the partial unique index on (user_id) for
  // source=welcome make retries and concurrent activations at-most-once.
  const inserted = await pool.query(`
    INSERT INTO entitlements(id,user_id,plan_id,source,source_key,starts_at,expires_at,issued_by_actor)
    VALUES($1,$2,'paid_entry','welcome','welcome:v1',$3,$4,'access:welcome')
    ON CONFLICT DO NOTHING
    RETURNING *
  `, [welcomeId(id), id, startsAt, expiresAt]);
  if (inserted.rows[0]) return inserted.rows[0];
  const existing = await pool.query("SELECT * FROM entitlements WHERE user_id=$1 AND source='welcome'", [id]);
  if (existing.rows[0]) return existing.rows[0];
  throw new Error('Welcome entitlement could not be issued or found.');
}

async function replaceLegacyEntitlementsForCutover(pool, authData) {
  const rows = buildLegacyRows(authData).entitlements;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('beatgaler:legacy-entitlement-cutover'))");
    const marker = await client.query("SELECT state FROM control_plane_cutovers WHERE id='legacy-json-v1' FOR UPDATE");
    if (marker.rows[0]?.state === 'READY') throw new Error('Legacy entitlement import is refused after PostgreSQL cutover.');
    await client.query('DELETE FROM entitlements');
    for (const row of rows) {
      await client.query(`
        INSERT INTO entitlements(id,user_id,plan_id,source,starts_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6)
      `, [row.id, row.user_id, row.plan_id, row.source, row.starts_at, row.expires_at]);
    }
    await client.query('COMMIT');
    return rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { WELCOME_DAYS, issueWelcomeGrant, replaceLegacyEntitlementsForCutover };
