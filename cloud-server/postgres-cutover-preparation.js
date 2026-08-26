'use strict';

const { parseLegacyJson, snapshotManifest, planLegacyImport } = require('./legacy-import-plan');
const {
  replaceAuthSnapshot,
  replacePersistentSnapshot,
  loadAuthSnapshot,
  loadPersistentSnapshot,
  writeCutoverMarker,
} = require('./postgres-control-plane-runtime');

async function preparePostgresCutover(pool, { authRaw, persistentRaw, cryptoConfig }) {
  if (!pool || typeof pool.query !== 'function') throw new Error('PostgreSQL pool is required.');
  const auth = parseLegacyJson(authRaw, 'accounts-data.json');
  const persistent = parseLegacyJson(persistentRaw, 'cloud-data.json');

  // Validation/dry-run happens before any database mutation.
  const plan = planLegacyImport(auth, persistent);
  const snapshot = snapshotManifest({
    'accounts-data.json': String(authRaw),
    'cloud-data.json': String(persistentRaw),
  });

  await replaceAuthSnapshot(pool, auth, cryptoConfig);
  await replacePersistentSnapshot(pool, persistent);

  const [roundTripAuth, roundTripPersistent] = await Promise.all([
    loadAuthSnapshot(pool, cryptoConfig),
    loadPersistentSnapshot(pool),
  ]);
  const roundTripPlan = planLegacyImport(roundTripAuth, roundTripPersistent);

  for (const key of ['users', 'auth_sessions', 'linked_accounts', 'uploaded_files', 'beat_topics', 'pending_topic_deletes', 'message_redirects']) {
    if (Number(roundTripPlan.counts[key]) !== Number(plan.counts[key])) {
      throw new Error(`PostgreSQL cutover validation count mismatch for ${key}: expected ${plan.counts[key]}, got ${roundTripPlan.counts[key]}.`);
    }
  }

  await writeCutoverMarker(pool, snapshot.manifest_sha256, 'READY');
  return Object.freeze({ snapshot, plan, roundTripPlan });
}

module.exports = { preparePostgresCutover };
