import { readFileSync, writeFileSync } from "node:fs";

function read(path) { return readFileSync(path, "utf8"); }
function write(path, value) { writeFileSync(path, value); }
function once(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Missing patch anchor: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Patch anchor is not unique: ${label}`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}
function countReplace(source, before, after, expected, label) {
  const parts = source.split(before);
  if (parts.length - 1 !== expected) throw new Error(`Expected ${expected} occurrences for ${label}, found ${parts.length - 1}`);
  return parts.join(after);
}

{
  const path = "src/features/cloud/webTransportSession.ts";
  let source = read(path);
  source = once(source,
`  type TempAuthBinding,\n  type TempAuthMetadata,`,
`  type TempAuthBinding,\n  type TempAuthLongJson,\n  type TempAuthMetadata,`,
"session imports TempAuthLongJson");
  source = once(source,
`  /** Client-generated temporary key. It is never serialized back to Galer Cloud. */\n  temp_auth_key: Uint8Array;\n  temp_primary_dcs: unknown;`,
`  /** Client-generated temporary key. It is never serialized back to Galer Cloud. */\n  temp_auth_key: Uint8Array;\n  /** MTProto session id that the temporary key was cryptographically bound to. */\n  temp_session_id: TempAuthLongJson;\n  temp_primary_dcs: unknown;`,
"session preserves bound temp session id");
  source = countReplace(source,
`      temp_auth_key: imported.authKey,\n      temp_primary_dcs: imported.primaryDcs,`,
`      temp_auth_key: imported.authKey,\n      temp_session_id: prepared.metadata.tempSessionId,\n      temp_primary_dcs: imported.primaryDcs,`,
2,
"session returns bound temp session id");
  write(path, source);
}

{
  const path = "src/features/cloud/webTransportWorkerProtocol.ts";
  let source = read(path);
  source = once(source,
`      session: Pick<WebTransportSession, "chat_id" | "transport_user_id" | "temp_auth_key" | "temp_primary_dcs"> & {`,
`      session: Pick<WebTransportSession, "chat_id" | "transport_user_id" | "temp_auth_key" | "temp_session_id" | "temp_primary_dcs"> & {`,
"worker protocol carries bound temp session id");
  write(path, source);
}

{
  const path = "src/features/cloud/webTransport.worker.ts";
  let source = read(path);
  source = once(source,
`import { InputMedia, MemoryStorage, TelegramClient, WebCryptoProvider, type FileDownloadLocation } from "@mtcute/web";`,
`import { InputMedia, MemoryStorage, SessionConnection, TelegramClient, WebCryptoProvider, type FileDownloadLocation } from "@mtcute/web";`,
"worker imports SessionConnection");

  source = once(source,
`type BoundTempConnection = { _session?: { initConnectionCalled: boolean } };\ntype BoundTempPool = {\n  _connections?: BoundTempConnection[];\n  onUsable?: { add(handler: (index: number) => void): void };\n};\ntype BoundTempDcManager = {\n  main?: BoundTempPool;\n  upload?: BoundTempPool;\n  download?: BoundTempPool;\n  downloadSmall?: BoundTempPool;\n};\ntype BoundTempNetwork = {\n  _dcConnections?: Map<number, BoundTempDcManager>;\n  _getOtherDc?: (...args: any[]) => Promise<BoundTempDcManager>;\n  changePrimaryDc?: (...args: any[]) => Promise<unknown>;\n  __beatgalerBoundTempRpcSeam?: boolean;\n};`,
`type BoundTempLongJson = { low: number; high: number; unsigned: boolean };\ntype BoundTempSession = {\n  initConnectionCalled: boolean;\n  _sessionId?: any;\n  resetState?: (...args: any[]) => void;\n  __beatgalerBoundTempSessionIdSeam?: boolean;\n};\ntype BoundTempConnection = {\n  params?: { isMainConnection?: boolean; isMainDcConnection?: boolean; dc?: { id?: number } };\n  _session?: BoundTempSession;\n  reset?: (...args: any[]) => void;\n  __beatgalerBoundTempConnectionSeam?: boolean;\n};\ntype BoundTempPool = {\n  _connections?: BoundTempConnection[];\n  onUsable?: { add(handler: (index: number) => void): void };\n};\ntype BoundTempDcManager = { main?: BoundTempPool };\ntype BoundTempNetwork = { _dcConnections?: Map<number, BoundTempDcManager> };`,
"worker bound-temp internal types");

  const functionStart = source.indexOf("function markBoundTempPool(");
  const functionEnd = source.indexOf("\nasync function closeClient", functionStart);
  if (functionStart < 0 || functionEnd < 0) throw new Error("Missing bound-temp seam function block");
  const replacement = `function isBoundTempLongJson(value: unknown): value is BoundTempLongJson {\n  const row = value as Partial<BoundTempLongJson> | null;\n  return Boolean(\n    row &&\n    Number.isInteger(row.low) &&\n    Number.isInteger(row.high) &&\n    typeof row.unsigned === "boolean"\n  );\n}\n\nfunction applyBoundTempSessionId(session: BoundTempSession, sessionId: BoundTempLongJson): void {\n  const LongCtor = session._sessionId?.constructor;\n  if (typeof LongCtor !== "function") {\n    throw new Error("Galer Cloud Web transport could not restore its temporary session.");\n  }\n  session._sessionId = new LongCtor(sessionId.low, sessionId.high, sessionId.unsigned);\n  session.initConnectionCalled = true;\n}\n\nfunction markBoundTempConnection(connection: BoundTempConnection | undefined, sessionId: BoundTempLongJson): void {\n  const session = connection?._session;\n  if (!connection || !session) return;\n\n  if (!session.__beatgalerBoundTempSessionIdSeam && typeof session.resetState === "function") {\n    const resetState = session.resetState;\n    session.resetState = (...args: any[]) => {\n      resetState.apply(session, args);\n      applyBoundTempSessionId(session, sessionId);\n    };\n    session.__beatgalerBoundTempSessionIdSeam = true;\n  }\n\n  if (!connection.__beatgalerBoundTempConnectionSeam && typeof connection.reset === "function") {\n    const reset = connection.reset;\n    connection.reset = (...args: any[]) => {\n      const result = reset.apply(connection, args);\n      if (args[0] !== true && connection._session) applyBoundTempSessionId(connection._session, sessionId);\n      return result;\n    };\n    connection.__beatgalerBoundTempConnectionSeam = true;\n  }\n\n  applyBoundTempSessionId(session, sessionId);\n}\n\nfunction markBoundTempPool(pool: BoundTempPool | undefined, sessionId: BoundTempLongJson): void {\n  if (!pool) return;\n  const mark = () => {\n    for (const connection of pool._connections || []) markBoundTempConnection(connection, sessionId);\n  };\n  mark();\n  if (!boundTempPools.has(pool as object)) {\n    pool.onUsable?.add(() => mark());\n    boundTempPools.add(pool as object);\n  }\n}\n\nfunction installBoundTempConnectHook(\n  sessionId: BoundTempLongJson,\n  dcId: number,\n): () => void {\n  const prototype = SessionConnection.prototype as any;\n  const originalConnect = prototype.connect;\n  if (typeof originalConnect !== "function") {\n    throw new Error("Galer Cloud Web transport could not prepare its temporary session.");\n  }\n  const wrappedConnect = function (this: BoundTempConnection, ...args: any[]) {\n    if (\n      this?.params?.isMainConnection === true &&\n      this?.params?.isMainDcConnection === true &&\n      Number(this?.params?.dc?.id || 0) === dcId\n    ) {\n      markBoundTempConnection(this, sessionId);\n    }\n    return originalConnect.apply(this, args);\n  };\n  prototype.connect = wrappedConnect;\n  return () => {\n    if (prototype.connect === wrappedConnect) prototype.connect = originalConnect;\n  };\n}\n\nfunction installBoundTempRpcSeam(\n  next: TelegramClient,\n  sessionId: BoundTempLongJson,\n  dcId: number,\n): void {\n  const base = (next as any)._client || next;\n  const network = base?.mt?.network as BoundTempNetwork | undefined;\n  const manager = network?._dcConnections?.get(dcId);\n  if (!manager?.main) {\n    throw new Error("Galer Cloud Web transport could not restore its temporary authorization.");\n  }\n  markBoundTempPool(manager.main, sessionId);\n}\n`;
  source = source.slice(0, functionStart) + replacement + source.slice(functionEnd);

  source = once(source,
`  const { chat_id, expected_bot_id, temp_auth_key, temp_primary_dcs } = command.session;\n  if (!chat_id || !expected_bot_id || !(temp_auth_key instanceof Uint8Array) || temp_auth_key.byteLength !== 256 || !temp_primary_dcs) {\n    throw new Error("Galer Cloud returned incomplete temporary transport authorization.");\n  }`,
`  const { chat_id, expected_bot_id, temp_auth_key, temp_session_id, temp_primary_dcs } = command.session;\n  const primaryDcId = Number((temp_primary_dcs as any)?.main?.id || 0);\n  if (\n    !chat_id ||\n    !expected_bot_id ||\n    !(temp_auth_key instanceof Uint8Array) ||\n    temp_auth_key.byteLength !== 256 ||\n    !isBoundTempLongJson(temp_session_id) ||\n    !Number.isInteger(primaryDcId) ||\n    primaryDcId < 1 ||\n    primaryDcId > 5 ||\n    !temp_primary_dcs\n  ) {\n    throw new Error("Galer Cloud returned incomplete temporary transport authorization.");\n  }`,
"worker validates bound temp session id");

  source = once(source,
`    // Task 5.1 proved that a bound temporary key can issue application RPCs\n    // without exposing the permanent application API credentials. mtcute's\n    // high-level client otherwise wraps the first RPC in initConnection using\n    // apiId=0, which the service rejects. Connect first, then mark every bound\n    // temp session as already initialized before any application RPC is sent.\n    await next.connect();\n    installBoundTempRpcSeam(next);\n    const self = await next.getMe();`,
`    // auth.bindTempAuthKey binds the temporary key to the exact MTProto\n    // session id that created it. Intercept the primary connection before the\n    // socket opens so mtcute cannot replace that id with a fresh random one.\n    // The same seam also suppresses initConnection(apiId=0); permanent API\n    // credentials remain controlled-side and never enter the browser.\n    const restoreConnect = installBoundTempConnectHook(temp_session_id, primaryDcId);\n    try {\n      await next.connect();\n    } finally {\n      restoreConnect();\n    }\n    installBoundTempRpcSeam(next, temp_session_id, primaryDcId);\n    const self = await next.getMe();`,
"worker restores bound session before connect");

  write(path, source);
}

{
  const path = "tests/component-dom/webTransportWorker.test.ts";
  let source = read(path);
  source = once(source,
`  const importSession = vi.fn(async () => undefined);\n  const connect = vi.fn(async () => undefined);\n  const boundSession = { initConnectionCalled: false };\n  const boundConnection = { _session: boundSession };\n  const onUsableAdd = vi.fn();`,
`  const importSession = vi.fn(async () => undefined);\n  class FakeLong {\n    constructor(public low: number, public high: number, public unsigned = false) {}\n  }\n  const boundSession: any = {\n    initConnectionCalled: false,\n    _sessionId: new FakeLong(1, 2, false),\n    resetState() {\n      this._sessionId = new FakeLong(9, 9, false);\n      this.initConnectionCalled = false;\n    },\n  };\n  class SessionConnection {\n    params = { isMainConnection: true, isMainDcConnection: true, dc: { id: 2 } };\n    _session = boundSession;\n    connect() {\n      connectSnapshot = {\n        low: this._session._sessionId.low,\n        high: this._session._sessionId.high,\n        unsigned: this._session._sessionId.unsigned,\n        initConnectionCalled: this._session.initConnectionCalled,\n      };\n    }\n    reset() { this._session.initConnectionCalled = false; }\n  }\n  const boundConnection = new SessionConnection();\n  let connectSnapshot: any = null;\n  const connect = vi.fn(async () => { boundConnection.connect(); });\n  const onUsableAdd = vi.fn();`,
"worker test models real SessionConnection connect");

  source = once(source,
`    TelegramClient,\n    WebCryptoProvider: class {`,
`    TelegramClient,\n    SessionConnection,\n    getConnectSnapshot: () => connectSnapshot,\n    WebCryptoProvider: class {`,
"worker test exports SessionConnection mock");

  source = once(source,
`  TelegramClient: transport.TelegramClient,\n  WebCryptoProvider: transport.WebCryptoProvider,`,
`  TelegramClient: transport.TelegramClient,\n  SessionConnection: transport.SessionConnection,\n  WebCryptoProvider: transport.WebCryptoProvider,`,
"worker test mocks SessionConnection export");

  source = once(source,
`      temp_auth_key: new Uint8Array(256).fill(7),\n      temp_primary_dcs: { main: { id: 2 }, media: { id: 2 } },`,
`      temp_auth_key: new Uint8Array(256).fill(7),\n      temp_session_id: { low: 123456, high: 789, unsigned: false },\n      temp_primary_dcs: { main: { id: 2 }, media: { id: 2 } },`,
"worker test supplies bound session id");

  source = once(source,
`    expect(transport.connect).toHaveBeenCalledOnce();\n    expect(transport.boundSession.initConnectionCalled).toBe(true);\n    expect(transport.onUsableAdd).toHaveBeenCalledOnce();`,
`    expect(transport.connect).toHaveBeenCalledOnce();\n    expect(transport.getConnectSnapshot()).toEqual({\n      low: 123456,\n      high: 789,\n      unsigned: false,\n      initConnectionCalled: true,\n    });\n    expect(transport.boundSession.initConnectionCalled).toBe(true);\n    expect(transport.boundSession._sessionId).toMatchObject({ low: 123456, high: 789, unsigned: false });\n    expect(transport.onUsableAdd).toHaveBeenCalledOnce();\n\n    transport.boundSession.resetState();\n    expect(transport.boundSession._sessionId).toMatchObject({ low: 123456, high: 789, unsigned: false });\n    expect(transport.boundSession.initConnectionCalled).toBe(true);`,
"worker test proves bound session id survives reset");
  write(path, source);
}

{
  const path = "scripts/regression-web-bound-temp-rpc.mjs";
  let source = read(path);
  source = once(source,
`const protocol = await readFile(new URL('../src/features/cloud/webTransportWorkerProtocol.ts', import.meta.url), 'utf8');`,
`const protocol = await readFile(new URL('../src/features/cloud/webTransportWorkerProtocol.ts', import.meta.url), 'utf8');\nconst session = await readFile(new URL('../src/features/cloud/webTransportSession.ts', import.meta.url), 'utf8');`,
"regression reads session bridge");
  source = once(source,
`assert.match(worker, /await next\\.connect\\(\\);\\s*\\n\\s*installBoundTempRpcSeam\\(next\\);\\s*\\n\\s*const self = await next\\.getMe\\(\\);/, 'Bound-temp seam must be installed before the first application RPC.');\nassert.match(worker, /connection\\._session\\.initConnectionCalled = true/, 'Bound temporary sessions must suppress mtcute initConnection wrapping.');\nassert.match(worker, /network\\._getOtherDc = async/, 'Additional DC managers must inherit the bound-temp seam.');\nassert.match(worker, /network\\.changePrimaryDc = async/, 'Primary DC changes must re-apply the bound-temp seam.');\nassert.match(worker, /pool\\.onUsable\\?\\.add/, 'Reconnects must re-apply the bound-temp seam.');`,
`assert.match(protocol, /temp_session_id/, 'Worker protocol must preserve the bound temporary MTProto session id.');\nassert.match(session, /temp_session_id:\\s*prepared\\.metadata\\.tempSessionId/, 'Session bridge must retain the exact id used by auth.bindTempAuthKey.');\nassert.match(worker, /installBoundTempConnectHook\\(temp_session_id, primaryDcId\\);[\\s\\S]*await next\\.connect\\(\\);/, 'Bound session id hook must be installed before opening the socket.');\nassert.match(worker, /session\\._sessionId = new LongCtor\\(sessionId\\.low, sessionId\\.high, sessionId\\.unsigned\\)/, 'Primary connection must reuse the session id that was cryptographically bound.');\nassert.match(worker, /session\\.resetState = \\(\\.\\.\\.args: any\\[\\]\\) =>/, 'Session resets must restore the bound temporary session id.');\nassert.match(worker, /session\\.initConnectionCalled = true/, 'Bound temporary sessions must suppress mtcute initConnection wrapping.');\nassert.match(worker, /markBoundTempPool\\(manager\\.main, sessionId\\)/, 'Only the bound primary MAIN pool may inherit this temporary-session seam.');\nassert.match(worker, /pool\\.onUsable\\?\\.add/, 'Reconnects must re-apply the bound-temp seam.');`,
"regression enforces bound session id");
  write(path, source);
}

console.log("APPLY_WEB_BOUND_TEMP_SESSION_ID=PASS");
