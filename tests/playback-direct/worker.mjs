import { parentPort, workerData } from 'node:worker_threads';
import { TelegramClient, SessionConnection } from '@mtcute/web';
import { AsyncLocalStorage } from 'node:async_hooks';
import { installTestC } from '../playback-c/instrument.mjs';
import { installTestD } from '../playback-d/instrument.mjs';

const now = () => performance.timeOrigin + performance.now();
const emit = event => parentPort.postMessage({ harnessTrace: { ts_ms: now(), ...event } });
const testC = workerData.testCMode ? installTestC(SessionConnection, emit,
  { mode: workerData.testCMode, earlyMs: workerData.testCEarlyMs }) : null;
let capturedBytes = 0;
const captureBytes = workerData.testECapture ? (fields, wsBytes, units) => {
  if (capturedBytes++ >= 4) return;
  parentPort.postMessage({ testEBytes: { fields,
    ws: wsBytes, units } });
} : null;
const testD = workerData.testDMode ? installTestD(TelegramClient, SessionConnection, emit,
  { route101: workerData.testDRoute101, order: workerData.testDOrder,
    offsetMs: workerData.testDOffsetMs, testEWriter: workerData.testEWriter,
    captureBytes, observeIncoming: workerData.testEObserveIncoming }) : null;
const lookup = new AsyncLocalStorage();
const observedCores = new WeakSet();
let lookupSerial = 0, rpcSerial = 0;
const methods = new Set(['channels.getMessages', 'messages.getMessages', 'upload.getFile']);
const safeError = error => ({ error_name: error?.name ?? 'unknown',
  rpc_error_code: Number.isFinite(error?.code) ? error.code : null,
  rpc_error_tag: /^[A-Z][A-Z0-9_]{1,80}$/.test(error?.text || '') ? error.text : null });
// Observe the real library boundary too: getMessages may contain local peer
// work before core.call. sendRpc begins only after mtcute chooses a connection;
// it is explicitly NOT labelled as a socket send.
const originalSendRpc = SessionConnection.prototype.sendRpc;
SessionConnection.prototype.sendRpc = function (request, ...args) {
  if (!methods.has(request?._)) return originalSendRpc.call(this, request, ...args);
  const fields = { rpc_id: ++rpcSerial, lookup_id: lookup.getStore() ?? null,
    rpc_method: request._, connection_uid: this._uid ?? null,
    queued_before: this._session?.queuedRpc?.length ?? null, connection_usable: !!this._usable };
  emit({ stage: 'MTCUTE_CONNECTION_RPC_BEGIN', ...fields });
  const promise = originalSendRpc.call(this, request, ...args);
  void Promise.resolve(promise).then(
    () => emit({ stage: 'MTCUTE_CONNECTION_RPC_DONE', ...fields }),
    error => emit({ stage: 'MTCUTE_CONNECTION_RPC_ERROR', ...fields, ...safeError(error) }),
  );
  return promise;
};
// Capture structured production observations, never arbitrary mtcute payloads.
for (const level of ['info', 'warn', 'error', 'log', 'debug']) console[level] = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('[play-trace] ')) {
    try { const event = JSON.parse(args[0].slice(13)); emit(testD?.enrichTrace(event) ?? event); } catch { /* Not a structured trace. */ }
  } else if (level === 'warn' || level === 'error') {
    const text = args.map(value => typeof value === 'string' ? value : value?.name || '').join(' ');
    emit({ stage: 'MTCUTE_LOG', level, category: /pong to unknown ping/i.test(text) ? 'unknown_pong' : /retry/i.test(text) ? 'retry' : 'other',
      error_name: args.find(value => value instanceof Error)?.name ?? null });
  }
};

// A passive identity probe on the real getMessages result. The method itself,
// arguments, promise and result remain the production implementation.
const originalGetMessages = TelegramClient.prototype.getMessages;
if (typeof originalGetMessages !== 'function') throw new Error('getMessages identity probe unavailable');
TelegramClient.prototype.getMessages = async function (...args) {
  const core = this._client;
  if (core && !observedCores.has(core)) {
    observedCores.add(core);
    const call = core.call;
    core.call = function (request, ...rest) {
      if (!methods.has(request?._)) return call.call(this, request, ...rest);
      const fields = { lookup_id: lookup.getStore() ?? null, rpc_method: request._,
        ...(request._ === 'upload.getFile' ? { offset_bytes: request.offset, limit_bytes: request.limit } : {}) };
      emit({ stage: 'MTCUTE_CORE_CALL_BEGIN', ...fields });
      const promise = testD
        ? testD.invoke(request, rest, changed => call.call(this, request, ...changed))
        : call.call(this, request, ...rest);
      void Promise.resolve(promise).then(
        result => emit({ stage: 'MTCUTE_CORE_CALL_DONE', ...fields,
          ...(request._ === 'upload.getFile' ? { bytes: result?.bytes?.byteLength ?? null } : {}) }),
        error => emit({ stage: 'MTCUTE_CORE_CALL_ERROR', ...fields, ...safeError(error) }),
      );
      return promise;
    };
  }
  const result = await lookup.run(++lookupSerial, () => originalGetMessages.apply(this, args));
  for (const message of result) {
    testD?.observeMessage(message);
    if (message?.id !== workerData.messageId) continue;
    testC?.observeMessage(message);
    emit({ stage: 'TARGET_IDENTITY', message_id: message.id,
      filename_matches: message.media?.fileName === workerData.filename,
      filename: message.media?.fileName ?? null, total_bytes: message.media?.fileSize ?? null });
  }
  return result;
};
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
await import('../../src/features/cloud/webTransport.worker.ts');
parentPort.on('message', command => {
  if (command.op === 'test_e_reconnect') {
    if (!testD) { parentPort.postMessage({ requestId: command.requestId, ok: false, code: 'TEST_E_DISABLED' }); return; }
    void testD.reconnectMainSocket().then(
      result => parentPort.postMessage({ requestId: command.requestId, ok: true, result }),
      error => parentPort.postMessage({ requestId: command.requestId, ok: false, code: error?.name ?? 'TEST_E_RECONNECT_ERROR' }),
    );
    return;
  }
  if (command.op === 'test_d_raw_pair') {
    if (!testD) {
      parentPort.postMessage({ requestId: command.requestId, ok: false, code: 'TEST_D_DISABLED' });
      return;
    }
    void testD.runRawPair(command.input).then(
      result => parentPort.postMessage({ requestId: command.requestId, ok: true, result }),
      error => parentPort.postMessage({ requestId: command.requestId, ok: false,
        code: error?.name ?? 'TEST_D_ERROR' }),
    );
    return;
  }
  globalThis.onmessage({ data: command });
});
parentPort.postMessage({ harnessReady: true });
