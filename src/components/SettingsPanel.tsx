import React, { useEffect, useState } from "react";
import {
  listTrash, restoreBeatFromTrash, purgeTrashNow,
  getLogDir, getTemplatesDir, revealInExplorer, type TrashItem,
  listTemplateTrash, restoreTemplateFromTrash, purgeTemplateTrashNow, type TemplateTrashItem,
  setIncompleteWarningsEnabled, setCustomCursorEnabled,
} from "../lib/tauri";
import type { Beat } from "../types";

interface Props {
  currentFolder: string | null;
  showIncompleteWarnings: boolean;
  onIncompleteWarningsChanged: (enabled: boolean) => void;
  customCursorEnabled: boolean;
  onCustomCursorChanged: (enabled: boolean) => void;
  telegramConnected: boolean;
  telegramUsername: string | null;
  onConnectTelegram: () => Promise<void>;
  onDisconnectTelegram: () => Promise<void>;
  onClose: () => void;
  onFolderChanged: (folder: string) => void;
  onBeatRestored?: (beat: Beat) => void;
}

export default function SettingsPanel(props: Props) {
  const {
    showIncompleteWarnings, onIncompleteWarningsChanged,
    customCursorEnabled, onCustomCursorChanged, telegramConnected, telegramUsername,
    onDisconnectTelegram, onClose, onFolderChanged, onBeatRestored,
  } = props;

  const [saving, setSaving] = useState(false);
  const [preferenceBusy, setPreferenceBusy] = useState(false);
  const [trashItems, setTrashItems] = useState<TrashItem[]>([]);
  const [loadingTrash, setLoadingTrash] = useState(true);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);
  const [presetTrashItems, setPresetTrashItems] = useState<TemplateTrashItem[]>([]);
  const [loadingPresetTrash, setLoadingPresetTrash] = useState(true);
  const [restoringPresetId, setRestoringPresetId] = useState<string | null>(null);
  const [purgingPresets, setPurgingPresets] = useState(false);

  useEffect(() => {
    listTrash().then(setTrashItems).catch(console.error).finally(() => setLoadingTrash(false));
    listTemplateTrash().then(setPresetTrashItems).catch(console.error).finally(() => setLoadingPresetTrash(false));
  }, []);

  const toggleIncomplete = async () => {
    const next = !showIncompleteWarnings;
    setPreferenceBusy(true);
    try { await setIncompleteWarningsEnabled(next); onIncompleteWarningsChanged(next); }
    finally { setPreferenceBusy(false); }
  };

  const toggleCursor = async () => {
    const next = !customCursorEnabled;
    setPreferenceBusy(true);
    try { await setCustomCursorEnabled(next); onCustomCursorChanged(next); }
    finally { setPreferenceBusy(false); }
  };

  const restore = async (item: TrashItem) => {
    setRestoringId(item.id); setTrashError(null);
    try {
      const beat = await restoreBeatFromTrash(item.id);
      setTrashItems(items => items.filter(x => x.id !== item.id));
      onBeatRestored?.(beat);
    } catch (e: any) { setTrashError(String(e?.message || e)); }
    finally { setRestoringId(null); }
  };

  const emptyTrash = async () => {
    if (!trashItems.length || !confirm(`Delete ${trashItems.length} item(s) permanently? This can't be undone.`)) return;
    setPurging(true);
    try { await purgeTrashNow(); setTrashItems([]); }
    catch (e: any) { setTrashError(String(e?.message || e)); }
    finally { setPurging(false); }
  };

  const emptyPresetTrash = async () => {
    if (!presetTrashItems.length || !confirm(`Delete ${presetTrashItems.length} preset(s) permanently? This can't be undone.`)) return;
    setPurgingPresets(true);
    try { await purgeTemplateTrashNow(); setPresetTrashItems([]); }
    finally { setPurgingPresets(false); }
  };

  const section = (title: string, children: React.ReactNode) => (
    <div style={{ borderTop: "1px solid #171717", paddingTop: 19, marginBottom: 22 }}>
      <div style={{ fontSize: 10, color: "#555", letterSpacing: 1, marginBottom: 9, fontWeight: 650 }}>{title}</div>
      {children}
    </div>
  );

  const switchButton = (enabled: boolean, onClick: () => void) => (
    <button disabled={preferenceBusy} onClick={onClick} style={{
      width: 38, height: 21, padding: 2, borderRadius: 20, border: "1px solid #303030",
      background: enabled ? "#ddd" : "#1b1b1b", cursor: preferenceBusy ? "default" : "pointer",
    }}>
      <span style={{ display: "block", width: 15, height: 15, borderRadius: "50%", background: enabled ? "#111" : "#666", transform: enabled ? "translateX(16px)" : "translateX(0)", transition: "transform .15s" }} />
    </button>
  );

  return <>
    <div onClick={saving ? undefined : onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 300, backdropFilter: "blur(4px)" }} />
    <div style={{ position: "fixed", right: 0, top: 0, bottom: 0, width: 340, zIndex: 310, background: "#0f0f0f", borderLeft: "1px solid #1b1b1b", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "18px 22px", borderBottom: "1px solid #1a1a1a", display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 14, color: "#ddd" }}>Settings</span>
        <button onClick={onClose} style={{ border: 0, background: "transparent", color: "#666", cursor: "pointer", fontSize: 17 }}>×</button>
      </div>

      <div style={{ padding: 22, overflowY: "auto", flex: 1 }}>
        <div style={{ marginBottom: 22 }}>
          <div style={{ fontSize: 10, color: "#555", letterSpacing: 1, marginBottom: 9, fontWeight: 650 }}>BEATGALER ACCOUNT</div>
          <div style={{ padding: 12, border: "1px solid #202020", borderRadius: 9, background: "#141414" }}>
            <div style={{ fontSize: 12, color: telegramConnected ? "#ddd" : "#777" }}>
              {telegramConnected ? `@${telegramUsername || "user"}` : "Account session unavailable"}
            </div>
            <div style={{ marginTop: 5, fontSize: 10, color: "#555", lineHeight: 1.5 }}>
              Telegram storage is private and managed by BeatGaler. Your account has no access to the storage group.
            </div>
          </div>
          <button onClick={() => void onDisconnectTelegram()} style={{ width: "100%", marginTop: 9, padding: 9, borderRadius: 8, border: "1px solid #2a2a2a", background: "#181818", color: "#aaa", cursor: "pointer" }}>Sign out</button>
        </div>

        {section("PREFERENCES", <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0" }}>
            <div><div style={{ fontSize: 12, color: "#bbb" }}>Incomplete file warnings</div><div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>Warn when Samples or a project file is missing.</div></div>
            {switchButton(showIncompleteWarnings, toggleIncomplete)}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0" }}>
            <div><div style={{ fontSize: 12, color: "#bbb" }}>Custom cursor</div><div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>Use the BeatGaler custom pointer.</div></div>
            {switchButton(customCursorEnabled, toggleCursor)}
          </div>
        </>)}

        {section("TRASH", <>
          <div style={{ fontSize: 10, color: "#555", marginBottom: 8 }}>Deleted beats stay here until permanent purge.</div>
          {loadingTrash ? <div style={{ color: "#555", fontSize: 11 }}>Loading…</div> :
            trashItems.length === 0 ? <div style={{ color: "#444", fontSize: 11 }}>Trash is empty</div> :
            <>
              {trashItems.map(item => <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #171717" }}>
                <span style={{ color: "#aaa", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>{item.beat_name || "Untitled beat"}</span>
                <button disabled={restoringId === item.id} onClick={() => void restore(item)} style={{ border: 0, background: "transparent", color: "#999", cursor: "pointer", fontSize: 10 }}>{restoringId === item.id ? "Restoring…" : "Restore"}</button>
              </div>)}
              <button disabled={purging} onClick={() => void emptyTrash()} style={{ marginTop: 9, border: 0, background: "transparent", color: "#c77777", cursor: "pointer", fontSize: 10 }}>{purging ? "Emptying…" : "Empty trash"}</button>
            </>}
          {trashError && <div style={{ marginTop: 7, color: "#c77777", fontSize: 10 }}>{trashError}</div>}
        </>)}

        {section("PRESET TRASH", <>
          {loadingPresetTrash ? <div style={{ color: "#555", fontSize: 11 }}>Loading…</div> :
            presetTrashItems.length === 0 ? <div style={{ color: "#444", fontSize: 11 }}>Preset trash is empty</div> :
            <>
              {presetTrashItems.map(item => <div key={item.id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #171717" }}>
                <span style={{ fontSize: 11, color: "#aaa" }}>{item.preset_name}</span>
                <button disabled={restoringPresetId === item.id} onClick={async () => { setRestoringPresetId(item.id); try { await restoreTemplateFromTrash(item.id); setPresetTrashItems(x => x.filter(y => y.id !== item.id)); } finally { setRestoringPresetId(null); } }} style={{ border: 0, background: "transparent", color: "#999", fontSize: 10, cursor: "pointer" }}>Restore</button>
              </div>)}
              <button disabled={purgingPresets} onClick={() => void emptyPresetTrash()} style={{ marginTop: 9, border: 0, background: "transparent", color: "#c77777", cursor: "pointer", fontSize: 10 }}>{purgingPresets ? "Emptying…" : "Empty trash"}</button>
            </>}
        </>)}

        {section("TOOLS", <>
          <button onClick={async () => { const dir = await getLogDir(); if (dir) await revealInExplorer(dir); }} style={{ width: "100%", padding: 9, borderRadius: 8, border: "1px solid #252525", background: "#1a1a1a", color: "#aaa", cursor: "pointer" }}>Open log folder</button>
          <button onClick={async () => { const dir = await getTemplatesDir(); if (dir) await revealInExplorer(dir); }} style={{ width: "100%", marginTop: 7, padding: 9, borderRadius: 8, border: "1px solid #252525", background: "#1a1a1a", color: "#aaa", cursor: "pointer" }}>Open templates folder</button>
        </>)}

        <div style={{ borderTop: "1px solid #171717", paddingTop: 18, color: "#444", fontSize: 10 }}>BeatGaler 0.2.0</div>
      </div>
    </div>
  </>;
}
