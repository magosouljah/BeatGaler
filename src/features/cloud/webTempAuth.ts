import {
  Long,
  SessionConnection,
  WebCryptoProvider,
  WebSocketTransport,
  tl,
} from "@mtcute/web";
import mtcuteWasmUrl from "@mtcute/wasm/mtcute.wasm?url";
import {
  TlBinaryWriter,
  TlSerializationCounter,
  __tlReaderMap,
  __tlWriterMap,
  longFromBuffer,
  randomLong,
} from "__beatgaler_mtcute_utils__";
import { doAuthorization } from "__beatgaler_mtcute_authorization__";

export const PRODUCTIVE_TEMP_AUTH_TTL_SECONDS = 10 * 60;
const TIMEOUT_MS = 60_000;
const PROD_DC_SUBDOMAINS: Record<number, string> = {
  1: "pluto",
  2: "venus",
  3: "aurora",
  4: "vesta",
  5: "flora",
};

export interface TempAuthLongJson {
  low: number;
  high: number;
  unsigned: boolean;
}

export interface TempAuthMetadata {
  msgId: TempAuthLongJson;
  nonce: TempAuthLongJson;
  tempAuthKeyId: TempAuthLongJson;
  tempSessionId: TempAuthLongJson;
  expiresAt: number;
}

export interface TempAuthBinding {
  perm_auth_key_id: TempAuthLongJson;
  encrypted_message: string;
}

/**
 * Minimum MTProto state needed to continue the exact session that performed
 * auth.bindTempAuthKey after crossing the main-thread/Worker boundary.
 */
export interface TempAuthSessionState {
  seqNo: number;
  lastMessageId: TempAuthLongJson;
  timeOffset: number;
  serverSalt: TempAuthLongJson;
  queuedAcks: TempAuthLongJson[];
  bindMsgId: TempAuthLongJson;
  lastSessionCreatedUid: TempAuthLongJson;
}

export interface PreparedWebTempAuth {
  dcId: number;
  metadata: TempAuthMetadata;
  bind(binding: TempAuthBinding): Promise<{
    authKey: Uint8Array;
    primaryDcs: any;
    sessionState: TempAuthSessionState;
  }>;
  destroy(): Promise<void>;
}

function timeout<T>(promise: Promise<T>, label: string, ms = TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function productionDc(dcId: number) {
  const subdomain = PROD_DC_SUBDOMAINS[dcId];
  if (!subdomain) throw new Error(`Galer Cloud returned unsupported storage DC ${dcId}.`);
  return {
    id: dcId,
    ipAddress: `${subdomain}.web.telegram.org`,
    port: 443,
    testMode: false,
    mediaOnly: false,
    ipv6: false,
  };
}

function silentLogger(prefix = ""): any {
  return {
    prefix,
    mgr: { level: 0 },
    create(child: string) { return silentLogger(prefix ? `${prefix}:${child}` : child); },
    verbose() {}, debug() {}, info() {}, warn() {},
    error(...args: unknown[]) { console.error("[galer-temp-auth]", ...args); },
  };
}

class TempSaltManager {
  currentSalt = Long.ZERO;
  isFetching = false;
  getServerTime?: () => number;
  setTimeSource(fn: () => number) { this.getServerTime = fn; }
  shouldFetchSalts() { return false; }
  setFutureSalts() {}
  destroy() {}
}

class DeferredLike<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

function longJson(value: any): TempAuthLongJson {
  return { low: value.low, high: value.high, unsigned: Boolean(value.unsigned) };
}

function longFromJson(value: TempAuthLongJson): any {
  return new Long(value.low, value.high, Boolean(value.unsigned));
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function makeConnection(provider: WebCryptoProvider, dcId: number): Promise<any> {
  class ManualSessionConnection extends SessionConnection {
    onConnected() {}
  }
  const platform = {
    isOnline: () => true,
    onNetworkChanged: () => () => {},
    getDeviceModel: () => "BeatGaler temporary data plane",
    getDefaultLogLevel: () => null,
  };
  const connection = new ManualSessionConnection({
    crypto: provider,
    initConnection: {
      _: "initConnection",
      apiId: 0,
      deviceModel: "BeatGaler temporary data plane",
      systemVersion: globalThis.navigator?.userAgent || "browser-worker",
      appVersion: "0.8.0-alpha.1",
      systemLangCode: "en",
      langPack: "",
      langCode: "en",
      query: { _: "help.getNearestDc" },
    },
    transport: new WebSocketTransport({ ws: globalThis.WebSocket }),
    dc: productionDc(dcId),
    testMode: false,
    reconnectionStrategy: () => 1_000,
    layer: tl.LAYER,
    disableUpdates: true,
    readerMap: __tlReaderMap,
    writerMap: __tlWriterMap,
    usePfs: false,
    isMainConnection: true,
    isMainDcConnection: true,
    inactivityTimeout: 120_000,
    salts: new TempSaltManager() as any,
    platform,
    pingInterval: 60_000,
  } as any, silentLogger("productive-worker"));
  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Temporary-auth socket open timeout.")), TIMEOUT_MS);
    connection.onUsable.add(() => { clearTimeout(timer); resolve(); });
  });
  connection.connect();
  await opened;
  return connection;
}

export async function prepareWebTempAuth(dcId: number): Promise<PreparedWebTempAuth> {
  if (typeof globalThis.WebSocket !== "function") throw new Error("Temporary transport requires WebSocket support.");
  const provider = new WebCryptoProvider({ wasmInput: mtcuteWasmUrl });
  await provider.initialize();
  const connection = await makeConnection(provider, dcId);
  let authKeyBytes: Uint8Array | null = null;
  try {
    const [generatedTempKey, tempServerSalt] = await timeout(
      doAuthorization(connection, provider, PRODUCTIVE_TEMP_AUTH_TTL_SECONDS),
      "temporary auth generation",
    );
    authKeyBytes = generatedTempKey;
    // mtcute 0.31.0 checks the primary key slot while decoding the manual bind.
    // This random sentinel is never authorized and never leaves this Worker.
    connection._session._authKey.setup(provider.randomBytes(256));
    const tempKey = connection._session._authKeyTempSecondary;
    tempKey.setup(authKeyBytes);
    const msgId = connection._session.getMessageId();
    const nonce = randomLong();
    const expiresAt = Math.floor(Date.now() / 1000) + PRODUCTIVE_TEMP_AUTH_TTL_SECONDS;
    const metadata: TempAuthMetadata = {
      msgId: longJson(msgId),
      nonce: longJson(nonce),
      tempAuthKeyId: longJson(longFromBuffer(tempKey.id)),
      tempSessionId: longJson(connection._session._sessionId),
      expiresAt,
    };

    return {
      dcId,
      metadata,
      async bind(binding: TempAuthBinding) {
        if (!binding?.perm_auth_key_id || !binding?.encrypted_message) {
          throw new Error("Galer Cloud returned incomplete temporary authorization.");
        }
        const pending = new DeferredLike<any>();
        connection._session.pendingMessages.set(msgId, { _: "bind", promise: pending });
        const bindRequest = {
          _: "auth.bindTempAuthKey",
          permAuthKeyId: longFromJson(binding.perm_auth_key_id),
          nonce,
          expiresAt,
          encryptedMessage: fromBase64(binding.encrypted_message),
        };
        const reqSize = TlSerializationCounter.countNeededBytes(__tlWriterMap, bindRequest);
        const reqWriter = TlBinaryWriter.alloc(__tlWriterMap, reqSize + 16);
        reqWriter.long(connection._registerOutgoingMsgId(msgId));
        reqWriter.uint(connection._session.getSeqNo());
        reqWriter.uint(reqSize);
        reqWriter.object(bindRequest);
        const requestEncrypted = tempKey.encryptMessage(
          reqWriter.result(),
          tempServerSalt,
          connection._session._sessionId,
        );
        await connection.send(requestEncrypted);
        const bindResult = await timeout(pending.promise, "auth.bindTempAuthKey response");
        connection._session.pendingMessages.delete(msgId);
        if (typeof bindResult === "object") {
          throw new Error(`Telegram rejected temporary authorization: ${bindResult.errorCode}:${bindResult.errorMessage}`);
        }
        if (bindResult !== true) throw new Error("Telegram did not accept temporary authorization.");
        const activeAuthKey = authKeyBytes;
        if (!activeAuthKey) throw new Error("Temporary authorization was cleared before it could be imported.");
        const session = connection._session as any;
        const exported = activeAuthKey.slice();
        return {
          authKey: exported,
          primaryDcs: { main: productionDc(dcId), media: productionDc(dcId) },
          sessionState: {
            seqNo: Number(session._seqNo),
            lastMessageId: longJson(session._lastMessageId),
            timeOffset: Number(session._timeOffset),
            serverSalt: longJson(tempServerSalt),
            queuedAcks: Array.from(session.queuedAcks || [], longJson),
            bindMsgId: longJson(msgId),
            lastSessionCreatedUid: longJson(session.lastSessionCreatedUid || Long.ZERO),
          },
        };
      },
      async destroy() {
        authKeyBytes?.fill(0);
        authKeyBytes = null;
        await connection.destroy().catch(() => {});
      },
    };
  } catch (error) {
    authKeyBytes?.fill(0);
    await connection.destroy().catch(() => {});
    throw error;
  }
}
