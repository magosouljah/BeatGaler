'use strict';
// Adopta una base restaurada con pg_restore: postura HELD (época+1, restore_hold, capacidades/concesiones revocadas, jobs a cola) y ANALYZE.
//   DATABASE_URL_ADOPT=postgres://…/base_restore node scripts/backup/adopt-restored.cjs <BACKUP_ID> [manifest_sha256]
// Solo contra una base AISLADA restaurada (el nombre debe contener «restore»). No toca Telegram ni AWS.
const { Pool } = require(require('path').join(__dirname, '..', '..', 'cloud-server', 'node_modules', 'pg'));
const { createCatalogBackup } = require('../../cloud-server/catalog/backup');

async function main() {
  const [backupId, manifestSha256 = ''] = process.argv.slice(2);
  const url = process.env.DATABASE_URL_ADOPT || '';
  if (!backupId || !url) { console.error('uso: DATABASE_URL_ADOPT=… node adopt-restored.cjs <BACKUP_ID> [manifest_sha256]'); process.exit(2); }
  if (!/^[0-9a-f]{64}$/.test(manifestSha256)) { console.error('manifest_sha256 (64 hex, de <id>.manifest.json.sha256) requerido'); process.exit(2); }
  const dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!/restore/.test(dbName)) { console.error(`STOP-ENV: la base «${dbName}» no parece una base restaurada aislada (el nombre debe contener «restore»)`); process.exit(4); }
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const r = await createCatalogBackup({ pool, log: (e, d) => console.error('[adopt]', e, JSON.stringify(d || {})) }).adoptRestoredDatabase({ backupId, manifestSha256 });
    console.log(JSON.stringify(r));
  } finally { await pool.end(); }
}
main().catch((e) => { console.error(e.code || 'ERROR', e.message); process.exit(1); });
