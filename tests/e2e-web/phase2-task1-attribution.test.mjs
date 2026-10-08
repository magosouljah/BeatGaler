import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { assessPhase2Task1Markers, persistPhase2Task1Samples } from "./phase2-task1-attribution.mjs";
import { observeAuth } from "./stage1-auth-observer.mjs";

const harness = fs.readFileSync(new URL("./stage1-real-multi-account.e2e.mjs", import.meta.url), "utf8");
const attributionSource = harness.slice(
  harness.indexOf("function phase2Task1Http("),
  harness.indexOf("async function runtimeSnapshot("),
);

function fixture({ omit = [], move = {}, renewalAt = 1600, condition = "apertura_fria", authObservedAt = 1010 } = {}) {
  const times = {
    SESSION_START_BOOTSTRAP_DONE: 1030,
    SESSION_ACTIVATE_HTTP_DONE: 1040,
    SESSION_START_BIND_DONE: 1045,
    CONTROLLER_SESSION_MEDIA_GATE_OPEN: 1050,
    WORKER_MTPROTO_CONNECT_BEGIN: 1060,
    WORKER_MTPROTO_CLIENT_READY: 1070,
    CONTROLLER_SESSION_DATA_PLANE_READY: 1080,
    WORKER_VERIFY_GET_CHAT_BEGIN: 1085,
    WORKER_VERIFY_GET_CHAT_RPC_SENT: 1086,
    WORKER_VERIFY_GET_CHAT_RPC_RESPONSE_RECEIVED: 1087,
    WORKER_VERIFY_GET_CHAT_LOCAL_DONE: 1088,
    WORKER_VERIFY_GET_CHAT_END: 1089,
    WORKER_INDEX_BEGIN: 1100,
    WORKER_INDEX_POINTER_LOOKUP_BEGIN: 1110,
    WORKER_INDEX_POINTER_GET_MESSAGES_BEGIN: 1120,
    WORKER_INDEX_POINTER_GET_MESSAGES_RPC_SENT: 1130,
    WORKER_INDEX_POINTER_GET_MESSAGES_RPC_RESPONSE_RECEIVED: 1140,
    WORKER_INDEX_POINTER_GET_MESSAGES_END: 1150,
    WORKER_INDEX_POINTER_LOOKUP_DONE: 1160,
    WORKER_INDEX_DONE: 1170,
    WEB_LIBRARY_INDEX_PROCESS_BEGIN: 1180,
    WEB_LIBRARY_INDEX_PROCESS_DONE: 1190,
    TASK2_INPUT_WEBSOCKET_SEND: 1132,
    TASK2_INPUT_WEBSOCKET_MESSAGE: 1141,
    ...move,
  };
  const traces = Object.entries(times)
    .filter(([stage]) => !omit.includes(stage))
    .map(([stage, ts_ms]) => ({ stage, ts_ms, correlation_id: "run" }));
  const http = [
    { route: condition === "apertura_fria" ? "/beatgaler-api/auth/login" : "/beatgaler-api/auth/session", state: "response", status: 200, correlation_id: "run", observed_at_ms: authObservedAt },
    { route: "/beatgaler-api/transport/session/start", state: "response", status: 200, correlation_id: "run", started_at_ms: 1015, observed_at_ms: 1030, transport_stage: "reserve" },
    { route: "/beatgaler-api/transport/session/activate", state: "response", status: 200, correlation_id: "run", observed_at_ms: 1040 },
    { route: "/beatgaler-api/transport/session/start", state: "response", status: 200, correlation_id: "run", started_at_ms: 1031, observed_at_ms: 1045, transport_stage: "bind" },
    { route: "/beatgaler-api/transport/session/start", state: "response", status: 200, correlation_id: "run", started_at_ms: renewalAt - 10, observed_at_ms: renewalAt, transport_stage: "bind" },
  ];
  const observers = new Map([["01", {
    snapshot: () => http,
    playTraceSnapshot: () => traces.map(trace => ({ trace })),
  }]]);
  const context = {
    authObservers: observers,
    phase2Task2Mode: true,
    phase2Task2PassivePingTrace: true,
    assessPhase2Task1Markers,
  };
  const attribute = vm.runInNewContext(`${attributionSource}\nphase2Task1Attribution`, context);
  const sample = attribute({ account: { label: "01" }, condition, startedAtMs: 1000, readyAtMs: 1200, correlationId: "run" });
  return { sample, traces, http };
}

const marker = (sample, event) => sample.markers.find(point => point.event === event)?.absolute_ms;

test("bootstrap, activate, initial bind, gate and Direct precede later bind without shifting controlReady", () => {
  const { sample } = fixture();
  assert.equal(sample.complete, true);
  assert.equal(marker(sample, "cloud_control_end"), 1050);
  assert.equal(marker(sample, "session_start_bootstrap_done"), 1030);
  assert.equal(marker(sample, "session_start_bind_done"), 1045);
  assert.equal(marker(sample, "session_activate_http_done"), 1040);
  assert.equal(marker(sample, "mtproto_connect_begin"), 1060);
  assert.equal(marker(sample, "direct_disponible"), 1080);
  assert.equal(sample.durations_ms.cloud_control, 35);
  assert.equal(sample.cloud_session_start.length, 3);
  assert.deepEqual(Array.from(sample.task2_input_timeline, event => event.stage), ["TASK2_INPUT_WEBSOCKET_SEND", "TASK2_INPUT_WEBSOCKET_MESSAGE"]);
});

test("Task 2 accepts Worker preconnect and Cloud renewal before reload auth completes", () => {
  const { sample } = fixture({
    condition: "reload_caliente",
    authObservedAt: 1020,
    move: { CONTROLLER_SESSION_MEDIA_GATE_OPEN: 1075 },
  });
  assert.equal(sample.complete, true);
  assert.equal(marker(sample, "mtproto_connect_begin"), 1060);
  assert.equal(marker(sample, "cliente_mtproto_listo"), 1070);
  assert.equal(marker(sample, "cloud_control_end"), 1075);
  assert.equal(marker(sample, "direct_disponible"), 1080);
  assert.equal(sample.durations_ms.mtproto_connect, 10);
  assert.equal(sample.durations_ms.auth_session_a_cloud_control, -5);
});

test("missing initial bind and missing gate remain distinct attribution failures", () => {
  const noBind = fixture({ omit: ["SESSION_START_BIND_DONE"] }).sample;
  assert.equal(noBind.complete, false);
  assert.ok(noBind.missing_markers.includes("session_start_bind_done"));
  assert.ok(!noBind.missing_markers.includes("cloud_control_end"));
  const noGate = fixture({ omit: ["CONTROLLER_SESSION_MEDIA_GATE_OPEN"] }).sample;
  assert.equal(noGate.complete, false);
  assert.ok(noGate.missing_markers.includes("cloud_control_end"));
  assert.ok(noGate.blocked_markers.some(item => item.event === "direct_disponible"));
  assert.ok(!noGate.missing_markers.includes("direct_disponible"));
});

test("missing parent does not erase a child that was actually observed", () => {
  const { sample } = fixture({ omit: ["WORKER_INDEX_POINTER_LOOKUP_BEGIN"] });
  assert.equal(sample.complete, false);
  assert.ok(sample.missing_markers.includes("pointer_lookup_begin"));
  assert.equal(marker(sample, "get_messages_begin"), 1120);
  assert.ok(!sample.missing_markers.includes("get_messages_begin"));
  assert.equal(sample.chronological, true);
});

test("out-of-order timestamps fail even with an absent marker between them", () => {
  const { sample } = fixture({ omit: ["WORKER_INDEX_POINTER_LOOKUP_BEGIN"], move: { WORKER_INDEX_POINTER_GET_MESSAGES_BEGIN: 1090 } });
  assert.equal(sample.complete, false);
  assert.equal(sample.chronological, false);
  assert.ok(sample.out_of_order.some(item => item.before === "get_index_begin" && item.after === "get_messages_begin"));
});

test("a Direct event before the gate is reported as out of order", () => {
  const { sample } = fixture({ move: { CONTROLLER_SESSION_DATA_PLANE_READY: 1049 } });
  assert.equal(sample.complete, false);
  assert.equal(sample.chronological, false);
  assert.ok(sample.out_of_order.some(item => item.after === "CONTROLLER_SESSION_DATA_PLANE_READY"));
});

test("cold and reload samples survive incomplete-attribution failure", () => {
  const report = { phase2_task1: { samples: { apertura_fria: [], reload_caliente: [] } } };
  const cold = [{ ...fixture({ omit: ["SESSION_START_BIND_DONE"] }).sample, condition: "apertura_fria" }];
  const reload = [{ ...fixture().sample, condition: "reload_caliente" }];
  assert.throws(() => persistPhase2Task1Samples(report, cold, reload), error => error.code === "PHASE2_TASK1_INCOMPLETE_ATTRIBUTION");
  assert.equal(report.phase2_task1.samples.apertura_fria, cold);
  assert.equal(report.phase2_task1.samples.reload_caliente, reload);
});

test("passive ingress events do not evict early startup markers from the BiDi collector", async () => {
  let emit;
  const observer = await observeAuth({ addInitScript: async () => ({ on: (_, listener) => { emit = listener; } }) });
  emit({ kind: "play-trace", task2_passive_ping_trace: true, trace: { stage: "CONTROLLER_SESSION_MEDIA_GATE_OPEN" } });
  for (let index = 0; index < 600; index += 1) {
    emit({ kind: "play-trace", task2_passive_ping_trace: true, trace: { stage: "TASK2_INPUT_WEBSOCKET_MESSAGE", ts_ms: index } });
  }
  for (let index = 0; index < 450; index += 1) {
    emit({ kind: "play-trace", trace: { stage: "UNRELATED_TRACE", ts_ms: index } });
  }
  assert.equal(observer.playTraceSnapshot().length, 1001);
  assert.equal(observer.playTraceSnapshot()[0].trace.stage, "CONTROLLER_SESSION_MEDIA_GATE_OPEN");
});
