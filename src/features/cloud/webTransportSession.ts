import { getBeatGalerAuthToken, getResolvedCloudApiBase } from "../../components/AccountGate";
import { platform } from "../../platform";

export interface WebTransportCredentialEnvelope {
  version: 1;
  format: "beatgaler-web-transport-v1";
  algorithm: "RSA-OAEP-256";
  ciphertext: string;
}

export interface WebTransportSession {
  mode: "galer-direct-web-mtproto";
  session_id: string;
  transport_id: string;
  transport_user_id: string | null;
  transport_username: string | null;
  chat_id: string;
  resolver_chat_id: string | null;
  generation: number;
  credential_version: number;
  heartbeat_interval_ms: number;
  heartbeat_timeout_ms: number;
  token_rotation_enabled: boolean;
  bot_token: string;
  telegram_api_id: number;
  telegram_api_hash: string;
}

type SessionEnvelopeResponse = Omit<WebTransportSession, "bot_token" | "telegram_api_id" | "telegram_api_hash"> & {
  credential_envelope: WebTransportCredentialEnvelope;
};

export interface WebTransportHeartbeatResponse {
  ok?: boolean;
  expired?: boolean;
  credential_refresh?: SessionEnvelopeResponse;
}

export interface WebTransportOperationResponse {
  ok?: boolean;
  expired?: boolean;
  wait?: boolean;
  retry_after_ms?: number;
  refresh_required?: boolean;
  operation_id?: string;
  credential_refresh?: SessionEnvelopeResponse;
}

type BrowserKeyState = {
  publicJwk: JsonWebKey;
  privateKey: CryptoKey;
};

let browserKeyState: Promise<BrowserKeyState> | null = null;

function decodeBase64Url(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function createBrowserKeyState(): Promise<BrowserKeyState> {
  const generated = await crypto.subtle.generateKey({
    name: "RSA-OAEP",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["encrypt", "decrypt"]);

  const [publicJwk, exportedPrivate] = await Promise.all([
    crypto.subtle.exportKey("jwk", generated.publicKey),
    crypto.subtle.exportKey("pkcs8", generated.privateKey),
  ]);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    exportedPrivate,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  new Uint8Array(exportedPrivate).fill(0);
  return { publicJwk, privateKey };
}

async function keyState(): Promise<BrowserKeyState> {
  if (!browserKeyState) browserKeyState = createBrowserKeyState();
  return browserKeyState;
}

async function decryptCredentials(envelope: WebTransportCredentialEnvelope, privateKey: CryptoKey) {
  if (envelope?.version !== 1 || envelope?.format !== "beatgaler-web-transport-v1" || envelope?.algorithm !== "RSA-OAEP-256") {
    throw new Error("Galer Cloud returned an unsupported Web credential envelope.");
  }
  const decrypted = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    decodeBase64Url(envelope.ciphertext),
  );
  const compact = JSON.parse(new TextDecoder().decode(decrypted));
  const credentials = {
    bot_token: String(compact?.t || ""),
    telegram_api_id: Number(compact?.i || 0),
    telegram_api_hash: String(compact?.h || ""),
  };
  if (!credentials.bot_token || !credentials.telegram_api_id || !credentials.telegram_api_hash) {
    throw new Error("Galer Cloud returned incomplete Web transport credentials.");
  }
  return credentials;
}

async function transportRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  const response = await fetch(`${getResolvedCloudApiBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `Galer Cloud HTTP ${response.status}`);
  return payload as T;
}

async function unwrapSession(response: SessionEnvelopeResponse): Promise<WebTransportSession> {
  const keys = await keyState();
  const credentials = await decryptCredentials(response.credential_envelope, keys.privateKey);
  const { credential_envelope: _credentialEnvelope, ...publicSession } = response;
  return { ...publicSession, ...credentials };
}

function sessionIdentity(session: WebTransportSession) {
  return {
    sessionId: session.session_id,
    generation: session.generation,
    credentialVersion: session.credential_version,
  };
}

/** Opens an in-memory Web lease. Nothing is persisted and no file bytes touch the control server. */
export async function prepareWebTransportSession(): Promise<WebTransportSession> {
  const keys = await keyState();
  const response = await transportRequest<SessionEnvelopeResponse>("/transport/session/start", {
    webTransportPublicKey: keys.publicJwk,
    browserClientId: platform.clientId,
  });
  return unwrapSession(response);
}

export async function activateWebTransportSession(session: WebTransportSession): Promise<void> {
  const response = await transportRequest<{ activated?: boolean }>("/transport/session/activate", sessionIdentity(session));
  if (response.activated !== true) throw new Error("Galer Cloud could not activate this Web storage session.");
}

export async function heartbeatWebTransportSession(session: WebTransportSession): Promise<{
  expired: boolean;
  credentialRefresh: WebTransportSession | null;
}> {
  const keys = await keyState();
  const response = await transportRequest<WebTransportHeartbeatResponse>("/transport/session/heartbeat", {
    ...sessionIdentity(session),
    webTransportPublicKey: keys.publicJwk,
  });
  return {
    expired: response.expired === true,
    credentialRefresh: response.credential_refresh ? await unwrapSession(response.credential_refresh) : null,
  };
}

export async function beginWebTransportOperation(
  session: WebTransportSession,
  kind: string,
): Promise<{
  expired: boolean;
  waitMs: number | null;
  credentialRefresh: WebTransportSession | null;
  operationId: string | null;
}> {
  const keys = await keyState();
  const response = await transportRequest<WebTransportOperationResponse>("/transport/operation/begin", {
    ...sessionIdentity(session),
    kind,
    webTransportPublicKey: keys.publicJwk,
  });
  return {
    expired: response.expired === true,
    waitMs: response.wait === true ? Math.min(1000, Math.max(100, Number(response.retry_after_ms) || 250)) : null,
    credentialRefresh: response.credential_refresh ? await unwrapSession(response.credential_refresh) : null,
    operationId: typeof response.operation_id === "string" && response.operation_id ? response.operation_id : null,
  };
}

export async function endWebTransportOperation(
  session: Pick<WebTransportSession, "session_id" | "generation">,
  operationId: string,
): Promise<void> {
  await transportRequest("/transport/operation/end", {
    sessionId: session.session_id,
    generation: session.generation,
    operationId,
  });
}

export async function stopWebTransportSession(
  session: Pick<WebTransportSession, "session_id" | "generation">,
): Promise<void> {
  await transportRequest("/transport/session/stop", {
    sessionId: session.session_id,
    generation: session.generation,
  });
}

export async function ensureWebTransportTopic(beatId: string, beatName: string): Promise<number> {
  const response = await transportRequest<{ message_thread_id?: number }>("/transport/topic/ensure", {
    beatId,
    beatName,
  });
  const threadId = Number(response.message_thread_id || 0);
  if (!Number.isInteger(threadId) || threadId <= 0) {
    throw new Error("Galer Cloud returned incomplete beat storage information.");
  }
  return threadId;
}
