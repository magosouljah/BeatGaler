import React, { useMemo, useState } from "react";
import type { Beat } from "../types";
import type { ImportAudioConflict } from "../lib/tauri";
import { resolveImportAudioConflict } from "../lib/tauri";

interface Props {
  batchId: string;
  conflicts: ImportAudioConflict[];
  onResolved: (beats: Beat[]) => void;
  onCancel: () => void;
}

function basename(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function conflictLabel(conflict: ImportAudioConflict) {
  if (conflict.kind === "hq_wav") return "Choose the HQ WAV";
  return "Choose the main audio";
}

export default function ImportAudioConflictsModal({ batchId, conflicts, onResolved, onCancel }: Props) {
  const initial = useMemo(() => {
    const out: Record<string, string> = {};
    for (const conflict of conflicts) out[conflict.core_name] = "";
    return out;
  }, [conflicts]);
  const [choices, setChoices] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = conflicts.every(conflict => Boolean(choices[conflict.core_name]));

  const confirm = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const beats: Beat[] = [];
      // Resolve in UI order and one at a time. Conflict work is intentionally
      // behind the normal fast path, so it never steals I/O from Review Beat 1.
      for (const conflict of conflicts) {
        const choice = choices[conflict.core_name];
        if (choice === "__skip__") continue;
        beats.push(await resolveImportAudioConflict(
          batchId,
          conflict.core_name,
          choice,
        ));
      }
      onResolved(beats);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.62)", zIndex: 310, backdropFilter: "blur(4px)" }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        zIndex: 311, width: "min(650px,92vw)", maxHeight: "86vh", overflowY: "auto",
        background: "#0f0f0f", border: "1px solid #202020", borderRadius: 14,
        boxShadow: "0 20px 70px rgba(0,0,0,.7)", fontFamily: "'DM Sans',sans-serif",
      }}>
        <div style={{ padding: "18px 22px", borderBottom: "1px solid #1a1a1a", display: "flex", alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: "#e5e5e5", fontSize: 14, fontWeight: 500 }}>Resolve audio conflicts</div>
            <div style={{ color: "#666", fontSize: 11, marginTop: 4 }}>Normal beats were kept fast. These ambiguous beats were moved to the end.</div>
          </div>
          <button disabled={busy} onClick={onCancel} style={{ background: "none", border: 0, color: "#777", fontSize: 12, cursor: busy ? "default" : "pointer" }}>Cancel import</button>
        </div>

        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
          {conflicts.map(conflict => (
            <div key={conflict.core_name} style={{ padding: 15, borderRadius: 10, border: "1px solid #202020", background: "#141414" }}>
              <div style={{ color: "#ddd", fontSize: 13, fontWeight: 500 }}>{conflict.display_name}</div>
              <div style={{ color: "#777", fontSize: 11, margin: "4px 0 10px" }}>{conflictLabel(conflict)}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {conflict.candidates.map(path => {
                  const selected = choices[conflict.core_name] === path;
                  return (
                    <button
                      key={path}
                      type="button"
                      onClick={() => setChoices(current => ({ ...current, [conflict.core_name]: path }))}
                      style={{
                        display: "flex", alignItems: "center", gap: 10, textAlign: "left",
                        padding: "9px 11px", borderRadius: 8, cursor: "pointer",
                        border: `1px solid ${selected ? "#666" : "#242424"}`,
                        background: selected ? "#222" : "#181818", color: selected ? "#fff" : "#aaa",
                      }}
                    >
                      <span style={{ width: 12, height: 12, borderRadius: "50%", border: `1px solid ${selected ? "#fff" : "#555"}`, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        {selected && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#fff" }} />}
                      </span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{basename(path)}</span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setChoices(current => ({ ...current, [conflict.core_name]: "__skip__" }))}
                  style={{
                    marginTop: 3, padding: "8px 10px", borderRadius: 8, cursor: "pointer",
                    border: `1px solid ${choices[conflict.core_name] === "__skip__" ? "#555" : "#242424"}`,
                    background: choices[conflict.core_name] === "__skip__" ? "#202020" : "transparent",
                    color: choices[conflict.core_name] === "__skip__" ? "#ddd" : "#777", textAlign: "left",
                  }}
                >
                  Skip this beat
                </button>
              </div>
            </div>
          ))}

          {error && <div style={{ padding: "10px 12px", borderRadius: 8, background: "#331414", border: "1px solid #642222", color: "#fca5a5", fontSize: 11 }}>{error}</div>}
          <button
            onClick={() => void confirm()}
            disabled={!ready || busy}
            style={{
              marginTop: 2, width: "100%", padding: 11, borderRadius: 8, border: 0,
              background: !ready || busy ? "#1d1d1d" : "#fff",
              color: !ready || busy ? "#444" : "#000", fontWeight: 600,
              cursor: !ready || busy ? "default" : "pointer",
            }}
          >
            {busy ? "Preparing conflicts…" : "Continue to Review"}
          </button>
        </div>
      </div>
    </>
  );
}
