import React, { useState } from "react";
import type { Beat } from "../types";
import type { ImportBatchPreview, ImportDecisionInput, PendingDecision } from "../lib/tauri";
import { resolveImportDecisions } from "../lib/tauri";

interface Props {
  batch: ImportBatchPreview;
  onClose: () => void;
  onImported: (beats: Beat[]) => void;
}

type Action = "assign" | "independent" | "ignore";

interface RowState {
  action: Action;
  role: string;
  targetBeatName: string;
}

const ROLE_OPTIONS = [
  { value: "loop", label: "Loop" },
  { value: "mp3", label: "MP3 principal" },
  { value: "wav", label: "WAV principal" },
  { value: "stems", label: "Stems" },
  { value: "flp", label: "FLP / proyecto" },
  { value: "als", label: "Proyecto Ableton" },
  { value: "other", label: "Otro (sin rol específico)" },
];

function basename(p: string) { return p.split(/[\\/]/).pop() ?? p; }

function scoreColor(score: number) {
  if (score >= 80) return "#4ade80";
  if (score >= 60) return "#f5a623";
  return "#888";
}

function initialRowState(d: PendingDecision): RowState {
  return { action: "assign", role: d.suggested_role || "other", targetBeatName: d.suggested_beat_name };
}

export default function ImportDecisionsModal({ batch, onClose, onImported }: Props) {
  const [rows, setRows] = useState<Record<string, RowState>>(() => {
    const init: Record<string, RowState> = {};
    for (const d of batch.pending) init[d.path] = initialRowState(d);
    return init;
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (path: string, patch: Partial<RowState>) => {
    setRows(r => ({ ...r, [path]: { ...r[path], ...patch } }));
  };

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const decisions: ImportDecisionInput[] = batch.pending.map(d => {
        const row = rows[d.path];
        if (row.action === "ignore") {
          return { path: d.path, action: "ignore" };
        }
        if (row.action === "independent") {
          return { path: d.path, action: "independent", role: row.role };
        }
        return { path: d.path, action: "assign", target_beat_name: row.targetBeatName, role: row.role };
      });
      const beats = await resolveImportDecisions(batch.batch_id, decisions);
      onImported(beats);
      onClose();
    } catch (e: any) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div onClick={submitting ? undefined : onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200 }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
        width: "min(680px, 92vw)", maxHeight: "86vh", overflowY: "auto",
        background: "#0f0f0f", border: "1px solid #1e1e1e", borderRadius: 14, zIndex: 201,
      }}>
        <div style={{
          padding: "18px 22px", borderBottom: "1px solid #1a1a1a", position: "sticky", top: 0,
          background: "#0f0f0f", zIndex: 1,
        }}>
          <div style={{ fontWeight: 500, fontSize: 14, color: "#e0e0e0" }}>Confirmar archivos parecidos</div>
          <div style={{ fontSize: 11, color: "#555", marginTop: 4 }}>
            {batch.confirmed_count} beat{batch.confirmed_count !== 1 ? "s" : ""} listo{batch.confirmed_count !== 1 ? "s" : ""} ·{" "}
            {batch.pending.length} archivo{batch.pending.length !== 1 ? "s" : ""} necesita{batch.pending.length === 1 ? "" : "n"} tu decisión
          </div>
        </div>

        <div style={{ padding: 20 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {batch.pending.map(d => {
              const row = rows[d.path];
              return (
                <div key={d.path} style={{
                  padding: "14px 16px", background: "#141414", border: "1px solid #1e1e1e", borderRadius: 10,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                    <div style={{ fontSize: 12, color: "#e0e0e0", fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {basename(d.path)}
                    </div>
                    <div style={{ fontSize: 10, color: scoreColor(d.score), border: `1px solid ${scoreColor(d.score)}33`, borderRadius: 999, padding: "2px 8px", flexShrink: 0 }}>
                      {Math.round(d.score)}% parecido
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 8, marginBottom: row.action === "assign" ? 10 : 0, flexWrap: "wrap" }}>
                    {(["assign", "independent", "ignore"] as Action[]).map(a => (
                      <button key={a} onClick={() => update(d.path, { action: a })}
                        style={{
                          padding: "6px 12px", borderRadius: 7, fontSize: 11, cursor: "pointer",
                          background: row.action === a ? "#fff" : "#1a1a1a",
                          color: row.action === a ? "#000" : "#888",
                          border: `1px solid ${row.action === a ? "#fff" : "#262626"}`,
                        }}>
                        {a === "assign" ? `Sí, es parte de "${d.suggested_beat_name}"` : a === "independent" ? "No, es un beat aparte" : "Ignorar"}
                      </button>
                    ))}
                  </div>

                  {row.action === "assign" && (
                    <select value={row.role} onChange={e => update(d.path, { role: e.target.value })}
                      style={{
                        width: "100%", padding: "8px 10px", background: "#1a1a1a", border: "1px solid #262626",
                        borderRadius: 7, color: "#ddd", fontSize: 12,
                      }}>
                      {ROLE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  )}
                  {row.action === "independent" && (
                    <select value={row.role} onChange={e => update(d.path, { role: e.target.value })}
                      style={{
                        width: "100%", padding: "8px 10px", background: "#1a1a1a", border: "1px solid #262626",
                        borderRadius: 7, color: "#ddd", fontSize: 12,
                      }}>
                      <option value="mp3">Es un MP3</option>
                      <option value="wav">Es un WAV</option>
                    </select>
                  )}
                </div>
              );
            })}
          </div>

          {error && (
            <div style={{ marginTop: 14, padding: "10px 14px", background: "#3d0000", border: "1px solid #7f1d1d", borderRadius: 8, fontSize: 12, color: "#fca5a5" }}>
              {error}
            </div>
          )}

          <button onClick={handleConfirm} disabled={submitting}
            style={{
              marginTop: 16, width: "100%", padding: "11px", background: submitting ? "#1e1e1e" : "#fff",
              border: "none", borderRadius: 8, color: submitting ? "#3a3a3a" : "#000", fontWeight: 500,
              fontSize: 14, cursor: submitting ? "not-allowed" : "pointer",
            }}>
            {submitting ? "Importando…" : "Confirmar e importar"}
          </button>
        </div>
      </div>
    </>
  );
}
