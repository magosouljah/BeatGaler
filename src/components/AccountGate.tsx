import React, { useEffect, useRef, useState } from "react";
import { sanitizeUserVisibleText } from "../lib/userVisibleError";
import { platform } from "../platform";
import { formatSignupVerificationCode } from "../features/auth/signupVerificationCode";
import {
  getBeatGalerAccountInfo,
  oauthBeatGalerAccount,
  registerBeatGalerAccount,
  clearDesktopSignup,
  rememberedDesktopSignup,
  resendBeatGalerSignup,
  restoreBeatGalerSession,
  resumeBeatGalerSignup,
  verifyBeatGalerSignup,
  type BeatGalerAccount,
  type OAuthProvider,
  type PendingBeatGalerSignup,
} from "../features/auth/webSession";
import { loginBeatGalerAccount } from "../features/auth/webSignIn";
import { UiButton, UiFeedback, UiField, UiSpinner } from "./ui/DesignPrimitives";

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
  const authRunRef = useRef(0);
  const [checking, setChecking] = useState(true);
  const [registerMode, setRegisterMode] = useState(false);
  const [identifier, setIdentifier] = useState("");
  const [usernameBase, setUsernameBase] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false);
  const [pendingSignup, setPendingSignup] = useState<PendingBeatGalerSignup | null>(null);
  const [signupCode, setSignupCode] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlockUsername, setUnlockUsername] = useState<string | null>(null);

  useEffect(() => {
    document.getElementById("beatgaler-startup-loader")?.remove();

    let cancelled = false;
    const restoreRun = ++authRunRef.current;
    void restoreBeatGalerSession()
      .then(async value => {
        if (cancelled || restoreRun !== authRunRef.current) return;
        setAccount(value);
        if (!value) {
          if (platform.kind !== "web" && rememberedDesktopSignup()) {
            try {
              const result = await resumeBeatGalerSignup();
              if (cancelled) return;
              if ("signup_pending" in result) {
                if (result.status === "ACTIVE") setNotice("Your account is ready. Sign in with your email.");
                else setPendingSignup(result);
              } else setAccount(result);
            } catch (error: any) {
              if (["SIGNUP_NOT_FOUND", "SIGNUP_CONTINUATION_INVALID", "SIGNUP_EXPIRED"].includes(String(error?.code || ""))) {
                clearDesktopSignup();
              } else if (!cancelled) setError(String(error?.message || error));
            }
          }
        }
      })
      .catch(e => { if (!cancelled && restoreRun === authRunRef.current) setError(String((e as Error)?.message || e)); })
      .finally(() => { if (!cancelled && restoreRun === authRunRef.current) setChecking(false); });
    const logout = () => {
      authRunRef.current += 1;
      setAccount(null);
      setChecking(false);
    };
    const updated = (event: Event) => {
      const detail = (event as CustomEvent<BeatGalerAccount>).detail;
      const run = ++authRunRef.current;
      if (detail?.id) { setAccount(detail); setChecking(false); }
      else void restoreBeatGalerSession().then(value => {
        if (cancelled || run !== authRunRef.current) return;
        if (value) setAccount(value);
        setChecking(false);
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

  if (account?.id) return <>{children}{unlockUsername && <XUnlockOverlay username={unlockUsername} onDone={() => setUnlockUsername(null)}/>}</>;
  if (checking) return <div className="bg-account-loading" aria-live="polite"><div className="bg-account-loading__inner"><UiSpinner label="Loading BeatGaler"/><span>Loading BeatGaler…</span></div></div>;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy) return; setError(null);
    if (registerMode && password !== confirmPassword) { setError("Passwords do not match."); return; }
    setBusy(true);
    try {
      const value = registerMode
        ? await registerBeatGalerAccount(usernameBase, email, password)
        : await loginBeatGalerAccount(identifier, password, mfaCode);
      if ("signup_pending" in value) {
        setPassword(""); setConfirmPassword("");
        if (value.signup_id) setPendingSignup(value);
        else { setRegisterMode(false); setNotice("If this address is eligible, verification instructions will arrive shortly."); }
      } else setAccount(value);
    } catch (e: any) {
      if (e?.mfa_required) setMfaRequired(true);
      setError(String(e?.message || e));
    } finally { setBusy(false); }
  };

  const confirmPendingSignup = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !pendingSignup?.signup_id) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await verifyBeatGalerSignup(pendingSignup.signup_id, signupCode.trim(), pendingSignup.continuation_secret || "");
      if ("signup_pending" in result) {
        if (result.status === "ACTIVE") { setPendingSignup(null); setNotice("Your account is ready. Sign in with your email."); }
        else setNotice("Account setup is still in progress. Check status shortly.");
      } else { setPendingSignup(null); setAccount(result); }
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  const checkPendingSignup = async () => {
    if (busy || !pendingSignup?.signup_id) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await resumeBeatGalerSignup(pendingSignup.signup_id, pendingSignup.continuation_secret || "");
      if ("signup_pending" in result) {
        if (result.status === "ACTIVE") { setPendingSignup(null); setNotice("Your account is ready. Sign in with your email."); }
        else setNotice("Account setup is still in progress.");
      } else { setPendingSignup(null); setAccount(result); }
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  const resendPendingSignup = async () => {
    if (busy || !pendingSignup?.signup_id) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await resendBeatGalerSignup(pendingSignup.signup_id, pendingSignup.continuation_secret || "");
      setNotice("If this signup is active, a new code will arrive shortly.");
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  const social = async (provider: OAuthProvider) => {
    if (busy) return; setBusy(true); setError(null);
    try { setAccount(await oauthBeatGalerAccount(provider, false)); }
    catch (e: any) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  return <div className="bg-account-gate">
    {pendingSignup ? <form className="bg-account-card" onSubmit={confirmPendingSignup}>
      <h1 className="bg-account-title">Check your email</h1>
      <p className="bg-account-subtitle">Enter the verification code to finish creating your account.</p>
      <UiField id="beatgaler-signup-code" label="VERIFICATION CODE" autoFocus value={signupCode} onChange={e => setSignupCode(formatSignupVerificationCode(e.target.value))} inputMode="numeric" autoComplete="one-time-code" maxLength={7} pattern="[0-9]{3}-[0-9]{3}" placeholder="123-123" required />
      {notice && <UiFeedback tone="info">{notice}</UiFeedback>}
      {error && <UiFeedback tone="error" role="alert">{sanitizeUserVisibleText(error)}</UiFeedback>}
      <UiButton variant="primary" fullWidth loading={busy} type="submit">Verify and create account</UiButton>
      <UiButton variant="secondary" fullWidth disabled={busy} type="button" onClick={() => void resendPendingSignup()}>Resend code</UiButton>
      <UiButton variant="ghost" fullWidth disabled={busy} type="button" onClick={() => void checkPendingSignup()}>Check setup status</UiButton>
      <UiButton variant="ghost" fullWidth type="button" onClick={() => { setPendingSignup(null); setRegisterMode(false); }}>Back to sign in</UiButton>
    </form> :
    <form className="bg-account-card" onSubmit={submit} autoComplete="on">
      <h1 className="bg-account-title">BeatGaler</h1>
      <p className="bg-account-subtitle">{registerMode ? "Create your BeatGaler account" : "Sign in to your BeatGaler account"}</p>

      {<>
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
        <UiField id="beatgaler-login-identifier" label="EMAIL" type="email" autoFocus value={identifier} onChange={e => setIdentifier(e.target.value)} autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="email@example.com" />
        <UiField id="beatgaler-login-password" label="PASSWORD" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
        {mfaRequired && <UiField id="beatgaler-login-mfa" label="AUTHENTICATOR CODE" inputMode="numeric" maxLength={6} value={mfaCode} onChange={e => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))} autoComplete="one-time-code" />}
      </>}

      {notice && <UiFeedback tone="info">{notice}</UiFeedback>}
      {error && <UiFeedback tone="error" role="alert" aria-live="assertive">{sanitizeUserVisibleText(error)}</UiFeedback>}
      <UiButton className="bg-account-submit" variant="primary" fullWidth loading={busy} type="submit">{registerMode ? "Create account" : "Sign in"}</UiButton>
      <UiButton className="bg-account-switch" variant="ghost" fullWidth type="button" disabled={busy} onClick={() => { setRegisterMode(v => !v); setError(null); setMfaRequired(false); setMfaCode(""); setPassword(""); setConfirmPassword(""); }}>{registerMode ? "Already have an account? Sign in" : "New to BeatGaler? Create account"}</UiButton>
      <div className="bg-account-footer">Normal BeatGaler usernames use username#1234. Claiming X replaces it with your official X username.</div>
    </form>}
    {unlockUsername && <XUnlockOverlay username={unlockUsername} onDone={() => setUnlockUsername(null)}/>} 
  </div>;
}
