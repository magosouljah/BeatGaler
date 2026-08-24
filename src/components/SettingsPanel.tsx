import React, { useEffect, useState } from "react";
import type { Beat } from "../types";
import { platform } from "../platform";
import type {
  PlatformPlaybackCacheStatus as PlaybackCacheStatus,
  PlatformPresetTrashItem as TemplateTrashItem,
  PlatformTrashItem as TrashItem,
} from "../platform/contracts";
import { sanitizeUserVisibleText } from "../lib/userVisibleError";
import {
  beginMfaSetup, changeBeatGalerEmail, changeBeatGalerPassword, disableMfa, disconnectOAuthProvider,
  enableMfa, getBeatGalerAccountInfo, getBeatGalerPlanCatalog, devSwitchBeatGalerPlan, oauthBeatGalerAccount,
  type BeatGalerAccount, type BeatGalerPlanDefinition, type BeatGalerPlanId, type OAuthProvider,
} from "./AccountGate";

interface Props {
  currentFolder: string | null;
  showIncompleteWarnings: boolean;
  onIncompleteWarningsChanged: (enabled: boolean) => void;
  customCursorEnabled: boolean;
  onCustomCursorChanged: (enabled: boolean) => void;
  telegramConnected: boolean;
  networkOnline: boolean;
  telegramUsername: string | null;
  onDisconnectTelegram: () => Promise<void>;
  onClose: () => void;
  onFolderChanged: (folder: string) => void;
  onBeatRestored?: (beat: Beat) => void;
}

type Section = "account" | "plan" | "preferences" | "trash" | "tools" | "privacy" | "terms";

type LegalSection = { heading: string; paragraphs?: string[]; bullets?: string[] };

const LEGAL_UPDATED = "August 11, 2026";
const PRIVACY_SECTIONS: LegalSection[] = [
  { heading: "1. Who we are", paragraphs: ["Beat Galer is an application for discovering, organizing, and playing music beats (\"Beat Vault\"), with optional cloud account features and syncing."], bullets: ["Data controller: [Developer or company name]", "Contact email: [your-email@example.com]", "Country of operation: Mexico (this policy is governed by Mexican law, including the Federal Law on Protection of Personal Data Held by Private Parties)"] },
  { heading: "2. Information we collect", paragraphs: ["The information we may collect depends on the Beat Galer features you choose to use."] },
  { heading: "2.1 Account information", paragraphs: ["If you create a Beat Galer account, we may collect:"], bullets: ["Username and password (stored encrypted via salted hashing; we never store your password in plain text)", "Email address (if provided)"] },
  { heading: "2.2 Third-party sign-in (Google and X)", paragraphs: ["If you choose to sign in with Google or X (formerly Twitter), we receive the following from those providers:"], bullets: ["A unique identifier for your account", "Your public name and, for Google, your email address", "For X, your username", "We do not receive or store your Google or X password. Authentication is handled through the standard OAuth 2.0 protocol, and we only receive the data the provider authorizes to share."] },
  { heading: "2.3 Cloud services", paragraphs: ["Beat Galer uses private cloud infrastructure to sync and store supported account data and content. Infrastructure credentials are kept server-side and are never exposed to the app interface."] },
  { heading: "2.4 Content you upload (beats and audio files)", paragraphs: ["If you use the cloud storage features (\"Beat Vault\"), the audio files and related metadata (name, cover art, beat info) you upload are stored on our servers so you can access them across your devices."] },
  { heading: "2.5 Technical information", paragraphs: ["We may automatically collect:"], bullets: ["IP address", "Device type and operating system", "Usage and diagnostic logs, which do not include your file contents or sensitive tokens"] },
  { heading: "2.6 Payment information", paragraphs: ["If you subscribe to a paid plan, payment processing is handled by a third-party payment provider. Beat Galer does not store your full credit or debit card details."] },
  { heading: "3. How we use your information", paragraphs: ["We use the information we collect to:"], bullets: ["Create and manage your account", "Let you sign in via Google, X, or username/password", "Sync and store your beats in the cloud", "Process payments and manage your subscription (free or paid plan)", "Improve the performance, security, and stability of the Service", "Comply with legal obligations", "We do not sell your personal information to third parties."] },
  { heading: "4. Who we share information with", paragraphs: ["We may share information only in these cases:"], bullets: ["Service providers: companies that help us operate the Service (e.g., cloud hosting, payment processing), under confidentiality obligations.", "Google and X: solely in the sense that these providers process your authentication under their own privacy policies.", "Legal requirements: if required by law, or to protect our rights, user safety, or prevent fraud.", "Business transfers: in the event of a merger, acquisition, or sale of assets."] },
  { heading: "5. Storage and security", bullets: ["Passwords are stored using secure hashing (scrypt) with a unique salt per user; never in plain text.", "Login sessions use random, single-use tokens with defined expiration.", "We apply reasonable technical and organizational security measures to protect your information, although no system is completely infallible.", "We retain your information while your account is active, or as long as necessary for legal, accounting, or security purposes."] },
  { heading: "6. Your rights", paragraphs: ["Depending on your location, you may have rights to:"], bullets: ["Access the personal data we hold about you", "Correct inaccurate or incomplete information", "Delete your data when no longer necessary", "Object to certain uses of your data"], },
  { heading: "7. Children", paragraphs: ["Beat Galer is not directed at children under 13 (or the applicable minimum age in your country). We do not knowingly collect information from children without parental or guardian consent. If we learn that a minor has provided data without authorization, we will delete it."] },
  { heading: "8. International data transfers", paragraphs: ["Because we use providers such as Google, X, and cloud hosting services, your information may be processed on servers located outside your country of residence. We take steps to ensure such providers meet appropriate data protection standards."] },
  { heading: "9. Changes to this policy", paragraphs: ["We may update this Privacy Policy from time to time. We will post the updated version at this same location with a revised \"Last updated\" date. Continued use of the Service after a change constitutes your acceptance of the new version."] },
  { heading: "10. Contact", paragraphs: ["If you have questions about this Privacy Policy, contact us at:", "earthisagiantplayground@gmail.com"] },
];

const TERMS_SECTIONS: LegalSection[] = [
  { heading: "1. Description of the Service", paragraphs: ["Beat Galer is an application that lets you discover, organize, play, and store music beats. It includes:"], bullets: ["A local beat library (\"Beat Vault\")", "Optional account and cloud storage features", "Sign-in via username/password, Google, or X", "Free and paid (freemium) plans", "We may modify, add, or remove features of the Service at any time, with or without notice, particularly during beta phases."] },
  { heading: "2. Eligibility and accounts", bullets: ["You must be at least 13 years old (or the applicable minimum age in your country) to use the Service.", "You are responsible for keeping your password confidential and for all activity that occurs under your account.", "If you sign in via Google or X, you must also comply with those providers' terms.", "You must provide accurate information when creating your account.", "We reserve the right to suspend or delete accounts that violate these Terms."] },
  { heading: "3. Free and paid plans", bullets: ["Beat Galer offers a free plan with basic features and paid (subscription) plans with additional features, more cloud storage, or other benefits.", "Pricing, features, and terms for each plan are shown within the app or on our website before purchase.", "Payments are processed through third-party payment providers; by subscribing, you also agree to that provider's terms.", "Subscriptions may renew automatically unless canceled before the next billing cycle, as indicated at the time of purchase.", "We reserve the right to change prices with reasonable prior notice to affected users."] },
  { heading: "4. User content (beats and uploaded files)", bullets: ["You retain all rights to the audio files and content you upload to your Beat Vault.", "By uploading content to our cloud servers, you grant us a limited, non-exclusive license to store, process, and transmit that content solely to provide you the Service (for example, syncing it across your devices).", "You are solely responsible for ensuring you have the necessary rights to any beat, track, or file you upload or share through the Service.", "We reserve the right to remove content that infringes intellectual property rights, is unlawful, or violates these Terms."] },
  { heading: "5. Prohibited conduct", paragraphs: ["When using Beat Galer, you agree NOT to:"], bullets: ["Upload or distribute content that infringes third-party intellectual property rights", "Use the Service for unlawful activities", "Attempt to breach, hack, or interfere with the security of the Service, including cloud infrastructure or the authentication system", "Impersonate another person or provide false information", "Use bots, scrapers, or other unauthorized automated means to access the Service", "Resell or redistribute the Service without express authorization"] },
  { heading: "6. Third-party integrations", paragraphs: ["Beat Galer may integrate with third-party services for optional features:"], bullets: ["Google / X: used for authentication (sign-in). Your relationship with these providers is governed by their own terms and privacy policies.", "Cloud and infrastructure providers may process data only as needed to operate the Service.", "We are not responsible for the availability, functioning, or policies of third-party services."] },
  { heading: "7. Intellectual property of the Service", paragraphs: ["The software, design, \"Beat Galer\" brand, and other elements of the Service (excluding user-uploaded content) are the property of [Developer or company name] and are protected by intellectual property laws. No rights are granted to you over these elements other than the limited license to use the Service under these Terms."] },
  { heading: "8. Beta phase and Service availability", paragraphs: ["Certain features (including cloud storage) may be in beta. This means:"], bullets: ["Bugs, interruptions, or occasional data loss may occur", "Features may change or be discontinued without notice", "We recommend keeping backups of your important files", "The Service is provided \"as is\" and \"as available,\" without warranties of any kind, express or implied."] },
  { heading: "9. Limitation of liability", paragraphs: ["To the maximum extent permitted by applicable law:"], bullets: ["We are not liable for indirect, incidental, special, or consequential damages arising from your use or inability to use the Service.", "We do not guarantee that the Service will be uninterrupted, error-free, or completely secure.", "Our total liability to you for any claim related to the Service will not exceed the amount you paid for your subscription in the last 12 months (or $0 if you use the free plan)."] },
  { heading: "10. Termination", paragraphs: ["You may stop using the Service and delete your account at any time.", "We may suspend or terminate your access to the Service if:"], bullets: ["You violate these Terms", "We detect fraudulent or abusive use", "Required by law", "Upon termination, certain provisions of these Terms (intellectual property, limitation of liability, governing law) will remain in effect."] },
  { heading: "11. Changes to these Terms", paragraphs: ["We may update these Terms from time to time. We will post the updated version with the corresponding date. Continued use of the Service after a change constitutes your acceptance of the new Terms."] },
  { heading: "12. Governing law and jurisdiction", paragraphs: ["These Terms are governed by the laws of Mexico. Any dispute related to the Service will be submitted to the competent courts of Mexico, unless applicable law provides otherwise."] },
  { heading: "13. Contact", paragraphs: ["For questions about these Terms of Service, contact us at:", "earthisagiantplayground@gmail.com"] },
];
const fieldStyle: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "10px 11px", border: "1px solid #292929", borderRadius: 8, outline: 0, background: "#151515", color: "#eee", fontSize: 12 };
const buttonStyle: React.CSSProperties = { padding: "9px 13px", border: "1px solid #2b2b2b", borderRadius: 8, background: "#181818", color: "#bbb", cursor: "pointer", fontSize: 12 };

export default function SettingsPanel(props: Props) {
  const { showIncompleteWarnings, onIncompleteWarningsChanged, customCursorEnabled, onCustomCursorChanged, onDisconnectTelegram, onClose, onBeatRestored } = props;
  const [active, setActive] = useState<Section>("account");
  const [preferenceBusy, setPreferenceBusy] = useState(false);
  const [trashItems, setTrashItems] = useState<TrashItem[]>([]);
  const [loadingTrash, setLoadingTrash] = useState(true);
  const [restoringIds, setRestoringIds] = useState<Set<string>>(() => new Set());
  const [trashError, setTrashError] = useState<string | null>(null);
  const [trashMessage, setTrashMessage] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);
  const [presetTrashItems, setPresetTrashItems] = useState<TemplateTrashItem[]>([]);
  const [loadingPresetTrash, setLoadingPresetTrash] = useState(true);
  const [restoringPresetId, setRestoringPresetId] = useState<string | null>(null);
  const [purgingPresets, setPurgingPresets] = useState(false);
  const [account, setAccount] = useState<BeatGalerAccount | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
  const [planCatalog, setPlanCatalog] = useState<BeatGalerPlanDefinition[]>([]);
  const [planSwitching, setPlanSwitching] = useState<BeatGalerPlanId | null>(null);
  const [email, setEmail] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mfaSecret, setMfaSecret] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [showDisableMfaConfirm, setShowDisableMfaConfirm] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<PlaybackCacheStatus | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [customCacheMb, setCustomCacheMb] = useState("2048");
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const navigationSections: Section[] = [
    "account",
    "plan",
    "preferences",
    ...(platform.capabilities.trashLifecycle ? ["trash" as const] : []),
    ...(platform.capabilities.developerTools ? ["tools" as const] : []),
  ];

  const refreshAccount = async () => {
    try { const value = await getBeatGalerAccountInfo(); setAccount(value); }
    catch (e: any) { setAccountError(String(e?.message || e)); }
  };

  useEffect(() => {
    void refreshAccount();
    getBeatGalerPlanCatalog().then(setPlanCatalog).catch(console.error);
    if (platform.capabilities.trashLifecycle) {
      platform.trash.listBeats().then(setTrashItems).catch(console.error).finally(() => setLoadingTrash(false));
      if (platform.capabilities.localHelper) {
        platform.trash.listPresets().then(setPresetTrashItems).catch(console.error).finally(() => setLoadingPresetTrash(false));
      } else {
        setLoadingPresetTrash(false);
      }
    } else {
      setLoadingTrash(false);
      setLoadingPresetTrash(false);
    }
    if (platform.capabilities.playbackCache) {
      platform.playbackCache.status().then(status => { setCacheStatus(status); setCustomCacheMb(String(status.limit_mb)); }).catch(console.error);
    }
  }, []);

  const toggleIncomplete = async () => {
    const next = !showIncompleteWarnings; setPreferenceBusy(true);
    try { await platform.preferences.setIncompleteWarnings(next); onIncompleteWarningsChanged(next); }
    finally { setPreferenceBusy(false); }
  };
  const toggleCursor = async () => {
    const next = !customCursorEnabled; setPreferenceBusy(true);
    try { await platform.preferences.setCustomCursor(next); onCustomCursorChanged(next); }
    finally { setPreferenceBusy(false); }
  };

  const updateCacheLimit = async (limitMb: number) => {
    setCacheBusy(true);
    try {
      const status = await platform.playbackCache.setLimitMb(Math.max(0, Math.round(limitMb)));
      setCacheStatus(status);
      setCustomCacheMb(String(status.limit_mb));
    } finally { setCacheBusy(false); }
  };

  const clearCache = async () => {
    setCacheBusy(true);
    try { setCacheStatus(await platform.playbackCache.clear()); }
    finally { setCacheBusy(false); }
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${Math.max(0, bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const restore = (item: TrashItem) => {
    // Optimistically mark only this row busy and immediately return control to
    // React. Other Trash rows remain clickable while native work runs in the
    // background. Duplicate clicks on the same row are ignored.
    if (restoringIds.has(item.id)) return;
    setRestoringIds(current => {
      const next = new Set(current);
      next.add(item.id);
      return next;
    });
    setTrashError(null);

    void platform.trash.restoreBeat(item.id)
      .then(beat => {
        setTrashItems(items => items.filter(x => x.id !== item.id));
        onBeatRestored?.(beat);
      })
      .catch((e: any) => {
        setTrashError(String(e?.message || e));
      })
      .finally(() => {
        setRestoringIds(current => {
          const next = new Set(current);
          next.delete(item.id);
          return next;
        });
      });
  };

  const emptyTrash = () => {
    if (!props.networkOnline) {
      setTrashMessage(null);
      setTrashError("Connect to the internet before permanently emptying beat Trash.");
      return;
    }
    if (!trashItems.length) return;
    const requested = trashItems.length;

    // Empty Trash is a one-click enqueue action. No native confirmation dialog
    // and no foreground wait: disappear immediately, then reconcile quietly.
    setTrashItems([]);
    setPurging(true);
    setTrashError(null);
    setTrashMessage(`Deleting ${requested} beat${requested === 1 ? "" : "s"} in background…`);

    void (async () => {
      try {
        const purged = await platform.trash.purgeBeats();
        const remaining = await platform.trash.listBeats();
        setTrashItems(remaining);
        if (remaining.length > 0) {
          setTrashError(`${remaining.length} item(s) could not be queued for permanent deletion and were restored to Trash.`);
          setTrashMessage(null);
        } else {
          setTrashMessage(`${purged || requested} beat${(purged || requested) === 1 ? "" : "s"} queued for permanent deletion.`);
          window.setTimeout(() => setTrashMessage(null), 3500);
        }
      } catch (e: any) {
        // If the request never reached/committed at the backend, restore the real
        // local Trash instead of pretending deletion succeeded.
        setTrashError(String(e?.message || e));
        setTrashMessage(null);
        try { setTrashItems(await platform.trash.listBeats()); } catch {}
      } finally {
        setPurging(false);
      }
    })();
  };
  const emptyPresetTrash = async () => {
    if (!presetTrashItems.length || !confirm(`Delete ${presetTrashItems.length} preset(s) permanently? This can't be undone.`)) return;
    setPurgingPresets(true); try { await platform.trash.purgePresets(); setPresetTrashItems([]); } finally { setPurgingPresets(false); }
  };

  const setAccountStatus = (message: string | null, error: string | null = null) => { setAccountMessage(message); setAccountError(error); };
  const switchPlanForTesting = async (planId: BeatGalerPlanId) => {
    setPlanSwitching(planId); setAccountStatus(null);
    try {
      const updated = await devSwitchBeatGalerPlan(planId);
      setAccount(updated);
      setAccountStatus(`Plan changed to ${updated.plan?.label || planId}.`);
    } catch (e: any) { setAccountStatus(null, String(e?.message || e)); }
    finally { setPlanSwitching(null); }
  };
  const changeEmail = async () => {
    if (!email.trim()) return setAccountStatus(null, "Enter your new email address.");
    if (email.trim().toLowerCase() !== confirmEmail.trim().toLowerCase()) return setAccountStatus(null, "Email addresses do not match.");
    setAccountBusy(true); setAccountStatus(null);
    try { const updated = await changeBeatGalerEmail(email, confirmEmail); setAccount(updated); setEmail(""); setConfirmEmail(""); setAccountStatus("Email updated."); }
    catch (e: any) { setAccountStatus(null, String(e?.message || e)); }
    finally { setAccountBusy(false); }
  };

  const changePassword = async () => {
    if (newPassword.length < 8) return setAccountStatus(null, "New password must be at least 8 characters.");
    if (newPassword !== confirmPassword) return setAccountStatus(null, "New passwords do not match.");
    setAccountBusy(true); setAccountStatus(null);
    try { await changeBeatGalerPassword(currentPassword, newPassword); setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); await refreshAccount(); setAccountStatus("Password updated."); }
    catch (e: any) { setAccountStatus(null, String(e?.message || e)); }
    finally { setAccountBusy(false); }
  };

  const connectProvider = async (provider: OAuthProvider) => {
    setAccountBusy(true); setAccountStatus(null);
    try { await oauthBeatGalerAccount(provider, true); await refreshAccount(); setAccountStatus(`${provider === "x" ? "X" : "Google"} connected.`); }
    catch (e: any) { setAccountStatus(null, String(e?.message || e)); }
    finally { setAccountBusy(false); }
  };
  const disconnectProvider = async (provider: OAuthProvider) => {
    setAccountBusy(true); setAccountStatus(null);
    try { await disconnectOAuthProvider(provider); await refreshAccount(); setAccountStatus(`${provider === "x" ? "X" : "Google"} disconnected.`); }
    catch (e: any) { setAccountStatus(null, String(e?.message || e)); }
    finally { setAccountBusy(false); }
  };

  const beginMfa = async () => {
    setAccountBusy(true); setAccountStatus(null);
    try { const result = await beginMfaSetup(); setMfaSecret(result.secret); setMfaCode(""); }
    catch (e: any) { setAccountStatus(null, String(e?.message || e)); }
    finally { setAccountBusy(false); }
  };
  const confirmMfa = async () => {
    setAccountBusy(true); setAccountStatus(null);
    try { await enableMfa(mfaCode); setMfaSecret(null); setMfaCode(""); await refreshAccount(); setAccountStatus("Multi-factor authentication enabled."); }
    catch (e: any) { setAccountStatus(null, String(e?.message || e)); }
    finally { setAccountBusy(false); }
  };
  const turnOffMfa = async () => {
    if (!mfaCode) return setAccountStatus(null, "Enter the current 6-digit authenticator code to disable MFA.");
    setAccountBusy(true); setAccountStatus(null);
    try { await disableMfa(mfaCode); setMfaCode(""); setShowDisableMfaConfirm(false); await refreshAccount(); setAccountStatus("Multi-factor authentication disabled."); }
    catch (e: any) { setAccountStatus(null, String(e?.message || e)); }
    finally { setAccountBusy(false); }
  };

  const switchButton = (enabled: boolean, onClick: () => void) => <button disabled={preferenceBusy} onClick={onClick} style={{ width: 40, height: 22, padding: 2, borderRadius: 20, border: "1px solid #303030", background: enabled ? "#ddd" : "#1b1b1b", cursor: preferenceBusy ? "default" : "pointer" }}><span style={{ display: "block", width: 16, height: 16, borderRadius: "50%", background: enabled ? "#111" : "#666", transform: enabled ? "translateX(16px)" : "translateX(0)", transition: "transform .15s" }}/></button>;
  const card = (children: React.ReactNode) => <div style={{ border: "1px solid #202020", background: "#121212", borderRadius: 12, padding: 18, marginBottom: 14 }}>{children}</div>;
  const title = (heading: string, sub: string) => <div style={{ marginBottom: 24 }}><div style={{ fontSize: 23, color: "#e7e7e7", fontWeight: 650, letterSpacing: -.4 }}>{heading}</div><div style={{ marginTop: 5, color: "#666", fontSize: 12 }}>{sub}</div></div>;

  const renderLegalSections = (sections: LegalSection[]) => sections.map(section => <div key={section.heading} style={{ marginBottom: 28 }}>
    <div style={{ fontSize: 16, fontWeight: 650, color: "#d5d5d5", marginBottom: 10 }}>{section.heading}</div>
    {section.paragraphs?.map((paragraph, index) => <p key={index} style={{ margin: "0 0 10px", color: "#828282", fontSize: 11, lineHeight: 1.75 }}>{paragraph}</p>)}
    {section.bullets && <ul style={{ margin: "8px 0 0", paddingLeft: 19, color: "#828282", fontSize: 11, lineHeight: 1.75 }}>{section.bullets.map((bullet, index) => <li key={index} style={{ marginBottom: 6 }}>{bullet}</li>)}</ul>}
    {section.heading === "6. Your rights" && <p style={{ margin: "10px 0 0", color: "#828282", fontSize: 11, lineHeight: 1.75 }}>To exercise these rights, contact us at <strong>earthisagiantplayground@gmail.com</strong>. We will respond within the timeframes required by applicable law.<br/><br/>You can also delete your account and stored content at any time from the app settings, or by requesting it via email.</p>}
  </div>);

  const providerRow = (provider: OAuthProvider, connected: boolean, detail?: string | null) => <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, padding: "12px 0", borderBottom: "1px solid #1c1c1c" }}><div><div style={{ color: "#ccc", fontSize: 13 }}>{provider === "x" ? "X" : "Google"}</div><div style={{ color: "#555", fontSize: 10, marginTop: 3 }}>{connected ? (detail || "Connected") : "Not connected"}</div></div><button disabled={accountBusy} onClick={() => void (connected ? disconnectProvider(provider) : connectProvider(provider))} style={buttonStyle}>{connected ? "Disconnect" : "Connect"}</button></div>;

  return <div style={{ position: "fixed", inset: 0, zIndex: 310, background: "#0a0a0a", color: "#ddd", display: "flex", fontFamily: "Inter, system-ui, sans-serif" }}>
    <aside style={{ width: 220, flexShrink: 0, borderRight: "1px solid #191919", background: "#0d0d0d", padding: "24px 16px", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "0 10px 22px", fontSize: 17, fontWeight: 650 }}>Settings</div>
      {navigationSections.map(section => <button key={section} onClick={() => setActive(section)} style={{ textAlign: "left", border: 0, borderRadius: 8, padding: "10px 12px", marginBottom: 4, background: active === section ? "#1c1c1c" : "transparent", color: active === section ? "#eee" : "#777", cursor: "pointer", textTransform: "capitalize", fontSize: 13 }}>{section === "tools" ? "Tools (Dev)" : section}</button>)}
      <div style={{ flex: 1 }}/>
      <div style={{ borderTop: "1px solid #191919", paddingTop: 10 }}>
        <button onClick={() => setActive("privacy")} style={{ width: "100%", textAlign: "left", border: 0, background: "transparent", color: active === "privacy" ? "#bbb" : "#555", padding: "7px 12px", cursor: "pointer", fontSize: 10 }}>Privacy Policy</button>
        <button onClick={() => setActive("terms")} style={{ width: "100%", textAlign: "left", border: 0, background: "transparent", color: active === "terms" ? "#bbb" : "#555", padding: "7px 12px", cursor: "pointer", fontSize: 10 }}>Terms of Service</button>
      </div>
      <div style={{ padding: "8px 12px 0", color: "#3f3f3f", fontSize: 10 }}>Beat Galer 0.8.0-alpha.1</div>
    </aside>

    <main style={{ flex: 1, overflowY: "auto" }}>
      <div style={{ minHeight: 58, borderBottom: "1px solid #171717", display: "flex", justifyContent: "flex-end", alignItems: "center", padding: "0 26px" }}><button onClick={onClose} style={{ border: 0, background: "transparent", color: "#777", cursor: "pointer", fontSize: 24 }}>×</button></div>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "38px 34px 80px" }}>
        {active === "account" && <>
          {title("Account", "Manage sign-in methods and account security.")}
          {card(<>
            <div style={{ fontSize: 11, color: "#555", marginBottom: 5 }}>BEATGALER ACCOUNT</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div data-beatgaler-username-target="true" style={{ fontSize: 19, color: "#e7e7e7", fontWeight: 650 }}>{account?.official_username ? `@${account?.username || "…"}` : (account?.username || "…")}</div>
              {account?.official_username && <span style={{ fontSize: 9, color: "#bdbdbd", border: "1px solid #343434", borderRadius: 999, padding: "3px 6px" }}>X OFFICIAL</span>}
            </div>
            <div style={{ marginTop: 5, fontSize: 10, color: "#555" }}>Your private Galer Library is attached to this account, not to a specific sign-in provider.</div>
            {!account?.providers?.x?.connected && <div style={{ marginTop: 17, paddingTop: 15, borderTop: "1px solid #1c1c1c", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18 }}>
              <div>
                <div style={{ color: "#c8c8c8", fontSize: 12, fontWeight: 600 }}>Get an official username</div>
                <div style={{ color: "#505050", fontSize: 10, marginTop: 3 }}>Use your current X username as your verified BeatGaler identity.</div>
              </div>
              <button disabled={accountBusy} onClick={() => void connectProvider("x")} title="Connect with X" style={{ minWidth: 142, height: 38, borderRadius: 10, border: "1px solid #333", background: "#f0f0f0", color: "#080808", display: "flex", alignItems: "center", justifyContent: "center", gap: 9, cursor: accountBusy ? "default" : "pointer", opacity: accountBusy ? .55 : 1, fontSize: 11, fontWeight: 700 }}><span style={{ fontSize: 17, lineHeight: 1 }}>𝕏</span><span>Connect with X</span></button>
            </div>}
            {account?.providers?.x?.connected && <div style={{ marginTop: 14, paddingTop: 13, borderTop: "1px solid #1c1c1c", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}><div style={{ color: "#777", fontSize: 10 }}>Connected to X as @{account.providers.x.username || account.username}. BeatGaler keeps this username synced.</div><button disabled={accountBusy} onClick={() => void disconnectProvider("x")} style={{ ...buttonStyle, padding: "6px 9px", fontSize: 10 }}>Disconnect X</button></div>}
          </>)}

          {card(<><div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Sign-in methods</div><div style={{ color: "#5d5d5d", fontSize: 11, marginBottom: 8 }}>Connect Google as an additional sign-in method. X is managed from your official username card above.</div>{providerRow("google", !!account?.providers?.google?.connected, account?.providers?.google?.email || account?.providers?.google?.name)}</>)}

          {card(<><div style={{ fontSize: 14, fontWeight: 600 }}>Email</div><div style={{ marginTop: 8, color: "#555", fontSize: 10 }}>Current sign-in email</div><div style={{ marginTop: 4, marginBottom: 5, color: "#d0d0d0", fontSize: 12, fontWeight: 600, userSelect: "text" }}>{account?.email || "No email connected"}</div><div style={{ color: "#5d5d5d", fontSize: 11, marginTop: 4, marginBottom: 14 }}>To change it, type the new email twice.</div><input type="email" placeholder="New email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="off" style={fieldStyle}/><input type="email" placeholder="Type new email again" value={confirmEmail} onChange={e => setConfirmEmail(e.target.value)} autoComplete="off" style={{ ...fieldStyle, marginTop: 8 }}/><button disabled={accountBusy} onClick={() => void changeEmail()} style={{ ...buttonStyle, marginTop: 10 }}>Change email</button></>)}

          {card(<><div style={{ fontSize: 14, fontWeight: 600 }}>Password</div><div style={{ color: "#5d5d5d", fontSize: 11, marginTop: 4, marginBottom: 14 }}>{account?.has_password ? "Change your BeatGaler password." : "Add a password so you can also sign in without Google or X."}</div>{account?.has_password && <input type="password" placeholder="Current password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} style={fieldStyle}/>}<input type="password" placeholder="New password" value={newPassword} onChange={e => setNewPassword(e.target.value)} style={{ ...fieldStyle, marginTop: account?.has_password ? 8 : 0 }}/><input type="password" placeholder="Confirm new password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} style={{ ...fieldStyle, marginTop: 8 }}/><button disabled={accountBusy} onClick={() => void changePassword()} style={{ ...buttonStyle, marginTop: 10 }}>{account?.has_password ? "Change password" : "Set password"}</button></>)}

          {card(<><div style={{ fontSize: 14, fontWeight: 600 }}>Multi-factor authentication</div><div style={{ color: "#5d5d5d", fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>Use a 6-digit code from an authenticator app when signing in with your BeatGaler password.</div>{!account?.mfa_enabled && !mfaSecret && <button disabled={accountBusy} onClick={() => void beginMfa()} style={{ ...buttonStyle, marginTop: 12 }}>Enable MFA</button>}{mfaSecret && <div style={{ marginTop: 14, padding: 14, borderRadius: 9, background: "#181818", border: "1px solid #242424" }}><div style={{ color: "#aaa", fontSize: 11 }}>Add this secret to your authenticator app:</div><div style={{ marginTop: 8, padding: 9, borderRadius: 6, background: "#0d0d0d", color: "#eee", fontFamily: "monospace", wordBreak: "break-all", userSelect: "text" }}>{mfaSecret}</div><input inputMode="numeric" maxLength={6} placeholder="6-digit code" value={mfaCode} onChange={e => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))} style={{ ...fieldStyle, marginTop: 9 }}/><button disabled={accountBusy || mfaCode.length !== 6} onClick={() => void confirmMfa()} style={{ ...buttonStyle, marginTop: 9 }}>Confirm and enable</button></div>}{account?.mfa_enabled && <div style={{ marginTop: 12 }}><div style={{ color: "#7b9b7b", fontSize: 11 }}>MFA is enabled.</div>{!showDisableMfaConfirm ? <button disabled={accountBusy} onClick={() => { setMfaCode(""); setShowDisableMfaConfirm(true); }} style={{ ...buttonStyle, marginTop: 10, color: "#c98787" }}>Disable MFA</button> : <div style={{ marginTop: 10, padding: 12, border: "1px solid #2a2222", background: "#151111", borderRadius: 8 }}><div style={{ color: "#777", fontSize: 10, lineHeight: 1.45, marginBottom: 8 }}>Confirm disabling MFA with one current authenticator code.</div><input autoFocus inputMode="numeric" maxLength={6} placeholder="6-digit authenticator code" value={mfaCode} onChange={e => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))} style={fieldStyle}/><div style={{ display: "flex", gap: 8, marginTop: 8 }}><button disabled={accountBusy || mfaCode.length !== 6} onClick={() => void turnOffMfa()} style={{ ...buttonStyle, color: "#c98787" }}>Confirm disable</button><button disabled={accountBusy} onClick={() => { setMfaCode(""); setShowDisableMfaConfirm(false); }} style={buttonStyle}>Cancel</button></div></div>}</div>}</>)}

          {accountMessage && <div style={{ marginBottom: 14, color: "#83a783", fontSize: 11 }}>{accountMessage}</div>}{accountError && <div style={{ marginBottom: 14, padding: 10, border: "1px solid #542020", background: "#241010", borderRadius: 8, color: "#e6a0a0", fontSize: 11 }}>{sanitizeUserVisibleText(accountError)}</div>}
          <button disabled={accountBusy} onClick={() => void onDisconnectTelegram()} style={{ ...buttonStyle, width: "100%", color: "#c98787" }}>Sign out of BeatGaler</button>
        </>}

        {active === "plan" && <>
          {title("Plan", "Manage your BeatGaler access.")}

          <div style={{ marginBottom: 22, padding: "18px 20px", border: "1px solid #252525", borderRadius: 13, background: "#151515", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 18 }}>
            <div>
              <div style={{ fontSize: 10, color: "#606060", letterSpacing: .7 }}>CURRENT PLAN</div>
              <div style={{ marginTop: 6, fontSize: 22, color: "#f0f0f0", fontWeight: 700 }}>{account?.plan?.label || "Free"}</div>
              <div style={{ marginTop: 5, color: "#666", fontSize: 10 }}>
                {account?.plan?.effective_until ? `Temporary access until ${new Date(account.plan.effective_until).toLocaleDateString()}` : "Your plan is synced with your BeatGaler account."}
              </div>
            </div>
            <div style={{ textAlign: "right", color: "#555", fontSize: 10, lineHeight: 1.55 }}>
              {account?.plan?.quotas.max_beats == null ? "Unlimited beats" : `${account?.plan?.quotas.max_beats ?? 20} beats`}<br/>
              {account?.plan?.entitlements.upload_project ? "PROJECT upload included" : "PROJECT upload not included"}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, margin: "0 0 12px" }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#e8e8e8" }}>All plans</div>
              <div style={{ marginTop: 3, fontSize: 10, color: "#555" }}>Pricing comes later. Buttons simulate checkout for architecture testing.</div>
            </div>
            <div style={{ fontSize: 9, letterSpacing: .6, color: "#7a6546", border: "1px solid #3a3021", background: "#19150f", borderRadius: 999, padding: "4px 7px" }}>DEV ONLY</div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, alignItems: "stretch" }}>
            {(planCatalog.length ? planCatalog : []).map(plan => {
              const current = account?.plan?.base_plan_id === plan.id;
              const featured = plan.id === "paid_entry";
              const projectMb = plan.quotas.max_project_zip_bytes == null ? "Unlimited" : plan.quotas.max_project_zip_bytes >= 1024 * 1024 * 1024 ? `${(plan.quotas.max_project_zip_bytes / 1024 / 1024 / 1024).toFixed(plan.id === "highest_paid" ? 1 : 0)} GB PROJECT` : `${Math.round(plan.quotas.max_project_zip_bytes / 1024 / 1024)} MB PROJECT`;
              const features = [
                plan.quotas.max_beats == null ? "Unlimited beats" : `${plan.quotas.max_beats} beats`,
                projectMb,
                plan.entitlements.upload_project ? "PROJECT upload" : "No PROJECT upload",
                plan.quotas.youtube_uploads_per_day == null ? "Unlimited YouTube / day" : `${plan.quotas.youtube_uploads_per_day} YouTube / day`,
                plan.quotas.youtube_uploads_per_month == null ? "Unlimited YouTube / month" : `${plan.quotas.youtube_uploads_per_month} YouTube / month`,
                plan.entitlements.bulk_youtube_upload === "full" ? "Bulk YouTube Upload" : plan.entitlements.bulk_youtube_upload === "limited" ? "Limited Bulk YouTube" : "No Bulk YouTube",
              ];
              return <div key={plan.id} style={{ position: "relative", minHeight: 310, padding: "17px 16px 15px", borderRadius: 13, border: featured ? "1px solid #5a5a5a" : "1px solid #262626", background: featured ? "#181818" : "#141414", boxShadow: featured ? "0 0 0 1px #1e1e1e inset" : "none", display: "flex", flexDirection: "column" }}>
                {featured && <div style={{ position: "absolute", top: 13, right: 13, fontSize: 8, fontWeight: 700, letterSpacing: .55, color: "#cfcfcf", background: "#292929", borderRadius: 999, padding: "4px 7px" }}>POPULAR</div>}
                <div style={{ paddingRight: featured ? 58 : 0, fontSize: 15, color: "#eee", fontWeight: 700 }}>{plan.label}</div>
                <div style={{ marginTop: 5, minHeight: 27, fontSize: 9.5, color: "#5c5c5c", lineHeight: 1.45 }}>{plan.id === "free" ? "Start your library." : plan.id === "paid_entry" ? "For producers building every day." : "Maximum BeatGaler access."}</div>
                <button disabled={current || planSwitching !== null} onClick={() => void switchPlanForTesting(plan.id)} style={{ marginTop: 13, width: "100%", height: 34, borderRadius: 8, border: current ? "1px solid #282828" : featured ? "1px solid #e6e6e6" : "1px solid #353535", background: current ? "#171717" : featured ? "#ececec" : "#1d1d1d", color: current ? "#595959" : featured ? "#111" : "#d0d0d0", cursor: current || planSwitching !== null ? "default" : "pointer", fontSize: 10.5, fontWeight: 700 }}>
                  {current ? "Current plan" : planSwitching === plan.id ? "Changing…" : plan.id === "free" ? "Switch to Free" : "Choose plan"}
                </button>
                <div style={{ height: 1, background: "#222", margin: "15px 0 11px" }}/>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {features.map((feature, index) => <div key={feature} style={{ display: "flex", alignItems: "flex-start", gap: 7, color: index >= 2 && feature.startsWith("No ") ? "#4d4d4d" : "#929292", fontSize: 9.5, lineHeight: 1.35 }}><span style={{ color: index >= 2 && feature.startsWith("No ") ? "#3f3f3f" : "#6f6f6f", lineHeight: 1 }}>•</span><span>{feature}</span></div>)}
                </div>
                <div style={{ marginTop: "auto", paddingTop: 13, fontSize: 8.5, color: "#484848" }}>
                  {plan.quotas.max_active_devices == null ? "Unlimited devices" : `${plan.quotas.max_active_devices} devices`} · {plan.quotas.max_simultaneous_sessions} simultaneous {plan.quotas.max_simultaneous_sessions === 1 ? "session" : "sessions"}
                  {plan.entitlements.early_access ? " · Early Access" : ""}
                </div>
              </div>;
            })}
          </div>

          {planCatalog.length === 0 && <div style={{ padding: 18, border: "1px solid #232323", borderRadius: 12, color: "#555", fontSize: 11 }}>Loading plans…</div>}

          <div style={{ marginTop: 16, padding: "13px 15px", borderRadius: 11, border: "1px solid #242424", background: "#131313" }}>
            <div style={{ fontSize: 11, color: "#aaa", fontWeight: 600 }}>Free days</div>
            <div style={{ marginTop: 4, color: "#565656", fontSize: 9.5, lineHeight: 1.55 }}>New users receive 7 days of Paid Entry. Eligible codes can add temporary plan days to existing accounts. Code redemption is architecture-only for now.</div>
          </div>

          {accountMessage && <div style={{ marginTop: 12, color: "#83a783", fontSize: 10 }}>{accountMessage}</div>}
          {accountError && <div style={{ marginTop: 12, padding: 10, border: "1px solid #542020", background: "#241010", borderRadius: 8, color: "#e6a0a0", fontSize: 10 }}>{sanitizeUserVisibleText(accountError)}</div>}
        </>}

        {active === "preferences" && <>{title("Preferences", "Control how BeatGaler behaves on this device.")}{card(<><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0" }}><div><div style={{ fontSize: 13, color: "#bbb" }}>Incomplete file warnings</div><div style={{ fontSize: 10, color: "#555", marginTop: 3 }}>Warn when Samples or a project file is missing.</div></div>{switchButton(showIncompleteWarnings, toggleIncomplete)}</div><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 0 8px", borderTop: "1px solid #1c1c1c", marginTop: 8 }}><div><div style={{ fontSize: 13, color: "#bbb" }}>Custom cursor</div><div style={{ fontSize: 10, color: "#555", marginTop: 3 }}>Use the BeatGaler custom pointer.</div></div>{switchButton(customCursorEnabled, toggleCursor)}</div>{platform.capabilities.playbackCache && <div style={{ padding: "14px 0 4px", borderTop: "1px solid #1c1c1c", marginTop: 8 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}><div><div style={{ fontSize: 13, color: "#bbb" }}>Playback cache</div><div style={{ fontSize: 10, color: "#555", marginTop: 3, maxWidth: 380 }}>Keeps recently played MASTER MP3s on this device so repeat playback starts instantly. BeatGaler removes older cached audio automatically when the limit is reached.</div></div><select disabled={cacheBusy || !cacheStatus} value={[0,500,1024,2048,5120,10240].includes(cacheStatus?.limit_mb ?? -1) ? String(cacheStatus?.limit_mb ?? 2048) : "custom"} onChange={(e) => { if (e.target.value !== "custom") void updateCacheLimit(Number(e.target.value)); }} style={{ background: "#151515", color: "#bbb", border: "1px solid #2a2a2a", borderRadius: 7, padding: "7px 9px", minWidth: 110 }}><option value="0">Off</option><option value="500">500 MB</option><option value="1024">1 GB</option><option value="2048">2 GB</option><option value="5120">5 GB</option><option value="10240">10 GB</option><option value="custom">Custom…</option></select></div><div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, flexWrap: "wrap" }}><span style={{ fontSize: 10, color: "#666" }}>Used: {cacheStatus ? formatBytes(cacheStatus.used_bytes) : "…"}{cacheStatus && cacheStatus.limit_mb > 0 ? ` of ${cacheStatus.limit_mb >= 1024 ? `${(cacheStatus.limit_mb / 1024).toFixed(cacheStatus.limit_mb % 1024 === 0 ? 0 : 1)} GB` : `${cacheStatus.limit_mb} MB`}` : ""}</span><input type="number" min={0} max={51200} step={100} value={customCacheMb} onChange={(e) => setCustomCacheMb(e.target.value)} style={{ width: 90, background: "#111", color: "#aaa", border: "1px solid #272727", borderRadius: 6, padding: "6px 7px", fontSize: 10 }} /><span style={{ fontSize: 10, color: "#555" }}>MB</span><button disabled={cacheBusy || !customCacheMb} onClick={() => void updateCacheLimit(Number(customCacheMb))} style={{ ...buttonStyle, padding: "6px 9px", fontSize: 10 }}>Set</button><button disabled={cacheBusy || !cacheStatus || cacheStatus.used_bytes === 0} onClick={() => void clearCache()} style={{ ...buttonStyle, padding: "6px 9px", fontSize: 10 }}>Clear cache</button></div></div>}</>)}</>}

        {active === "trash" && platform.capabilities.trashLifecycle && <>
          {title("Trash", platform.capabilities.localHelper
            ? "Restore deleted beats and presets or remove them permanently."
            : "Restore deleted beats or remove them permanently.")}
          {card(<>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Beats</div>
            {loadingTrash ? <div style={{ color: "#555", fontSize: 11 }}>Loading…</div> : trashItems.length === 0
              ? <div style={{ color: "#444", fontSize: 11 }}>Trash is empty</div>
              : <>
                {trashItems.map(item => <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "1px solid #1b1b1b" }}>
                  <span style={{ color: "#aaa", fontSize: 11 }}>{item.beat_name || "Untitled beat"}</span>
                  <button disabled={restoringIds.has(item.id)} onClick={() => restore(item)} style={{ ...buttonStyle, padding: "6px 9px", fontSize: 10 }}>{restoringIds.has(item.id) ? "Restoring…" : "Restore"}</button>
                </div>)}
                <button disabled={purging || !props.networkOnline} title={!props.networkOnline ? "Internet connection required" : undefined} onClick={() => void emptyTrash()} style={{ ...buttonStyle, marginTop: 10, color: "#c77777", opacity: props.networkOnline ? 1 : 0.45, cursor: props.networkOnline ? "pointer" : "default" }}>{purging ? "Emptying…" : "Empty beat trash"}</button>
              </>}
            {trashMessage && <div style={{ marginTop: 8, color: "#777", fontSize: 10 }}>{trashMessage}</div>}
            {trashError && <div style={{ marginTop: 8, color: "#c77777", fontSize: 10 }}>{sanitizeUserVisibleText(trashError)}</div>}
          </>)}
          {platform.capabilities.localHelper && card(<>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Presets</div>
            {loadingPresetTrash ? <div style={{ color: "#555", fontSize: 11 }}>Loading…</div> : presetTrashItems.length === 0
              ? <div style={{ color: "#444", fontSize: 11 }}>Preset trash is empty</div>
              : <>
                {presetTrashItems.map(item => <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "1px solid #1b1b1b" }}>
                  <span style={{ color: "#aaa", fontSize: 11 }}>{item.preset_name}</span>
                  <button disabled={restoringPresetId === item.id} onClick={async () => { setRestoringPresetId(item.id); try { await platform.trash.restorePreset(item.id); setPresetTrashItems(x => x.filter(y => y.id !== item.id)); } finally { setRestoringPresetId(null); } }} style={{ ...buttonStyle, padding: "6px 9px", fontSize: 10 }}>Restore</button>
                </div>)}
                <button disabled={purgingPresets} onClick={() => void emptyPresetTrash()} style={{ ...buttonStyle, marginTop: 10, color: "#c77777" }}>{purgingPresets ? "Emptying…" : "Empty preset trash"}</button>
              </>}
          </>)}
        </>}

        {active === "privacy" && <>
          {title("Beat Galer Privacy Policy", `Last updated: ${LEGAL_UPDATED}`)}
          <div style={{ color: "#8a8a8a", fontSize: 12, lineHeight: 1.75, marginBottom: 18 }}>This Privacy Policy explains how Beat Galer ("we", "us", or "the App") collects, uses, stores, and protects information from people who use the Beat Galer desktop application and its associated cloud services (the "Service").<br/><br/>By using Beat Galer, you agree to the practices described in this policy. If you do not agree, please do not use the Service.</div>
          {renderLegalSections(PRIVACY_SECTIONS)}
        </>}

        {active === "terms" && <>
          {title("Beat Galer Terms of Service", `Last updated: ${LEGAL_UPDATED}`)}
          <div style={{ color: "#8a8a8a", fontSize: 12, lineHeight: 1.75, marginBottom: 18 }}>Welcome to Beat Galer. These Terms of Service ("Terms") govern your use of the Beat Galer desktop application and its associated cloud services (the "Service"), operated by [Developer or company name] ("we", "us", "our").<br/><br/>By downloading, installing, or using Beat Galer, you agree to these Terms. If you do not agree, do not use the Service.</div>
          {renderLegalSections(TERMS_SECTIONS)}
        </>}

        {active === "tools" && platform.capabilities.developerTools && <>
          {title("Tools", "Development, diagnostics, and application updates.")}

          {card(<>
            <div style={{ color: "#9b7f54", fontSize: 10, marginBottom: 12 }}>DEVELOPMENT ONLY</div>
            <button
              onClick={async () => {
                const dir = await platform.system.getLogDirectory();
                if (dir) await platform.system.revealPath(dir);
              }}
              style={{ ...buttonStyle, width: "100%" }}
            >
              Open log folder
            </button>
            <button
              onClick={async () => {
                const dir = await platform.system.getTemplatesDirectory();
                if (dir) await platform.system.revealPath(dir);
              }}
              style={{ ...buttonStyle, width: "100%", marginTop: 8 }}
            >
              Open templates folder
            </button>
          </>)}

          {card(<>
            <div style={{ fontSize: 13, color: "#eee", marginBottom: 6 }}>App updates</div>
            <div style={{ fontSize: 11, color: "#888", lineHeight: 1.5, marginBottom: 12 }}>
              Updates are verified before installation.
            </div>

            <button
              disabled={updateBusy}
              onClick={async () => {
                setUpdateBusy(true);
                setUpdateMessage(null);
                try {
                  const result = await platform.system.checkForUpdate();
                  if (!result?.available) {
                    setUpdateMessage("Beat Galer is up to date.");
                    return;
                  }
                  setUpdateMessage(
                    result.version
                      ? `Beat Galer ${result.version} is available.`
                      : "An update is available."
                  );
                } catch (error: any) {
                  setUpdateMessage(sanitizeUserVisibleText(String(error?.message || error), "Update operation failed."));
                } finally {
                  setUpdateBusy(false);
                }
              }}
              style={{ ...buttonStyle, width: "100%", opacity: updateBusy ? 0.6 : 1 }}
            >
              {updateBusy ? "Checking…" : "Check for updates"}
            </button>

            <button
              disabled={updateBusy}
              onClick={async () => {
                setUpdateBusy(true);
                setUpdateMessage("Installing update…");
                try {
                  await platform.system.installUpdate();
                  setUpdateMessage("Update installed. Restart Beat Galer to finish.");
                } catch (error: any) {
                  setUpdateMessage(sanitizeUserVisibleText(String(error?.message || error), "Update operation failed."));
                } finally {
                  setUpdateBusy(false);
                }
              }}
              style={{ ...buttonStyle, width: "100%", marginTop: 8, opacity: updateBusy ? 0.6 : 1 }}
            >
              Install update
            </button>

            {updateMessage && (
              <div style={{ marginTop: 10, fontSize: 11, color: "#aaa", lineHeight: 1.4 }}>
                {sanitizeUserVisibleText(updateMessage, "Update operation failed.")}
              </div>
            )}
          </>)}
        </>}
      </div>
    </main>
  </div>;
}
