'use strict';

const { Pool } = require('pg');
const { createProviderIdentityAuthority } = require('../provider-identity-authority');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 2 });
  try {
    const authority = createProviderIdentityAuthority({
      pool,
      getBridge: () => ({ adoptIdentityUser() {}, setUsernameByUserId() {}, userIdByUsername() { return null; } }),
    });
    const result = await authority.prepareX({
      identity: { id: process.env.TEST_X_SUBJECT, username: process.env.TEST_X_HANDLE },
      registrationOpen: true,
    });
    process.stdout.write(JSON.stringify({ userId: result.existingUserId, created: result.created }));
  } finally {
    await pool.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
