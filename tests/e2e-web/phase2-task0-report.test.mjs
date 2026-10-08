import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePhase2Task0Run,
  summarize,
  validateDirectPostgresPreflight,
} from "../../scripts/phase2-task0-report.mjs";

const identity = { head: "same-revision", source_sha256: "source", web_dist_sha256: "build" };
const labels = ["01", "02", "03", "04", "05"];
const conditions = ["apertura_fria", "reapertura_caliente", "reload_caliente", "play_tras_biblioteca_autoritativa"];

function fixture() {
  const samples = Object.fromEntries(conditions.map(condition => [condition, []]));
  for (const [index, account_label] of labels.entries()) {
    samples.apertura_fria.push({ account_label, started_at_ms: 1000 + index, ready_at_ms: 3000 + index, get_index: { operation_id: `cold-${account_label}` } });
    samples.reapertura_caliente.push({ account_label, started_at_ms: 4000 + index, ready_at_ms: 6000 + index, get_index: { operation_id: `reopen-${account_label}` } });
    for (let round = 1; round <= 4; round += 1) {
      const libraryReady = 10000 + round * 1000 + index;
      samples.reload_caliente.push({ account_label, round, started_at_ms: libraryReady - 3000, ready_at_ms: libraryReady, get_index: { operation_id: `reload-${account_label}-${round}` } });
      samples.play_tras_biblioteca_autoritativa.push({ account_label, round, library_ready_at_ms: libraryReady, clicked_at_ms: libraryReady + 100, first_playing_at_ms: libraryReady + 900, progress_seconds: 0.6, beat_id: `beat-${account_label}` });
    }
  }
  return {
    baseline_sha: identity.head,
    experiment_identity: { working_tree_fingerprint: identity.source_sha256 },
    requested_account_count: 5,
    web_server_mode: "vite-preview",
    workload_mode: "phase2-task0-four-conditions",
    overall: "PASS",
    started_at: "2026-09-25T00:00:00.000Z",
    finished_at: "2026-09-25T00:05:00.000Z",
    phase2_task0: { samples, completed_conditions: conditions },
    scenarios: [{ name: "multi_account_direct_identity", status: "PASS" }],
    accounts: Object.fromEntries(labels.map(label => [label, {
      vault_chat_id: `vault-${label}`,
      transport_id: `transport-${label}`,
      auth_network: [{ route: "/beatgaler-api/transport/session/start", state: "response", status: 200 }],
    }])),
  };
}

test("normalizes four independent conditions with per-account timestamps", () => {
  assert.deepEqual(summarize([1, 2, 3, 4, 5]), { samples: 5, p95_ms: 5, max_ms: 5, avg_ms: 3 });
  const report = normalizePhase2Task0Run({ report: fixture(), runId: 1, identity });
  assert.equal(report.validity.status, "VALID");
  assert.equal(report.statistics.apertura_fria.samples, 5);
  assert.equal(report.statistics.reapertura_caliente.samples, 5);
  assert.equal(report.statistics.reload_caliente.samples, 20);
  assert.equal(report.statistics.play_tras_biblioteca_autoritativa.samples, 20);
});

test("rejects missing account, missing authority, and wrong Web mode", () => {
  const raw = fixture();
  raw.web_server_mode = "vite-dev";
  raw.phase2_task0.samples.reload_caliente.pop();
  raw.phase2_task0.samples.apertura_fria[0].get_index = null;
  const report = normalizePhase2Task0Run({ report: raw, runId: 1, identity });
  assert.equal(report.validity.status, "INVALID");
  assert.ok(report.validity.reasons.some(reason => reason.includes("vite preview")));
  assert.ok(report.validity.reasons.some(reason => reason.includes("cuenta 05")));
  assert.ok(report.validity.reasons.some(reason => reason.includes("prueba autoritativa")));
});

test("PostgreSQL Direct proof requires a successful session start for all five", () => {
  const raw = fixture();
  raw.overall = "FAIL";
  assert.equal(validateDirectPostgresPreflight(raw).ok, true);
  raw.accounts["05"].auth_network[0].status = 503;
  assert.equal(validateDirectPostgresPreflight(raw).ok, false);
});
