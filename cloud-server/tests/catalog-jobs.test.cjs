'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { createCatalogCommands } = require('../catalog/commands');
const { createCatalogDirect } = require('../catalog/direct');
const { createCatalogOperations } = require('../catalog/operations');
const { createCatalogPurge } = require('../catalog/purge');
const { createCatalogQueries } = require('../catalog/queries');

const uuid = '00000000-0000-4000-8000-000000000001';
const request = { userId: 'u', era: uuid, epoch: '2', operationId: `top-${uuid}` };
const revision = '34';
const partKey = 'FILES:0:0';
const longKey = `FILES:${'segment.'.repeat(6)}0`;
const purgeId = `op-purge-${uuid}`;
const library = { authority: 'POSTGRES', migration_state: 'IDLE', generation_id: 'gen', active_generation_id: 'gen',
  authority_era: uuid, authority_epoch: '2', revision, restore_hold: false, cleanup_enabled: false };

function fake(responses, { failAt, existingJobs = [] } = {}) {
  const trace = [];
  const jobs = new Set(existingJobs);
  let pending;
  const insert = (sql, [jobId], target) => {
    if (target.has(jobId) && !sql.endsWith('ON CONFLICT (job_id) DO NOTHING')) {
      throw Object.assign(new Error('duplicate job'), { code: '23505' });
    }
    target.add(jobId);
    return { rows: [] };
  };
  const client = {
    async query(sql, params) {
      trace.push(['client', sql, params ?? null]);
      if (sql === 'BEGIN') { pending = new Set(jobs); return; }
      if (sql === 'COMMIT') { for (const job of pending) jobs.add(job); pending = undefined; return; }
      if (sql === 'ROLLBACK') { pending = undefined; return; }
      if (sql.startsWith('INSERT INTO catalog_jobs')) return insert(sql, params, pending);
      if (failAt && sql.includes(failAt)) throw new Error('forced rollback after enqueue');
      if (sql.includes('control_plane_flush_quarantine')) return { rows: [] };
      if (sql.includes('FROM catalog_libraries') && sql.includes('WHERE l.user_id')) return { rows: [library] };
      const match = responses.find(([pattern]) => sql.includes(pattern));
      return { rows: match?.[1] ?? [], rowCount: 0 };
    },
    release() { trace.push(['release']); },
  };
  return {
    trace, jobs, randomUUID: () => uuid, env: {},
    resolveAccess: async () => ({ maxBeats: null }),
    pool: {
      async connect() { trace.push(['connect']); return client; },
      async query(sql, params) {
        trace.push(['pool', sql, params ?? null]);
        if (sql.startsWith('INSERT INTO catalog_jobs')) return insert(sql, params, jobs);
        const match = responses.find(([pattern]) => sql.includes(pattern));
        assert.ok(match, 'unexpected autocommit query');
        return { rows: match[1] };
      },
    },
    authority: {
      async availability() { trace.push(['availability']); },
      async requireLibraryForMutation(connection, headers) {
        assert.equal(connection, client);
        trace.push(['lock', headers]);
        return library;
      },
    },
  };
}

const transfer = { operation_id: request.operationId, status: 'TRANSFERRING', intent_json: '{}' };
const transferRow = ['FROM catalog_transfer_operations o WHERE', [transfer]];
const partRows = ['FROM catalog_operation_parts', [{ part_key: partKey, dispatch_state: 'DISPATCHED', declared_size: '42' }]];
const purgeRow = ['FROM catalog_purges WHERE user_id = $1 AND purge_id = $2', [{ purge_id: purgeId }]];
const querySet = (db) => createCatalogQueries(db).createQuerySet({ ...request, consumer: { id: 'consumer', kind: 'BUILD' } });
const cases = [
  ['bulk', [['SELECT count(*)::text AS n', [{ n: '3' }]], ['FROM catalog_operations o WHERE', [{}]]],
    (db) => createCatalogCommands(db).createOperation({ ...request, idempotencyKey: 'sample-key', kind: 'TAG_RENAME', rename: { from: 'old', to: 'new' } })],
  ['bulk resume', [['FROM catalog_operations o WHERE', [{ status: 'CONFLICT' }]]],
    (db) => createCatalogCommands(db).resumeOperation({ ...request, revision })],
  ['transfer verify', [transferRow, partRows],
    (db) => createCatalogOperations(db).putReceipt({ ...request, partKey, receipt: { messageId: 3, size: 42 } })],
  ['transfer commit', [transferRow, partRows],
    (db) => createCatalogOperations(db).commitOperation(request)],
  ['transfer reconcile', [transferRow, ['SELECT count(*)::int AS n', [{ n: 2 }]],
    ['SELECT part_key FROM catalog_operation_parts', [{ part_key: partKey }, { part_key: longKey }]], partRows],
    (db) => createCatalogOperations(db).cancelOperation(request)],
  ['direct reconcile', [['FROM catalog_operation_parts', [{ op_status: 'TRANSFERRING', dispatch_state: 'DISPATCHED' }]],
    ['SELECT attempt, status, outcome', [{}]]],
    async (db) => assert.rejects(createCatalogDirect({ ...db,
      operations: { markDispatched: assert.fail, putReceipt: assert.fail },
    }).issueSendTicket({ ...request, partKey }), { code: 'PART_UNCERTAIN' })],
  ['purge request', [['coalesce(max(export_position)', [{ p: -1 }]], ['SELECT restore_hold', [library]], purgeRow],
    (db) => createCatalogPurge(db).requestPurge({ ...request, idempotencyKey: 'sample-key' })],
  ['purge cleanup', [['SELECT restore_hold', [library]], ['SELECT DISTINCT purge_id', [{ purge_id: purgeId }]]],
    (db) => createCatalogPurge(db).resumeCleanup(request)],
  ['purge already running', [["status = 'ENUMERATING' FOR UPDATE", [{ purge_id: purgeId }]]],
    async (db) => assert.rejects(createCatalogPurge(db).requestPurge({ ...request, idempotencyKey: 'sample-key' }),
      { code: 'PURGE_IN_PROGRESS', detail: { operation_id: purgeId, resumed: true } })],
  ['query set', [['FROM catalog_query_sets s WHERE', [{}]]], querySet],
  ['worker', [], (db) => createCatalogOperations(db).enqueueJob({ ...request, kind: 'TRANSFER_COMMIT', payload: { z: true, a: 42 } })],
];

// Baseline from git show 2aa481f for job INSERTs, and 4279a2e for complete traces (including M4.3b).
const deduplicatedSql = "INSERT INTO catalog_jobs(job_id, user_id, kind, operation_id, payload_json) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (job_id) DO NOTHING";
const directSql = "INSERT INTO catalog_jobs(job_id, user_id, kind, operation_id, payload_json) VALUES ($1, $2, 'TRANSFER_RECONCILE', $3, $4) ON CONFLICT (job_id) DO NOTHING";
const purgeSql = "INSERT INTO catalog_jobs(job_id, user_id, kind, operation_id, payload_json) VALUES ($1, $2, 'PURGE', $3, $4) ON CONFLICT (job_id) DO NOTHING";
const workerSql = "INSERT INTO catalog_jobs(job_id, user_id, kind, operation_id, payload_json) VALUES ($1,$2,$3,$4,$5)";
const baseline = {
  'bulk': [
    [
      ['client', deduplicatedSql,
        [ "job-op-op-00000000-0000-4000-8000-000000000001", "u", "OPERATION_STEP", "op-00000000-0000-4000-8000-000000000001", "{\"operationId\":\"op-00000000-0000-4000-8000-000000000001\"}" ]],
    ],
    '7c5c0f190b3d1bdcf4b67668ce6b6623f2e5d3d38d87f27ad3f5f90b540aa0c9',
  ],
  'bulk resume': [
    [
      ['client', deduplicatedSql,
        [ "job-op-top-00000000-0000-4000-8000-000000000001-resume-34", "u", "OPERATION_STEP", "top-00000000-0000-4000-8000-000000000001", "{\"operationId\":\"top-00000000-0000-4000-8000-000000000001\",\"resumedAt\":\"34\"}" ]],
    ],
    'cb908d77e21872de4570eaad1e51a3bb38b0ec7d0d53921c879218206f9fac2d',
  ],
  'transfer verify': [
    [
      ['client', deduplicatedSql,
        [ "job-verify-top-00000000-0000-4000-8000-000000000001-FILES_0_0", "u", "TRANSFER_VERIFY", "top-00000000-0000-4000-8000-000000000001", "{\"partKey\":\"FILES:0:0\"}" ]],
    ],
    'c6382156795cf7cd9e32d771de5b735f326a1a173e2822fea16fecf16fb3b13e',
  ],
  'transfer commit': [
    [
      ['client', deduplicatedSql,
        [ "job-commit-top-00000000-0000-4000-8000-000000000001", "u", "TRANSFER_COMMIT", "top-00000000-0000-4000-8000-000000000001", "{\"reason\":\"CLIENT_COMMIT\"}" ]],
    ],
    '6c2b03e94db20ba37736162d2c165b1106caed4222e634159eb4a97b14bb5a2b',
  ],
  'transfer reconcile': [
    [
      ['client', deduplicatedSql,
        [ "job-reconcile-top-00000000-0000-4000-8000-000000000001-FILES_0_0", "u", "TRANSFER_RECONCILE", "top-00000000-0000-4000-8000-000000000001", "{\"partKey\":\"FILES:0:0\"}" ]],
      ['client', deduplicatedSql,
        [ "job-reconcile-top-00000000-0000-4000-8000-00000-69754a4732b8489e", "u", "TRANSFER_RECONCILE", "top-00000000-0000-4000-8000-000000000001", "{\"partKey\":\"FILES:segment.segment.segment.segment.segment.segment.0\"}" ]],
    ],
    '958bc5abf09d2d2f1ee5b62b1fcce81498575492764897e7d3634def2a21c189',
  ],
  'direct reconcile': [
    [
      ['client', directSql,
        [ "job-reconcile-top-00000000-0000-4000-8000-000000000001-FILES_0_0", "u", "top-00000000-0000-4000-8000-000000000001", "{\"partKey\":\"FILES:0:0\"}" ]],
    ],
    'be4fe287507d36db709f7da93f02c6a11df955b1cf1d2f30a925f12e942e9e27',
  ],
  'purge request': [
    [
      ['client', purgeSql,
        [ "job-purge-op-purge-00000000-0000-4000-8000-000000000001", "u", "op-purge-00000000-0000-4000-8000-000000000001", "{\"purgeId\":\"op-purge-00000000-0000-4000-8000-000000000001\"}" ]],
    ],
    'e06c89a5177b553a6831e9d80e17ba1f70318b467f926029185614dc0146b96a',
  ],
  'purge cleanup': [
    [
      ['client', purgeSql,
        [ "job-pclean-00000000-0000-4000-8000-000000000001", "u", "op-purge-00000000-0000-4000-8000-000000000001", "{\"purgeId\":\"op-purge-00000000-0000-4000-8000-000000000001\"}" ]],
    ],
    '7ce2bad2d945108d548a075c6b7f59b430b052cf3c46d0c9ea042af9024c1970',
  ],
  'purge already running': [
    [
      ['client', purgeSql,
        [ "job-pclean-00000000-0000-4000-8000-000000000001", "u", "op-purge-00000000-0000-4000-8000-000000000001", "{\"purgeId\":\"op-purge-00000000-0000-4000-8000-000000000001\"}" ]],
    ],
    '77e775321b7093f999fbf06977c41f4743df56ba13d4d168b1e63eddef57f09d',
  ],
  'query set': [
    [
      ['client', deduplicatedSql,
        [ "job-qs-qs-00000000-0000-4000-8000-000000000001", "u", "QUERY_SET_BUILD", null, "{\"setId\":\"qs-00000000-0000-4000-8000-000000000001\"}" ]],
    ],
    '128b4d9f68b0a146ab74573fbaffc8b7581d01fbc74ac5481c1f727d8caa336b',
  ],
  'worker': [
    [
      ['pool', workerSql,
        [ "job-00000000-0000-4000-8000-000000000001", "u", "TRANSFER_COMMIT", "top-00000000-0000-4000-8000-000000000001", "{\"a\":42,\"z\":true}" ]],
    ],
    '7f3a4674346a7db42fc4c2bd2587e531c382995b00b2957e5209750eb340b539',
  ],
};

for (const [name, responses, act] of cases) {
  test(`SQL, params and transaction order: ${name}`, async () => {
    const db = fake(responses);
    await act(db);
    const [expectedJobs, expectedTrace] = baseline[name];
    const inserts = db.trace.filter(([, sql]) => typeof sql === 'string' && sql.startsWith('INSERT INTO catalog_jobs'));
    assert.deepEqual(inserts, expectedJobs);
    assert.deepEqual([...db.jobs], expectedJobs.map(([, , params]) => params[0]));
    assert.equal(createHash('sha256').update(JSON.stringify(db.trace)).digest('hex'), expectedTrace);
  });
}

test('job is discarded when the query-set lease write rolls back the caller', async () => {
  const db = fake([], { failAt: 'INSERT INTO catalog_query_set_leases' });
  await assert.rejects(querySet(db), { code: 'CATALOG_UNAVAILABLE' });
  assert.ok(db.trace.some(([, sql]) => typeof sql === 'string' && sql.startsWith('INSERT INTO catalog_jobs')));
  assert.deepEqual(db.trace.slice(-2), [['client', 'ROLLBACK', null], ['release']]);
  assert.equal(db.jobs.size, 0);
});

test('query-set build tolerates an existing job_id without discarding the lease write', async (t) => {
  t.mock.method(console, 'error', () => {});
  const jobId = 'job-qs-qs-00000000-0000-4000-8000-000000000001';
  const db = fake([['FROM catalog_query_sets s WHERE', [{}]]], { existingJobs: [jobId] });
  assert.equal((await querySet(db)).created, true);
  assert.ok(db.trace.some(([, sql]) => typeof sql === 'string' && sql.startsWith('INSERT INTO catalog_query_set_leases')));
  assert.deepEqual(db.trace.slice(-2), [['client', 'COMMIT', null], ['release']]);
  assert.deepEqual([...db.jobs], [jobId]);
});

test('worker autocommit reports duplicate job_id as 23505', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = fake([], { existingJobs: ['fixed-worker-id'] });
  await assert.rejects(createCatalogOperations(db).enqueueJob({ ...request, jobId: 'fixed-worker-id', kind: 'TRANSFER_COMMIT' }),
    { code: 'CATALOG_UNAVAILABLE', detail: { sqlstate: '23505', reason: 'SQL_ERROR' } });
  assert.deepEqual(db.trace.map(([connection]) => connection), ['pool']);
});

test('Direct replays an uncertain report and enqueues only one reconciliation after commit', async () => {
  const db = fake([
    ['FROM catalog_operation_parts', partRows[1]],
    ['SELECT capability_hash, status', [{ status: 'CONSUMED' }]],
  ]);
  const direct = createCatalogDirect({ ...db, operations: { markDispatched: assert.fail, putReceipt: assert.fail } });
  const report = { ...request, partKey, attempt: 1, outcome: 'UNCERTAIN' };
  const expected = { state: 'UNCERTAIN', reconcile: true, resend: 'BLOCKED', retryAfterMs: 60000, replay: true };
  const jobId = `job-reconcile-top-${uuid}-FILES_0_0`;
  const enqueueTraces = [];
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await direct.reportSend(report), expected);
    assert.deepEqual([...db.jobs], [jobId]);
    enqueueTraces.push(db.trace.slice(-3));
  }
  const enqueueTrace = [
    ['client', 'COMMIT', null], ['release'],
    ['pool', directSql, [jobId, request.userId, request.operationId, '{"partKey":"FILES:0:0"}']],
  ];
  assert.deepEqual(enqueueTraces, [enqueueTrace, enqueueTrace]);
});
