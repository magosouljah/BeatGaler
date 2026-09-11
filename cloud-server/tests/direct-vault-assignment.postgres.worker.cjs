'use strict';

const { Pool } = require('pg');
const { createDirectVaultAssignmentStore } = require('../direct-vault-assignment');

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');

  const chatIds = JSON.parse(process.argv[2] || '[]');
  if (!Array.isArray(chatIds) || chatIds.some(chatId => !String(chatId || '').trim())) {
    throw new Error('Worker requires a JSON array of non-empty chat ids.');
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const store = createDirectVaultAssignmentStore(pool);
    const assignments = [];
    for (const chatId of chatIds) {
      assignments.push(await store.assignIfMissing({ chatId: String(chatId) }));
    }
    process.stdout.write(`${JSON.stringify(assignments)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
