import ReactDOM from "react-dom";
import type { TagRenameState } from "../useTagRename";

type Props = {
  rename: TagRenameState;
  busy: boolean;
  error: string | null;
  affectedCount: number;
  mp3Count: number;
  wavCount: number;
  onNewTagChange: (value: string) => void;
  onContinue: () => void;
  onBack: () => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export default function TagRenameDialog({
  rename, busy, error, affectedCount, mp3Count, wavCount,
  onNewTagChange, onContinue, onBack, onCancel, onConfirm,
}: Props) {
  const normalizedOld = rename.oldTag.trim().toLowerCase();
  const normalizedNew = rename.newTag.trim().toLowerCase();

  return ReactDOM.createPortal(
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 10020, background: "rgba(0,0,0,0.72)", backdropFilter: "blur(5px)" }} />
      <div style={{ position: "fixed", zIndex: 10021, width: 430, maxWidth: "calc(100vw - 32px)", left: "50%", top: "50%", transform: "translate(-50%,-50%)", background: "#121212", border: "1px solid #292929", borderRadius: 14, padding: 22, boxShadow: "0 28px 90px rgba(0,0,0,.8)" }}>
        <div style={{ fontSize: 16, color: "#eee", fontWeight: 600 }}>Rename tag globally</div>
        {rename.stage === "name" ? (
          <>
            <div style={{ marginTop: 8, fontSize: 12, color: "#777" }}>The original metadata order will be preserved; only the matching tag name changes.</div>
            <input autoFocus value={rename.newTag} onChange={event => onNewTagChange(event.target.value)}
              onKeyDown={event => { if (event.key === "Enter" && normalizedNew && normalizedNew !== normalizedOld) onContinue(); }}
              style={{ width: "100%", marginTop: 16, padding: "10px 12px", borderRadius: 8, border: "1px solid #333", background: "#191919", color: "#fff", outline: "none" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button onClick={onCancel} style={{ padding: "8px 13px", borderRadius: 7, border: "1px solid #333", background: "transparent", color: "#999", cursor: "pointer" }}>Cancel</button>
              <button disabled={!normalizedNew || normalizedNew === normalizedOld} onClick={onContinue} style={{ padding: "8px 13px", borderRadius: 7, border: 0, background: "#eee", color: "#111", cursor: "pointer" }}>Continue</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ marginTop: 14, padding: 14, borderRadius: 9, background: "#191919", color: "#aaa", fontSize: 12, lineHeight: 1.7 }}>
              <div><b style={{ color: "#ddd" }}>{normalizedOld}</b> → <b style={{ color: "#ddd" }}>{normalizedNew}</b></div>
              <div style={{ marginTop: 8 }}>This will rewrite metadata in:</div>
              <div> {affectedCount} beats</div><div> {mp3Count} MP3 files</div><div> {wavCount} WAV files</div>
              <div style={{ marginTop: 8, color: "#fbbf24" }}>Do not close Beat Galer while it is running. A recovery journal will roll back an interrupted operation on the next start.</div>
            </div>
            {error && <div style={{ marginTop: 10, color: "#f87171", fontSize: 11 }}>{error}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button disabled={busy} onClick={onBack} style={{ padding: "8px 13px", borderRadius: 7, border: "1px solid #333", background: "transparent", color: "#999", cursor: "pointer" }}>Back</button>
              <button disabled={busy || affectedCount === 0} onClick={onConfirm} style={{ padding: "8px 13px", borderRadius: 7, border: 0, background: "#ef4444", color: "#fff", cursor: "pointer" }}>{busy ? "Renaming…" : "Rename everywhere"}</button>
            </div>
          </>
        )}
      </div>
    </>, document.body
  );
}
