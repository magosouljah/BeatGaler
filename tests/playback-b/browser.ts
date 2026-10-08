import { WebTransportWorkerClient } from "../../src/features/cloud/webTransportWorkerClient";
import { WebPlaybackSourceManager } from "../../src/features/playback/webPlaybackSource";
import type { WebTransportSession } from "../../src/features/cloud/webTransportSession";

type Event = Record<string, unknown> & { stage: string; ts_ms: number; run_id: string; intent_id: number | null };
let events: Event[] = [];
let runId = "setup";
let intentId: number | null = null;
let workerClient: WebTransportWorkerClient | null = null;
let source: WebPlaybackSourceManager | null = null;
let audio: HTMLAudioElement | null = null;
let verifiedPeer = false;
const beatId = "test-b-message-96";
const messageId = 96;
const originalInfo = console.info.bind(console);
const stamp = () => performance.timeOrigin + performance.now();
const record = (stage: string, detail: Record<string, unknown> = {}) => {
  events.push({ run_id: runId, intent_id: intentId, ts_ms: stamp(), ...detail, stage });
};
console.info = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("[play-trace] ")) {
    try {
      const trace = JSON.parse(args[0].slice(13));
      record(trace.stage, trace);
    } catch { /* Observation only. */ }
  }
  originalInfo(...args);
};

const NativeWorker = globalThis.Worker;
globalThis.Worker = class TracedWorker extends NativeWorker {
  constructor(_url: string | URL, options?: WorkerOptions) {
    super(new URL("./worker.ts", import.meta.url), options);
    this.addEventListener("message", event => {
      if (event.data?.harnessTrace) record(event.data.harnessTrace.stage, event.data.harnessTrace);
    });
  }
};

function makeTransport(client: WebTransportWorkerClient) {
  return {
    async prefetchFile(input: Parameters<WebTransportWorkerClient["prefetch"]>[0]) {
      record("TRANSPORT_PREFETCH_ENTER", { message_id: input.messageId });
      if (!verifiedPeer) throw new Error("Peer not verified");
      const result = await client.prefetch(input);
      record("TRANSPORT_PREFETCH_READY", { message_id: input.messageId, bytes: result.prefix.byteLength });
      return result;
    },
    async prefetchFiles(inputs: Parameters<WebTransportWorkerClient["prefetchBatch"]>[0]["inputs"], onChunk?: Parameters<WebTransportWorkerClient["prefetchBatch"]>[1], onTerminal?: Parameters<WebTransportWorkerClient["prefetchBatch"]>[2]) {
      record("TRANSPORT_PREFETCH_BATCH_ENTER", { message_ids: inputs.map(input => input.messageId), peer_ready: verifiedPeer });
      if (!verifiedPeer) throw new Error("Peer not verified");
      const handle = client.prefetchBatch({ inputs, maxConcurrency: 7 }, onChunk, onTerminal);
      return {
        ...handle,
        completed: handle.completed.finally(() => record("TRANSPORT_PREFETCH_BATCH_DONE", { message_ids: inputs.map(input => input.messageId) })),
      };
    },
    async focusPlayback(id: number, traceIntentId?: number) { record("TRANSPORT_FOCUS_BEGIN", { message_id: id }); await client.focusPlayback(id, traceIntentId); record("TRANSPORT_FOCUS_DONE", { message_id: id }); },
    markPlaybackStable: (id: number, traceIntentId?: number) => client.markPlaybackStable(id, traceIntentId),
    releasePlaybackFocus: (id: number, traceIntentId?: number) => client.releasePlaybackFocus(id, traceIntentId),
    async streamFile(input: Parameters<WebTransportWorkerClient["stream"]>[0], onChunk: Parameters<WebTransportWorkerClient["stream"]>[1]) {
      record("TRANSPORT_STREAM_ENTER", { message_id: input.messageId, offset_bytes: input.offsetBytes ?? 0, peer_ready: verifiedPeer });
      if (!verifiedPeer) throw new Error("Peer not verified");
      return client.stream(input, onChunk);
    },
  };
}

export async function setup(input: { session: Omit<WebTransportSession, "temp_auth_key"> & { temp_auth_key: number[] }; run_id: string }) {
  runId = input.run_id;
  intentId = null;
  verifiedPeer = false;
  record("SESSION_INIT_BEGIN", { session_state: "new", peer_state: "unknown" });
  workerClient = new WebTransportWorkerClient();
  const session = { ...input.session, temp_auth_key: Uint8Array.from(input.session.temp_auth_key) } as WebTransportSession;
  try {
    await workerClient.initialize(session, []);
    session.temp_auth_key.fill(0);
    record("SESSION_INIT_DONE");
    await workerClient.verifyIdentity();
    record("SESSION_IDENTITY_DONE");
  } catch (error) {
    session.temp_auth_key.fill(0);
    record("SESSION_ERROR", { error_name: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
  return { events: takeEvents(), peer_ready: verifiedPeer };
}

export async function verify(input: { membership: unknown }) {
  if (!workerClient) throw new Error("Worker is not initialized");
  record("PEER_VERIFY_BEGIN");
  await workerClient.verifyReady(undefined, input.membership as Parameters<WebTransportWorkerClient["verifyReady"]>[1]);
  verifiedPeer = true;
  record("PEER_READY");
  source = new WebPlaybackSourceManager(makeTransport(workerClient));
  return { events: takeEvents(), peer_ready: verifiedPeer };
}

export function takeEvents() { const result = events; events = []; return result; }

export async function run(input: { run_id: string; intent_id: number; mode: "repeat" | "source-cold" | "warm" | "index" | "overlap"; mime_type?: string; warm_message_ids?: number[]; warm_lead_ms?: number; timeout_ms?: number }) {
  if (!workerClient || !source || !verifiedPeer) throw new Error("Test B session is not ready");
  runId = input.run_id;
  intentId = input.intent_id;
  if (input.mode !== "repeat") source.forget(beatId);
  audio?.pause();
  audio?.remove();
  audio = document.createElement("audio");
  audio.muted = true;
  audio.preload = "auto";
  document.body.append(audio);
  const player = audio;
  let firstProgress = false;
  let halfSecond = false;
  let waiting = false;
  const update = () => source?.updatePlaybackState({ beatId, currentTime: player.currentTime, playing: !player.paused && !player.ended, waiting });
  player.addEventListener("sourceopen", () => record("AUDIO_SOURCEOPEN"));
  player.addEventListener("playing", () => { waiting = false; record("AUDIO_EVENT_PLAYING", { current_time: player.currentTime, ready_state: player.readyState }); update(); });
  player.addEventListener("waiting", () => { waiting = true; record("AUDIO_EVENT_WAITING", { current_time: player.currentTime }); update(); });
  player.addEventListener("timeupdate", () => {
    if (!firstProgress && player.currentTime > 0) { firstProgress = true; record("AUDIO_FIRST_PROGRESS", { current_time: player.currentTime }); }
    if (!halfSecond && player.currentTime >= 0.5) { halfSecond = true; record("AUDIO_HALF_SECOND", { current_time: player.currentTime }); }
    update();
  });
  player.addEventListener("error", () => record("AUDIO_ERROR", { code: player.error?.code ?? null }));
  const mimeType = input.mime_type || "audio/mpeg";
  const otherIds = (input.warm_message_ids || []).filter(id => id !== messageId);
  const warmPromises: Promise<void>[] = [];
  if (input.mode === "warm") {
    for (const id of [messageId, ...otherIds]) {
      if (id !== messageId) source.forget(`test-b-warm-${id}`);
      const warm = source.prefetch(id === messageId ? beatId : `test-b-warm-${id}`, id, mimeType, "visible");
      void warm.catch(() => {});
      warmPromises.push(warm);
    }
    await new Promise(resolve => setTimeout(resolve, input.warm_lead_ms ?? 10));
  }
  let indexPromise: Promise<unknown> | null = null;
  if (input.mode === "index") {
    record("INDEX_COMPETITION_BEGIN");
    indexPromise = workerClient.getLibraryIndex().then(() => record("INDEX_COMPETITION_DONE"), error => record("INDEX_COMPETITION_ERROR", { error_name: error?.name || "unknown" }));
    await new Promise(resolve => setTimeout(resolve, input.warm_lead_ms ?? 10));
  }
  record("START", { session_state: "ready", peer_state: "ready", warm_present: input.mode === "warm", mode: input.mode });
  const timeout = input.timeout_ms ?? 45000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const finished = new Promise<void>((resolve, reject) => {
      const onProgress = () => { if (player.currentTime >= 0.5) { player.removeEventListener("timeupdate", onProgress); resolve(); } };
      player.addEventListener("timeupdate", onProgress);
      timer = setTimeout(() => reject(new Error("Audio did not reach 0.5 s")), timeout);
    });
    record("PLAY_INTENT", { message_id: messageId });
    const warm = source.prefetch(beatId, messageId, mimeType, "visible");
    void warm.catch(() => {});
    record("SOURCE_PREPARE_CALL");
    let prepared;
    if (input.mode === "overlap") {
      const superseded = source.prepare(beatId, messageId, mimeType, input.intent_id * 2 - 1);
      void superseded.catch(() => {});
      await new Promise(resolve => setTimeout(resolve, input.warm_lead_ms ?? 10));
      record("SECOND_INTENT_BEGIN", { second_intent_id: input.intent_id * 2 });
      prepared = await source.prepare(beatId, messageId, mimeType, input.intent_id * 2);
      await Promise.allSettled([superseded]);
    } else prepared = await source.prepare(beatId, messageId, mimeType, input.intent_id);
    record("SOURCE_PREPARE_RETURN", { url_scheme: prepared.url.split(":")[0] });
    player.src = prepared.url;
    player.load();
    record("AUDIO_SRC_SET");
    record("AUDIO_PLAY_CALL");
    const playing = player.play();
    void playing.then(() => record("AUDIO_PLAY_PROMISE_RESOLVED"), error => record("AUDIO_PLAY_PROMISE_REJECTED", { error_name: error?.name || "unknown" }));
    await finished;
    record("END", { current_time: player.currentTime });
    await Promise.allSettled(warmPromises);
    if (indexPromise) await indexPromise;
    return { status: "OK", events: takeEvents() };
  } catch (error) {
    record("RUN_ERROR", { error_name: error instanceof Error ? error.name : "unknown" });
    return { status: "ERROR", error_name: error instanceof Error ? error.name : "unknown", events: takeEvents() };
  } finally {
    if (timer) clearTimeout(timer);
    player.pause();
    update();
  }
}

export async function close() {
  audio?.pause();
  audio?.remove();
  audio = null;
  if (source) source.forget(beatId);
  if (workerClient) await workerClient.shutdown();
  workerClient = null;
  source = null;
  verifiedPeer = false;
  return takeEvents();
}
