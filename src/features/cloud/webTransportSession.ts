import { getBeatGalerAuthToken, getResolvedCloudApiBase } from "../../components/AccountGate";
import { getWebClientId } from "../../platform/webClientId";
import {
  prepareWebTempAuth,
  type TempAuthBinding,
  type TempAuthLongJson,
  type TempAuthMetadata,
  type TempAuthSessionState,
} from "./webTempAuth";

export interface WebTransportTempAuthPublic {
  version: 1;
  dc_id: number;
  api_id: number;
  expected_bot_id: string;
  expires_at: number | null;
  binding: TempAuthBinding | null;
}

export interface WebTransportCapabilityScope {
  objectType: "beat" | "topic" | "message" | "index" | "trash";
  objectIds: string[];
}

export interface WebTransportCapabilityPublic {
  token: string;
  user_id: string;
  tenant_id: string;
  installation_id: string;
  vault_scope: string;
  operation: string;
  object_scope: { object_type: string; object_ids: string[] };
  issued_at: string;
  expires_at: string;
}

export interface WebTransportSessionPublic {
  ok?: boolean;
  mode: "galer-direct-temp-mtproto";
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
  temp_auth_required: boolean;
  temp_auth: WebTransportTempAuthPublic;
}

export interface WebTransportSession extends WebTransportSessionPublic {
  temp_auth_required: false;
  temp_auth: WebTransportTempAuthPublic & {
    expires_at: number;
    binding: TempAuthBinding;
  };
  /** Client-generated temporary key. It is never serialized back to Galer Cloud. */
  temp_auth_key: Uint8Array;
  /** MTProto session id that the temporary key was cryptographically bound to. */
  temp_session_id: TempAuthLongJson;
  /** MTProto counters/salt/ACK state needed to continue the bound session in the Worker. */
  temp_session_state: TempAuthSessionState;
  temp_primary_dcs: unknown;
}

export interface WebTransportHeartbeatResponse {
  ok?: boolean;
  expired?: boolean;
  refresh_required?: boolean;
  temp_auth_required?: boolean;
  credential_refresh?: WebTransportSessionPublic | null;
}

export interface WebTransportOperationResponse {
  ok?: boolean;
  expired?: boolean;
  wait?: boolean;
  retry_after_ms?: number;
  refresh_required?: boolean;
  temp_auth_required?: boolean;
  operation_id?: string;
  capability?: WebTransportCapabilityPublic;
  credential_refresh?: WebTransportSessionPublic | null;
}

async function transportRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  const response = await fetch(`${getResolvedCloudApiBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(webTransportRequestBody(body)),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `Galer Cloud HTTP ${response.status}`);
  return payload as T;
}

export function webTransportRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, beatgalerUserId: getWebClientId() };
}

function assertNoPermanentCredentials(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of ["bot_token", "telegram_api_id", "telegram_api_hash", "credential_envelope"]) {
    if (serialized.includes(`\"${forbidden}\"`)) {
      throw new Error("Galer Cloud refused an unsafe transport credential response.");
    }
  }
}

function validateBootstrap(response: WebTransportSessionPublic): WebTransportSessionPublic {
  assertNoPermanentCredentials(response);
  if (response?.mode !== "galer-direct-temp-mtproto") {
    throw new Error("Galer Cloud returned an unsupported Direct transport mode.");
  }
  const dcId = Number(response?.temp_auth?.dc_id || 0);
  const apiId = Number(response?.temp_auth?.api_id || 0);
  if (
    !Number.isInteger(dcId) || dcId < 1 || dcId > 5 ||
    !Number.isInteger(apiId) || apiId <= 0 ||
    !response?.temp_auth?.expected_bot_id
  ) {
    throw new Error("Galer Cloud returned incomplete temporary authorization metadata.");
  }
  return response;
}

function sessionIdentity(session: WebTransportSession) {
  return {
    sessionId: session.session_id,
    generation: session.generation,
    credentialVersion: session.credential_version,
  };
}

async function bindTemporarySession(
  bootstrap: WebTransportSessionPublic,
  metadata?: TempAuthMetadata,
): Promise<WebTransportSession> {
  const safeBootstrap = validateBootstrap(bootstrap);
  const prepared = await prepareWebTempAuth(safeBootstrap.temp_auth.dc_id);
  try {
    if (metadata) throw new Error("Unexpected prebuilt temporary-auth metadata.");
    const response = validateBootstrap(await transportRequest<WebTransportSessionPublic>("/transport/session/start", {
      browserClientId: getWebClientId(),
      tempAuthMetadata: prepared.metadata,
    }));
    if (
      response.session_id !== safeBootstrap.session_id ||
      response.generation !== safeBootstrap.generation ||
      response.transport_id !== safeBootstrap.transport_id ||
      response.temp_auth.api_id !== safeBootstrap.temp_auth.api_id
    ) {
      throw new Error("Galer Cloud changed the Direct lease while binding temporary authorization.");
    }
    const binding = response.temp_auth.binding;
    const expiresAt = Number(response.temp_auth.expires_at || 0);
    if (!binding || expiresAt !== prepared.metadata.expiresAt) {
      throw new Error("Galer Cloud returned an incomplete temporary authorization binding.");
    }
    const imported = await prepared.bind(binding);
    return {
      ...response,
      temp_auth_required: false,
      temp_auth: { ...response.temp_auth, expires_at: expiresAt, binding },
      temp_auth_key: imported.authKey,
      temp_session_id: prepared.metadata.tempSessionId,
      temp_session_state: imported.sessionState,
      temp_primary_dcs: imported.primaryDcs,
    } as WebTransportSession;
  } finally {
    await prepared.destroy().catch(() => {});
  }
}

/** Opens a lease, then binds a client-generated temporary key. No permanent transport secret reaches the browser. */
export async function prepareWebTransportSession(): Promise<WebTransportSession> {
  const bootstrap = validateBootstrap(await transportRequest<WebTransportSessionPublic>("/transport/session/start", {
    browserClientId: getWebClientId(),
  }));
  return bindTemporarySession(bootstrap);
}

export async function renewWebTransportSession(session: WebTransportSession): Promise<WebTransportSession> {
  const prepared = await prepareWebTempAuth(session.temp_auth.dc_id);
  try {
    const response = validateBootstrap(await transportRequest<WebTransportSessionPublic>("/transport/session/start", {
      browserClientId: getWebClientId(),
      tempAuthMetadata: prepared.metadata,
    }));
    if (
      response.session_id !== session.session_id ||
      response.generation !== session.generation ||
      response.transport_id !== session.transport_id ||
      response.temp_auth.api_id !== session.temp_auth.api_id
    ) {
      throw new Error("Galer Cloud changed the Direct lease during temporary-auth renewal.");
    }
    const binding = response.temp_auth.binding;
    const expiresAt = Number(response.temp_auth.expires_at || 0);
    if (!binding || expiresAt !== prepared.metadata.expiresAt) {
      throw new Error("Galer Cloud returned an incomplete renewal binding.");
    }
    const imported = await prepared.bind(binding);
    return {
      ...response,
      temp_auth_required: false,
      temp_auth: { ...response.temp_auth, expires_at: expiresAt, binding },
      temp_auth_key: imported.authKey,
      temp_session_id: prepared.metadata.tempSessionId,
      temp_session_state: imported.sessionState,
      temp_primary_dcs: imported.primaryDcs,
    } as WebTransportSession;
  } finally {
    await prepared.destroy().catch(() => {});
  }
}

export async function activateWebTransportSession(session: WebTransportSession): Promise<void> {
  const response = await transportRequest<{ activated?: boolean }>("/transport/session/activate", sessionIdentity(session));
  if (response.activated !== true) throw new Error("Galer Cloud could not activate this Web storage session.");
}

export async function heartbeatWebTransportSession(session: WebTransportSession): Promise<{
  expired: boolean;
  credentialRefresh: WebTransportSession | null;
}> {
  const response = await transportRequest<WebTransportHeartbeatResponse>("/transport/session/heartbeat", sessionIdentity(session));
  assertNoPermanentCredentials(response);
  if (response.expired === true) return { expired: true, credentialRefresh: null };
  const now = Math.floor(Date.now() / 1000);
  const renewBefore = session.temp_auth.expires_at - 120;
  const needsRenewal = now >= renewBefore || response.refresh_required === true || response.temp_auth_required === true;
  return {
    expired: false,
    credentialRefresh: needsRenewal ? await renewWebTransportSession(session) : null,
  };
}

export async function beginWebTransportOperation(
  session: WebTransportSession,
  kind: string,
  scope: WebTransportCapabilityScope,
): Promise<{
  expired: boolean;
  waitMs: number | null;
  credentialRefresh: WebTransportSession | null;
  operationId: string | null;
}> {
  const response = await transportRequest<WebTransportOperationResponse>("/transport/operation/begin", {
    ...sessionIdentity(session),
    kind,
    scope,
  });
  assertNoPermanentCredentials(response);
  if (response.expired === true) {
    return { expired: true, waitMs: null, credentialRefresh: null, operationId: null };
  }
  if (response.refresh_required === true || response.temp_auth_required === true) {
    return {
      expired: false,
      waitMs: null,
      credentialRefresh: await renewWebTransportSession(session),
      operationId: null,
    };
  }
  const operationId = typeof response.operation_id === "string" && response.operation_id ? response.operation_id : null;
  if (operationId && (!response.capability || response.capability.token !== operationId)) {
    throw new Error("Galer Cloud returned an unscoped Direct operation.");
  }
  return {
    expired: false,
    waitMs: response.wait === true ? Math.min(1000, Math.max(100, Number(response.retry_after_ms) || 250)) : null,
    credentialRefresh: null,
    operationId,
  };
}

export async function authorizeWebTransportOperation(
  session: Pick<WebTransportSession, "session_id" | "generation">,
  operationId: string,
  kind: string,
  scope: WebTransportCapabilityScope,
): Promise<void> {
  const response = await transportRequest<{ authorized?: boolean; operation_id?: string }>("/transport/capability/authorize", {
    sessionId: session.session_id,
    generation: session.generation,
    operationId,
    kind,
    scope,
  });
  assertNoPermanentCredentials(response);
  if (response.authorized !== true || response.operation_id !== operationId) {
    throw new Error("Galer Cloud refused the scoped Direct capability.");
  }
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

/** Records only the tiny authoritative INDEX pointer; document bytes stay on the direct data plane. */
export async function commitWebTransportIndexPointer(input: {
  messageId: number;
  sourceId: string;
  beatCount: number;
}): Promise<void> {
  await transportRequest("/transport/index/commit", input);
}
