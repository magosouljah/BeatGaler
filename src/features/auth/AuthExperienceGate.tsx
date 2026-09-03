import { playTrace, playTraceSpan } from "../playback/playTrace";
import React, { useEffect, useRef, useState } from "react";
import {
  getBeatGalerInstallationId,
  loginBeatGalerAccount,
  registerBeatGalerAccount,
  resolveBeatGalerCloudApi,
  restoreBeatGalerSession,
  type BeatGalerAccount,
  type OAuthProvider,
} from "../../components/AccountGate";
import { UiButton, UiFeedback, UiField, UiSpinner } from "../../components/ui/DesignPrimitives";
import { sanitizeUserVisibleText } from "../../lib/userVisibleError";
import { platform } from "../../platform";
import { hasRememberedWebSessionMarker } from "./webSessionBootstrap";

const WEB_SESSION_MARKER_KEY = "beatgaler:web-session-present:v1";
const TOKEN_KEY = "beatgaler:account-session:v1";
const CSRF_KEY = "beatgaler:web-csrf:v1";

type Phase = "login" | "register" | "mfa" | "verify" | "reset-request" | "reset-complete" | "offline";
type OAuthState = "idle" | "opening" | "polling" | "blocked" | "cancelled" | "error";

type PublicAuthError = Error & { status?: number; code?: string; mfa_required?: boolean };

function humanError(error: unknown): string {
  const value = error as { message?: string; code?: string } | null;
  const fallback = value?.message || "Something went wrong. Try again.";
  return sanitizeUserVisibleText(fallback);
}

async function publicAuthRequest(path: string, body: Record<string, unknown>) {
  const base = await resolveBeatGalerCloudApi();
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-BeatGaler-Client": "web",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    throw Object.assign(new Error(offline ? "BeatGaler Cloud is offline. Check your connection and try again." : "Could not reach BeatGaler Cloud. Try again."), {
      code: offline ? "CLOUD_OFFLINE" : "CLOUD_UNREACHABLE",
    });
  }
  const text = await response.text();
  let payload: any = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: text }; }
  if (!response.ok) {
    throw Object.assign(new Error(payload?.error || `BeatGaler Cloud HTTP ${response.status}`), {
      status: response.status,
      code: payload?.code || `HTTP_${response.status}`,
      ...payload,
    }) as PublicAuthError;
  }
  return payload;
}

async function storeWebCookieSession(result: any): Promise<BeatGalerAccount> {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.setItem(WEB_SESSION_MARKER_KEY, "1");
  if (result?.csrf_token) sessionStorage.setItem(CSRF_KEY, String(result.csrf_token));
  const base = await resolveBeatGalerCloudApi();
  await platform.cloudAuth.syncSession(null, base);
  const user = result?.user as BeatGalerAccount;
  window.dispatchEvent(new CustomEvent("beatgaler:account-updated", { detail: user }));
  return user;
}

async function startWebOAuth(provider: OAuthProvider) {
  const base = await resolveBeatGalerCloudApi();
  const beatgalerUserId = await getBeatGalerInstallationId();
  const started = await publicAuthRequest("/auth/oauth/start", { provider, beatgalerUserId });
  return {
    base,
    beatgalerUserId,
    authorizationUrl: String(started.authorization_url || ""),
    flowId: String(started.flow_id || ""),
  };
}

export default function AuthExperienceGate({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<BeatGalerAccount | null>(null);
  // Product policy for Situation 2: a remembered browser session may reveal the
  // local presentation cache immediately. Cloud authority still resolves in the
  // background and can revoke this optimistic shell if the cookie session is no
  // longer valid.
  const [optimisticRememberedSession, setOptimisticRememberedSession] = useState(
    () => platform.kind === "web" && hasRememberedWebSessionMarker(),
  );
  const [checking, setChecking] = useState(platform.kind === "web");
  const [phase, setPhase] = useState<Phase>("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [identifier, setIdentifier] = useState("");
  const [usernameBase, setUsernameBase] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [verifyToken, setVerifyToken] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [oauthState, setOauthState] = useState<OAuthState>("idle");
  const [oauthProvider, setOauthProvider] = useState<OAuthProvider | null>(null);
  const [oauthUrl, setOauthUrl] = useState("");
  const oauthCancelled = useRef(false);
  const oauthPopup = useRef<Window | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (platform.kind !== "web") return;
    let cancelled = false;
    const endRestore = playTraceSpan("AUTH_RESTORE");
    void restoreBeatGalerSession()
      .then(value => {
        endRestore("done", { auth_session: value ? "restored" : "signed_out", cancelled });
        if (!cancelled) {
          setAccount(value);
          if (!value) setOptimisticRememberedSession(false);
        }
      })
      .catch(errorValue => {
        endRestore("error", { auth_session: "unknown", cancelled });
        if (cancelled) return;
        const code = String((errorValue as { code?: string })?.code || "");
        if (["CLOUD_OFFLINE", "CLOUD_UNREACHABLE", "CLOUD_TIMEOUT"].includes(code)) {
          setPhase("offline");
          setError(humanError(errorValue));
        } else {
          setError(humanError(errorValue));
        }
      })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (platform.kind === "web" && optimisticRememberedSession && !account) {
      playTrace("AUTH_CACHE_REVEAL_OPTIMISTIC");
    }
  }, [optimisticRememberedSession, account]);

  useEffect(() => {
    if (platform.kind === "web" && account) playTrace("AUTH_SESSION_CONFIRMED");
  }, [account]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [phase]);

  useEffect(() => {
    const online = () => {
      if (phase === "offline") {
        setNotice("Connection restored. You can retry now.");
        setError(null);
      }
    };
    const offline = () => {
      setPhase("offline");
      setError("BeatGaler Cloud is offline. Your saved session was kept.");
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, [phase]);

  if (platform.kind !== "web") return <>{children}</>;
  if (account || optimisticRememberedSession) return <>{children}</>;
  if (checking) return <main className="bg-auth-shell" aria-busy="true"><div className="bg-auth-card bg-auth-card--loading"><UiSpinner label="Loading account"/><span>Loading your account…</span></div></main>;

  const go = (next: Phase) => {
    setPhase(next);
    setError(null);
    setNotice(null);
    setBusy(false);
  };

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const user = await loginBeatGalerAccount(identifier, password, "");
      setAccount(user);
    } catch (errorValue: any) {
      if (errorValue?.mfa_required) {
        setPhase("mfa");
        setError(null);
        setNotice("Enter your authenticator code or a recovery code to continue.");
      } else {
        setError(humanError(errorValue));
      }
    } finally { setBusy(false); }
  };

  const handleMfa = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const user = await loginBeatGalerAccount(identifier, password, mfaCode.trim());
      setAccount(user);
    } catch (errorValue) {
      setError(humanError(errorValue));
    } finally { setBusy(false); }
  };

  const handleRegister = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (password !== confirmPassword) { setError("Passwords do not match."); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      const user = await registerBeatGalerAccount(usernameBase, email, password);
      setAccount(null);
      setPhase("verify");
      setNotice(`Account created for ${user.email || email}. Check your email for the verification link or paste the verification code below.`);
    } catch (errorValue) {
      setError(humanError(errorValue));
    } finally { setBusy(false); }
  };

  const resendVerification = async () => {
    if (!email || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await publicAuthRequest("/auth/email/verification/request", { email });
      setNotice(String(result?.message || "If that email belongs to an account, a verification message was sent."));
    } catch (errorValue) {
      setError(humanError(errorValue));
    } finally { setBusy(false); }
  };

  const confirmVerification = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await publicAuthRequest("/auth/email/verification/confirm", { token: verifyToken.trim() });
      setNotice("Email verified. You can sign in now.");
      setPhase("login");
    } catch (errorValue) {
      setError(humanError(errorValue));
    } finally { setBusy(false); }
  };

  const requestReset = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await publicAuthRequest("/auth/password/reset/request", { email });
      setNotice(String(result?.message || "If that email belongs to an account, a reset message was sent."));
      setPhase("reset-complete");
    } catch (errorValue) {
      setError(humanError(errorValue));
    } finally { setBusy(false); }
  };

  const completeReset = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (newPassword !== confirmNewPassword) { setError("Passwords do not match."); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      await publicAuthRequest("/auth/password/reset/complete", { token: resetToken.trim(), newPassword });
      setPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
      setNotice("Password reset. Existing sessions were revoked. Sign in with your new password.");
      setPhase("login");
    } catch (errorValue) {
      setError(humanError(errorValue));
    } finally { setBusy(false); }
  };

  const beginOAuth = async (provider: OAuthProvider) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null); setOauthProvider(provider); setOauthState("opening"); setOauthUrl("");
    oauthCancelled.current = false;
    try {
      const started = await startWebOAuth(provider);
      if (!started.authorizationUrl || !started.flowId) throw new Error("Could not start provider sign-in. Try again.");
      setOauthUrl(started.authorizationUrl);
      const popup = window.open(started.authorizationUrl, "beatgaler-oauth", "popup,width=540,height=720,resizable=yes,scrollbars=yes");
      oauthPopup.current = popup;
      if (!popup) {
        setOauthState("blocked");
        setBusy(false);
        return;
      }
      setOauthState("polling");
      const startedAt = Date.now();
      while (Date.now() - startedAt < 10 * 60 * 1000) {
        if (oauthCancelled.current) {
          setOauthState("cancelled");
          setNotice("Provider sign-in cancelled. You can retry whenever you are ready.");
          return;
        }
        if (popup.closed) {
          setOauthState("cancelled");
          setNotice("Provider window closed before sign-in finished. Retry to continue.");
          return;
        }
        await new Promise(resolve => window.setTimeout(resolve, 900));
        const result = await publicAuthRequest("/auth/oauth/poll", { flowId: started.flowId, beatgalerUserId: started.beatgalerUserId });
        if (result?.pending) continue;
        const user = await storeWebCookieSession(result);
        popup.close();
        setAccount(user);
        return;
      }
      setOauthState("error");
      setError("Provider sign-in timed out. Retry to start a fresh sign-in.");
    } catch (errorValue) {
      setOauthState("error");
      setError(humanError(errorValue));
    } finally {
      setBusy(false);
    }
  };

  const cancelOAuth = () => {
    oauthCancelled.current = true;
    oauthPopup.current?.close();
    oauthPopup.current = null;
    setOauthState("cancelled");
    setBusy(false);
    setNotice("Provider sign-in cancelled. You can retry whenever you are ready.");
  };

  const retryRestore = async () => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const restored = await restoreBeatGalerSession();
      if (restored) setAccount(restored);
      else {
        setOptimisticRememberedSession(false);
        setPhase("login");
      }
    } catch (errorValue) {
      setError(humanError(errorValue));
    } finally { setBusy(false); }
  };

  const title = phase === "register" ? "Create your account"
    : phase === "mfa" ? "Two-step verification"
      : phase === "verify" ? "Verify your email"
        : phase === "reset-request" ? "Reset your password"
          : phase === "reset-complete" ? "Choose a new password"
            : phase === "offline" ? "BeatGaler Cloud is unavailable"
              : "Welcome back";

  return <main className="bg-auth-shell" aria-labelledby="beatgaler-auth-title">
    <section className="bg-auth-card">
      <div className="bg-auth-brand" aria-hidden="true">BG</div>
      <h1 ref={headingRef} tabIndex={-1} id="beatgaler-auth-title" className="bg-auth-title">{title}</h1>
      <p className="bg-auth-subtitle">
        {phase === "register" ? "Create one account for your BeatGaler library."
          : phase === "mfa" ? "Use your authenticator or one unused recovery code."
            : phase === "verify" ? "Confirm the address connected to your BeatGaler account."
              : phase === "reset-request" ? "We will send reset instructions without revealing whether an account exists."
                : phase === "reset-complete" ? "Paste the reset code and set a new password."
                  : phase === "offline" ? "Your saved session was kept. Retry when your connection is back."
                    : "Sign in to your BeatGaler account."}
      </p>

      <div className="bg-auth-live" aria-live="polite" aria-atomic="true">
        {notice && <UiFeedback tone="success">{notice}</UiFeedback>}
        {error && <UiFeedback tone="error" role="alert" aria-live="assertive">{error}</UiFeedback>}
      </div>

      {phase === "login" && <form className="bg-auth-form" onSubmit={handleLogin}>
        <div className="bg-auth-social" aria-label="Provider sign in">
          <UiButton type="button" variant="secondary" fullWidth disabled={busy} onClick={() => void beginOAuth("google")}>Continue with Google</UiButton>
          <UiButton type="button" variant="secondary" fullWidth disabled={busy} onClick={() => void beginOAuth("x")}>Continue with X</UiButton>
        </div>
        {(oauthState === "polling" || oauthState === "opening") && <div className="bg-auth-oauth-status" role="status"><UiSpinner label="Waiting for provider sign-in"/><span>Finish sign-in in the provider window.</span><UiButton type="button" variant="ghost" onClick={cancelOAuth}>Cancel</UiButton></div>}
        {oauthState === "blocked" && <UiFeedback tone="info" className="bg-auth-oauth-blocked">
          <strong>Popup blocked.</strong> Allow popups and retry, open the provider in a new tab, or continue in this tab.
          <div className="bg-auth-inline-actions">
            <UiButton type="button" variant="secondary" onClick={() => oauthProvider && void beginOAuth(oauthProvider)}>Retry popup</UiButton>
            {oauthUrl && <a className="bg-auth-link-button" href={oauthUrl} target="_blank" rel="noreferrer">Open new tab</a>}
            {oauthUrl && <UiButton type="button" variant="ghost" onClick={() => window.location.assign(oauthUrl)}>Continue in this tab</UiButton>}
          </div>
        </UiFeedback>}
        {oauthState === "cancelled" && oauthProvider && <UiButton type="button" variant="ghost" onClick={() => void beginOAuth(oauthProvider)}>Retry provider sign-in</UiButton>}
        <div className="bg-auth-divider"><span>or use your password</span></div>
        <UiField id="auth-login-identifier" label="Username or email" autoFocus value={identifier} onChange={event => setIdentifier(event.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
        <UiField id="auth-login-password" label="Password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required />
        <UiButton type="submit" variant="primary" fullWidth loading={busy}>Sign in</UiButton>
        <div className="bg-auth-inline-actions bg-auth-inline-actions--center">
          <UiButton type="button" variant="ghost" onClick={() => go("reset-request")}>Forgot password?</UiButton>
          <UiButton type="button" variant="ghost" onClick={() => go("verify")}>Verify email</UiButton>
        </div>
        <UiButton type="button" variant="ghost" fullWidth onClick={() => go("register")}>New to BeatGaler? Create account</UiButton>
      </form>}

      {phase === "register" && <form className="bg-auth-form" onSubmit={handleRegister}>
        <UiField id="auth-register-username" label="Username" autoFocus value={usernameBase} onChange={event => setUsernameBase(event.target.value.toLowerCase().replace(/[^a-z0-9._]/g, "").slice(0, 20))} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required description="BeatGaler adds four random numbers to normal usernames." />
        <UiField id="auth-register-email" label="Email" type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" autoCapitalize="none" autoCorrect="off" required />
        <UiField id="auth-register-password" label="Password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" minLength={8} required />
        <UiField id="auth-register-confirm" label="Confirm password" type="password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={8} required />
        <UiButton type="submit" variant="primary" fullWidth loading={busy}>Create account</UiButton>
        <UiButton type="button" variant="ghost" fullWidth onClick={() => go("login")}>Back to sign in</UiButton>
      </form>}

      {phase === "mfa" && <form className="bg-auth-form" onSubmit={handleMfa}>
        <UiField
          id="auth-login-mfa"
          label={useRecoveryCode ? "Recovery code" : "Authenticator code"}
          autoFocus
          value={mfaCode}
          onChange={event => setMfaCode(useRecoveryCode ? event.target.value.trim() : event.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode={useRecoveryCode ? "text" : "numeric"}
          autoComplete="one-time-code"
          maxLength={useRecoveryCode ? 40 : 6}
          required
        />
        <UiButton type="submit" variant="primary" fullWidth loading={busy}>Continue</UiButton>
        <UiButton type="button" variant="ghost" fullWidth onClick={() => { setUseRecoveryCode(value => !value); setMfaCode(""); setError(null); }}>
          {useRecoveryCode ? "Use authenticator code" : "Use a recovery code"}
        </UiButton>
        <UiButton type="button" variant="ghost" fullWidth onClick={() => go("login")}>Cancel</UiButton>
      </form>}

      {phase === "verify" && <form className="bg-auth-form" onSubmit={confirmVerification}>
        <UiField id="auth-verify-email" label="Email" type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" autoCapitalize="none" autoCorrect="off" />
        <UiButton type="button" variant="secondary" fullWidth loading={busy} disabled={!email} onClick={() => void resendVerification()}>Send or resend verification</UiButton>
        <UiField id="auth-verify-token" label="Verification code" autoFocus value={verifyToken} onChange={event => setVerifyToken(event.target.value)} autoComplete="one-time-code" required />
        <UiButton type="submit" variant="primary" fullWidth loading={busy}>Verify email</UiButton>
        <UiButton type="button" variant="ghost" fullWidth onClick={() => go("login")}>Back to sign in</UiButton>
      </form>}

      {phase === "reset-request" && <form className="bg-auth-form" onSubmit={requestReset}>
        <UiField id="auth-reset-email" label="Email" type="email" autoFocus value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" autoCapitalize="none" autoCorrect="off" required />
        <UiButton type="submit" variant="primary" fullWidth loading={busy}>Send reset instructions</UiButton>
        <UiButton type="button" variant="ghost" fullWidth onClick={() => go("login")}>Back to sign in</UiButton>
      </form>}

      {phase === "reset-complete" && <form className="bg-auth-form" onSubmit={completeReset}>
        <UiField id="auth-reset-token" label="Reset code" autoFocus value={resetToken} onChange={event => setResetToken(event.target.value)} autoComplete="one-time-code" required />
        <UiField id="auth-reset-new-password" label="New password" type="password" value={newPassword} onChange={event => setNewPassword(event.target.value)} autoComplete="new-password" minLength={8} required />
        <UiField id="auth-reset-confirm-password" label="Confirm new password" type="password" value={confirmNewPassword} onChange={event => setConfirmNewPassword(event.target.value)} autoComplete="new-password" minLength={8} required />
        <UiButton type="submit" variant="primary" fullWidth loading={busy}>Reset password</UiButton>
        <UiButton type="button" variant="ghost" fullWidth onClick={() => go("reset-request")}>Send a new reset code</UiButton>
      </form>}

      {phase === "offline" && <div className="bg-auth-form">
        <UiButton type="button" variant="primary" fullWidth loading={busy} onClick={() => void retryRestore()}>Retry connection</UiButton>
        <UiButton type="button" variant="ghost" fullWidth onClick={() => go("login")}>Use another account</UiButton>
      </div>}

      <p className="bg-auth-footnote">BeatGaler keeps browser sessions in secure cookies and never stores your Web bearer token.</p>
    </section>
  </main>;
}
