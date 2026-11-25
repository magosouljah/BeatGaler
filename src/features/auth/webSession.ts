import { platform } from "../../platform";
import { playTrace } from "../playback/playTrace";
import { getWebAccountGeneration, setActiveWebAccountId } from "./activeWebAccount";
import { WEB_SESSION_MARKER_KEY, WEB_CSRF_SESSION_KEY as CSRF_KEY } from "./webSessionBootstrap";

const TOKEN_KEY = "beatgaler:account-session:v1";
const BROWSER_SESSION_SENTINEL = "browser-cookie-session";
const PENDING_SIGNUP_KEY = "beatgaler:pending-signup:v1";
export function getBeatGalerAuthToken(): string | null {
  if (platform.kind === "web") return localStorage.getItem(WEB_SESSION_MARKER_KEY) === "1" ? BROWSER_SESSION_SENTINEL : null;
  return localStorage.getItem(TOKEN_KEY);
}
const API_KEY = "beatgaler:cloud-api:v1";
const LOCAL_API = import.meta.env.DEV ? "http://127.0.0.1:4000" : null;
const REMOTE_API = "https://desktop-7l93a0j.tailabe8ff.ts.net";

function sameOriginProxyApi(): string | null {
  if (typeof window === "undefined") return null;
  return `${window.location.origin}/beatgaler-api`;
}

function currentWebCsrfToken(): string {
  if (platform.kind !== "web" || typeof sessionStorage === "undefined") return "";
  return sessionStorage.getItem(CSRF_KEY) || "";
}

function trustedRememberedApi(value: string | null): value is string {
  if (!value) return false;
  const sameOriginProxy = sameOriginProxyApi();
  if (platform.kind === "web") return !!sameOriginProxy && value === sameOriginProxy;
  return value === REMOTE_API || (!!LOCAL_API && value === LOCAL_API);
}

function isBeatGalerApiRequest(input: RequestInfo | URL): boolean {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const sameOriginProxy = sameOriginProxyApi();
  return !!sameOriginProxy && (url === sameOriginProxy || url.startsWith(`${sameOriginProxy}/`));
}

function installWebCredentialedFetchBoundary(): void {
  if (platform.kind !== "web" || typeof window === "undefined") return;
  const taggedWindow = window as Window & { __beatgalerCredentialedFetchInstalled?: boolean };
  if (taggedWindow.__beatgalerCredentialedFetchInstalled) return;
  taggedWindow.__beatgalerCredentialedFetchInstalled = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    if (!isBeatGalerApiRequest(input)) return nativeFetch(input, init);
    const requestInput = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const headers = new Headers(init.headers || requestInput?.headers);
    headers.set("X-BeatGaler-Client", "web");
    const method = String(init.method || requestInput?.method || "GET").toUpperCase();
    if (!new Set(["GET", "HEAD", "OPTIONS"]).has(method)) {
      const csrf = currentWebCsrfToken();
      if (csrf) headers.set("X-BeatGaler-CSRF", csrf);
    }
    return nativeFetch(input, { ...init, headers, credentials: "include" });
  }) as typeof window.fetch;
}

installWebCredentialedFetchBoundary();

export type OAuthProvider = "google" | "x";
export type BeatGalerPlanId = "free" | "paid_entry" | "highest_paid";
export interface BeatGalerPlanDefinition {
  id: BeatGalerPlanId;
  label: string;
  checkout_available?: boolean;
  price?: { amount_minor: number; currency: string; interval: "month" | null; offer_id: string | null };
  entitlements: { upload_project: boolean; early_access: boolean };
  quotas: {
    max_beats: number | null;
    max_project_zip_bytes: number | null;
    max_active_devices?: number | null;
    max_simultaneous_sessions?: number | null;
  };
}
export interface BeatGalerAccount {
  id: string;
  username: string;
  username_source?: "beatgaler" | "x";
  official_username?: boolean;
  email?: string | null;
  storage_ready: boolean;
  has_password?: boolean;
  mfa_enabled?: boolean;
  plan?: {
    base_plan_id: BeatGalerPlanId;
    effective_plan_id: BeatGalerPlanId;
    initial_checkout_allowed?: boolean;
    label: string;
    effective_until?: number | null;
    access_source?: string;
    entitlements: { upload_project: boolean; bulk_youtube_upload: "none" | "limited" | "full"; early_access: boolean };
    quotas: {
      max_beats: number | null;
      max_project_zip_bytes: number | null;
      youtube_uploads_per_day: number | null;
      youtube_uploads_per_month: number | null;
      max_active_devices?: number | null;
      max_simultaneous_sessions?: number | null;
    };
    referral?: { rewarded_referrals_per_month: number; reward_plan_id: string; reward_days: number };
    access?: {
      commercialPlanId: BeatGalerPlanId;
      commercialAccessPlanId?: BeatGalerPlanId | null;
      commercialAccessState: string;
      effectivePlanId: BeatGalerPlanId;
      capabilities: BeatGalerPlanDefinition["entitlements"];
      quotas: BeatGalerPlanDefinition["quotas"];
      accessSources: Array<{ type: string; mode: string; planId: BeatGalerPlanId; validUntil: number | null }>;
      nextRecalculationAt: number | null;
      billing: { paidThrough: number | null; graceUntil: number | null; cancelAtPeriodEnd: boolean; nextPlanId: BeatGalerPlanId | null; nextPlanEffectiveAt: number | null; providerStatus?: string | null; endedAt?: number | null };
    };
  };
  providers?: {
    google?: { connected: boolean; email?: string | null; name?: string | null };
    x?: { connected: boolean; username?: string | null; name?: string | null };
  };
}

export interface BeatGalerSessionInfo {
  id: string;
  current: boolean;
  created_at: string;
  expires_at: string;
  last_seen_at?: string | null;
  client_kind?: string;
  installation_id?: string | null;
}

type AuthResponse = { ok: boolean; token?: string; csrf_token?: string; session_transport?: "cookie"; session_rotated?: boolean; user: BeatGalerAccount; linked?: boolean; pending?: boolean };

type RequestFailureKind = "http" | "offline" | "timeout" | "network";
type BeatGalerRequestError = Error & { status?: number; code?: string; kind?: RequestFailureKind; mfa_required?: boolean };

function taggedRequestError(message: string, fields: Partial<BeatGalerRequestError>): BeatGalerRequestError {
  return Object.assign(new Error(message), fields);
}

function networkFailure(error: unknown): BeatGalerRequestError {
  const value = error as { name?: string; message?: string } | null;
  if (value?.name === "AbortError") return taggedRequestError("BeatGaler Cloud request timed out. Your saved session was kept.", { code: "CLOUD_TIMEOUT", kind: "timeout" });
  if (typeof navigator !== "undefined" && navigator.onLine === false) return taggedRequestError("BeatGaler Cloud is offline. Your saved session was kept.", { code: "CLOUD_OFFLINE", kind: "offline" });
  return taggedRequestError(value?.message || "Could not reach BeatGaler Cloud. Your saved session was kept.", { code: "CLOUD_UNREACHABLE", kind: "network" });
}

export function isBeatGalerSessionExpiryError(error: unknown): boolean {
  const value = error as BeatGalerRequestError | null;
  return Number(value?.status || 0) === 401 || ["SESSION_EXPIRED", "SESSION_REVOKED", "SESSION_ROTATED", "SESSION_ROTATION_EXPIRED", "SESSION_INVALID"].includes(String(value?.code || ""));
}

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 10000): Promise<any> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      throw networkFailure(error);
    }
    const text = await response.text();
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text || `HTTP ${response.status}` }; }
    if (!response.ok) {
      const error: BeatGalerRequestError = taggedRequestError(body?.error || `BeatGaler Cloud HTTP ${response.status}`, {
        status: response.status,
        code: body?.code || `HTTP_${response.status}`,
        kind: "http",
      });
      Object.assign(error, body || {});
      throw error;
    }
    return body;
  } finally { window.clearTimeout(timeout); }
}

async function probe(base: string, timeoutMs: number): Promise<boolean> {
  try { return (await fetchJson(`${base}/auth/health`, undefined, timeoutMs))?.account_auth === true; }
  catch { return false; }
}

export async function resolveBeatGalerCloudApi(): Promise<string> {
  const remembered = localStorage.getItem(API_KEY);
  const sameOriginProxy = sameOriginProxyApi();
  if (platform.kind === "web") {
    if (!sameOriginProxy) throw new Error("Could not resolve BeatGaler Cloud API.");
    if (remembered && remembered !== sameOriginProxy) localStorage.removeItem(API_KEY);
    localStorage.setItem(API_KEY, sameOriginProxy);
    return sameOriginProxy;
  }
  if (trustedRememberedApi(remembered) && await probe(remembered, 1200)) return remembered;
  if (LOCAL_API && await probe(LOCAL_API, 900)) {
    localStorage.setItem(API_KEY, LOCAL_API);
    return LOCAL_API;
  }
  if (await probe(REMOTE_API, 2500)) {
    localStorage.setItem(API_KEY, REMOTE_API);
    return REMOTE_API;
  }
  throw new Error("Could not reach BeatGaler Cloud.");
}

export function getResolvedCloudApiBase(): string {
  const remembered = localStorage.getItem(API_KEY);
  if (platform.kind === "web") return sameOriginProxyApi() || "";
  return trustedRememberedApi(remembered) ? remembered : REMOTE_API;
}

export async function getBeatGalerInstallationId(): Promise<string> {
  return platform.account.getInstallationId();
}

function clearLocalSessionState(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(WEB_SESSION_MARKER_KEY);
  try { sessionStorage.removeItem(CSRF_KEY); } catch {}
}

async function authRequest(path: string, body: Record<string, unknown> = {}, token?: string, onDispatched?: () => void): Promise<any> {
  let base: string;
  try { base = await resolveBeatGalerCloudApi(); }
  catch (error) { throw networkFailure(error); }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (platform.kind === "web") {
    headers["X-BeatGaler-Client"] = "web";
    const csrf = currentWebCsrfToken();
    if (csrf) headers["X-BeatGaler-CSRF"] = csrf;
  }
  if (token && !(platform.kind === "web" && token === BROWSER_SESSION_SENTINEL)) headers.Authorization = `Bearer ${token}`;
  const pending = fetchJson(`${base}${path}`, {
    method: "POST",
    headers,
    credentials: platform.kind === "web" ? "include" : "same-origin",
    body: JSON.stringify(body),
  }, path === "/auth/register" ? 45000 : 20000);
  onDispatched?.();
  const result = await pending;
  if (platform.kind === "web" && result?.csrf_token) sessionStorage.setItem(CSRF_KEY, String(result.csrf_token));
  return result;
}

type WebSessionConfirmationFlow = "account" | "restore" | "oauth";

function prepareWebSessionConfirmation(result: AuthResponse, flow: WebSessionConfirmationFlow) {
  const user = flow === "oauth" ? result?.user : result.user;
  if (!user?.id) throw new Error("Cloud did not confirm an account identity.");
  if (flow !== "oauth") playTrace("AUTH_SESSION_CONFIRMED");
  setActiveWebAccountId(user.id);
  const confirmedGeneration = getWebAccountGeneration();
  localStorage.removeItem(TOKEN_KEY);
  localStorage.setItem(WEB_SESSION_MARKER_KEY, "1");
  if (flow !== "restore" && result.csrf_token) {
    sessionStorage.setItem(CSRF_KEY, flow === "oauth" ? String(result.csrf_token) : result.csrf_token);
  }
  return {
    user,
    sync: (base = getResolvedCloudApiBase()) => platform.cloudAuth.syncSession(null, base),
    finish() {
      if (confirmedGeneration !== getWebAccountGeneration()) {
        if (flow === "restore") return false;
        throw new Error("Sign-in was cancelled by an account change.");
      }
      if (flow !== "restore") publishAccountUpdate(user);
      return true;
    },
  };
}

function publishAccountUpdate(user: BeatGalerAccount): void {
  window.dispatchEvent(new CustomEvent("beatgaler:account-updated", { detail: user }));
}

export async function storeWebCookieSession(result: AuthResponse): Promise<BeatGalerAccount> {
  const confirmation = prepareWebSessionConfirmation(result, "oauth");
  const base = await resolveBeatGalerCloudApi();
  await confirmation.sync(base);
  confirmation.finish();
  return confirmation.user;
}

async function storeSession(result: AuthResponse): Promise<BeatGalerAccount> {
  if (platform.kind === "web") {
    const confirmation = prepareWebSessionConfirmation(result, "account");
    await confirmation.sync();
    confirmation.finish();
  } else {
    if (result.token) {
      localStorage.setItem(TOKEN_KEY, result.token);
      await platform.cloudAuth.syncSession(result.token, getResolvedCloudApiBase());
    }
    publishAccountUpdate(result.user);
  }
  return result.user;
}

export type PendingBeatGalerSignup = {
  signup_pending: boolean;
  signup_id?: string;
  recovered?: boolean;
  continuation_secret?: string;
  status: string;
  expires_at?: string;
};

function rememberDesktopSignup(result: PendingBeatGalerSignup): void {
  if (platform.kind === "web" || !result.signup_id || !result.continuation_secret) return;
  localStorage.setItem(PENDING_SIGNUP_KEY, JSON.stringify({
    signup_id: result.signup_id,
    continuation_secret: result.continuation_secret,
    expires_at: result.expires_at,
  }));
}

export function clearDesktopSignup(): void {
  if (platform.kind !== "web") localStorage.removeItem(PENDING_SIGNUP_KEY);
}

export function rememberedDesktopSignup(): { signup_id: string; continuation_secret: string } | null {
  if (platform.kind === "web") return null;
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_SIGNUP_KEY) || "null");
    if (!value?.signup_id || !value?.continuation_secret || (value.expires_at && Date.parse(value.expires_at) <= Date.now())) {
      clearDesktopSignup();
      return null;
    }
    return value;
  } catch { clearDesktopSignup(); return null; }
}

export async function registerBeatGalerAccount(usernameBase: string, email: string, password: string): Promise<BeatGalerAccount | PendingBeatGalerSignup> {
  const result = await authRequest("/auth/register", { usernameBase, email, password, beatgalerUserId: await getBeatGalerInstallationId() });
  if (result?.signup_pending) { rememberDesktopSignup(result); return result as PendingBeatGalerSignup; }
  clearDesktopSignup();
  return await storeSession(result);
}

export async function verifyBeatGalerSignup(signupId: string, code: string, continuationSecret = ""): Promise<BeatGalerAccount | PendingBeatGalerSignup> {
  const result = await authRequest("/auth/signup/verify", { signup_id: signupId, continuation_secret: continuationSecret, code });
  if (result?.user) { clearDesktopSignup(); return await storeSession(result); }
  if (result?.status === "ACTIVE") clearDesktopSignup();
  return result as PendingBeatGalerSignup;
}

export async function resendBeatGalerSignup(signupId: string, continuationSecret = ""): Promise<void> {
  await authRequest("/auth/signup/resend", { signup_id: signupId, continuation_secret: continuationSecret });
}

export async function resumeBeatGalerSignup(signupId = "", continuationSecret = ""): Promise<PendingBeatGalerSignup | BeatGalerAccount> {
  const remembered = !signupId ? rememberedDesktopSignup() : null;
  const result = await authRequest("/auth/signup/status", {
    signup_id: signupId || remembered?.signup_id || "",
    continuation_secret: continuationSecret || remembered?.continuation_secret || "",
  });
  if (result?.user) { clearDesktopSignup(); return await storeSession(result); }
  if (result?.status === "ACTIVE") clearDesktopSignup();
  if (platform.kind !== "web" && result?.signup_pending) {
    return { ...result, continuation_secret: continuationSecret || remembered?.continuation_secret || "" } as PendingBeatGalerSignup;
  }
  return result as PendingBeatGalerSignup;
}

let signInPrewarm: { accountId: string | null } | null = null;
let discardDirectPrewarm: (() => Promise<void>) | undefined;

function discardSignInPrewarm(): Promise<void> | undefined {
  signInPrewarm = null;
  const discard = discardDirectPrewarm;
  discardDirectPrewarm = undefined;
  return discard?.();
}

type SignInPrewarm = {
  enabled: () => boolean;
  load: () => Promise<{
    prewarmDirectRuntime: (owner: { accountId: string | null }) => void;
    discardPrewarmedDirectRuntime: () => Promise<void>;
  }>;
};

export async function loginBeatGalerAccount(
  email: string,
  password: string,
  mfaCode = "",
  signInPrewarmOptions?: SignInPrewarm,
): Promise<BeatGalerAccount> {
  if (logoutBeatGalerAccountInFlight) await logoutBeatGalerAccountInFlight;
  const prewarm = platform.kind === "web" && signInPrewarmOptions?.enabled() && typeof window !== "undefined"
    && !(window as any).__TAURI_INTERNALS__ && (typeof navigator === "undefined" || navigator.onLine !== false)
    ? signInPrewarmOptions : null;
  const owner: { accountId: string | null } | null = prewarm ? { accountId: null } : null;
  if (owner) signInPrewarm = owner;
  // Start loading in parallel, but don't construct the Worker until login has been dispatched.
  const directPort = prewarm?.load().catch(() => null);
  const onDispatched = owner && directPort ? () => {
    void directPort.then(module => {
      if (!module || signInPrewarm !== owner) return;
      playTrace("DIRECT_SIGN_IN_PRECONNECT_BEGIN");
      module.prewarmDirectRuntime(owner);
      discardDirectPrewarm = module.discardPrewarmedDirectRuntime;
    }).catch(() => {});
  } : undefined;
  const generation = getWebAccountGeneration();
  const result = await authRequest("/auth/login", { email, password, mfaCode, beatgalerUserId: await getBeatGalerInstallationId() }, undefined, onDispatched);
  if (platform.kind === "web" && generation !== getWebAccountGeneration()) throw new Error("Sign-in was cancelled by an account change.");
  if (owner && typeof result.user?.id === "string") owner.accountId = result.user.id.trim() || null;
  return await storeSession(result);
}

let restoreBeatGalerSessionInFlight: Promise<BeatGalerAccount | null> | null = null;

export function restoreBeatGalerSession(): Promise<BeatGalerAccount | null> {
  // AuthExperienceGate and the legacy AccountGate can mount in the same Web
  // tree. Share one restore request so optimistic cache reveal does not turn
  // into duplicate /auth/session round trips.
  if (restoreBeatGalerSessionInFlight) return restoreBeatGalerSessionInFlight;

  const pending = (async (): Promise<BeatGalerAccount | null> => {
    const generation = getWebAccountGeneration();
    const legacyToken = localStorage.getItem(TOKEN_KEY);
    const hasWebMarker = platform.kind === "web" && localStorage.getItem(WEB_SESSION_MARKER_KEY) === "1";
    const token = platform.kind === "web" ? (legacyToken || (hasWebMarker ? BROWSER_SESSION_SENTINEL : null)) : legacyToken;
    if (!token) return null;
    try {
      const result = await authRequest("/auth/session", { beatgalerUserId: await getBeatGalerInstallationId() }, token);
      if (platform.kind === "web" && generation !== getWebAccountGeneration()) return null;
      if (platform.kind === "web") {
        const confirmation = prepareWebSessionConfirmation(result, "restore");
        await confirmation.sync();
        if (!confirmation.finish()) return null;
      } else {
        const activeToken = result?.token || token;
        if (result?.token) localStorage.setItem(TOKEN_KEY, result.token);
        await platform.cloudAuth.syncSession(activeToken, getResolvedCloudApiBase());
      }
      return result.user;
    } catch (error) {
      if (platform.kind === "web" && generation !== getWebAccountGeneration()) return null;
      if (!isBeatGalerSessionExpiryError(error)) throw error;
      clearLocalSessionState();
      if (platform.kind === "web") setActiveWebAccountId(null);
      if (platform.kind === "web") {
        void discardSignInPrewarm()?.catch(() => {});
        void platform.cloudData.disconnect().catch(() => {});
      }
      try { await platform.cloudAuth.syncSession(null, getResolvedCloudApiBase()); } catch {}
      return null;
    }
  })();

  restoreBeatGalerSessionInFlight = pending;
  const clear = () => {
    if (restoreBeatGalerSessionInFlight === pending) restoreBeatGalerSessionInFlight = null;
  };
  pending.then(clear, clear);
  return pending;
}

export async function getBeatGalerAccountInfo(): Promise<BeatGalerAccount> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  return (await authRequest("/auth/account", {}, token)).user;
}

export async function getBeatGalerCurrentPlan(): Promise<NonNullable<BeatGalerAccount["plan"]>> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  const base = await resolveBeatGalerCloudApi();
  const headers: Record<string, string> = {};
  if (!(platform.kind === "web" && token === BROWSER_SESSION_SENTINEL)) headers.Authorization = `Bearer ${token}`;
  const result = await fetchJson(`${base}/plans/me`, { headers, credentials: platform.kind === "web" ? "include" : "same-origin" });
  if (!result?.plan?.effective_plan_id) throw new Error("Current plan is unavailable.");
  return result.plan;
}

export async function listBeatGalerSessions(): Promise<BeatGalerSessionInfo[]> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  const result = await authRequest("/auth/sessions", {}, token);
  return Array.isArray(result?.sessions) ? result.sessions : [];
}

export async function revokeBeatGalerSession(sessionId: string): Promise<{ current_revoked: boolean }> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  const result = await authRequest("/auth/sessions/revoke", { session_id: sessionId }, token);
  if (result?.current_revoked) {
    clearLocalSessionState();
    try { await platform.cloudAuth.syncSession(null, getResolvedCloudApiBase()); } catch {}
    window.dispatchEvent(new Event("beatgaler:account-logged-out"));
  }
  return { current_revoked: result?.current_revoked === true };
}

export async function revokeAllBeatGalerSessions(): Promise<number> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  const result = await authRequest("/auth/sessions/revoke-all", {}, token);
  clearLocalSessionState();
  try { await platform.cloudAuth.syncSession(null, getResolvedCloudApiBase()); } catch {}
  window.dispatchEvent(new Event("beatgaler:account-logged-out"));
  return Number(result?.revoked_count || 0);
}

export async function getBeatGalerPlanCatalog(): Promise<BeatGalerPlanDefinition[]> {
  const base = await resolveBeatGalerCloudApi();
  const result = await fetchJson(`${base}/plans/catalog`);
  return Array.isArray(result?.plans) ? result.plans : [];
}

export async function startBeatGalerCheckout(offerId: string, requestId: string): Promise<{ url: string; recovered: boolean }> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  const result = await authRequest("/billing/checkout", { offerId, requestId }, token);
  const url = String(result?.checkout?.url || "");
  if (result?.checkout?.state !== "OPEN" || new URL(url).protocol !== "https:") {
    throw new Error("Checkout could not be opened securely.");
  }
  return { url, recovered: Boolean(result.checkout.recovered) };
}

export async function reauthenticateBeatGalerPassword(password: string, mfaCode = ""): Promise<string> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  const result = await authRequest("/auth/reauth", { password, mfaCode }, token);
  return String(result.reauth_token || "");
}

export async function reauthenticateBeatGalerProvider(provider: OAuthProvider): Promise<string> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  const started = await authRequest("/auth/oauth/start", { provider, purpose: "reauth" }, token);
  await platform.external.openUrl(started.authorization_url);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10 * 60 * 1000) {
    await new Promise(resolve => window.setTimeout(resolve, 900));
    const result = await authRequest("/auth/oauth/poll", { flowId: started.flow_id }, token);
    if (result.pending) continue;
    if (!result.reauth_token) throw new Error("Provider reauthentication did not complete.");
    return String(result.reauth_token);
  }
  throw new Error("Provider reauthentication timed out. Try again.");
}

export async function startBeatGalerEmailChange(email: string, reauthToken: string): Promise<void> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  await authRequest("/auth/email/change/start", { email, reauthToken }, token);
}

export async function resendBeatGalerEmailChange(): Promise<void> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  await authRequest("/auth/email/change/resend", {}, token);
}

export async function confirmBeatGalerEmailChange(code: string): Promise<void> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  await authRequest("/auth/email/change/confirm", { code }, token);
  clearLocalSessionState();
  try { await platform.cloudAuth.syncSession(null, getResolvedCloudApiBase()); } catch {}
  window.dispatchEvent(new Event("beatgaler:account-logged-out"));
}

export async function changeBeatGalerPassword(currentPassword: string, newPassword: string, reauthToken = ""): Promise<void> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  const result = await authRequest("/auth/password/change", { currentPassword, newPassword, reauthToken }, token);
  if (platform.kind !== "web" && result?.token) {
    localStorage.setItem(TOKEN_KEY, result.token);
    await platform.cloudAuth.syncSession(result.token, getResolvedCloudApiBase());
  }
}

export async function beginMfaSetup(): Promise<{ secret: string; otpauth_url: string }> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  return authRequest("/auth/mfa/setup", {}, token);
}
export async function enableMfa(code: string): Promise<void> {
  const token = getBeatGalerAuthToken(); if (!token) throw new Error("Session expired. Sign in again.");
  await authRequest("/auth/mfa/enable", { code }, token);
}
export async function disableMfa(code: string): Promise<void> {
  const token = getBeatGalerAuthToken(); if (!token) throw new Error("Session expired. Sign in again.");
  await authRequest("/auth/mfa/disable", { code }, token);
}

export async function oauthBeatGalerAccount(provider: OAuthProvider, linkExisting: boolean, reauthToken = ""): Promise<BeatGalerAccount> {
  const beatgalerUserId = await getBeatGalerInstallationId();
  const token = linkExisting ? getBeatGalerAuthToken() || undefined : undefined;
  const before = linkExisting ? await getBeatGalerAccountInfo().catch(() => null) : null;
  const started = await authRequest("/auth/oauth/start", { provider, beatgalerUserId, reauthToken }, token);
  await platform.external.openUrl(started.authorization_url);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10 * 60 * 1000) {
    await new Promise(resolve => window.setTimeout(resolve, 900));
    const result = await authRequest("/auth/oauth/poll", { flowId: started.flow_id, beatgalerUserId }, token);
    if (result.pending) continue;
    const user: BeatGalerAccount = linkExisting ? result.user : await storeSession(result);
    if (provider === "x") {
      const previousUsername = before?.username || null;
      window.dispatchEvent(new CustomEvent("beatgaler:x-username-unlocked", { detail: { username: user.username, previousUsername } }));
    }
    if (linkExisting) window.dispatchEvent(new CustomEvent("beatgaler:account-updated", { detail: user }));
    return user;
  }
  throw new Error("Sign-in timed out. Try again.");
}

export async function disconnectOAuthProvider(provider: OAuthProvider, reauthToken = ""): Promise<void> {
  const token = getBeatGalerAuthToken(); if (!token) throw new Error("Session expired. Sign in again.");
  await authRequest("/auth/oauth/disconnect", { provider, reauthToken }, token);
  window.dispatchEvent(new Event("beatgaler:account-updated"));
}

let logoutBeatGalerAccountInFlight: Promise<void> | null = null;

export function logoutBeatGalerAccount(): Promise<void> {
  if (logoutBeatGalerAccountInFlight) return logoutBeatGalerAccountInFlight;
  const token = getBeatGalerAuthToken();
  // Hide and invalidate the old account before the logout round trip begins.
  setActiveWebAccountId(null);
  window.dispatchEvent(new Event("beatgaler:account-logged-out"));
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(WEB_SESSION_MARKER_KEY);
  const pending = (async () => {
    const remote = (async () => {
      try { if (token) await authRequest("/auth/logout", { beatgalerUserId: await getBeatGalerInstallationId() }, token); } catch {}
    })();
    const disconnect = platform.cloudData.disconnect().catch(() => {});
    await Promise.all([remote, disconnect, discardSignInPrewarm()?.catch(() => {})]);
    clearLocalSessionState();
    try { await platform.cloudAuth.syncSession(null, getResolvedCloudApiBase()); } catch {}
  })();
  logoutBeatGalerAccountInFlight = pending;
  void pending.finally(() => { if (logoutBeatGalerAccountInFlight === pending) logoutBeatGalerAccountInFlight = null; });
  return pending;
}
