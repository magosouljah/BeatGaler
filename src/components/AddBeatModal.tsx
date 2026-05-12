import React, { useState } from "react";
import type { Beat, FolderScanResult, ResolveFilesPayload } from "../types";
import { Artwork, FolderIcon } from "./ui";
import { pickAndScanFolder, readBeatMeta, scanBeatFolder, resolveAndAddBeat, importSelectedBeats } from "../lib/tauri";
import { open } from "@tauri-apps/plugin-dialog";

interface Props {
  onClose: () => void;
  onAdd: (beats: Beat[]) => void;
  existingBeats: Beat[];
}

type Step = "choose" | "scanning" | "results" | "conflict";

// Displays a filename without the full path
function basename(p: string) { return p.split(/[\\/]/).pop() ?? p; }

// A simple file-picker row: label + current selection + change button
function FilePicker({ label, options, value, onChange }: {
  label: string; options: string[]; value: string | null; onChange: (v: string | null) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, color: "#555", letterSpacing: 0.7, marginBottom: 6 }}>{label}</div>
      {options.map(p => (
        <div key={p} onClick={() => onChange(value === p ? null : p)}
          style={{
            display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
            borderRadius: 7, cursor: "pointer", marginBottom: 4,
            background: value === p ? "#1a2a1a" : "#161616",
            border: `1px solid ${value === p ? "#2d4a2d" : "#1e1e1e"}`,
          }}>
          <div style={{
            width: 16, height: 16, borderRadius: "50%", flexShrink: 0, border: "1.5px solid",
            borderColor: value === p ? "#4ade80" : "#333",
            background: value === p ? "#4ade80" : "transparent",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {value === p && <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#000" }} />}
          </div>
          <span style={{ fontSize: 12, color: value === p ? "#ddd" : "#555", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {basename(p)}
          </span>
        </div>
      ))}
      {options.length > 1 && value && (
        <div onClick={() => onChange(null)}
          style={{ fontSize: 11, color: "#444", cursor: "pointer", marginTop: 2, paddingLeft: 2 }}>
          ✕ skip {label.toLowerCase()}
        </div>
      )}
    </div>
  );
}

function isDuplicateCandidate(beat: Beat, existingBeats: Beat[]) {
  return existingBeats.some(existing => (
    existing.folder_path === beat.folder_path ||
    existing.mp3_path === beat.mp3_path ||
    (existing.name.trim().toLowerCase() === beat.name.trim().toLowerCase() && existing.bpm === beat.bpm && existing.key === beat.key)
  ));
}

export default function AddBeatModal({ onClose, onAdd, existingBeats }: Props) {
  const [step, setStep] = useState<Step>("choose");
  const [scanned, setScanned] = useState<Beat[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [conflict, setConflict] = useState<FolderScanResult & { folder_path: string } | null>(null);
  const [resolving, setResolving] = useState<ResolveFilesPayload>({ folder_path: "", mp3_path: "", wav_path: null, stems_path: null, flp_path: null });
  const [scanMsg, setScanMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const handleScanFolder = async () => {
    setError(null); setScanMsg("Scanning beats…"); setStep("scanning");
    try {
      const beats = await pickAndScanFolder();
      if (beats.length === 0) { setError("No beats found. Make sure each beat has its own subfolder with an MP3."); setStep("choose"); return; }
      const duplicateIds = new Set(beats.filter(beat => isDuplicateCandidate(beat, existingBeats)).map(beat => beat.id));
      setScanned(beats);
      setSelected(new Set(beats.filter(beat => !duplicateIds.has(beat.id)).map(beat => beat.id)));
      setStep("results");
    } catch (e: any) { if (!String(e).includes("cancelled")) setError(String(e)); setStep("choose"); }
  };

  const handlePickSingleFolder = async () => {
    setError(null);
    try {
      const sel = await open({ directory: true, multiple: false, title: "Select beat folder" });
      if (!sel || typeof sel !== "string") return;
      setScanMsg("Reading beat folder…");
      setImporting(true);
      const result = await scanBeatFolder(sel);
      if (result.needs_resolution) {
        const r: ResolveFilesPayload = {
          folder_path: sel,
          mp3_path: result.mp3_files[0] ?? "",
          wav_path: result.wav_files[0] ?? null,
          stems_path: result.stems_files[0] ?? null,
          flp_path: result.flp_files[0] ?? null,
        };
        setConflict({ ...result, folder_path: sel });
        setResolving(r);
        setStep("conflict");
      } else if (result.beat) {
        onAdd([result.beat]); onClose();
      }
    } catch (e: any) { if (!String(e).includes("cancelled")) setError(String(e)); }
    finally { setImporting(false); }
  };

  const handlePickSingleMp3 = async () => {
    setError(null);
    try {
      const sel = await open({ filters: [{ name: "MP3 Audio", extensions: ["mp3"] }], multiple: false, title: "Select beat MP3" });
      if (!sel || typeof sel !== "string") return;
      setScanMsg("Importing beat…");
      setImporting(true);
      const beat = await readBeatMeta(sel);
      onAdd([beat]); onClose();
    } catch (e: any) { if (!String(e).includes("cancelled")) setError(String(e)); }
    finally { setImporting(false); }
  };

  const handleResolve = async () => {
    if (!resolving.mp3_path) { setError("Please select an MP3"); return; }
    setError(null);
    try {
      setScanMsg("Importing beat…");
      setImporting(true);
      const beat = await resolveAndAddBeat(resolving);
      onAdd([beat]); onClose();
    } catch (e: any) { setError(String(e)); }
    finally { setImporting(false); }
  };

  const addSelected = async () => {
    const selectedBeats = scanned.filter(b => selected.has(b.id));
    const folderPaths = selectedBeats.map(b => b.folder_path);
    setError(null);
    try {
      setScanMsg(`Importing ${selectedBeats.length} beat${selectedBeats.length !== 1 ? "s" : ""}…`);
      setImporting(true);
      const imported = await importSelectedBeats(folderPaths);
      onAdd(imported);
    } catch (e: any) {
      setError(String(e));
      return;
    } finally {
      setImporting(false);
    }
    onClose();
  };

  const toggle = (id: string) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)", zIndex: 400, backdropFilter: "blur(6px)" }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 420, maxHeight: "88vh", overflowY: "auto", background: "#0f0f0f", border: "1px solid #1e1e1e", borderRadius: 14, zIndex: 410, boxShadow: "0 24px 60px rgba(0,0,0,0.9)" }}>
        {importing && (
          <div style={{ position: "absolute", inset: 0, zIndex: 3, background: "rgba(8,8,8,0.82)", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12, backdropFilter: "blur(4px)" }}>
            <div style={{ fontSize: 13, color: "#9a9a9a" }}>{scanMsg || "Working…"}</div>
            <div style={{ display: "flex", justifyContent: "center", gap: 5 }}>
              {[0,1,2].map(i => <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "#4a4a4a", animation: `dot 1s ${i*0.2}s ease-in-out infinite alternate` }} />)}
            </div>
          </div>
        )}
        {/* Header */}
        <div style={{ padding: "18px 22px", borderBottom: "1px solid #1a1a1a", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, background: "#0f0f0f", zIndex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {step !== "choose" && <button onClick={() => setStep("choose")} style={{ background: "none", border: "none", color: "#555", fontSize: 16, cursor: "pointer" }}>←</button>}
            <span style={{ fontWeight: 500, fontSize: 14, color: "#e0e0e0" }}>
              {step === "choose" ? "Add beat" : step === "scanning" ? "Scanning…" : step === "conflict" ? "Multiple files found" : "Select beats to import"}
            </span>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#555", fontSize: 18, cursor: "pointer" }}>✕</button>
        </div>

        <div style={{ padding: 22 }}>
          {/* CHOOSE */}
          {step === "choose" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                { label: "Add single beat folder", sub: "Pick a beat's folder — auto-detects MP3, WAV, stems, FLP", fn: handlePickSingleFolder, icon: "📁" },
                { label: "Add single MP3", sub: "Pick an MP3 file directly", fn: handlePickSingleMp3, icon: "🎵" },
                { label: "Scan all beats folder", sub: "Pick ALL MY BEATS — imports everything at once", fn: handleScanFolder, icon: "📂" },
              ].map(({ label, sub, fn, icon }) => (
                <button key={label} onClick={fn}
                  style={{ padding: "16px 18px", background: "#161616", border: "1px solid #222", borderRadius: 10, cursor: "pointer", textAlign: "left" }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = "#333")}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = "#222")}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 8, background: "#1e1e1e", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>{icon}</div>
                    <div>
                      <div style={{ fontSize: 13, color: "#e0e0e0", fontWeight: 500 }}>{label}</div>
                      <div style={{ fontSize: 11, color: "#444", marginTop: 2 }}>{sub}</div>
                    </div>
                  </div>
                </button>
              ))}
              {error && <div style={{ padding: "10px 14px", background: "#3d0000", border: "1px solid #7f1d1d", borderRadius: 8, fontSize: 12, color: "#fca5a5" }}>{error}</div>}
            </div>
          )}

          {/* SCANNING */}
          {step === "scanning" && (
            <div style={{ textAlign: "center", padding: "40px 0", color: "#555", fontSize: 13 }}>
              <div style={{ marginBottom: 12 }}>{scanMsg}</div>
              <div style={{ display: "flex", justifyContent: "center", gap: 5 }}>
                {[0,1,2].map(i => <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "#333", animation: `dot 1s ${i*0.2}s ease-in-out infinite alternate` }} />)}
              </div>
            </div>
          )}

          {/* CONFLICT RESOLUTION */}
          {step === "conflict" && conflict && (
            <div>
              <p style={{ fontSize: 12, color: "#555", marginBottom: 16 }}>
                This folder has multiple files of the same type. Pick which one to use for each.
              </p>
              <FilePicker label="MP3 (required)" options={conflict.mp3_files} value={resolving.mp3_path}
                onChange={v => setResolving(r => ({ ...r, mp3_path: v ?? "" }))} />
              <FilePicker label="WAV" options={conflict.wav_files} value={resolving.wav_path}
                onChange={v => setResolving(r => ({ ...r, wav_path: v }))} />
              <FilePicker label="STEMS" options={conflict.stems_files} value={resolving.stems_path}
                onChange={v => setResolving(r => ({ ...r, stems_path: v }))} />
              <FilePicker label="FLP / PROJECT" options={conflict.flp_files} value={resolving.flp_path}
                onChange={v => setResolving(r => ({ ...r, flp_path: v }))} />
              {error && <div style={{ padding: "10px 14px", background: "#3d0000", border: "1px solid #7f1d1d", borderRadius: 8, fontSize: 12, color: "#fca5a5", marginBottom: 12 }}>{error}</div>}
              <button onClick={handleResolve} disabled={!resolving.mp3_path}
                style={{ width: "100%", padding: "11px", background: resolving.mp3_path ? "#fff" : "#1e1e1e", border: "none", borderRadius: 8, color: resolving.mp3_path ? "#000" : "#3a3a3a", fontWeight: 500, fontSize: 14, cursor: resolving.mp3_path ? "pointer" : "not-allowed" }}>
                Add beat
              </button>
            </div>
          )}

          {/* RESULTS */}
          {step === "results" && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <span style={{ fontSize: 12, color: "#555" }}>{scanned.length} beats · {selected.size} selected</span>
                <button onClick={() => setSelected(selected.size === scanned.length ? new Set() : new Set(scanned.map(b => b.id)))}
                  style={{ fontSize: 11, color: "#666", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
                  {selected.size === scanned.length ? "Deselect all" : "Select all"}
                </button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 360, overflowY: "auto", marginBottom: 16 }}>
                {scanned.map(b => {
                  const duplicate = isDuplicateCandidate(b, existingBeats);
                  return (
                  <div key={b.id} onClick={() => toggle(b.id)}
                    style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 12px", background: selected.has(b.id) ? "#161f16" : "#141414", border: `1px solid ${selected.has(b.id) ? "#2a3a2a" : "#1e1e1e"}`, borderRadius: 8, cursor: "pointer" }}>
                    <Artwork beat={b} size={38} playing={false} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: "#e0e0e0", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{b.name}</div>
                        {duplicate && (
                          <span style={{ fontSize: 10, color: "#8b8b8b", border: "1px solid #2b2b2b", borderRadius: 999, padding: "2px 7px", flexShrink: 0 }}>
                            duplicate
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 6, marginTop: 3, flexWrap: "wrap" }}>
                        {b.bpm && <span style={{ fontSize: 10, color: "#444", fontFamily: "monospace" }}>{b.bpm} BPM</span>}
                        {b.key && <span style={{ fontSize: 10, color: "#444", fontFamily: "monospace" }}>{b.key}</span>}
                        {b.has_wav && <span style={{ fontSize: 9, color: "#33aaff66", border: "1px solid #33aaff22", padding: "0 4px", borderRadius: 3 }}>WAV</span>}
                        {b.has_stems && <span style={{ fontSize: 9, color: "#aa33ff66", border: "1px solid #aa33ff22", padding: "0 4px", borderRadius: 3 }}>STEMS</span>}
                        {b.has_flp && <span style={{ fontSize: 9, color: "#f5a62366", border: "1px solid #f5a62322", padding: "0 4px", borderRadius: 3 }}>FLP</span>}
                      </div>
                    </div>
                    <div style={{ width: 18, height: 18, borderRadius: 5, flexShrink: 0, background: selected.has(b.id) ? "#4ade80" : "#222", border: `1px solid ${selected.has(b.id) ? "#4ade80" : "#333"}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {selected.has(b.id) && <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 5L4 7.5L8.5 2.5" stroke="#000" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                    </div>
                  </div>
                  );
                })}
              </div>
              <button onClick={addSelected} disabled={selected.size === 0}
                style={{ width: "100%", padding: "11px", background: selected.size > 0 ? "#fff" : "#1e1e1e", border: "none", borderRadius: 8, color: selected.size > 0 ? "#000" : "#3a3a3a", fontWeight: 500, fontSize: 14, cursor: selected.size > 0 ? "pointer" : "not-allowed" }}>
                Import {selected.size} beat{selected.size !== 1 ? "s" : ""}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
