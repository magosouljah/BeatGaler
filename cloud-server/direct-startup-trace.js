'use strict';

const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');

// Per-request diagnostics only. Identifiers used to correlate assignment and
// membership are allowed; credentials and authorization material are not.
function createDirectStartupTrace() {
  const started = performance.now();
  const payload = { request_id: randomUUID(), events: [], dropped_events: 0 };
  const round = value => Math.round(value * 10) / 10;
  function mark(stage, detail = {}) {
    const safe = {};
    if (['new', 'reused'].includes(detail.server_lease)) safe.server_lease = detail.server_lease;
    if (['ASSIGNING', 'ACTIVE', 'STOPPING'].includes(detail.lease_state)) safe.lease_state = detail.lease_state;
    for (const key of [
      'user_id', 'vault_chat_id', 'channel_id', 'transport_id', 'expected_bot_id',
      'actual_bot_id', 'membership_state', 'membership_source', 'probe_error_code',
    ]) {
      if (detail[key] !== undefined && detail[key] !== null) safe[key] = String(detail[key]).slice(0, 120);
    }
    for (const key of ['invite_promote_executed', 'membership_confirmed']) {
      if (typeof detail[key] === 'boolean') safe[key] = detail[key];
    }
    if (Number.isInteger(detail.attempt)) safe.attempt = detail.attempt;
    if (Number.isFinite(detail.elapsed_ms) && detail.elapsed_ms >= 0) safe.elapsed_ms = detail.elapsed_ms;
    const event = { stage, t_ms: round(performance.now() - started), ...safe };
    if (payload.events.length < 32) payload.events.push(event);
    else {
      // Keep the correlation origin plus the newest outcome events.
      payload.events.splice(1, 1);
      payload.events.push(event);
      payload.dropped_events += 1;
    }
  }
  async function step(stage, operation) {
    const begin = performance.now();
    mark(`${stage}_BEGIN`);
    try {
      const result = await operation();
      mark(`${stage}_DONE`, { elapsed_ms: round(performance.now() - begin) });
      return result;
    } catch (error) {
      mark(`${stage}_ERROR`, { elapsed_ms: round(performance.now() - begin) });
      throw error;
    }
  }
  function publish(res, outcome) {
    try {
      const summary = { ...payload, events: payload.events.slice(), outcome, elapsed_ms: round(performance.now() - started) };
      let serialized = JSON.stringify(summary);
      // Leave room for existing response headers in common reverse-proxy buffers.
      while (serialized.length > 3_000 && summary.events.length > 2) {
        // Preserve the correlation origin and the latest readiness outcome.
        // Intermediate timing detail is less important than losing the final
        // bot-visible/activation proof at the end of a long repair trace.
        summary.events.splice(1, 1);
        summary.dropped_events += 1;
        serialized = JSON.stringify(summary);
      }
      res.setHeader('X-BeatGaler-Startup-Trace', serialized);
      console.info(`[direct-startup-trace] ${serialized}`);
    } catch (_) { /* Logging/header delivery cannot fail a session. */ }
  }
  return { mark, step, publish };
}

// Callers outside the two measured HTTP routes retain their existing behavior.
const noDirectStartupTrace = { mark() {}, step: (_stage, operation) => operation() };
module.exports = { createDirectStartupTrace, noDirectStartupTrace };
