import ReactDOM from "react-dom";
import type { Beat } from "../../../types";
import type { CloudFileRecord } from "../../../lib/tauri";

export type BeatDownloadKind = "MP3" | "WAV" | "PROJECT" | "ALL";

export default function CloudFilesModal({
  beat, files, busyId, downloadedIds, onDownload, onClose,
}: {
  beat: Beat;
  files: CloudFileRecord[];
  busyId: string | null;
  downloadedIds: Set<string>;
  onDownload: (kind: BeatDownloadKind) => void;
  onClose: () => void;
}) {
  // Available Offline is a complete local package, not just a playback hint.
  // Prefer the durable local paths when present so the Download UI keeps
  // working on a cold start with no Telegram connection at all.
  const hasMp3 = Boolean(beat.telegram_file_id) || Boolean(beat.offline_available && beat.mp3_path);
  const hasWav = Boolean(beat.offline_available && beat.wav_path) || files.some(file => file.file_type === "WAV");
  const hasProject = Boolean(beat.offline_available && (beat.flp_path || beat.als_path)) || files.some(file => file.file_type === "PROJECT");
  const availableCount = Number(hasMp3) + Number(hasWav) + Number(hasProject);

  const option = (
    kind: BeatDownloadKind,
    title: string,
    sub: string,
    available: boolean,
  ) => {
    const busy = busyId === kind;
    const downloaded = downloadedIds.has(kind);
    const disabled = !available || busyId !== null;
    return (
      <button
        key={kind}
        disabled={disabled}
        onClick={() => onDownload(kind)}
        style={{
width: "100%",
display: "grid",
gridTemplateColumns: "minmax(0,1fr) auto",
alignItems: "center",
gap: 18,
textAlign: "left",
border: "1px solid #282828",
borderRadius: 12,
padding: "15px 16px",
marginTop: 9,
background: available ? "#181818" : "#141414",
color: available ? "#f0f0f0" : "#555",
cursor: available && busyId === null ? "pointer" : "default",
opacity: available ? 1 : .62,
transition: "background 120ms ease, border-color 120ms ease, transform 120ms ease",
        }}
        onMouseEnter={e => {
if (!available || busyId !== null) return;
e.currentTarget.style.background = "#1d1d1d";
e.currentTarget.style.borderColor = "#383838";
        }}
        onMouseLeave={e => {
e.currentTarget.style.background = available ? "#181818" : "#141414";
e.currentTarget.style.borderColor = "#282828";
        }}
      >
        <div style={{ minWidth: 0 }}>
<div style={{ fontSize: 13, lineHeight: 1.2, fontWeight: 650, letterSpacing: "-.01em" }}>{title}</div>
<div style={{ fontSize: 10.5, lineHeight: 1.35, color: available ? "#777" : "#505050", marginTop: 4 }}>{sub}</div>
        </div>
        <div style={{
minWidth: 78,
textAlign: "right",
fontSize: 10.5,
fontWeight: 600,
color: busy ? "#d7d7d7" : downloaded ? "#55d878" : available ? "#9b9b9b" : "#555",
whiteSpace: "nowrap",
        }}>
{busy ? "Downloading..." : downloaded ? "Downloaded" : available ? "Download" : "Unavailable"}
        </div>
      </button>
    );
  };

  return ReactDOM.createPortal(
    <div
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 20060,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 18,
        background: "rgba(0,0,0,.76)",
        backdropFilter: "blur(8px)",
        fontFamily: "'DM Sans',sans-serif",
      }}
    >
      <div style={{
        width: 460,
        maxWidth: "100%",
        borderRadius: 16,
        background: "#111",
        border: "1px solid #292929",
        boxShadow: "0 24px 70px rgba(0,0,0,.48)",
        padding: "20px 20px 17px",
      }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 15 }}>
<div style={{ minWidth: 0 }}>
  <div style={{ fontSize: 16, lineHeight: 1.2, fontWeight: 700, color: "#f3f3f3", letterSpacing: "-.02em" }}>Download</div>
  <div style={{ color: "#727272", fontSize: 11, marginTop: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{beat.name}</div>
</div>
<button
  onClick={onClose}
  aria-label="Close download window"
  style={{
    border: 0,
    background: "transparent",
    color: "#8a8a8a",
    padding: "0 2px",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
  }}
>
  Close
</button>
        </div>

        <div style={{ borderTop: "1px solid #202020", paddingTop: 2 }}>
{option("MP3", "MP3", "Master audio", hasMp3)}
{option("WAV", "WAV", "Original high-quality audio", hasWav)}
{option("PROJECT", "Full Project", "Project archive with included audio and samples", hasProject)}
{option("ALL", "Download Everything", `${availableCount} available ${availableCount === 1 ? "asset" : "assets"} in a new folder`, availableCount > 0)}
        </div>

        <div style={{ color: "#555", fontSize: 9.5, lineHeight: 1.45, marginTop: 14, padding: "0 2px" }}>
Downloads are independent copies and are not used by Beat Galer for playback or synchronization.
        </div>
      </div>
    </div>, document.body
  );
}
