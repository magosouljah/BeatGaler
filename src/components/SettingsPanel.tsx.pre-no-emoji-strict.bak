import React, { useEffect, useState } from "react";
import {
  listTrash, restoreBeatFromTrash, purgeTrashNow,
  getLogDir, getTemplatesDir, revealInExplorer, type TrashItem,
  listTemplateTrash, restoreTemplateFromTrash, purgeTemplateTrashNow, type TemplateTrashItem,
  setIncompleteWarningsEnabled,
} from "../lib/tauri";
import type { Beat } from "../types";

interface Props {
  currentFolder: string | null;
  onClose: () => void;
  onFolderChanged: (folder: string) => void;
  showIncompleteWarnings: boolean;
  onIncompleteWarningsChanged: (enabled: boolean) => void;
  customCursorEnabled?: boolean;
  onCustomCursorChanged?: (enabled: boolean) => void;
  telegramConnected: boolean;
  telegramUsername: string | null;
  onConnectTelegram: () => Promise<void>;
  onDisconnectTelegram: () => Promise<void>;
  onBeatRestored?: (beat: Beat) => void;
}

export default function SettingsPanel({
  onClose, showIncompleteWarnings, onIncompleteWarningsChanged,
  telegramConnected, telegramUsername, onConnectTelegram, onDisconnectTelegram, onBeatRestored,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const [savingPreference, setSavingPreference] = useState(false);
  const [telegramBusy, setTelegramBusy] = useState(false);
  const [telegramError, setTelegramError] = useState<string | null>(null);

  const [trashItems, setTrashItems] = useState<TrashItem[]>([]);
  const [loadingTrash, setLoadingTrash] = useState(true);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);

  const [presetTrashItems, setPresetTrashItems] = useState<TemplateTrashItem[]>([]);
  const [loadingPresetTrash, setLoadingPresetTrash] = useState(true);
  const [restoringPresetId, setRestoringPresetId] = useState<string | null>(null);
  const [presetTrashError, setPresetTrashError] = useState<string | null>(null);
  const [purgingPresets, setPurgingPresets] = useState(false);

  useEffect(() => {
    listTrash().then(setTrashItems).catch(console.error).finally(() => setLoadingTrash(false));
    listTemplateTrash().then(setPresetTrashItems).catch(console.error).finally(() => setLoadingPresetTrash(false));
  }, []);

  const handleRestore = async (item: TrashItem) => {
    setRestoringId(item.id);
    setTrashError(null);
    try {
      const beat = await restoreBeatFromTrash(item.id);
      setTrashItems(items => items.filter(i => i.id !== item.id));
      onBeatRestored?.(beat);
    } catch (e: any) {
      setTrashError(String(e));
    } finally {
      setRestoringId(null);
    }
  };

  const handleEmptyTrash = async () => {
    if (trashItems.length === 0) return;
    if (!confirm(`Delete ${trashItems.length} item(s) from the trash permanently? This can't be undone.`)) return;
    setPurging(true);
    setTrashError(null);
    try {
      await purgeTrashNow();
      setTrashItems([]);
    } catch (e: any) {
      setTrashError(String(e));
    } finally {
      setPurging(false);
    }
  };

  const handleRestorePreset = async (item: TemplateTrashItem) => {
    setRestoringPresetId(item.id);
    setPresetTrashError(null);
    try {
      await restoreTemplateFromTrash(item.id);
      setPresetTrashItems(items => items.filter(i => i.id !== item.id));
    } catch (e: any) {
      setPresetTrashError(String(e));
    } finally {
      setRestoringPresetId(null);
    }
  };

  const handleEmptyPresetTrash = async () => {
    if (presetTrashItems.length === 0) return;
    if (!confirm(`Delete ${presetTrashItems.length} preset(s) from the trash permanently? This can't be undone.`)) return;
    setPurgingPresets(true);
    setPresetTrashError(null);
    try {
      await purgeTemplateTrashNow();
      setPresetTrashItems([]);
    } catch (e: any) {
      setPresetTrashError(String(e));
    } finally {
      setPurgingPresets(false);
    }
  };

  const handleOpenLogs = async () => {
    try {
      const dir = await getLogDir();
      if (dir) await revealInExplorer(dir);
    } catch (e) {
      console.error(e);
    }
  };

  const handleOpenTemplates = async () => {
    try {
      const dir = await getTemplatesDir();
      if (dir) await revealInExplorer(dir);
    } catch (e) {
      console.error(e);
    }
  };

  const timeAgo = (unixSeconds: number) => {
    const diffMs = Date.now() - unixSeconds * 1000;
    const days = Math.floor(diffMs / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "1 day ago";
    return `${days} days ago`;
  };


  const handleIncompleteWarningsToggle = async () => {
    const next = !showIncompleteWarnings;
    onIncompleteWarningsChanged(next); // optimistic UI
    setSavingPreference(true);
    try {
      await setIncompleteWarningsEnabled(next);
    } catch (e: any) {
      onIncompleteWarningsChanged(!next);
      setError(String(e));
    } finally {
      setSavingPreference(false);
    }
  };

  const handleTelegramConnect = async () => {
    if (telegramBusy) return;
    setTelegramBusy(true); setTelegramError(null);
    try { await onConnectTelegram(); } catch (e: any) { setTelegramError(String(e)); } finally { setTelegramBusy(false); }
  };

  const handleTelegramDisconnect = async () => {
    if (telegramBusy) return;
    setTelegramBusy(true); setTelegramError(null);
    try { await onDisconnectTelegram(); } catch (e: any) { setTelegramError(String(e)); } finally { setTelegramBusy(false); }
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 300, backdropFilter: "blur(4px)" }} />
      <div style={{
        position: "fixed", right: 0, top: 0, bottom: 0, width: 320,
        background: "#0f0f0f", borderLeft: "1px solid #1a1a1a",
        zIndex: 310, display: "flex", flexDirection: "column",
        animation: "drawerIn 0.22s ease",
      }}>
        {/* Header */}
        <div style={{ padding: "18px 22px", borderBottom: "1px solid #1a1a1a", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 500, fontSize: 14, color: "#e0e0e0" }}>Settings</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#555", fontSize: 18, cursor: "pointer" }}>✕</button>
        </div>

        <div style={{ flex: 1, padding: 22, overflowY: "auto" }}>
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 11, color: "#555", letterSpacing: 0.8, marginBottom: 10, fontWeight: 600 }}>TELEGRAM VAULT</div>
            <div style={{ padding: "14px", background: "#131313", border: "1px solid #1e1e1e", borderRadius: 9 }}>
              <div style={{ fontSize: 12, color: telegramConnected ? "#4ade80" : "#aaa", fontWeight: 600 }}>{telegramConnected ? "● Connected" : "Not connected"}</div>
              <div style={{ fontSize: 10.5, color: "#555", marginTop: 5, lineHeight: 1.55 }}>Each Telegram account has its own independent BeatGaler vault. No connection means no beats are loaded.</div>
              {telegramConnected && <div style={{ marginTop: 8, fontSize: 11, color: "#888" }}>Account: {telegramUsername ? `@${telegramUsername.replace(/^@/, "")}` : "Telegram account"}</div>}
              <button onClick={() => void (telegramConnected ? handleTelegramDisconnect() : handleTelegramConnect())} disabled={telegramBusy}
                style={{ width: "100%", marginTop: 12, padding: "9px 12px", borderRadius: 8, border: `1px solid ${telegramConnected ? "#3a2020" : "#26384a"}`, background: telegramConnected ? "#211515" : "#14202b", color: telegramConnected ? "#f87171" : "#7dd3fc", fontSize: 12, cursor: telegramBusy ? "default" : "pointer", opacity: telegramBusy ? 0.6 : 1 }}>
                {telegramBusy ? "Working…" : telegramConnected ? "Disconnect Telegram" : "Connect Telegram"}
              </button>
              {telegramError && <div style={{ marginTop: 8, color: "#f87171", fontSize: 10 }}>{telegramError}</div>}
            </div>
          </div>

          {/* Preferences */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 11, color: "#555", letterSpacing: 0.8, marginBottom: 10, fontWeight: 600 }}>PREFERENCES</div>
            <div style={{
              padding: "12px 14px", background: "#131313", border: "1px solid #1e1e1e",
              borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14,
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: "#d0d0d0", fontWeight: 500 }}>Incomplete file warnings</div>
                <div style={{ fontSize: 10.5, color: "#555", marginTop: 4, lineHeight: 1.55 }}>
                  Show a yellow border and an info tooltip when a beat is missing a project file or stems / samples.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={showIncompleteWarnings}
                disabled={savingPreference}
                onClick={handleIncompleteWarningsToggle}
                style={{
                  position: "relative", width: 42, height: 24, borderRadius: 999, flexShrink: 0,
                  border: `1px solid ${showIncompleteWarnings ? "#8b651f" : "#303030"}`,
                  background: showIncompleteWarnings ? "rgba(245,158,11,0.28)" : "#1b1b1b",
                  cursor: savingPreference ? "default" : "pointer", padding: 0,
                  opacity: savingPreference ? 0.65 : 1, transition: "all 0.16s ease",
                }}
              >
                <span style={{
                  position: "absolute", top: 3, left: showIncompleteWarnings ? 20 : 3,
                  width: 16, height: 16, borderRadius: "50%",
                  background: showIncompleteWarnings ? "#f5a623" : "#666",
                  transition: "left 0.16s ease", boxShadow: "0 1px 4px rgba(0,0,0,0.45)",
                }} />
              </button>
            </div>
          </div>

          <div style={{ borderTop: "1px solid #141414", paddingTop: 20, marginBottom: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: "#555", letterSpacing: 0.8, fontWeight: 600 }}>TRASH</div>
              {trashItems.length > 0 && (
                <button onClick={handleEmptyTrash} disabled={purging}
                  style={{ background: "none", border: "none", color: purging ? "#3a3a3a" : "#f87171", fontSize: 11, cursor: purging ? "default" : "pointer" }}>
                  {purging ? "Emptying…" : "Empty trash"}
                </button>
              )}
            </div>
            <div style={{ fontSize: 11, color: "#444", marginBottom: 12, lineHeight: 1.7 }}>
              Deleted beats stay here for 14 days before being removed automatically.
            </div>

            {loadingTrash ? (
              <div style={{ fontSize: 12, color: "#444" }}>Loading…</div>
            ) : trashItems.length === 0 ? (
              <div style={{ fontSize: 12, color: "#3a3a3a", padding: "10px 0" }}>Trash is empty</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {trashItems.map(item => (
                  <div key={item.id} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                    padding: "9px 12px", background: "#131313", border: "1px solid #1e1e1e", borderRadius: 8,
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: "#ccc", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.beat_name || "Untitled beat"}
                      </div>
                      <div style={{ fontSize: 10, color: "#444", marginTop: 2 }}>{timeAgo(item.trashed_at)}</div>
                    </div>
                    <button onClick={() => handleRestore(item)} disabled={restoringId === item.id}
                      style={{
                        flexShrink: 0, padding: "5px 10px", background: "#1a1a1a", border: "1px solid #262626",
                        borderRadius: 6, color: restoringId === item.id ? "#444" : "#ccc", fontSize: 11,
                        cursor: restoringId === item.id ? "default" : "pointer",
                      }}>
                      {restoringId === item.id ? "Restoring…" : "Restore"}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {trashError && (
              <div style={{ marginTop: 10, padding: "10px 14px", background: "#3d0000", border: "1px solid #7f1d1d", borderRadius: 8, fontSize: 12, color: "#fca5a5" }}>
                {trashError}
              </div>
            )}
          </div>

          <div style={{ borderTop: "1px solid #141414", paddingTop: 20, marginBottom: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: "#555", letterSpacing: 0.8, fontWeight: 600 }}>PRESET TRASH</div>
              {presetTrashItems.length > 0 && (
                <button onClick={handleEmptyPresetTrash} disabled={purgingPresets}
                  style={{ background: "none", border: "none", color: purgingPresets ? "#3a3a3a" : "#f87171", fontSize: 11, cursor: purgingPresets ? "default" : "pointer" }}>
                  {purgingPresets ? "Emptying…" : "Empty trash"}
                </button>
              )}
            </div>
            <div style={{ fontSize: 11, color: "#444", marginBottom: 12, lineHeight: 1.7 }}>
              Deleted upload presets stay here for 14 days before being removed automatically.
            </div>

            {loadingPresetTrash ? (
              <div style={{ fontSize: 12, color: "#444" }}>Loading…</div>
            ) : presetTrashItems.length === 0 ? (
              <div style={{ fontSize: 12, color: "#3a3a3a", padding: "10px 0" }}>Trash is empty</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {presetTrashItems.map(item => (
                  <div key={item.id} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                    padding: "9px 12px", background: "#131313", border: "1px solid #1e1e1e", borderRadius: 8,
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: "#ccc", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.preset_name || "Untitled preset"}
                      </div>
                      <div style={{ fontSize: 10, color: "#444", marginTop: 2 }}>{timeAgo(item.trashed_at)}</div>
                    </div>
                    <button onClick={() => handleRestorePreset(item)} disabled={restoringPresetId === item.id}
                      style={{
                        flexShrink: 0, padding: "5px 10px", background: "#1a1a1a", border: "1px solid #262626",
                        borderRadius: 6, color: restoringPresetId === item.id ? "#444" : "#ccc", fontSize: 11,
                        cursor: restoringPresetId === item.id ? "default" : "pointer",
                      }}>
                      {restoringPresetId === item.id ? "Restoring…" : "Restore"}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {presetTrashError && (
              <div style={{ marginTop: 10, padding: "10px 14px", background: "#3d0000", border: "1px solid #7f1d1d", borderRadius: 8, fontSize: 12, color: "#fca5a5" }}>
                {presetTrashError}
              </div>
            )}
          </div>

          <div style={{ borderTop: "1px solid #141414", paddingTop: 20, marginBottom: 24 }}>
            <div style={{ fontSize: 11, color: "#555", letterSpacing: 0.8, marginBottom: 8, fontWeight: 600 }}>LOGS</div>
            <div style={{ fontSize: 11, color: "#444", marginBottom: 12, lineHeight: 1.7 }}>
              If something breaks, this is what to send along with the report.
            </div>
            <button
              onClick={handleOpenLogs}
              style={{
                width: "100%", padding: "9px 16px",
                background: "#1a1a1a", border: "1px solid #252525",
                borderRadius: 8, color: "#ccc", fontSize: 13, cursor: "pointer",
                transition: "background 0.15s",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "#212121")}
              onMouseLeave={e => (e.currentTarget.style.background = "#1a1a1a")}
            >
              Open log folder
            </button>
          </div>

          <div style={{ borderTop: "1px solid #141414", paddingTop: 20, marginBottom: 24 }}>
            <div style={{ fontSize: 11, color: "#555", letterSpacing: 0.8, marginBottom: 8, fontWeight: 600 }}>UPLOAD PRESETS</div>
            <div style={{ fontSize: 11, color: "#444", marginBottom: 12, lineHeight: 1.7 }}>
              Saved title/description/tags presets from the Upload modal live here as .txt files.
            </div>
            <button
              onClick={handleOpenTemplates}
              style={{
                width: "100%", padding: "9px 16px",
                background: "#1a1a1a", border: "1px solid #252525",
                borderRadius: 8, color: "#ccc", fontSize: 13, cursor: "pointer",
                transition: "background 0.15s",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "#212121")}
              onMouseLeave={e => (e.currentTarget.style.background = "#1a1a1a")}
            >
              Open templates folder
            </button>
          </div>

          <div style={{ borderTop: "1px solid #141414", paddingTop: 20 }}>
            <div style={{ fontSize: 11, color: "#555", letterSpacing: 0.8, marginBottom: 8, fontWeight: 600 }}>VERSION</div>
            <div style={{ fontSize: 12, color: "#333" }}>BeatVault 0.1.0</div>
          </div>
        </div>
      </div>
    </>
  );
}