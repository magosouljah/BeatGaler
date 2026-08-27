import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { sanitizeUserVisibleText } from "../lib/userVisibleError";

const TOKEN_KEY = "beatgaler:account-session:v1";
export function getBeatGalerAuthToken(): string | null { return localStorage.getItem(TOKEN_KEY); }
const API_KEY = "beatgaler:cloud-api:v1";
const LOCAL_API = "http://127.0.0.1:4000";
const REMOTE_API = "https://api.beatgaler.com";

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

type AuthResponse = { ok: boolean; token: string; user: BeatGalerAccount; linked?: boolean; pending?: boolean };

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 10000): Promise<any> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text || `HTTP ${response.status}` }; }
    if (!response.ok) {
      const error: any = new Error(body?.error || `BeatGaler Cloud HTTP ${response.status}`);
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
  if (await probe(REMOTE_API, 2500)) { localStorage.setItem(API_KEY, REMOTE_API); return REMOTE_API; }
  if (remembered && await probe(remembered, 1200)) return remembered;
  if (await probe(LOCAL_API, 900)) { localStorage.setItem(API_KEY, LOCAL_API); return LOCAL_API; }
  throw new Error("Could not reach BeatGaler Cloud.");
}

export function getResolvedCloudApiBase(): string { return localStorage.getItem(API_KEY) || REMOTE_API; }

async function getInstallationId(): Promise<string> {
  let settings: any = await invoke("get_settings");
  if (settings?.beatgaler_user_id) return String(settings.beatgaler_user_id);
  try { await invoke("poll_telegram_cloud_status"); } catch {}
  settings = await invoke("get_settings");
  if (!settings?.beatgaler_user_id) throw new Error("BeatGaler could not create its installation ID.");
  return String(settings.beatgaler_user_id);
}

async function authRequest(path: string, body: Record<string, unknown> = {}, token?: string): Promise<any> {
  const base = await resolveBeatGalerCloudApi();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetchJson(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) }, path === "/auth/register" ? 45000 : 20000);
}

async function storeSession(result: AuthResponse) {
  if (result.token) {
    localStorage.setItem(TOKEN_KEY, result.token);
    await invoke("set_cloud_auth_token", { token: result.token, cloudApiBase: getResolvedCloudApiBase() });
  }
  window.dispatchEvent(new CustomEvent("beatgaler:account-updated", { detail: result.user }));
  return result.user;
}

export async function registerBeatGalerAccount(usernameBase: string, email: string, password: string): Promise<BeatGalerAccount> {
  const result = await authRequest("/auth/register", { usernameBase, email, password, beatgalerUserId: await getInstallationId() });
  return await storeSession(result);
}

export async function loginBeatGalerAccount(identifier: string, password: string, mfaCode = ""): Promise<BeatGalerAccount> {
  const result = await authRequest("/auth/login", { identifier, password, mfaCode, beatgalerUserId: await getInstallationId() });
  return await storeSession(result);
}

export async function restoreBeatGalerSession(): Promise<BeatGalerAccount | null> {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  try {
    const result = await authRequest("/auth/session", { beatgalerUserId: await getInstallationId() }, token);
    await invoke("set_cloud_auth_token", { token, cloudApiBase: getResolvedCloudApiBase() });
    return result.user;
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    try { await invoke("set_cloud_auth_token", { token: null, cloudApiBase: getResolvedCloudApiBase() }); } catch {}
    return null;
  }
}

export async function getBeatGalerAccountInfo(): Promise<BeatGalerAccount> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  return (await authRequest("/auth/account", {}, token)).user;
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
  await authRequest("/auth/password/change", { currentPassword, newPassword }, token);
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
  const beatgalerUserId = await getInstallationId();
  const token = linkExisting ? getBeatGalerAuthToken() || undefined : undefined;
  const before = linkExisting ? await getBeatGalerAccountInfo().catch(() => null) : null;
  const started = await authRequest("/auth/oauth/start", { provider, beatgalerUserId }, token);
  await open(started.authorization_url);
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
  const token = localStorage.getItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
  try { if (token) await authRequest("/auth/logout", { beatgalerUserId: await getInstallationId() }, token); } catch {}
  try { await invoke("set_cloud_auth_token", { token: null, cloudApiBase: getResolvedCloudApiBase() }); } catch {}
  window.dispatchEvent(new Event("beatgaler:account-logged-out"));
}

const providerButtonStyle: React.CSSProperties = { width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #2b2b2b", background: "#171717", color: "#ddd", cursor: "pointer", fontWeight: 600 };
const fieldStyle: React.CSSProperties = { boxSizing: "border-box", width: "100%", marginTop: 7, padding: "10px 11px", border: "1px solid #292929", borderRadius: 8, outline: 0, background: "#151515", color: "#eee", fontSize: 13 };

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
    // The static loader in index.html exists only to cover the short gap before
    // React mounts. AccountGate has its own loading UI, so hand off immediately.
    // Without this, a signed-out/expired macOS session can leave the static
    // "Loading Beat Galer..." layer above the login screen forever.
    document.getElementById("beatgaler-startup-loader")?.remove();

    let cancelled = false;
    void restoreBeatGalerSession().then(value => { if (!cancelled) setAccount(value); }).finally(() => { if (!cancelled) setChecking(false); });
    const logout = () => setAccount(null);
    const updated = (event: Event) => {
      const detail = (event as CustomEvent<BeatGalerAccount>).detail;
      if (detail) setAccount(detail);
      else void restoreBeatGalerSession().then(value => { if (value) setAccount(value); });
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

  if (checking) return <div style={{ position: "fixed", inset: 0, background: "#090909", display: "grid", placeItems: "center", color: "#555", fontSize: 13 }}>Loading BeatGaler…</div>;
  if (account) return <>{children}{unlockUsername && <XUnlockOverlay username={unlockUsername} onDone={() => setUnlockUsername(null)}/>}</>;

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

  return <div style={{ position: "fixed", inset: 0, background: "#090909", color: "#ddd", display: "grid", placeItems: "center", fontFamily: "Inter, system-ui, sans-serif" }}>
    <form onSubmit={submit} style={{ width: 370, padding: 28, border: "1px solid #202020", borderRadius: 14, background: "#101010", boxShadow: "0 24px 80px rgba(0,0,0,.55)" }}>
      <div style={{ fontSize: 22, fontWeight: 650, letterSpacing: -.4 }}>BeatGaler</div>
      <div style={{ marginTop: 6, color: "#666", fontSize: 12 }}>{registerMode ? "Create your BeatGaler account" : "Sign in to your BeatGaler account"}</div>

      {!registerMode && <>
        <div style={{ display: "grid", gap: 8, marginTop: 22 }}>
          <button type="button" disabled={busy} onClick={() => void social("google")} style={providerButtonStyle}>Continue with Google</button>
          <button type="button" disabled={busy} onClick={() => void social("x")} style={providerButtonStyle}>Continue with X</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0", color: "#444", fontSize: 10 }}><span style={{ height: 1, flex: 1, background: "#222" }}/><span>OR</span><span style={{ height: 1, flex: 1, background: "#222" }}/></div>
      </>}

      {registerMode ? <>
        <label style={{ display: "block", marginTop: 20, fontSize: 11, color: "#777" }}>USERNAME</label>
        <div style={{ marginTop: 7, display: "flex", alignItems: "center", border: "1px solid #292929", borderRadius: 8, background: "#151515", overflow: "hidden" }}>
          <input autoFocus value={usernameBase} onChange={e => setUsernameBase(e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, "").slice(0, 20))} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="username" style={{ flex: 1, minWidth: 0, padding: "10px 11px", border: 0, outline: 0, background: "transparent", color: "#eee", fontSize: 13 }}/>
          <span style={{ paddingRight: 11, color: "#555", fontSize: 12 }}># random</span>
        </div>
        <div style={{ marginTop: 7, color: "#4e4e4e", fontSize: 10 }}>BeatGaler adds 4 random numbers, for example <span style={{ color: "#777" }}>{usernameBase || "username"}#4821</span>.</div>
        <label style={{ display: "block", marginTop: 14, fontSize: 11, color: "#777" }}>EMAIL</label>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoCapitalize="none" autoCorrect="off" style={fieldStyle}/>
        <label style={{ display: "block", marginTop: 14, fontSize: 11, color: "#777" }}>PASSWORD</label>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} style={fieldStyle}/>
        <label style={{ display: "block", marginTop: 14, fontSize: 11, color: "#777" }}>CONFIRM PASSWORD</label>
        <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} style={fieldStyle}/>
      </> : <>
        <label style={{ display: "block", fontSize: 11, color: "#777" }}>USERNAME OR EMAIL</label>
        <input autoFocus value={identifier} onChange={e => setIdentifier(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="username#1234 or email@example.com" style={fieldStyle}/>
        <label style={{ display: "block", marginTop: 14, fontSize: 11, color: "#777" }}>PASSWORD</label>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} style={fieldStyle}/>
        {mfaRequired && <><label style={{ display: "block", marginTop: 14, fontSize: 11, color: "#777" }}>AUTHENTICATOR CODE</label><input inputMode="numeric" maxLength={6} value={mfaCode} onChange={e => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))} style={fieldStyle}/></>}
      </>}

      {error && <div style={{ marginTop: 14, padding: "9px 10px", border: "1px solid #542020", borderRadius: 8, background: "#241010", color: "#e6a0a0", fontSize: 11, lineHeight: 1.55 }}>{sanitizeUserVisibleText(error)}</div>}
      <button disabled={busy} type="submit" style={{ width: "100%", marginTop: 18, padding: "10px 12px", border: "1px solid #303030", borderRadius: 8, background: "#e9e9e9", color: "#111", fontWeight: 650, cursor: busy ? "default" : "pointer", opacity: busy ? .55 : 1 }}>{busy ? "Working…" : (registerMode ? "Create account" : "Sign in")}</button>
      <button type="button" disabled={busy} onClick={() => { setRegisterMode(v => !v); setError(null); setMfaRequired(false); setMfaCode(""); setPassword(""); setConfirmPassword(""); }} style={{ width: "100%", marginTop: 8, padding: 8, border: 0, background: "transparent", color: "#777", cursor: busy ? "default" : "pointer", fontSize: 11 }}>{registerMode ? "Already have an account? Sign in" : "New to BeatGaler? Create account"}</button>
      <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid #1b1b1b", color: "#444", fontSize: 10, lineHeight: 1.55 }}>Normal BeatGaler usernames use username#1234. Claiming X replaces it with your official X username.</div>
    </form>
    {unlockUsername && <XUnlockOverlay username={unlockUsername} onDone={() => setUnlockUsername(null)}/>} 
  </div>;
}
