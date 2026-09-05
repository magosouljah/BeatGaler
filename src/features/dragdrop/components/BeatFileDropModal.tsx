import { useEffect } from "react";
import ReactDOM from "react-dom";
import type { Beat } from "../../../types";

export type DroppedBeatFileRole = "main" | "wav" | "projectFolder" | "loop" | "stems";

export default function BeatFileDropModal({
  beat,
  filePath,
  fileName,
  fileExtension,
  isDirectory,
  onChoose,
  onClose,
}: {
  beat: Beat;
  filePath: string;
  fileName: string;
  fileExtension: string;
  isDirectory: boolean;
  onChoose: (role: DroppedBeatFileRole) => void;
  onClose: () => void;
}) {
  const ext = fileExtension;
  const maybeFolder = isDirectory;
  const choices: Array<{ role: DroppedBeatFileRole; title: string; sub: string; disabled?: boolean }> = [
    { role: "main", title: "MASTER MP3", sub: "Replace the beat's MASTER with this MP3", disabled: ext !== "mp3" },
    { role: "wav", title: "WAV HQ", sub: "Add or replace the beat's high-quality WAV slot", disabled: ext !== "wav" },
    { role: "loop", title: "Loop · Coming soon", sub: "Loop storage will be enabled in a future BeatGaler update", disabled: true },
    { role: "projectFolder", title: "Add folder to Project", sub: "Keep this folder's name and place it inside PROJECT.zip", disabled: !maybeFolder },
    { role: "stems", title: "Stems · Coming soon", sub: "Dedicated Stems storage will be enabled in a future BeatGaler update", disabled: true },
  ];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return ReactDOM.createPortal(
    <div
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 20050, display: "flex",
        alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.72)", backdropFilter: "blur(7px)",
        fontFamily: "'DM Sans',sans-serif",
      }}
    >
      <div style={{
        width: 430, maxWidth: "calc(100vw - 32px)", borderRadius: 14,
        background: "#151515", border: "1px solid #2c2c2c",
        boxShadow: "0 24px 80px rgba(0,0,0,0.75)", padding: 18,
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: "#eee", marginBottom: 5 }}>
What are you adding?
        </div>
        <div style={{ color: "#777", fontSize: 12, marginBottom: 4 }}>{beat.name}</div>
        <div title={filePath} style={{ color: "#aaa", fontSize: 12, marginBottom: 16, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
{fileName}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
{choices.map(choice => (
  <button
    key={choice.role}
    disabled={choice.disabled}
    onClick={() => onChoose(choice.role)}
    style={{
      width: "100%", display: "flex", alignItems: "center", gap: 12,
      borderRadius: 10, border: "1px solid #292929", padding: "11px 12px", textAlign: "left",
      background: "#1b1b1b", color: choice.disabled ? "#444" : "#ddd",
      cursor: choice.disabled ? "default" : "pointer", opacity: choice.disabled ? 0.55 : 1,
    }}
  >
    <span>
      <span style={{ display: "block", fontSize: 13, fontWeight: 650 }}>{choice.title}</span>
      <span style={{ display: "block", marginTop: 2, color: choice.disabled ? "#3d3d3d" : "#777", fontSize: 11 }}>{choice.sub}</span>
    </span>
  </button>
))}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
<button onClick={onClose} style={{ border: 0, background: "transparent", color: "#777", padding: "7px 10px", cursor: "pointer", fontSize: 12 }}>
  Cancel
</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
