import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const TOKEN_KEY = "beatgaler:account-session:v1";
export function getBeatGalerAuthToken(): string | null { return localStorage.getItem(TOKEN_KEY); }
const API_KEY = "beatgaler:cloud-api:v1";
const LOCAL_API = "http://127.0.0.1:4000";
const REMOTE_API = "https://desktop-7l93a0j.tailabe8ff.ts.net";

export interface BeatGalerAccount {
  id: string;
  username: string;
  storage_ready: boolean;
}

type AuthResponse = {
  ok: boolean;
  token: string;
  user: BeatGalerAccount;
};

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 10000): Promise<any> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text || `HTTP ${response.status}` }; }
    if (!response.ok) throw new Error(body?.error || `BeatGaler Cloud HTTP ${response.status}`);
    return body;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function probe(base: string, timeoutMs: number): Promise<boolean> {
  try {
    const body = await fetchJson(`${base}/auth/health`, undefined, timeoutMs);
    return body?.ok === true && body?.account_auth === true;
  } catch {
    return false;
  }
}

export async function resolveBeatGalerCloudApi(): Promise<string> {
  const remembered = localStorage.getItem(API_KEY);
  if (remembered && await probe(remembered, 1200)) return remembered;
  if (await probe(LOCAL_API, 900)) {
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
  return localStorage.getItem(API_KEY) || REMOTE_API;
}

async function getInstallationId(): Promise<string> {
  let settings: any = await invoke("get_settings");
  if (settings?.beatgaler_user_id) return String(settings.beatgaler_user_id);

  // Existing Rust command creates/persists the permanent installation id
  // before it performs its network status request. Ignore network errors here.
  try { await invoke("poll_telegram_cloud_status"); } catch {}
  settings = await invoke("get_settings");
  if (!settings?.beatgaler_user_id) throw new Error("BeatGaler could not create its installation ID.");
  return String(settings.beatgaler_user_id);
}

async function authRequest(path: string, body: Record<string, unknown>, token?: string): Promise<AuthResponse> {
  const base = await resolveBeatGalerCloudApi();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetchJson(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, path === "/auth/register" ? 45000 : 20000);
}

export async function registerBeatGalerAccount(username: string, password: string): Promise<BeatGalerAccount> {
  const beatgalerUserId = await getInstallationId();
  const result = await authRequest("/auth/register", { username, password, beatgalerUserId });
  localStorage.setItem(TOKEN_KEY, result.token);
  return result.user;
}

export async function loginBeatGalerAccount(username: string, password: string): Promise<BeatGalerAccount> {
  const beatgalerUserId = await getInstallationId();
  const result = await authRequest("/auth/login", { username, password, beatgalerUserId });
  localStorage.setItem(TOKEN_KEY, result.token);
  return result.user;
}

export async function restoreBeatGalerSession(): Promise<BeatGalerAccount | null> {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  try {
    const beatgalerUserId = await getInstallationId();
    const result = await authRequest("/auth/session", { beatgalerUserId }, token);
    return result.user;
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    return null;
  }
}

export async function logoutBeatGalerAccount(): Promise<void> {
  const token = localStorage.getItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
  try {
    const beatgalerUserId = await getInstallationId();
    if (token) await authRequest("/auth/logout", { beatgalerUserId }, token);
  } catch {}
  window.dispatchEvent(new Event("beatgaler:account-logged-out"));
}

export default function AccountGate({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<BeatGalerAccount | null>(null);
  const [checking, setChecking] = useState(true);
  const [registerMode, setRegisterMode] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void restoreBeatGalerSession()
      .then(value => { if (!cancelled) setAccount(value); })
      .finally(() => { if (!cancelled) setChecking(false); });
    const logout = () => setAccount(null);
    window.addEventListener("beatgaler:account-logged-out", logout);
    return () => {
      cancelled = true;
      window.removeEventListener("beatgaler:account-logged-out", logout);
    };
  }, []);

  const normalizedPreview = useMemo(() => username.trim().replace(/^@+/, ""), [username]);

  if (checking) {
    return <div style={{ position: "fixed", inset: 0, background: "#090909", display: "grid", placeItems: "center", color: "#555", fontSize: 13 }}>Loading BeatGaler…</div>;
  }
  if (account) return <>{children}</>;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const value = registerMode
        ? await registerBeatGalerAccount(username, password)
        : await loginBeatGalerAccount(username, password);
      setAccount(value);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#090909", color: "#ddd", display: "grid", placeItems: "center", fontFamily: "Inter, system-ui, sans-serif" }}>
      <form onSubmit={submit} style={{ width: 330, padding: 28, border: "1px solid #202020", borderRadius: 14, background: "#101010", boxShadow: "0 24px 80px rgba(0,0,0,.55)" }}>
        <div style={{ fontSize: 22, fontWeight: 650, letterSpacing: -0.4 }}>BeatGaler</div>
        <div style={{ marginTop: 6, color: "#666", fontSize: 12 }}>
          {registerMode ? "Create your BeatGaler account" : "Sign in to your BeatGaler account"}
        </div>

        <label style={{ display: "block", marginTop: 22, fontSize: 11, color: "#777" }}>USERNAME</label>
        <div style={{ display: "flex", alignItems: "center", marginTop: 7, border: "1px solid #292929", borderRadius: 8, background: "#151515" }}>
          <span style={{ paddingLeft: 11, color: "#666" }}>@</span>
          <input autoFocus value={username} onChange={e => setUsername(e.target.value)}
            autoCapitalize="none" autoCorrect="off" spellCheck={false}
            style={{ flex: 1, minWidth: 0, padding: "10px 11px 10px 4px", border: 0, outline: 0, background: "transparent", color: "#eee", fontSize: 13 }} />
        </div>

        <label style={{ display: "block", marginTop: 14, fontSize: 11, color: "#777" }}>PASSWORD</label>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)}
          style={{ boxSizing: "border-box", width: "100%", marginTop: 7, padding: "10px 11px", border: "1px solid #292929", borderRadius: 8, outline: 0, background: "#151515", color: "#eee", fontSize: 13 }} />

        {registerMode && normalizedPreview && (
          <div style={{ marginTop: 9, color: "#555", fontSize: 11 }}>Your BeatGaler handle will be @{normalizedPreview.toLowerCase()}.</div>
        )}

        {error && <div style={{ marginTop: 14, padding: "9px 10px", border: "1px solid #542020", borderRadius: 8, background: "#241010", color: "#e6a0a0", fontSize: 11, lineHeight: 1.55 }}>{error}</div>}

        <button disabled={busy} type="submit" style={{ width: "100%", marginTop: 18, padding: "10px 12px", border: "1px solid #303030", borderRadius: 8, background: "#e9e9e9", color: "#111", fontWeight: 650, cursor: busy ? "default" : "pointer", opacity: busy ? .55 : 1 }}>
          {busy ? (registerMode ? "Creating private storage…" : "Signing in…") : (registerMode ? "Create account" : "Sign in")}
        </button>

        <button type="button" disabled={busy} onClick={() => { setRegisterMode(v => !v); setError(null); }}
          style={{ width: "100%", marginTop: 8, padding: 8, border: 0, background: "transparent", color: "#777", cursor: busy ? "default" : "pointer", fontSize: 11 }}>
          {registerMode ? "Already have an account? Sign in" : "New to BeatGaler? Create account"}
        </button>

        <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid #1b1b1b", color: "#444", fontSize: 10, lineHeight: 1.55 }}>
          Telegram storage is managed privately by BeatGaler. Your account does not need Telegram access.
        </div>
      </form>
    </div>
  );
}
