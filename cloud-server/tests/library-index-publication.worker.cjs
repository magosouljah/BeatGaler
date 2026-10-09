'use strict';

const { Pool } = require('pg');
const { createLibraryBeatQuota } = require('../library-beat-quota');

async function main() {
  const [beatId] = process.argv.slice(2);
  const source = new URL(process.env.BEATGALER_STEP3_TEST_ADMIN_URL || '');
  source.pathname = `/${process.env.BEATGALER_STEP4_TEST_DB_NAME}`;
  const pool = new Pool({ connectionString: source.toString(), max: 1 });
  try {
    const result = await createLibraryBeatQuota({ pool }).reserve({
      userId: 'free', beatId, reservationId: `new:${beatId}`, retryDenied: true,
    });
    process.stdout.write(JSON.stringify({ status: result.status, beatId }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: 'REJECTED', beatId, code: error?.code || 'UNKNOWN' }));
  } finally { await pool.end(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
