import React, { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  setBeatsFolder, listTrash, restoreBeatFromTrash, purgeTrashNow,
  getLogDir, getTemplatesDir, revealInExplorer, type TrashItem,
  listTemplateTrash, restoreTemplateFromTrash, purgeTemplateTrashNow, type TemplateTrashItem,
  setIncompleteWarningsEnabled, setCustomCursorEnabled,
} from "../lib/tauri";
import type { Beat } from "../types";
import { appAlert, appConfirm } from "../lib/dialog";

interface Props {
  currentFolder: string | null;
  showIncompleteWarnings: boolean;
  onIncompleteWarningsChanged: (enabled: boolean) => void;
  customCursorEnabled: boolean;
  onCustomCursorChanged: (enabled: boolean) => void;
  onClose: () => void;
  onFolderChanged: (folder: string) => void;
  // Optional — if provided, a restored beat is added straight into the
  // library grid instead of only showing up after the next "Reload Library".
  onBeatRestored?: (beat: Beat) => void;
}

export default function SettingsPanel({
  currentFolder,
  showIncompleteWarnings,
  onIncompleteWarningsChanged,
  customCursorEnabled,
  onCustomCursorChanged,
  onClose,
  onFolderChanged,
  onBeatRestored,
}: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingIncompleteWarnings, setSavingIncompleteWarnings] = useState(false);
  const [savingCustomCursor, setSavingCustomCursor] = useState(false);

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
    if (!(await appConfirm({
      title: "Empty beat trash?",
      message: `Permanently delete ${trashItems.length} item${trashItems.length === 1 ? "" : "s"} from the trash? This cannot be undone.`,
      confirmLabel: "Delete permanently",
      cancelLabel: "Cancel",
      danger: true,
    }))) return;
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
    if (!(await appConfirm({
      title: "Empty preset trash?",
      message: `Permanently delete ${presetTrashItems.length} preset${presetTrashItems.length === 1 ? "" : "s"} from the trash? This cannot be undone.`,
      confirmLabel: "Delete permanently",
      cancelLabel: "Cancel",
      danger: true,
    }))) return;
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
    if (savingIncompleteWarnings) return;
    const next = !showIncompleteWarnings;
    setSavingIncompleteWarnings(true);
    setError(null);
    try {
      await setIncompleteWarningsEnabled(next);
      onIncompleteWarningsChanged(next);
    } catch (e: any) {
      setError(String(e));
    } finally {
      setSavingIncompleteWarnings(false);
    }
  };

  const handleCustomCursorToggle = async () => {
    if (savingCustomCursor) return;
    const next = !customCursorEnabled;
    setSavingCustomCursor(true);
    setError(null);
    try {
      await setCustomCursorEnabled(next);
      onCustomCursorChanged(next);
    } catch (e: any) {
      setError(String(e));
    } finally {
      setSavingCustomCursor(false);
    }
  };

  const pickFolder = async () => {
    const sel = await open({ directory: true, multiple: false, title: "Choose BeatVault folder" });
    if (!sel || typeof sel !== "string") return;
    setSaving(true);
    setError(null);
    try {
      await setBeatsFolder(sel);
      onFolderChanged(sel);
    } catch (e: any) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div onClick={saving ? undefined : onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 300, backdropFilter: "blur(4px)" }} />
      <div style={{
        position: "fixed", right: 0, top: 0, bottom: 0, width: 320,
        background: "#0f0f0f", borderLeft: "1px solid #1a1a1a",
        zIndex: 310, display: "flex", flexDirection: "column",
        animation: "drawerIn 0.22s ease",
      }}>
        {saving && (
          <div style={{ position: "absolute", inset: 0, zIndex: 2, background: "rgba(8,8,8,0.84)", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12, backdropFilter: "blur(4px)" }}>
            <div style={{ fontSize: 13, color: "#9a9a9a", textAlign: "center", lineHeight: 1.6 }}>
              Moving your imported beats to the new folder…
            </div>
            <div style={{ display: "flex", justifyContent: "center", gap: 5 }}>
              {[0,1,2].map(i => <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "#4a4a4a", animation: `dot 1s ${i*0.2}s ease-in-out infinite alternate` }} />)}
            </div>
          </div>
        )}
        {/* Header */}
        <div style={{ padding: "18px 22px", borderBottom: "1px solid #1a1a1a", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 500, fontSize: 14, color: "#e0e0e0" }}>Settings</span>
          <button onClick={saving ? undefined : onClose} style={{ background: "none", border: "none", color: "#555", fontSize: 18, cursor: saving ? "default" : "pointer" }}>✕</button>
        </div>

        <div style={{ flex: 1, padding: 22, overflowY: "auto" }}>
          {/* Preferences */}
          <div style={{ marginBottom: 26 }}>
            <div style={{ fontSize: 11, color: "#555", letterSpacing: 0.8, marginBottom: 8, fontWeight: 600 }}>PREFERENCES</div>
            <div style={{
              padding: "13px 14px",
              background: "#121212",
              border: "1px solid #1f1f1f",
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: "#e1e1e1", fontWeight: 500 }}>Incomplete file warnings</div>
                <div style={{ fontSize: 10, color: "#555", marginTop: 5, lineHeight: 1.55 }}>
                  Show a yellow border and an info tooltip when a beat is missing a project file or Samples folder.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={showIncompleteWarnings}
                aria-label="Toggle incomplete file warnings"
                onClick={handleIncompleteWarningsToggle}
                disabled={savingIncompleteWarnings}
                style={{
                  width: 42,
                  height: 24,
                  borderRadius: 999,
                  padding: 2,
                  border: `1px solid ${showIncompleteWarnings ? "#6b5a2b" : "#333"}`,
                  background: showIncompleteWarnings ? "#3a3118" : "#191919",
                  cursor: savingIncompleteWarnings ? "wait" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: showIncompleteWarnings ? "flex-end" : "flex-start",
                  flexShrink: 0,
                  transition: "background 140ms ease, border-color 140ms ease",
                  opacity: savingIncompleteWarnings ? 0.65 : 1,
                }}
              >
                <span style={{
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: showIncompleteWarnings ? "#f5a623" : "#777",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
                  transition: "background 140ms ease",
                }} />
              </button>
            </div>

            <div style={{
              marginTop: 8,
              padding: "13px 14px",
              background: "#121212",
              border: "1px solid #1f1f1f",
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: "#e1e1e1", fontWeight: 500 }}>Custom cursor</div>
                <div style={{ fontSize: 10, color: "#555", marginTop: 5, lineHeight: 1.55 }}>
                  Use the custom Beat Galer pointer throughout the interface.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={customCursorEnabled}
                aria-label="Toggle custom cursor"
                onClick={handleCustomCursorToggle}
                disabled={savingCustomCursor}
                style={{
                  width: 42,
                  height: 24,
                  borderRadius: 999,
                  padding: 2,
                  border: `1px solid ${customCursorEnabled ? "#4b4b4b" : "#333"}`,
                  background: customCursorEnabled ? "#2a2a2a" : "#191919",
                  cursor: savingCustomCursor ? "wait" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: customCursorEnabled ? "flex-end" : "flex-start",
                  flexShrink: 0,
                  transition: "background 140ms ease, border-color 140ms ease",
                  opacity: savingCustomCursor ? 0.65 : 1,
                }}
              >
                <span style={{
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: customCursorEnabled ? "#e2e2e2" : "#777",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
                  transition: "background 140ms ease",
                }} />
              </button>
            </div>
          </div>

          {/* Beats folder */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 11, color: "#555", letterSpacing: 0.8, marginBottom: 8, fontWeight: 600 }}>BEATS FOLDER</div>
            <div style={{ fontSize: 11, color: "#444", marginBottom: 12, lineHeight: 1.7 }}>
              Imported beats are copied here. Changing this folder moves your existing library into the new location.
            </div>
            <div style={{
              padding: "11px 14px", background: "#131313", border: "1px solid #1e1e1e",
              borderRadius: 8, marginBottom: 10,
            }}>
              <div style={{ fontSize: 11, color: "#888", wordBreak: "break-all", lineHeight: 1.6 }}>
                {currentFolder || "Default (app data folder)"}
              </div>
            </div>
            <button
              onClick={pickFolder}
              disabled={saving}
              style={{
                width: "100%", padding: "9px 16px",
                background: "#1a1a1a", border: "1px solid #252525",
                borderRadius: 8, color: "#ccc", fontSize: 13, cursor: saving ? "not-allowed" : "pointer",
                transition: "background 0.15s",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "#212121")}
              onMouseLeave={e => (e.currentTarget.style.background = "#1a1a1a")}
            >
              {saving ? "Saving…" : "Change folder"}
            </button>
            {error && (
              <div style={{ marginTop: 10, padding: "10px 14px", background: "#3d0000", border: "1px solid #7f1d1d", borderRadius: 8, fontSize: 12, color: "#fca5a5" }}>
                {error}
              </div>
            )}
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