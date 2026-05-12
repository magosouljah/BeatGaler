import React, { useState, useEffect } from "react";
import { setBeatsFolder, pickAndScanFolder } from "../lib/tauri";
import type { Beat } from "../types";

interface Props {
  onDone: (folder: string, beats?: Beat[]) => void;
}

export default function SetupModal({ onDone }: Props) {
  const [folder, setFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [isDevMode, setIsDevMode] = useState(false);
  const [manualPath, setManualPath] = useState("");

  useEffect(() => {
    // Check if running in dev mode (no Tauri)
    const inDev = !(window as any).__TAURI_INTERNALS__;
    setIsDevMode(inDev);
    if (inDev) {
      // Pre-fill with dev beats folder path in dev mode
      setManualPath("E:\\777\\app\\beatvault\\dev-beats");
    }
  }, []);

  const pickFolder = async () => {
    if (isDevMode) {
      // In dev mode, use manual path input
      if (manualPath.trim()) {
        setFolder(manualPath.trim());
      }
    } else {
      // In Tauri mode, use native dialog (will work via tauri.ts wrapper)
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const sel = await open({ directory: true, multiple: false, title: "Choose your BeatVault folder" });
        if (sel && typeof sel === "string") setFolder(sel);
      } catch (e) {
        setError("Could not open file dialog: " + String(e));
      }
    }
  };

  const handleConfirm = async () => {
    if (!folder) return;
    setSaving(true);
    setError(null);
    try {
      await setBeatsFolder(folder);
      
      // In dev mode, also load the beats
      if (isDevMode) {
        const beats = await pickAndScanFolder();
        onDone(folder, beats);
      } else {
        onDone(folder);
      }
    } catch (e: any) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)", zIndex: 500, backdropFilter: "blur(10px)" }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        width: 400, background: "#0f0f0f", border: "1px solid #1e1e1e",
        borderRadius: 16, zIndex: 510, padding: "36px 32px",
        boxShadow: "0 32px 80px rgba(0,0,0,0.95)",
        animation: "fadeUp 0.3s cubic-bezier(0.22,1,0.36,1) both",
      }}>
        {saving && (
          <div style={{ position: "absolute", inset: 0, zIndex: 2, background: "rgba(8,8,8,0.82)", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12, borderRadius: 16, backdropFilter: "blur(4px)" }}>
            <div style={{ fontSize: 13, color: "#9a9a9a", textAlign: "center", lineHeight: 1.6 }}>
              {isDevMode ? "Loading dev beats…" : "Preparing your BeatVault folder…"}
            </div>
            <div style={{ display: "flex", justifyContent: "center", gap: 5 }}>
              {[0,1,2].map(i => <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "#4a4a4a", animation: `dot 1s ${i*0.2}s ease-in-out infinite alternate` }} />)}
            </div>
          </div>
        )}
        <div style={{ fontSize: 22, fontWeight: 600, color: "#e8e8e8", marginBottom: 8, letterSpacing: -0.3 }}>
          Welcome to BeatVault
        </div>
        <div style={{ fontSize: 13, color: "#4a4a4a", marginBottom: 28, lineHeight: 1.7 }}>
          {isDevMode ? (
            <>
              <strong>Dev Mode:</strong> Paste your beats folder path below or use the default dev folder.<br />
              Default: <code>E:\777\app\beatvault\dev-beats</code>
            </>
          ) : (
            <>Choose a folder where your beats will be stored.<br />
            Every imported beat gets copied there automatically.</>
          )}
        </div>

        {isDevMode ? (
          <>
            <input
              type="text"
              value={manualPath}
              onChange={e => setManualPath(e.target.value)}
              placeholder="Paste beats folder path..."
              style={{
                width: "100%", padding: "12px 14px", background: "#131313", border: "1px solid #222",
                borderRadius: 8, color: "#bbb", fontSize: 12, marginBottom: 12,
                boxSizing: "border-box", fontFamily: "monospace",
              }}
            />
            <button
              onClick={() => setFolder(manualPath.trim())}
              disabled={!manualPath.trim()}
              style={{
                width: "100%", padding: "10px", border: "none", borderRadius: 8,
                background: manualPath.trim() ? "#333" : "#1a1a1a",
                color: manualPath.trim() ? "#fff" : "#666",
                fontWeight: 500, fontSize: 12, cursor: manualPath.trim() ? "pointer" : "not-allowed",
                marginBottom: 16, transition: "background 0.15s",
              }}
            >
              Use this folder
            </button>
          </>
        ) : (
          <div
            onClick={pickFolder}
            style={{
              padding: "14px 16px", background: "#131313", border: "1px solid #222",
              borderRadius: 10, cursor: "pointer", marginBottom: 16,
              transition: "border-color 0.15s",
            }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = "#333")}
            onMouseLeave={e => (e.currentTarget.style.borderColor = "#222")}
          >
            {folder
              ? <div style={{ fontSize: 12, color: "#bbb", wordBreak: "break-all", lineHeight: 1.5 }}>{folder}</div>
              : <div style={{ fontSize: 13, color: "#383838" }}>Click to choose folder…</div>
            }
          </div>
        )}

        {folder && !isDevMode && (
          <div style={{ padding: "10px 14px", background: "#1a3a1a", border: "1px solid #2d5a2d", borderRadius: 8, fontSize: 12, color: "#a6e3a1", marginBottom: 14 }}>
            Selected: {folder}
          </div>
        )}

        {folder && isDevMode && (
          <div style={{ padding: "10px 14px", background: "#1a3a1a", border: "1px solid #2d5a2d", borderRadius: 8, fontSize: 12, color: "#a6e3a1", marginBottom: 14 }}>
            ✓ Ready: {folder}
          </div>
        )}

        {error && (
          <div style={{ padding: "10px 14px", background: "#3d0000", border: "1px solid #7f1d1d", borderRadius: 8, fontSize: 12, color: "#fca5a5", marginBottom: 14 }}>
            {error}
          </div>
        )}

        <button
          onClick={handleConfirm}
          disabled={!folder || saving}
          style={{
            width: "100%", padding: "12px", border: "none", borderRadius: 9,
            background: folder && !saving ? "#fff" : "#1a1a1a",
            color: folder && !saving ? "#000" : "#333",
            fontWeight: 500, fontSize: 14,
            cursor: folder && !saving ? "pointer" : "not-allowed",
            transition: "background 0.15s, color 0.15s",
          }}
        >
          {saving ? "Setting up…" : "Get started"}
        </button>
      </div>
    </>
  );
}
