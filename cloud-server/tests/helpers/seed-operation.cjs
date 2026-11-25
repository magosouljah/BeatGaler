'use strict';

const crypto = require('crypto');

// X1d: beginOperation was retired (no production route creates Direct operations).
// The cleanup/liveness code still reaps operations persisted in the state file, so
// tests seed that persisted state directly instead of going through a retired API.
// Shape = what the retired beginOperation persisted, written by ANOTHER process:
// numeric monotonic stamps that mean nothing to this process plus a foreign
// `liveness_owner_instance` (bounded re-confirmation grace applies, never the stamps).
function seedOperation({ directTransport, pool, lease, kind = 'data', operationId = null, extra = {} }) {
  const id = operationId || `op_${crypto.randomBytes(12).toString('hex')}`;
  directTransport.__testing.mutateState(pool, state => {
    const current = state.leases[lease.session_id];
    if (!current) throw new Error('seedOperation requires an existing lease.');
    state.operations[id] = {
      operation_id: id,
      session_id: lease.session_id,
      bot_id: lease.bot_id,
      installation_id: lease.installation_id,
      chat_id: lease.chat_id,
      kind,
      started_at: new Date().toISOString(),
      started_monotonic_ms: 5_000_000,
      liveness_owner_instance: 'previous-process',
      last_liveness_at: new Date().toISOString(),
      last_liveness_monotonic_ms: 5_000_000,
      ...extra,
    };
  });
  return id;
}

module.exports = { seedOperation };
