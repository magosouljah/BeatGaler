'use strict';

const { buildLegacyRows } = require('./legacy-import-executor');

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

module.exports = { replaceLegacyEntitlementsForCutover };
