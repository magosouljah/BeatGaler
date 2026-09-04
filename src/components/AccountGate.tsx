import React, { useEffect, useState } from "react";
import { sanitizeUserVisibleText } from "../lib/userVisibleError";
import { platform } from "../platform";
import { hasRememberedWebSessionMarker } from "../features/auth/webSessionBootstrap";
import { UiButton, UiFeedback, UiField, UiSpinner } from "./ui/DesignPrimitives";

const TOKEN_KEY = "beatgaler:account-session:v1";
const WEB_SESSION_MARKER_KEY = "beatgaler:web-session-present:v1";
const CSRF_KEY = "beatgaler:web-csrf:v1";
const BROWSER_SESSION_SENTINEL = "browser-cookie-session";
export function getBeatGalerAuthToken(): string | null {
  if (platform.kind === "web") return localStorage.getItem(WEB_SESSION_MARKER_KEY) === "1" ? BROWSER_SESSION_SENTINEL : null;
  return localStorage.getItem(TOKEN_KEY);
}
const API_KEY = "beatgaler:cloud-api:v1";
const LOCAL_API = "http://127.0.0.1:4000";
const REMOTE_API = "https://desktop-7l93a0j.tailabe8ff.ts.net";

function sameOriginProxyApi(): string | null {
  if (typeof window === "undefined") return null;
  return `${window.location.origin}/beatgaler-api`;
}

function currentWebCsrfToken(): string {
  if (platform.kind !== "web" || typeof sessionStorage === "undefined") return "";
  return sessionStorage.getItem(CSRF_KEY) || "";
}

function trustedWebApiCandidate(value: string | null): value is string {
  if (!value) return false;
  const sameOriginProxy = sameOriginProxyApi();
  if (value === REMOTE_API || (!!sameOriginProxy && value === sameOriginProxy)) return true;
  return /^http:\/\/127\.0\.0\.1:\d+$/.test(value);
}

function isBeatGalerApiRequest(input: RequestInfo | URL): boolean {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const remembered = localStorage.getItem(API_KEY);
  const candidates = [trustedWebApiCandidate(remembered) ? remembered : null, sameOriginProxyApi(), REMOTE_API].filter((value): value is string => Boolean(value));
  return candidates.some(base => url === base || url.startsWith(`${base}/`));
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
  entitlements: { upload_project: boolean; bulk_youtube_upload: "none" | "limited" | "full"; early_access: boolean };
  quotas: {
    max_beats: number | null;
    max_project_zip_bytes: number | null;
    youtube_uploads_per_day: number | null;
    youtube_uploads_per_month: number | null;
    max_active_devices: number | null;
    max_simultaneous_sessions: number | null;
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
    label: string;
    effective_until?: number | null;
    access_source?: string;
    entitlements: { upload_project: boolean; bulk_youtube_upload: "none" | "limited" | "full"; early_access: boolean };
    quotas: {
      max_beats: number | null;
      max_project_zip_bytes: number | null;
      youtube_uploads_per_day: number | null;
      youtube_uploads_per_month: number | null;
      max_active_devices: number | null;
      max_simultaneous_sessions: number | null;
    };
    referral?: { rewarded_referrals_per_month: number; reward_plan_id: string; reward_days: number };
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
  if (remembered && await probe(remembered, 1200)) return remembered;
  const sameOriginProxy = sameOriginProxyApi();
  if (sameOriginProxy && await probe(sameOriginProxy, 1500)) {
    localStorage.setItem(API_KEY, sameOriginProxy);
    return sameOriginProxy;
  }
  if (await probe(LOCAL_API, 900)) { localStorage.setItem(API_KEY, LOCAL_API); return LOCAL_API; }
  if (await probe(REMOTE_API, 2500)) { localStorage.setItem(API_KEY, REMOTE_API); return REMOTE_API; }
  throw new Error("Could not reach BeatGaler Cloud.");
}

export function getResolvedCloudApiBase(): string { return localStorage.getItem(API_KEY) || REMOTE_API; }

export async function getBeatGalerInstallationId(): Promise<string> {
  return platform.account.getInstallationId();
}

function clearLocalSessionState(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(WEB_SESSION_MARKER_KEY);
  try { sessionStorage.removeItem(CSRF_KEY); } catch {}
}

async function authRequest(path: string, body: Record<string, unknown> = {}, token?: string): Promise<any> {
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
  const result = await fetchJson(`${base}${path}`, {
    method: "POST",
    headers,
    credentials: platform.kind === "web" ? "include" : "same-origin",
    body: JSON.stringify(body),
  }, path === "/auth/register" ? 45000 : 20000);
  if (platform.kind === "web" && result?.csrf_token) sessionStorage.setItem(CSRF_KEY, String(result.csrf_token));
  return result;
}

async function storeSession(result: AuthResponse) {
  if (platform.kind === "web") {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.setItem(WEB_SESSION_MARKER_KEY, "1");
    if (result.csrf_token) sessionStorage.setItem(CSRF_KEY, result.csrf_token);
    await platform.cloudAuth.syncSession(null, getResolvedCloudApiBase());
  } else if (result.token) {
    localStorage.setItem(TOKEN_KEY, result.token);
    await platform.cloudAuth.syncSession(result.token, getResolvedCloudApiBase());
  }
  window.dispatchEvent(new CustomEvent("beatgaler:account-updated", { detail: result.user }));
  return result.user;
}

export async function registerBeatGalerAccount(usernameBase: string, email: string, password: string): Promise<BeatGalerAccount> {
  const result = await authRequest("/auth/register", { usernameBase, email, password, beatgalerUserId: await getBeatGalerInstallationId() });
  return await storeSession(result);
}

export async function loginBeatGalerAccount(identifier: string, password: string, mfaCode = ""): Promise<BeatGalerAccount> {
  const result = await authRequest("/auth/login", { identifier, password, mfaCode, beatgalerUserId: await getBeatGalerInstallationId() });
  return await storeSession(result);
}

let restoreBeatGalerSessionInFlight: Promise<BeatGalerAccount | null> | null = null;

export function restoreBeatGalerSession(): Promise<BeatGalerAccount | null> {
  // AuthExperienceGate and the legacy AccountGate can mount in the same Web
  // tree. Share one restore request so optimistic cache reveal does not turn
  // into duplicate /auth/session round trips.
  if (restoreBeatGalerSessionInFlight) return restoreBeatGalerSessionInFlight;

  const pending = (async (): Promise<BeatGalerAccount | null> => {
    const legacyToken = localStorage.getItem(TOKEN_KEY);
    const hasWebMarker = platform.kind === "web" && localStorage.getItem(WEB_SESSION_MARKER_KEY) === "1";
    const token = platform.kind === "web" ? (legacyToken || (hasWebMarker ? BROWSER_SESSION_SENTINEL : null)) : legacyToken;
    if (!token) return null;
    try {
      const result = await authRequest("/auth/session", { beatgalerUserId: await getBeatGalerInstallationId() }, token);
      if (platform.kind === "web") {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.setItem(WEB_SESSION_MARKER_KEY, "1");
        await platform.cloudAuth.syncSession(null, getResolvedCloudApiBase());
      } else {
        const activeToken = result?.token || token;
        if (result?.token) localStorage.setItem(TOKEN_KEY, result.token);
        await platform.cloudAuth.syncSession(activeToken, getResolvedCloudApiBase());
      }
      return result.user;
    } catch (error) {
      if (!isBeatGalerSessionExpiryError(error)) throw error;
      clearLocalSessionState();
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

export async function devSwitchBeatGalerPlan(planId: BeatGalerPlanId): Promise<BeatGalerAccount> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  const result = await authRequest("/plans/dev-switch", { plan_id: planId }, token);
  window.dispatchEvent(new CustomEvent("beatgaler:account-updated", { detail: result.user }));
  return result.user;
}

export async function changeBeatGalerEmail(email: string, confirmEmail: string): Promise<BeatGalerAccount> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  const result = await authRequest("/auth/email/change", { email, confirmEmail }, token);
  window.dispatchEvent(new CustomEvent("beatgaler:account-updated", { detail: result.user }));
  return result.user;
}

export async function changeBeatGalerPassword(currentPassword: string, newPassword: string): Promise<void> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  const result = await authRequest("/auth/password/change", { currentPassword, newPassword }, token);
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

export async function oauthBeatGalerAccount(provider: OAuthProvider, linkExisting: boolean): Promise<BeatGalerAccount> {
  const beatgalerUserId = await getBeatGalerInstallationId();
  const token = linkExisting ? getBeatGalerAuthToken() || undefined : undefined;
  const before = linkExisting ? await getBeatGalerAccountInfo().catch(() => null) : null;
  const started = await authRequest("/auth/oauth/start", { provider, beatgalerUserId }, token);
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

export async function disconnectOAuthProvider(provider: OAuthProvider): Promise<void> {
  const token = getBeatGalerAuthToken(); if (!token) throw new Error("Session expired. Sign in again.");
  await authRequest("/auth/oauth/disconnect", { provider }, token);
  window.dispatchEvent(new Event("beatgaler:account-updated"));
}

export async function logoutBeatGalerAccount(): Promise<void> {
  const token = getBeatGalerAuthToken();
  try { if (token) await authRequest("/auth/logout", { beatgalerUserId: await getBeatGalerInstallationId() }, token); } catch {}
  clearLocalSessionState();
  try { await platform.cloudAuth.syncSession(null, getResolvedCloudApiBase()); } catch {}
  window.dispatchEvent(new Event("beatgaler:account-logged-out"));
}

function XUnlockOverlay({ username, onDone }: { username: string; onDone: () => void }) {
  type UnlockStage = "waiting" | "opening" | "revealed" | "docking";
  const [stage, setStage] = useState<UnlockStage>("waiting");
  const [target, setTarget] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const cleanUsername = `@${username.replace(/^@+/, "")}`;

  const openUnlock = () => {
    if (stage !== "waiting") return;
    setStage("opening");
    window.setTimeout(() => setStage("revealed"), 720);
  };

  useEffect(() => {
    if (stage !== "revealed") return;
    const move = window.setTimeout(() => {
      const el = document.querySelector('[data-beatgaler-username-target="true"]') as HTMLElement | null;
      if (el) {
        const rect = el.getBoundingClientRect();
        setTarget({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
      }
      setStage("docking");
    }, 1750);
    return () => window.clearTimeout(move);
  }, [stage]);

  useEffect(() => {
    if (stage !== "docking") return;
    const done = window.setTimeout(onDone, 920);
    return () => window.clearTimeout(done);
  }, [stage, onDone]);

  const dockingStyle: React.CSSProperties = target ? {
    position: "fixed",
    left: target.left,
    top: target.top,
    width: Math.max(target.width, 130),
    height: target.height,
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-start",
    fontSize: 19,
    fontWeight: 650,
    letterSpacing: -.45,
    color: "#f1f1f1",
    transform: "translate(0,0) scale(1)",
    opacity: .98,
    transition: "all .82s cubic-bezier(.18,.86,.16,1)",
    zIndex: 3,
  } : {
    position: "fixed",
    left: "50%",
    top: "50%",
    transform: "translate(-50%,-90px) scale(.72)",
    opacity: 0,
    fontSize: 34,
    fontWeight: 760,
    transition: "all .82s cubic-bezier(.18,.86,.16,1)",
    zIndex: 3,
  };

  return <div
    onMouseDown={stage === "waiting" ? undefined : undefined}
    style={{ position: "fixed", inset: 0, zIndex: 9999, background: stage === "docking" ? "rgba(0,0,0,.22)" : "rgba(0,0,0,.72)", backdropFilter: stage === "docking" ? "blur(2px)" : "blur(13px)", WebkitBackdropFilter: stage === "docking" ? "blur(2px)" : "blur(13px)", display: "grid", placeItems: "center", overflow: "hidden", transition: "background .8s ease, backdrop-filter .8s ease" }}>
    <style>{`
      @keyframes bgUnlockIn{from{opacity:0}to{opacity:1}}
      @keyframes openGlow{0%{opacity:0;transform:scaleY(.2)}45%{opacity:1}100%{opacity:.2;transform:scaleY(1.15)}}
      @keyframes revealName{0%{opacity:0;transform:translateY(18px) scale(.92);filter:blur(12px)}55%{opacity:1;transform:translateY(-3px) scale(1.025);filter:blur(0)}100%{opacity:1;transform:none}}
      @keyframes revealX{0%{opacity:0;transform:scale(.55) rotate(-12deg)}65%{opacity:1;transform:scale(1.08) rotate(2deg)}100%{opacity:1;transform:scale(1) rotate(0)}}
      @keyframes shimmerName{0%{background-position:180% 0}100%{background-position:-180% 0}}
      @keyframes seamPulse{0%,100%{opacity:.18}50%{opacity:.9}}
      @keyframes ambientRing{0%{opacity:0;transform:scale(.45)}35%{opacity:.42}100%{opacity:0;transform:scale(1.65)}}
    `}</style>

    {stage === "waiting" && <button autoFocus onClick={openUnlock} style={{ border: "1px solid rgba(255,255,255,.24)", borderRadius: 999, background: "rgba(16,16,16,.78)", color: "#f3f3f3", padding: "12px 28px", minWidth: 110, fontSize: 12, fontWeight: 650, letterSpacing: .2, cursor: "pointer", boxShadow: "0 20px 80px rgba(0,0,0,.55), inset 0 1px rgba(255,255,255,.05)", animation: "bgUnlockIn .3s ease-out" }}>Open</button>}

    {(stage === "opening" || stage === "revealed") && <div style={{ position: "relative", width: 430, height: 270, perspective: 1100, display: "grid", placeItems: "center" }}>
      <div style={{ position: "absolute", inset: 0, borderRadius: 30, overflow: "hidden", border: "1px solid rgba(255,255,255,.12)", boxShadow: "0 35px 130px rgba(0,0,0,.72), inset 0 0 70px rgba(255,255,255,.025)" }}>
        <div style={{ position: "absolute", left: 0, top: 0, width: "50.2%", height: "100%", background: "linear-gradient(100deg,#0b0b0b,#171717)", borderRight: "1px solid rgba(255,255,255,.06)", transformOrigin: "left center", transform: stage === "opening" ? "translateX(-101%) rotateY(-8deg)" : "translateX(-101%) rotateY(-8deg)", transition: "transform .72s cubic-bezier(.7,0,.2,1)" }}/>
        <div style={{ position: "absolute", right: 0, top: 0, width: "50.2%", height: "100%", background: "linear-gradient(260deg,#0b0b0b,#171717)", borderLeft: "1px solid rgba(255,255,255,.06)", transformOrigin: "right center", transform: stage === "opening" ? "translateX(101%) rotateY(8deg)" : "translateX(101%) rotateY(8deg)", transition: "transform .72s cubic-bezier(.7,0,.2,1)" }}/>
        <div style={{ position: "absolute", left: "50%", top: 18, bottom: 18, width: 1, background: "linear-gradient(transparent,rgba(255,255,255,.8),transparent)", animation: "openGlow .7s ease-out both" }}/>
      </div>

      {stage === "revealed" && <>
        <div style={{ position: "absolute", width: 240, height: 240, borderRadius: "50%", border: "1px solid rgba(255,255,255,.13)", animation: "ambientRing 1.6s ease-out infinite" }}/>
        <div style={{ position: "relative", textAlign: "center", animation: "revealName .8s cubic-bezier(.2,.8,.2,1) both" }}>
          <div style={{ width: 54, height: 54, borderRadius: 17, margin: "0 auto 20px", background: "#f4f4f4", color: "#050505", display: "grid", placeItems: "center", fontSize: 29, fontWeight: 800, boxShadow: "0 17px 75px rgba(255,255,255,.13)", animation: "revealX .68s cubic-bezier(.18,.9,.2,1) both" }}>𝕏</div>
          <div style={{ color: "#6a6a6a", fontSize: 9, fontWeight: 750, letterSpacing: 2.4 }}>OFFICIAL USERNAME UNLOCKED</div>
          <div style={{ marginTop: 10, fontSize: 36, fontWeight: 770, letterSpacing: -1.45, background: "linear-gradient(100deg,#777,#fff,#8b8b8b,#fff,#777)", backgroundSize: "220% 100%", WebkitBackgroundClip: "text", color: "transparent", animation: "shimmerName 2s linear infinite" }}>{cleanUsername}</div>
        </div>
      </>}
    </div>}

    {stage === "docking" && <div style={dockingStyle}>{cleanUsername}</div>}
  </div>;
}

export default function AccountGate({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<BeatGalerAccount | null>(null);
  // A remembered Web profile owns its local presentation cache. Reveal that
  // shell immediately while the shared session restore verifies cloud authority.
  const [optimisticRememberedSession, setOptimisticRememberedSession] = useState(
    () => platform.kind === "web" && hasRememberedWebSessionMarker(),
  );
  const [checking, setChecking] = useState(true);
  const [registerMode, setRegisterMode] = useState(false);
  const [identifier, setIdentifier] = useState("");
  const [usernameBase, setUsernameBase] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlockUsername, setUnlockUsername] = useState<string | null>(null);

  useEffect(() => {
    document.getElementById("beatgaler-startup-loader")?.remove();

    let cancelled = false;
    void restoreBeatGalerSession()
      .then(value => {
        if (cancelled) return;
        setAccount(value);
        if (!value) setOptimisticRememberedSession(false);
      })
      .catch(e => { if (!cancelled) setError(String((e as Error)?.message || e)); })
      .finally(() => { if (!cancelled) setChecking(false); });
    const logout = () => {
      setAccount(null);
      setOptimisticRememberedSession(false);
    };
    const updated = (event: Event) => {
      const detail = (event as CustomEvent<BeatGalerAccount>).detail;
      if (detail) setAccount(detail);
      else void restoreBeatGalerSession().then(value => {
        if (value) setAccount(value);
        else setOptimisticRememberedSession(false);
      }).catch(() => {});
    };
    const unlocked = (event: Event) => {
      const detail = (event as CustomEvent<{ username?: string }>).detail;
      if (detail?.username) setUnlockUsername(detail.username);
    };
    window.addEventListener("beatgaler:account-logged-out", logout);
    window.addEventListener("beatgaler:account-updated", updated);
    window.addEventListener("beatgaler:x-username-unlocked", unlocked);
    return () => {
      cancelled = true;
      window.removeEventListener("beatgaler:account-logged-out", logout);
      window.removeEventListener("beatgaler:account-updated", updated);
      window.removeEventListener("beatgaler:x-username-unlocked", unlocked);
    };
  }, []);

  useEffect(() => {
    if (!account?.providers?.x?.connected) return;
    const timer = window.setInterval(() => {
      void getBeatGalerAccountInfo().then(updated => {
        if (updated.username !== account.username || updated.email !== account.email) {
          setAccount(updated);
          window.dispatchEvent(new CustomEvent("beatgaler:account-updated", { detail: updated }));
        }
      }).catch(() => {});
    }, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [account?.id, account?.username, account?.email, account?.providers?.x?.connected]);

  if (account || optimisticRememberedSession) return <>{children}{unlockUsername && <XUnlockOverlay username={unlockUsername} onDone={() => setUnlockUsername(null)}/>}</>;
  if (checking) return <div className="bg-account-loading" aria-live="polite"><div className="bg-account-loading__inner"><UiSpinner label="Loading BeatGaler"/><span>Loading BeatGaler…</span></div></div>;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy) return; setError(null);
    if (registerMode && password !== confirmPassword) { setError("Passwords do not match."); return; }
    setBusy(true);
    try {
      const value = registerMode
        ? await registerBeatGalerAccount(usernameBase, email, password)
        : await loginBeatGalerAccount(identifier, password, mfaCode);
      setAccount(value);
    } catch (e: any) {
      if (e?.mfa_required) setMfaRequired(true);
      setError(String(e?.message || e));
    } finally { setBusy(false); }
  };

  const social = async (provider: OAuthProvider) => {
    if (busy) return; setBusy(true); setError(null);
    try { setAccount(await oauthBeatGalerAccount(provider, false)); }
    catch (e: any) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  return <div className="bg-account-gate">
    <form className="bg-account-card" onSubmit={submit} autoComplete="on">
      <h1 className="bg-account-title">BeatGaler</h1>
      <p className="bg-account-subtitle">{registerMode ? "Create your BeatGaler account" : "Sign in to your BeatGaler account"}</p>

      {!registerMode && <>
        <div className="bg-account-social">
          <UiButton type="button" variant="secondary" fullWidth disabled={busy} onClick={() => void social("google")}>Continue with Google</UiButton>
          <UiButton type="button" variant="secondary" fullWidth disabled={busy} onClick={() => void social("x")}>Continue with X</UiButton>
        </div>
        <div className="bg-account-divider"><span>OR</span></div>
      </>}

      {registerMode ? <>
        <label className="bg-label bg-account-field-first" htmlFor="beatgaler-register-username">USERNAME</label>
        <div className="bg-account-username-shell">
          <input
            id="beatgaler-register-username"
            className="bg-account-username-input"
            autoFocus
            value={usernameBase}
            onChange={e => setUsernameBase(e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, "").slice(0, 20))}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="username"
          />
          <span className="bg-account-username-suffix"># random</span>
        </div>
        <div className="bg-account-hint">BeatGaler adds 4 random numbers, for example <strong>{usernameBase || "username"}#4821</strong>.</div>
        <UiField containerClassName="bg-account-field" id="beatgaler-register-email" label="EMAIL" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" autoCapitalize="none" autoCorrect="off" />
        <UiField id="beatgaler-register-password" label="PASSWORD" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
        <UiField id="beatgaler-register-password-confirm" label="CONFIRM PASSWORD" type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} autoComplete="new-password" />
      </> : <>
        <UiField id="beatgaler-login-identifier" label="USERNAME OR EMAIL" autoFocus value={identifier} onChange={e => setIdentifier(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="username#1234 or email@example.com" />
        <UiField id="beatgaler-login-password" label="PASSWORD" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
        {mfaRequired && <UiField id="beatgaler-login-mfa" label="AUTHENTICATOR CODE" inputMode="numeric" maxLength={6} value={mfaCode} onChange={e => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))} autoComplete="one-time-code" />}
      </>}

      {error && <UiFeedback tone="error" role="alert" aria-live="assertive">{sanitizeUserVisibleText(error)}</UiFeedback>}
      <UiButton className="bg-account-submit" variant="primary" fullWidth loading={busy} type="submit">{registerMode ? "Create account" : "Sign in"}</UiButton>
      <UiButton className="bg-account-switch" variant="ghost" fullWidth type="button" disabled={busy} onClick={() => { setRegisterMode(v => !v); setError(null); setMfaRequired(false); setMfaCode(""); setPassword(""); setConfirmPassword(""); }}>{registerMode ? "Already have an account? Sign in" : "New to BeatGaler? Create account"}</UiButton>
      <div className="bg-account-footer">Normal BeatGaler usernames use username#1234. Claiming X replaces it with your official X username.</div>
    </form>
    {unlockUsername && <XUnlockOverlay username={unlockUsername} onDone={() => setUnlockUsername(null)}/>} 
  </div>;
}
