import React, { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { setBeatsFolder } from "../lib/tauri";

interface Props {
  currentFolder: string | null;
  onClose: () => void;
  onFolderChanged: (folder: string) => void;
}

export default function SettingsPanel({ currentFolder, onClose, onFolderChanged }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

          <div style={{ borderTop: "1px solid #141414", paddingTop: 20 }}>
            <div style={{ fontSize: 11, color: "#555", letterSpacing: 0.8, marginBottom: 8, fontWeight: 600 }}>VERSION</div>
            <div style={{ fontSize: 12, color: "#333" }}>BeatVault 0.1.0</div>
          </div>
        </div>
      </div>
    </>
  );
}
