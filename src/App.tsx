import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import uploadCompleteWav from "./assets/status/upload-complete.wav";
import downloadCompleteWav from "./assets/status/download-complete.wav";
import type { Beat, AppSettings } from "./types";
import BeatCard from "./components/BeatCard";
import Drawer from "./components/Drawer";
import Player from "./components/Player";
import AddBeatModal from "./components/AddBeatModal";
import ImportDecisionsModal from "./components/ImportDecisionsModal";
import ImportAudioConflictsModal from "./components/ImportAudioConflictsModal";
import ReviewBeatSkeleton from "./components/ReviewBeatSkeleton";
import SettingsPanel from "./components/SettingsPanel";
import AccountGate, { getBeatGalerAuthToken, getResolvedCloudApiBase, logoutBeatGalerAccount } from "./components/AccountGate";
import UploadModal from "./components/UploadModal";
import JobStatusBar from "./components/JobStatusBar";
import { SearchIcon, PlusIcon, Artwork } from "./components/ui";
import { useAudio } from "./hooks/useAudio";
import { loadLibrary, loadOfflineLibrary, makeBeatAvailableOffline, removeBeatOfflineAvailability, recordOfflineTrashIntent, flushOfflineTrashIntents, removeBeatFromLibrary, reorderBeats, readBeatMeta, getSettings, saveBeatMeta, renameTagEverywhere, startImportReviewStream, getImportReviewBatchSummary, prepareNextImportReviewBeat, discardImportReviewBatch, resolveImportDecisions, uploadBeatToTelegram, downloadBeatFromTelegram, prepareBeatForPlayback, warmBeatForPlayback, getDownloadCookingStatus, downloadCookingDiagnosticEvent, uploadProjectToTelegram, getProjectCloudStatus, openBeatProject, updateProjectArchiveFromSource, inspectProjectDropSource, uploadDroppedFileToTelegram, listCloudFilesForBeat, downloadCloudFileToCache, downloadProjectToCache, startBackgroundDownload, revealInExplorer, syncBeatMetadataToTelegram, repairStaleCloudLibraryRefs, loadCloudArtworkForBeat, pollTelegramCloudStatus, detachLocalSourcesAfterCloudUpload, purgeInterruptedUploadLocal, getCloudClientId, chooseExportFilePath, chooseExportFolder, copyExportFile, copyAudioMetadata, prepareUniqueExportFolder, readImagePathAsDataUrl, isDirectoryPath, type CloudFileType, type CloudFileRecord, type BackgroundDownloadEvent, type ImportBatchPreview, isTauriAvailable } from "./lib/tauri";
import { libraryStateManager } from "./lib/libraryStateManager";
import { listen } from "@tauri-apps/api/event";
import { DndContext, DragEndEvent, DragOverlay, DragStartEvent, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy } from "@dnd-kit/sortable";
import ReactDOM from "react-dom";
import { appAlert, appConfirm } from "./lib/dialog";
import { useTagColors, setTagColor, renameTagColor, TAG_COLOR_PALETTE } from "./lib/tagColors";
import { registerJob, updateJob } from "./lib/jobStore";
import { cleanTags, validateBpm, validateMusicKey } from "./lib/metadataValidation";
import { fetchInternetArtworkDataUrl } from "./features/artwork/internetArtwork";
import { artworkFileToDataUrl } from "./features/dragdrop/browserArtwork";
import { nativeExternalImageSignalFromPaths } from "./features/dragdrop/nativeExternalImage";
import { installHtmlDropController } from "./features/dragdrop/htmlDropController";
import { cleanupOrphanedDropStaging, cleanupStagedDropPaths } from "./features/dragdrop/dropStaging";
import { isBeatPlaybackBlocked } from "./features/playback/playbackReadiness";
import { createBeatRuntimeState, hydrateBeatRuntimeState, transitionBeatRuntimeState, type BeatRuntimeEvent, type BeatRuntimeState } from "./features/state/beatRuntimeState";
import { reviewPerfMark } from "./features/perf/reviewPerf";

type DroppedBeatFileRole = "main" | "wav" | "projectFolder" | "loop" | "stems";
type AutoProjectDropResult = "not-project" | "handled" | "started";

type ReviewQueueState = {
  beats: Beat[];
  index: number;
  // Streaming discovery intentionally does not know N when Beat 1 appears.
  total: number | null;
  batchId: string | null;
  preparing: boolean;
};

// Intentionally isolated: if real-world timings prove the skeleton unnecessary,
// flipping/removing this one constant deletes the visual layer without touching
// the staged Review architecture underneath it.
const REVIEW_SKELETON_ENABLED = true;
// Safety cap for one Explorer drag gesture. A parent folder still counts as one
// root and is discovered lazily, so this never forces a full-tree scan.
const MAX_NATIVE_DROP_ITEMS = 50;

function dismissBeatGalerStartupLoader(): void {
  const loader = document.getElementById("beatgaler-startup-loader");
  if (!loader) return;
  loader.remove();
}

function fileNameFromPath(path: string) {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

function extensionFromPath(path: string) {
  const name = fileNameFromPath(path);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function reviewSourceKey(beat: Beat): string {
  return (beat.mp3_path || beat.wav_path || beat.playback_path || "")
    .replace(/\\/g, "/")
    .trim()
    .toLocaleLowerCase();
}

function isBackupFolderPath(path: string) {
  const name = fileNameFromPath(path).trim().toLowerCase();
  return name === "backup" || name === "backups";
}

const beatCloudUpdateBusyIds = new Set<string>();

function setBeatCloudUpdateBusy(beatId: string, active: boolean, success = false) {
  if (active) beatCloudUpdateBusyIds.add(beatId);
  else beatCloudUpdateBusyIds.delete(beatId);
  window.dispatchEvent(new CustomEvent("beatgaler:beat-cloud-busy", {
    detail: { beatId, active, success }
  }));
}

function formatCloudBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes; let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRuntimeConflictError(error: unknown): boolean {
  const message = runtimeErrorMessage(error).toLowerCase();
  return message.includes("409") || message.includes("conflict") || message.includes("revision mismatch") || message.includes("version mismatch");
}

type BeatDownloadKind = "MP3" | "WAV" | "PROJECT" | "ALL";
type ConnectionState = "checking" | "online" | "poor" | "offline";

function CloudFilesModal({
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

function BeatFileDropModal({
  beat,
  filePath,
  isDirectory,
  onChoose,
  onClose,
}: {
  beat: Beat;
  filePath: string;
  isDirectory: boolean;
  onChoose: (role: DroppedBeatFileRole) => void;
  onClose: () => void;
}) {
  const ext = extensionFromPath(filePath);
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
          {fileNameFromPath(filePath)}
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

type SortKey = "name" | "bpm" | "rating" | "manual";

function SearchBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const hasText = value.trim().length > 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {open && (
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <input autoFocus value={value} onChange={e => onChange(e.target.value)}
            onBlur={() => { if (!hasText) setOpen(false); }}
            placeholder="Search beats…"
            style={{ background: "#181818", border: "1px solid #252525", borderRadius: 8, padding: "6px 32px 6px 12px", color: "#fff", fontSize: 13, width: 220, outline: "none" }} />
          {hasText && (
            <button
              onMouseDown={e => { e.preventDefault(); onChange(""); }}
              style={{ position: "absolute", right: 6, background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "2px 4px", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center" }}
              onMouseEnter={e => (e.currentTarget.style.color = "#aaa")}
              onMouseLeave={e => (e.currentTarget.style.color = "#555")}
            ></button>
          )}
        </div>
      )}
      <button onClick={() => setOpen(o => !o)}
        style={{ width: 32, height: 32, borderRadius: 8, background: "transparent", border: "none", color: open ? "#ccc" : "#444", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <SearchIcon />
      </button>
    </div>
  );
}

function SortMenu({ value, onChange }: { value: SortKey; onChange: (v: SortKey) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const options: { key: SortKey; label: string }[] = [
    { key: "name", label: "Name" },
    { key: "bpm", label: "BPM" },
    { key: "rating", label: "Rating" },
    { key: "manual", label: "Manual" },
  ];

  const activeLabel = options.find(o => o.key === value)?.label ?? "Sort";

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(v => !v);
        }}
        style={{
          minWidth: 0,
          height: 32,
          padding: "0 18px 0 10px",
          borderRadius: 8,
          background: open ? "#222" : "#161616",
          border: `1px solid ${open ? "#323232" : "#1e1e1e"}`,
          color: open ? "#d2d2d2" : "#8a8a8a",
          fontSize: 11,
          cursor: "pointer",
          outline: "none",
          display: "flex",
          position: "relative",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span>{activeLabel}</span>
        <span style={{ fontSize: 9, opacity: 0.75, position: "absolute", right: 6 }}></span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: 36,
            right: 0,
            zIndex: 120,
            width: "fit-content",
            minWidth: 0,
            background: "rgba(24,24,24,0.96)",
            backdropFilter: "blur(12px)",
            border: "1px solid #2a2a2a",
            borderRadius: 10,
            padding: "4px 0",
            boxShadow: "0 12px 30px rgba(0,0,0,0.6)",
          }}
        >
          {options.map((opt) => {
            const active = opt.key === value;
            return (
              <button
                key={opt.key}
                onClick={() => {
                  onChange(opt.key);
                  setOpen(false);
                }}
                style={{
                  width: "auto",
                  border: "none",
                  background: "transparent",
                  color: active ? "#f1f1f1" : "#bebebe",
                  cursor: "pointer",
                  textAlign: "center",
                  padding: "7px 8px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  whiteSpace: "nowrap",
                }}
              >
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TagColorMenu({
  x, y, current, onSelect, onRename, onClose,
}: {
  x: number; y: number; current: string | null;
  onSelect: (hex: string | null) => void; onRename: () => void; onClose: () => void;
}) {
  React.useEffect(() => {
    const onAnyClick = () => onClose();
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("beatcard:close-menus", onClose);
    setTimeout(() => window.addEventListener("click", onAnyClick), 10);
    window.addEventListener("contextmenu", onAnyClick, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("beatcard:close-menus", onClose);
      window.removeEventListener("click", onAnyClick);
      window.removeEventListener("contextmenu", onAnyClick, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return ReactDOM.createPortal(
    <div onClick={e => e.stopPropagation()} style={{
      position: "fixed", top: y, left: x, zIndex: 9999,
      background: "#1c1c1c", border: "1px solid #2a2a2a", borderRadius: 10,
      padding: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.85)",
    }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
        {TAG_COLOR_PALETTE.map(c => (
          <button key={c.key} onClick={() => onSelect(c.hex)} title={c.label}
            style={{
              width: 24, height: 24, borderRadius: "50%", background: c.hex,
              border: current === c.hex ? "2px solid #fff" : "1px solid rgba(255,255,255,0.2)",
              cursor: "pointer", padding: 0,
            }} />
        ))}
      </div>
      <button onClick={() => onSelect(null)}
        style={{ marginTop: 8, width: "100%", padding: "5px 0", background: "transparent", border: "1px solid #333", borderRadius: 6, color: "#999", fontSize: 11, cursor: "pointer" }}>
        Ninguno
      </button>
      <button onClick={onRename}
        style={{ marginTop: 6, width: "100%", padding: "6px 0", background: "#222", border: "1px solid #383838", borderRadius: 6, color: "#ddd", fontSize: 11, cursor: "pointer" }}>
        Renombrar…
      </button>
    </div>,
    document.body
  );
}

// Local cache so the library paints instantly on next launch instead of
// showing a blank/loading screen while Rust re-scans disk. The real
// loadLibrary() call still runs in the background and silently replaces
// this once it resolves — this is purely a "show something now" cache,
// never the source of truth.
const LIBRARY_CACHE_KEY = "beatvault:library:v1";
const SORT_CACHE_KEY = "beatvault:sort:v2";
const INTERRUPTED_UPLOADS_KEY = "beatgaler:active-cloud-uploads:v1";

type ActiveCloudUpload = {
  beatId: string;
  beatName: string;
  stagingPaths: string[];
};

function activeUploadStagingPaths(beat: Beat): string[] {
  return [
    beat.mp3_path, beat.wav_path, beat.playback_path, beat.folder_path,
    beat.samples_path, beat.stems_path, beat.flp_path, beat.als_path,
    beat.loop_path, ...(beat.other_files ?? []),
  ].filter((value): value is string => !!value);
}

function readActiveCloudUploads(): ActiveCloudUpload[] {
  try {
    const raw = localStorage.getItem(INTERRUPTED_UPLOADS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(item => item?.beatId && item?.beatName) : [];
  } catch {
    return [];
  }
}

function writeActiveCloudUploads(items: ActiveCloudUpload[]): void {
  try {
    if (items.length === 0) localStorage.removeItem(INTERRUPTED_UPLOADS_KEY);
    else localStorage.setItem(INTERRUPTED_UPLOADS_KEY, JSON.stringify(items));
  } catch {}
}

function markCloudUploadActive(beat: Beat): void {
  const current = readActiveCloudUploads().filter(item => item.beatId !== beat.id);
  current.push({ beatId: beat.id, beatName: beat.name, stagingPaths: activeUploadStagingPaths(beat) });
  writeActiveCloudUploads(current);
}

function clearCloudUploadActive(beatId: string): void {
  writeActiveCloudUploads(readActiveCloudUploads().filter(item => item.beatId !== beatId));
}

async function rollbackInterruptedCloudUploads(beatgalerUserId: string, authoritativeBeatIds: Set<string> | null): Promise<string[]> {
  const pending = readActiveCloudUploads();
  if (pending.length === 0) return [];

  const rolledBack: string[] = [];
  const remaining: ActiveCloudUpload[] = [];
  const base = getResolvedCloudApiBase();
  const token = getBeatGalerAuthToken();

  for (const item of pending) {
    // A recovery marker is only evidence that the process died mid-flow.
    // Telegram INDEX is authoritative: if the beat is already present there,
    // the upload was durable and MUST NOT be rolled back. Clear only the stale
    // local marker and keep the beat/media intact.
    if (authoritativeBeatIds?.has(item.beatId)) {
      console.info(`[upload-recovery] marker cleared for durable beat ${item.beatId}`);
      continue;
    }

    // If we could not verify the authoritative INDEX, fail closed: keep the
    // marker for a later launch instead of guessing and deleting anything.
    if (authoritativeBeatIds === null) {
      remaining.push(item);
      continue;
    }

    try {
      const response = await fetch(`${base}/beats/delete-topic`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ beatgalerUserId, beatId: item.beatId }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(text || `HTTP ${response.status}`);
      }

      await purgeInterruptedUploadLocal(item.beatId, item.stagingPaths);
      rolledBack.push(item.beatName);
    } catch (error) {
      console.warn(`Could not roll back interrupted upload ${item.beatName}:`, error);
      remaining.push(item);
    }
  }

  writeActiveCloudUploads(remaining);
  return rolledBack;
}

function loadCachedBeats(): Beat[] | null {
  try {
    const raw = localStorage.getItem(LIBRARY_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveCachedBeats(beats: Beat[]) {
  try {
    // Never serialize full-resolution artwork into localStorage on every edit.
    // The cache only exists for instant paint; SQLite/Telegram remain source of truth.
    const lightweight = beats.map(beat => ({
      ...beat,
      image_base64: null,
      // Keep the small preview when available so cards can still paint quickly.
      image_preview_base64: beat.image_preview_base64 ?? null,
      other_files: [],
    }));
    localStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify(lightweight));
  } catch {
    // quota or disabled — ignore
  }
}

function cloudBeatFingerprint(beat: Beat): string {
  // IMPORTANT: image_base64/image_preview_base64 are presentation/cache state.
  // Cloud artwork is tracked durably in Rust cloud_metadata. Including decoded
  // image bytes here made startup artwork hydration look like nine independent
  // metadata edits, causing an INDEX rewrite storm and Telegram 429s.
  return [
    beat.id,
    beat.name,
    String(beat.bpm ?? ""),
    beat.key ?? "",
    beat.tags.join("\u001f"),
    String(beat.rating ?? 0),
    beat.color ?? "",
    beat.color2 ?? "",
    beat.telegram_file_id ?? "",
    String(beat.telegram_message_id ?? ""),
  ].join("\u001e");
}

function libraryViewFingerprint(beats: Beat[]): string {
  return beats.map(beat => [
    beat.id,
    beat.name,
    beat.cloud_status ?? "",
    beat.telegram_file_id ?? "",
    String(beat.telegram_message_id ?? ""),
    String(beat.bpm ?? ""),
    beat.key ?? "",
    beat.tags.join("\u001f"),
    String(beat.rating ?? 0),
  ].join("\u001d")).join("\u001c");
}

function loadCachedSort(): SortKey {
  try {
    const raw = localStorage.getItem(SORT_CACHE_KEY);
    return raw === "name" || raw === "bpm" || raw === "rating" || raw === "manual" ? raw : "rating";
  } catch {
    return "rating";
  }
}

function saveCachedSort(sortBy: SortKey) {
  try { localStorage.setItem(SORT_CACHE_KEY, sortBy); } catch { /* quota or disabled — ignore */ }
}

function preserveLoadedArtwork(incoming: Beat[], current: Beat[]): Beat[] {
  const previous = new Map(current.map(beat => [beat.id, beat]));
  return incoming.map(beat => {
    const old = previous.get(beat.id);
    if (!old) return beat;
    if (beat.image_base64 || beat.image_preview_base64) return beat;
    const artwork = old.image_preview_base64 || old.image_base64;
    return artwork
      ? { ...beat, image_base64: old.image_base64 ?? null, image_preview_base64: old.image_preview_base64 ?? null }
      : beat;
  });
}

// Clear upload preview cache when library reload is requested via UI reload button
// (This keeps reload button behavior explicit: refresh disk scan + clear derived previews)
export function clearUploadPreviewCache() {
  try { localStorage.removeItem('beatvault:upload-cache:v1'); } catch {}
}

const STARTUP_PRIORITY_BEATS = 6;

function decodeArtworkDataUrl(src: string): Promise<boolean> {
  return new Promise(resolve => {
    const image = new Image();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    image.onload = () => done(true);
    image.onerror = () => done(false);
    image.src = src;
    if (typeof image.decode === "function") {
      void image.decode().then(() => done(true)).catch(() => {});
    }
    window.setTimeout(() => done(false), 2500);
  });
}

function GalleryStartupSkeleton() {
  return (
    <div
      aria-label="Loading beat library"
      style={{
        position: "absolute", inset: 0, zIndex: 60, background: "#0c0c0c",
        overflow: "hidden", pointerEvents: "auto", padding: "28px 24px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "28px 22px", maxWidth: 1300, width: "100%" }}>
          {Array.from({ length: STARTUP_PRIORITY_BEATS }, (_, i) => (
            <div key={i} style={{ width: 160, opacity: 0.82 }}>
              <div className="beatgaler-skeleton-block beatgaler-skeleton-cover" />
              <div className="beatgaler-skeleton-block beatgaler-skeleton-title" />
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <div className="beatgaler-skeleton-block beatgaler-skeleton-tag" />
                <div className="beatgaler-skeleton-block beatgaler-skeleton-tag beatgaler-skeleton-tag-short" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function BeatGalerApp() {
  // Browser/localStorage library data is only an instant-paint helper AFTER the
  // cloud/offline source has been verified. Never render it as a cold-start
  // library by itself: navigator.onLine and a localhost SSE connection can both
  // look healthy while Telegram is actually unreachable.
  const startupCachedBeatsRef = useRef<Beat[] | null>(null);
  if (startupCachedBeatsRef.current === null) {
    const cached = loadCachedBeats() ?? [];
    const interruptedIds = new Set(readActiveCloudUploads().map(item => item.beatId));
    startupCachedBeatsRef.current = interruptedIds.size > 0
      ? cached.filter(beat => !interruptedIds.has(beat.id))
      : cached;
  }
  const [beats, setBeats] = useState<Beat[]>([]);
  const [openableCloudProjectIds, setOpenableCloudProjectIds] = useState<Set<string>>(new Set());
  const cloudMetaSnapshotRef = useRef<Map<string, string> | null>(null);
  const cloudMetaTimersRef = useRef<Map<string, number>>(new Map());
  const cloudLibraryTimerRef = useRef<number | null>(null);
  const cloudLibrarySnapshotRef = useRef<string | null>(null);
  const cacheSaveTimerRef = useRef<number | null>(null);
  const visibleLibraryFingerprintRef = useRef<string>("");
  const autoCloudUploadRef = useRef<Set<string>>(new Set());
  const backgroundUploadQueueRef = useRef<Beat[]>([]);
  // Always holds the newest library snapshot for immediate cloud-index writes.
  const beatsLatestRef = useRef<Beat[]>([]);
  // Definitive per-beat operation model. These states are intentionally session-local:
  // unfinished upload/download/playback work never resurrects after an app restart.
  // Stable Offline availability is re-hydrated from native durable BeatMeta instead.
  const [beatRuntimeStates, setBeatRuntimeStates] = useState<Record<string, BeatRuntimeState>>({});
  const beatRuntimeStatesRef = useRef<Record<string, BeatRuntimeState>>({});
  useEffect(() => { beatRuntimeStatesRef.current = beatRuntimeStates; }, [beatRuntimeStates]);

  const transitionRuntime = useCallback((beatId: string, event: BeatRuntimeEvent, beatHint?: Beat) => {
    setBeatRuntimeStates(current => {
      const beat = beatHint ?? beatsLatestRef.current.find(item => item.id === beatId);
      const base = current[beatId] ?? createBeatRuntimeState(beat);
      try {
        const nextState = transitionBeatRuntimeState(base, event);
        if (nextState === base) return current;
        return { ...current, [beatId]: nextState };
      } catch (error) {
        // A rejected transition is a programming bug, not a user-facing failure.
        // Keep the last valid state so races cannot corrupt the machine.
        console.warn(`Beat runtime transition rejected for ${beatId}:`, event.type, error);
        return current;
      }
    });
  }, []);

  const forgetRuntimeState = useCallback((beatId: string) => {
    setBeatRuntimeStates(current => {
      if (!(beatId in current)) return current;
      const next = { ...current };
      delete next[beatId];
      return next;
    });
  }, []);

  const clearReconciledTrashRuntimeStates = useCallback(() => {
    const visibleIds = new Set(beatsLatestRef.current.map(beat => beat.id));
    setBeatRuntimeStates(current => {
      let changed = false;
      const next = { ...current };
      for (const [id, runtime] of Object.entries(current)) {
        if (!visibleIds.has(id) && runtime.trash_sync_required) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, []);

  useEffect(() => {
    // Library reloads/Telegram refreshes must not overwrite transient machines,
    // but the durable Offline bit always comes from the native source of truth.
    setBeatRuntimeStates(current => {
      const next: Record<string, BeatRuntimeState> = {};
      let changed = false;
      for (const beat of beats) {
        const hydrated = hydrateBeatRuntimeState(current[beat.id], beat);
        next[beat.id] = hydrated;
        if (hydrated !== current[beat.id]) changed = true;
      }
      // A deleting beat leaves the visible library before its cloud-index commit
      // finishes. Keep that transient state (and the Offline Trash intent bit)
      // until the responsible operation explicitly clears it.
      for (const [id, runtime] of Object.entries(current)) {
        if (next[id]) continue;
        if (runtime.sync_state === "deleting" || runtime.trash_sync_required) next[id] = runtime;
        else changed = true;
      }
      return changed ? next : current;
    });
  }, [beats]);
  const backgroundUploadRunningRef = useRef(false);
  // A manual Reload pressed during an import must never overwrite the optimistic
  // in-flight rows with the older committed Telegram INDEX. Queue the reload and
  // execute it after the batch commits instead.
  const deferredLibraryReloadRef = useRef(false);
  const uploadCompleteTimersRef = useRef<Map<string, number>>(new Map());
  const cloudPullInFlightRef = useRef(false);
  const stagedImportPathsRef = useRef<Map<string, string[]>>(new Map());
  const [backgroundUploadErrors, setBackgroundUploadErrors] = useState<Record<string, string>>({});
  const [interruptedUploadNotices, setInterruptedUploadNotices] = useState<string[]>([]);

  useEffect(() => {
    if (interruptedUploadNotices.length === 0) return;
    const timer = window.setTimeout(() => setInterruptedUploadNotices([]), 15_000);
    return () => window.clearTimeout(timer);
  }, [interruptedUploadNotices]);

  const [loading, setLoading] = useState(() => loadCachedBeats() === null);
  const [libraryRefreshing, setLibraryRefreshing] = useState(false);
  const [startupCookingGate, setStartupCookingGate] = useState(true);
  const [revealedBeatIds, setRevealedBeatIds] = useState<Set<string>>(() => new Set());
  const startupCookingResolvedRef = useRef(false);
  const startupPipelineStartedRef = useRef(false);
  const startupEnginePrimeReadyRef = useRef(false);
  const progressiveRevealRunRef = useRef(0);
  const cookingPlaybackUrlRef = useRef<Map<string, { telegramFileId: string; url: string }>>(new Map());
  const cookingWarmPromisesRef = useRef<Map<string, Promise<string | null>>>(new Map());
  // Incremented whenever temporary playback cache is cleared. Warm promises
  // capture the epoch so a promise started before Clear cache cannot repopulate
  // the Fast Play map with a URL backed by files that were just deleted.
  const playbackCacheEpochRef = useRef(0);
  const artworkLoadPromisesRef = useRef<Map<string, Promise<boolean>>>(new Map());
  const [search, setSearch] = useState("");
  const [includedTags, setIncludedTags] = useState<Set<string>>(new Set());
  const [excludedTags, setExcludedTags] = useState<Set<string>>(new Set());
  const [tagColorMenu, setTagColorMenu] = useState<{ tag: string; x: number; y: number } | null>(null);
  const [tagRename, setTagRename] = useState<{ oldTag: string; newTag: string; stage: "name" | "confirm" } | null>(null);
  const [tagRenameBusy, setTagRenameBusy] = useState(false);
  const [tagRenameError, setTagRenameError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>(() => loadCachedSort());
  const [drawer, setDrawer] = useState<{ beat: Beat; mode: "detail" | "edit" } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [dropImporting, setDropImporting] = useState(false);
  const [dropImportBatch, setDropImportBatch] = useState<ImportBatchPreview | null>(null);
  const [deferredImportBatch, setDeferredImportBatch] = useState<ImportBatchPreview | null>(null);
  const [audioConflictBatch, setAudioConflictBatch] = useState<ImportBatchPreview | null>(null);
  const [reviewBootstrap, setReviewBootstrap] = useState<{ total: number | null } | null>(null);
  // Covers the WebView2 staging window that happens BEFORE importDroppedPaths
  // receives native paths. Without this state, the app can look frozen while
  // large dropped files are being copied into drop-staging.
  const [libraryDropStaging, setLibraryDropStaging] = useState(false);
  const [reviewPreparationDone, setReviewPreparationDone] = useState(true);
  const [bulkSaveAllBusy, setBulkSaveAllBusy] = useState(false);
  const [beatFileDrop, setBeatFileDrop] = useState<{ beat: Beat; filePath: string; kind: "file" | "directory" } | null>(null);
  const [cloudFilesBeat, setCloudFilesBeat] = useState<Beat | null>(null);
  const [cloudFiles, setCloudFiles] = useState<CloudFileRecord[]>([]);
  const [cloudFilesBusyId, setCloudFilesBusyId] = useState<string | null>(null);
  const [cloudFilesDownloadedIds, setCloudFilesDownloadedIds] = useState<Set<string>>(new Set());
  const [cloudFilesDownloadError, setCloudFilesDownloadError] = useState<string | null>(null);
  const [cloudDownloadNotice, setCloudDownloadNotice] = useState<{
    taskId: string;
    kind: BeatDownloadKind;
    beatName: string;
    status: "downloading" | "completed";
  } | null>(null);
  const backgroundDownloadRuntimeOwnersRef = useRef<Set<string>>(new Set());
  const [projectUpdateNotice, setProjectUpdateNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!projectUpdateNotice) return;
    const timer = window.setTimeout(() => setProjectUpdateNotice(null), 9000);
    return () => window.clearTimeout(timer);
  }, [projectUpdateNotice]);
  const [reviewQueue, setReviewQueue] = useState<ReviewQueueState | null>(null);
  // Background uploads can finish while the user is still reviewing other beats
  // from the SAME drop-staging session. Keep a live ref so staging cleanup never
  // deletes the remaining Review sources after the first upload succeeds.
  const reviewQueueLatestRef = useRef<ReviewQueueState | null>(null);
  const reviewPreparationRunRef = useRef(0);
  const reviewPreparationPromiseRef = useRef<Promise<Beat[]> | null>(null);
  // Cancels stale async import bootstrap work when Review is cancelled/replaced.
  const importReviewRequestRunRef = useRef(0);
  const skippedReviewSourceKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => { reviewQueueLatestRef.current = reviewQueue; }, [reviewQueue]);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // Prevent cached/local state from being pushed back to Telegram before this
  // app session has first verified and pulled the authoritative pinned index.
  const [cloudSessionVerified, setCloudSessionVerified] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>(() =>
    typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "checking"
  );
  const [offlineBusyIds, setOfflineBusyIds] = useState<Set<string>>(new Set());
  const [setupDone, setSetupDone] = useState(false);
  const [showUpload, setShowUpload] = useState<{ initialBeat: Beat | null; selectedIds?: string[] } | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [anchorIdx, setAnchorIdx] = useState<number | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [repeatMode, setRepeatMode] = useState<"off" | "all" | "one">("off");
  const [showQueue, setShowQueue] = useState(false);
  const [queueIds, setQueueIds] = useState<string[]>([]);
  const lastHandledEndedSeqRef = useRef(0);

  const { state: audio, play, primeAudioEngine, togglePause, seek, setVolume, releaseFile } = useAudio();

  // Keep a ref to togglePause so the keydown handler never goes stale
  const togglePauseRef = useRef(togglePause);
  const deleteInFlightRef = useRef(new Set<string>());
  const networkReconnectRunRef = useRef(0);
  useEffect(() => { togglePauseRef.current = togglePause; }, [togglePause]);

  const rejectOfflineMutation = useCallback((action: string): boolean => {
    if (connectionState === "online") return false;
    void appAlert({
      title: connectionState === "offline" ? "Offline" : "Connection unavailable",
      message: `${action} requires an internet connection. Offline mode is read-only except for moving beats to Trash.`,
    });
    return true;
  }, [connectionState]);

  useEffect(() => {
    let cancelled = false;

    const showOfflineLibrary = async (state: ConnectionState) => {
      // Keep the startup gate closed while native code validates durable Offline
      // packages. Changing connectionState first used to let the startup reveal
      // effect briefly expose every cached cloud card (and could resolve the
      // reveal pipeline while the Offline list was still empty).
      setCloudSessionVerified(false);
      const offline = await loadOfflineLibrary().catch(error => {
        console.warn("Could not load Offline library:", error);
        return [] as Beat[];
      });
      if (!cancelled) {
        // Offline packages are already complete local assets, so they do not
        // need Download Cooking. Resolve the startup reveal atomically with
        // the validated Offline library to prevent an empty/all-beats flash.
        startupCookingResolvedRef.current = true;
        startupPipelineStartedRef.current = false;
        progressiveRevealRunRef.current += 1;
        setRevealedBeatIds(new Set(offline.map(beat => beat.id)));
        setStartupCookingGate(false);
        setBeats(offline);
        setConnectionState(state);
        dismissBeatGalerStartupLoader();
      }
    };

    void (async () => {
      try {
        // Settings are local. Account linkage remains remembered even when the
        // network is down; connectivity is a separate runtime state.
        const local = await getSettings();
        if (cancelled) return;
        setSettings(local);
        setSetupDone(true);
        setLoading(false);

        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          await showOfflineLibrary("offline");
          return;
        }

        let status: Awaited<ReturnType<typeof pollTelegramCloudStatus>> = { connected: false, reachable: false, username: null };
        try {
          status = await pollTelegramCloudStatus();
          if (cancelled) return;

          // A hard Refresh restarts the Desktop helper. MASTER may need a few
          // seconds to admit the newly leased transport bot, so do not turn
          // that normal handoff into a fake empty/offline library.
          if (local.telegram_cloud_connected && !(status.connected && status.reachable)) {
            for (let attempt = 1; attempt <= 12; attempt += 1) {
              await new Promise(resolve => window.setTimeout(resolve, 500));
              if (cancelled) return;
              status = await pollTelegramCloudStatus().catch(() => status);
              if (status.connected && status.reachable) break;
              if (typeof navigator !== "undefined" && navigator.onLine === false) break;
            }
          }
        } catch (error) {
          console.warn("Telegram startup connectivity check failed:", error);
          await showOfflineLibrary(
            typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor"
          );
          return;
        }

        if (!status.reachable) {
          // Reachability is decided BEFORE account linkage. A local Cloud/Bot API
          // process can stay alive with Wi-Fi off, and that must never turn a cold
          // start into an online library or log the persisted account out.
          if (local.telegram_cloud_connected) {
            setSettings(current => current ? {
              ...current, telegram_cloud_connected: true,
              telegram_cloud_username: current.telegram_cloud_username ?? local.telegram_cloud_username,
            } : local);
          }
          await showOfflineLibrary(
            typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor"
          );
          return;
        }

        if (!status.connected) {
          // Telegram is actually reachable and the backend explicitly says this
          // installation is not linked. Only THIS case is a real logout/unlinked state.
          setCloudSessionVerified(false);
          setBeats([]);
          setSettings(current =>
            current
              ? { ...current, telegram_cloud_connected: false, telegram_cloud_username: null }
              : local
          );
          return;
        }
        setConnectionState("online");
        // A localhost EventSource can report before Telegram reachability is
        // known. Always give a verified online cold start a fresh cooking/reveal
        // pass even if an earlier transient state already resolved the gate.
        startupCookingResolvedRef.current = false;
        startupPipelineStartedRef.current = false;
        startupEnginePrimeReadyRef.current = false;
        progressiveRevealRunRef.current += 1;
        setRevealedBeatIds(new Set());
        setStartupCookingGate(true);

        // Recovery markers are only hints. Before deleting an interrupted upload,
        // verify it against the authoritative Telegram INDEX. A beat already in
        // the INDEX is durable even if an old local marker survived a crash.
        let recoveryAuthorityIds: Set<string> | null = null;
        if (local.beatgaler_user_id && readActiveCloudUploads().length > 0) {
          try {
            const authoritativeBeforeRecovery = await libraryStateManager.reloadAuthoritative();
            recoveryAuthorityIds = new Set(authoritativeBeforeRecovery.map(beat => beat.id));
          } catch (error) {
            console.warn("Could not verify Telegram INDEX before interrupted-upload cleanup; cleanup deferred safely:", error);
          }

          const rolledBackNames = await rollbackInterruptedCloudUploads(
            local.beatgaler_user_id,
            recoveryAuthorityIds,
          );
          if (!cancelled && rolledBackNames.length > 0) setInterruptedUploadNotices(rolledBackNames);
        }

        const flushedTrashCount = await flushOfflineTrashIntents();
        if (flushedTrashCount > 0) clearReconciledTrashRuntimeStates();
        let restored = await libraryStateManager.reloadAuthoritative();
        if (cancelled) return;

        // The INDEX can outlive media if an older interrupted-upload cleanup
        // physically deleted Telegram messages. Validate only MASTER references.
        // A beat is pruned only when Telegram explicitly confirms that message is
        // gone; transient/network errors preserve the entry. This repairs ghost
        // cards without touching the normal delete_messages cleanup model.
        try {
          const repaired = await repairStaleCloudLibraryRefs();
          if (repaired > 0) {
            console.warn(`[library-integrity] repaired_stale_master_refs=${repaired}`);
            restored = await libraryStateManager.reloadAuthoritative();
            if (cancelled) return;
          }
        } catch (error) {
          console.warn("Telegram library integrity repair deferred safely:", error);
        }

        cloudMetaSnapshotRef.current = new Map(
          restored.filter(beat => !!beat.telegram_file_id).map(beat => [beat.id, cloudBeatFingerprint(beat)])
        );
        cloudLibrarySnapshotRef.current = restored
          .filter(beat => !!beat.telegram_file_id)
          .map(cloudBeatFingerprint)
          .join("\u001c");
        setBeats(current => preserveLoadedArtwork(
          restored,
          current.length > 0 ? current : (startupCachedBeatsRef.current ?? [])
        ));
        startupCachedBeatsRef.current = [];
        void cleanupOrphanedDropStaging(restored);
        setCloudSessionVerified(true);
        setSettings(current =>
          current
            ? { ...current, telegram_cloud_connected: true, telegram_cloud_username: status.username }
            : local
        );
      } catch (error) {
        console.warn("Telegram vault startup check failed:", error);
        if (!cancelled) {
          setSetupDone(true);
          setLoading(false);
          await showOfflineLibrary(
            typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor"
          );
          dismissBeatGalerStartupLoader();
        }
      }
    })();

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!setupDone) return;
    let disposed = false;

    const restoreOnlineLibrary = async (username: string | null) => {
      const flushedTrashCount = await flushOfflineTrashIntents();
        if (flushedTrashCount > 0) clearReconciledTrashRuntimeStates();
      const restored = await libraryStateManager.reloadAuthoritative();
      if (disposed) return;
      cloudMetaSnapshotRef.current = new Map(
        restored.filter(beat => !!beat.telegram_file_id).map(beat => [beat.id, cloudBeatFingerprint(beat)])
      );
      cloudLibrarySnapshotRef.current = restored
        .filter(beat => !!beat.telegram_file_id)
        .map(cloudBeatFingerprint)
        .join("\u001c");
      setBeats(current => preserveLoadedArtwork(restored, current));
      setCloudSessionVerified(true);
      setSettings(current => current ? {
        ...current, telegram_cloud_connected: true, telegram_cloud_username: username
      } : current);

      // A cold offline start bypasses Download Cooking. Reset the reveal pipeline
      // so the full online library gets the normal readiness guarantees again.
      startupCookingResolvedRef.current = false;
      startupPipelineStartedRef.current = false;
      startupEnginePrimeReadyRef.current = false;
      progressiveRevealRunRef.current += 1;
      cookingWarmPromisesRef.current.clear();
      cookingPlaybackUrlRef.current.clear();
      artworkLoadPromisesRef.current.clear();
      setRevealedBeatIds(new Set());
      setStartupCookingGate(true);
    };

    const reconnect = async () => {
      const run = ++networkReconnectRunRef.current;
      const delays = [0, 1000, 2000, 5000, 10000, 30000, 60000];
      for (const delay of delays) {
        if (delay > 0) await new Promise(resolve => window.setTimeout(resolve, delay));
        if (disposed || run !== networkReconnectRunRef.current) return;
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          setConnectionState("offline");
          return;
        }
        try {
          const status = await pollTelegramCloudStatus();
          if (disposed || run !== networkReconnectRunRef.current) return;
          if (!status.reachable) {
            setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
            continue;
          }
          if (!status.connected) {
            setCloudSessionVerified(false);
            setBeats([]);
            setSettings(current => current ? {
              ...current, telegram_cloud_connected: false, telegram_cloud_username: null
            } : current);
            return;
          }
          setConnectionState("online");
          await restoreOnlineLibrary(status.username);
          return;
        } catch (error) {
          console.warn(`Reconnect attempt after ${delay}ms failed:`, error);
          setConnectionState("poor");
        }
      }
      // Stop active retry work after the 60s backoff attempt. The browser's
      // next online event or the existing SSE reconnect can wake us again.
      if (!disposed && run === networkReconnectRunRef.current) {
        setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
      }
    };

    const onOffline = () => {
      networkReconnectRunRef.current += 1;
      setConnectionState("offline");
      setCloudSessionVerified(false);
      // Intentionally keep the already-rendered session in memory. Cached audio
      // may continue playing until the app closes; a cold restart filters it out.
    };
    const onOnline = () => { void reconnect(); };

    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      disposed = true;
      networkReconnectRunRef.current += 1;
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [setupDone]);

  useEffect(() => {
    const styleId = "beatgaler-custom-cursor-style";
    let style = document.getElementById(styleId) as HTMLStyleElement | null;

    if (settings?.custom_cursor_enabled ?? true) {
      if (!style) {
        style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
          html, body, body * {
            cursor: url('/beatgaler-custom-cursor.cur'), url('/beatgaler-custom-cursor.png') 0 0, auto !important;
          }
          input[type="text"],
          input[type="email"],
          input[type="password"],
          input[type="search"],
          input[type="url"],
          input[type="tel"],
          input[type="number"],
          textarea,
          [contenteditable="true"] {
            cursor: text !important;
          }
        `;
        document.head.appendChild(style);
      }
    } else {
      style?.remove();
    }

    return () => {
      // Keep the current setting active across React re-renders.
    };
  }, [settings?.custom_cursor_enabled]);


  // Telegram/BeatGaler synchronization is push-based.
  // There is no timer and no focus-triggered full library scan.
  useEffect(() => {
    const userId = settings?.beatgaler_user_id;
    if (!setupDone || !userId) return;

    const sourceId = getCloudClientId();
    const cloudBase = getResolvedCloudApiBase();
    let events: EventSource | null = null;
    let cancelled = false;

    const applyRemoteLibraryChange = async () => {
      if (cancelled || cloudPullInFlightRef.current) return;
      cloudPullInFlightRef.current = true;
      try {
        const flushedTrashCount = await flushOfflineTrashIntents();
        if (flushedTrashCount > 0) clearReconciledTrashRuntimeStates();
        const merged = await libraryStateManager.reloadAuthoritative();
        if (!cancelled) {
          const nextFingerprint = libraryViewFingerprint(merged);
          if (nextFingerprint !== visibleLibraryFingerprintRef.current) {
            visibleLibraryFingerprintRef.current = nextFingerprint;
            cloudMetaSnapshotRef.current = new Map(
              merged.filter(beat => !!beat.telegram_file_id).map(beat => [beat.id, cloudBeatFingerprint(beat)])
            );
            cloudLibrarySnapshotRef.current = merged
              .filter(beat => !!beat.telegram_file_id)
              .map(cloudBeatFingerprint)
              .join("\u001c");
            setBeats(current => preserveLoadedArtwork(merged, current));
          }
        }
      } catch (error) {
        console.warn("Telegram event sync failed:", error);
      } finally {
        cloudPullInFlightRef.current = false;
      }
    };

    const onLibraryChanged = () => {
      void (async () => {
        try {
          const status = await pollTelegramCloudStatus();
          if (cancelled || !status.connected) return;
          if (!status.reachable) {
            setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
            return;
          }
          setConnectionState("online");
          await applyRemoteLibraryChange();
        } catch {
          if (!cancelled) setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
        }
      })();
    };
    const onReady = () => {
      void (async () => {
        try {
          const status = await pollTelegramCloudStatus();
          if (cancelled) return;
          if (!status.reachable) {
            setCloudSessionVerified(false);
            setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
            return;
          }
          if (!status.connected) {
            setCloudSessionVerified(false);
            setSettings(current => current ? { ...current, telegram_cloud_connected: false, telegram_cloud_username: null } : current);
            return;
          }
          setSettings(current => current ? { ...current, telegram_cloud_connected: true, telegram_cloud_username: status.username } : current);
          setConnectionState("online");
          await applyRemoteLibraryChange();
          if (!cancelled) setCloudSessionVerified(true);
        } catch (error) {
          if (!cancelled) setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
        }
      })();
    };
    const onTelegramConnected = () => {
      void (async () => {
        try {
          const status = await pollTelegramCloudStatus();
          if (cancelled || !status.connected) return;
          if (!status.reachable) {
            setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
            return;
          }
          setConnectionState("online");
          startupCookingResolvedRef.current = false;
          startupPipelineStartedRef.current = false;
          startupEnginePrimeReadyRef.current = false;
          artworkLoadPromisesRef.current.clear();
          cookingWarmPromisesRef.current.clear();
          cookingPlaybackUrlRef.current.clear();
          progressiveRevealRunRef.current += 1;
          setRevealedBeatIds(new Set());
          setStartupCookingGate(true);
          setCloudSessionVerified(false);
          setBeats([]);
          setSettings(current => current ? { ...current, telegram_cloud_connected: true, telegram_cloud_username: status.username } : current);
          await applyRemoteLibraryChange();
          if (!cancelled) setCloudSessionVerified(true);
        } catch (error) {
          console.warn("Could not activate Telegram vault:", error);
        }
      })();
    };

    void (async () => {
      const token = getBeatGalerAuthToken();
      if (!token) return;
      try {
        const response = await fetch(`${cloudBase}/events/ticket`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ beatgalerUserId: userId }),
        });
        if (!response.ok) throw new Error(`Event authorization failed (${response.status}).`);
        const body = await response.json();
        if (cancelled || !body?.ticket) return;
        const url =
          `${cloudBase}/events?beatgalerUserId=${encodeURIComponent(userId)}` +
          `&sourceId=${encodeURIComponent(sourceId)}` +
          `&ticket=${encodeURIComponent(String(body.ticket))}`;
        events = new EventSource(url);
        events.addEventListener("ready", onReady);
        events.addEventListener("library_changed", onLibraryChanged);
        events.addEventListener("telegram_connected", onTelegramConnected);
        events.onerror = () => {
          if (!cancelled) setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
        };
      } catch (error) {
        console.warn("BeatGaler event authorization failed:", error);
        if (!cancelled) setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
      }
    })();

    return () => {
      cancelled = true;
      events?.removeEventListener("ready", onReady);
      events?.removeEventListener("library_changed", onLibraryChanged);
      events?.removeEventListener("telegram_connected", onTelegramConnected);
      events?.close();
    };
  }, [setupDone, settings?.beatgaler_user_id]);

  // localStorage is synchronous and blocks the UI thread. Debounce it and store
  // a lightweight version without full artwork instead of serializing megabytes
  // of base64 on every small metadata change.
  useEffect(() => {
    if (cacheSaveTimerRef.current) window.clearTimeout(cacheSaveTimerRef.current);

    // Hiding the cloud library while disconnected is a view decision, not a
    // destructive cache mutation. Preserve the last verified instant-paint cache.
    if (settings && !settings.telegram_cloud_connected) return;

    cacheSaveTimerRef.current = window.setTimeout(() => {
      cacheSaveTimerRef.current = null;
      saveCachedBeats(beats);
    }, 1500);

    return () => {
      if (cacheSaveTimerRef.current) {
        window.clearTimeout(cacheSaveTimerRef.current);
        cacheSaveTimerRef.current = null;
      }
    };
  }, [beats, settings?.telegram_cloud_connected]);

  useEffect(() => {
    visibleLibraryFingerprintRef.current = libraryViewFingerprint(beats);
    beatsLatestRef.current = beats;
  }, [beats]);

  useEffect(() => {
    saveCachedSort(sortBy);
  }, [sortBy]);



  // One-time recovery for a cloud-only library after Telegram login/startup.
  // No timer, no permanent synchronization.
  const beatGalerCloudRecoveryAttemptedRef = useRef(false);

  const recoverTelegramLibraryOnceIfEmpty = useCallback(async () => {
    if (beatGalerCloudRecoveryAttemptedRef.current) return;
    if (beats.length !== 0) return;

    beatGalerCloudRecoveryAttemptedRef.current = true;
    try {
      const restored = await libraryStateManager.reloadAuthoritative();
      if (restored.length > 0) {
        setBeats(current => current.length === 0 ? restored : current);
      }
    } catch (error) {
      console.warn("Telegram library one-time recovery skipped:", error);
    }
  }, [beats.length]);

  // IMPORTANT: an empty library is a valid, authoritative state (for example
  // immediately after Remove All). Never infer "Telegram recovery" merely from
  // beats.length === 0; doing so races the pending trash/index commit and can
  // resurrect the just-removed cards with their artwork unloaded. Recovery is
  // only allowed from explicit Telegram connection/startup flows below.

  useEffect(() => {
    const onPlaybackCacheCleared = () => {
      playbackCacheEpochRef.current += 1;
      cookingPlaybackUrlRef.current.clear();
      cookingWarmPromisesRef.current.clear();
    };
    window.addEventListener("beatgaler:playback-cache-cleared", onPlaybackCacheCleared);
    return () => window.removeEventListener("beatgaler:playback-cache-cleared", onPlaybackCacheCleared);
  }, []);

  // `playing` means the browser audio element actually reached its Playing
  // event. Do not mark playback as playing merely because we assigned a src.
  useEffect(() => {
    const onAudioPlaying = (event: Event) => {
      const beatId = (event as CustomEvent<{ beatId?: string | null }>).detail?.beatId ?? null;
      if (!beatId) return;
      const runtime = beatRuntimeStatesRef.current[beatId];
      if (runtime?.playback_state === "playback_preparing") {
        transitionRuntime(beatId, { type: "PLAYBACK_PLAYING" });
      }
    };
    const onAudioIdle = (event: Event) => {
      const beatId = (event as CustomEvent<{ beatId?: string | null }>).detail?.beatId ?? null;
      if (!beatId) return;
      const runtime = beatRuntimeStatesRef.current[beatId];
      if (runtime && runtime.playback_state !== "idle") {
        transitionRuntime(beatId, { type: "PLAYBACK_IDLE" });
      }
    };
    window.addEventListener("beatgaler:audio-playing", onAudioPlaying);
    window.addEventListener("beatgaler:audio-idle", onAudioIdle);
    return () => {
      window.removeEventListener("beatgaler:audio-playing", onAudioPlaying);
      window.removeEventListener("beatgaler:audio-idle", onAudioIdle);
    };
  }, [transitionRuntime]);

  useEffect(() => {
    const onAudioUnavailable = (event: Event) => {
      const beatId = (event as CustomEvent<{ beatId?: string | null }>).detail?.beatId ?? null;
      if (beatId) {
        const runtime = beatRuntimeStatesRef.current[beatId];
        if (runtime?.playback_state === "playback_preparing" || runtime?.playback_state === "playing") {
          transitionRuntime(beatId, {
            type: "PLAYBACK_FAILED",
            code: "AUDIO_SOURCE_UNAVAILABLE",
            message: "Cloud audio unavailable. The MASTER file could not be loaded from cloud storage.",
            retryable: true,
          });
        }
      }
      void appAlert({
        title: "Beat unavailable",
        message: "Cloud audio unavailable. The MASTER file could not be loaded from cloud storage.",
        danger: true,
      });
    };

    window.addEventListener("beatgaler:audio-unavailable", onAudioUnavailable);
    return () => window.removeEventListener("beatgaler:audio-unavailable", onAudioUnavailable);
  }, [transitionRuntime]);

  const previousAudioBeatIdRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousAudioBeatIdRef.current;
    if (previous && previous !== audio.playingId) transitionRuntime(previous, { type: "PLAYBACK_IDLE" });
    previousAudioBeatIdRef.current = audio.playingId;
  }, [audio.playingId, transitionRuntime]);

  const previousEndedSeqRef = useRef(audio.endedSeq);
  useEffect(() => {
    if (audio.endedSeq === previousEndedSeqRef.current) return;
    previousEndedSeqRef.current = audio.endedSeq;
    if (audio.playingId) transitionRuntime(audio.playingId, { type: "PLAYBACK_IDLE" });
  }, [audio.endedSeq, audio.playingId, transitionRuntime]);

  useEffect(() => {
    const onTelegramConnected = (event: Event) => {
      const detail = (event as CustomEvent<{ connected?: boolean; username?: string | null }>).detail;
      if (!detail?.connected) return;

      setSettings(current => current ? {
        ...current,
        telegram_cloud_connected: true,
        telegram_cloud_username: detail.username ?? current.telegram_cloud_username ?? null,
      } : current);

      void recoverTelegramLibraryOnceIfEmpty();
    };

    window.addEventListener("beatgaler:telegram-connected", onTelegramConnected);
    return () => window.removeEventListener("beatgaler:telegram-connected", onTelegramConnected);
  }, [recoverTelegramLibraryOnceIfEmpty]);

  // Global keyboard shortcuts — stable handler via ref
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const isTyping = tag === "INPUT" || tag === "TEXTAREA";
      if (e.key === "Escape") {
        // Prevent Escape from leaving a focus ring or text selection behind
        // on whatever element/button was last interacted with.
        (document.activeElement as HTMLElement | null)?.blur();
        window.getSelection()?.removeAllRanges();
        setSelectedIds(new Set());
        setSelectMode(false);
        setDrawer(null);
        setShowAdd(false);
        setShowSettings(false);
        setShowQueue(false);
        setShowUpload(null);
      }
      if (e.key === " " && !isTyping) { e.preventDefault(); togglePauseRef.current(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []); // empty deps — safe because we use ref

  const ensureWarmPlaybackUrl = useCallback((beat: Beat): Promise<string | null> => {
    if (!beat.telegram_file_id) return Promise.resolve(null);

    const cacheEpoch = playbackCacheEpochRef.current;
    const existing = cookingPlaybackUrlRef.current.get(beat.id);
    if (existing?.telegramFileId === beat.telegram_file_id) return Promise.resolve(existing.url);

    const inFlight = cookingWarmPromisesRef.current.get(beat.id);
    if (inFlight) return inFlight;

    if (beat.offline_available) {
      const fileId = beat.telegram_file_id;
      const promise = prepareBeatForPlayback(beat).then(ready => {
        if (!ready.playback_path || playbackCacheEpochRef.current !== cacheEpoch) return null;
        cookingPlaybackUrlRef.current.set(beat.id, { telegramFileId: fileId, url: ready.playback_path });
        return ready.playback_path;
      }).catch(error => {
        console.warn("Offline playback preparation failed:", error);
        return null;
      }).finally(() => {
        cookingWarmPromisesRef.current.delete(beat.id);
      });
      cookingWarmPromisesRef.current.set(beat.id, promise);
      return promise;
    }

    const fileId = beat.telegram_file_id;
    const promise = warmBeatForPlayback(beat).then(prewarmUrl => {
      if (!prewarmUrl || playbackCacheEpochRef.current !== cacheEpoch) return null;
      const url = prewarmUrl.replace(/[?&]prewarm=1(?:&|$)/, "").replace(/[?&]$/, "");
      cookingPlaybackUrlRef.current.set(beat.id, { telegramFileId: fileId, url });
      return url;
    }).catch(error => {
      console.debug("Download Cooking warm skipped:", error);
      return null;
    }).finally(() => {
      cookingWarmPromisesRef.current.delete(beat.id);
    });

    cookingWarmPromisesRef.current.set(beat.id, promise);
    return promise;
  }, []);

  const ensureArtworkReady = useCallback((beat: Beat): Promise<boolean> => {
    const existingPromise = artworkLoadPromisesRef.current.get(beat.id);
    if (existingPromise) return existingPromise;

    const promise = (async () => {
      const existing = beat.image_preview_base64 || beat.image_base64;
      if (existing) {
        return decodeArtworkDataUrl(existing);
      }

      try {
        const artwork = await loadCloudArtworkForBeat(beat.id);
        if (!artwork) return true; // This beat genuinely has no artwork; gradient fallback is ready.
        const decoded = await decodeArtworkDataUrl(artwork);
        if (!decoded) return false;
        setBeats(current => {
          const next = current.map(item => item.id === beat.id
            ? { ...item, image_base64: artwork, image_preview_base64: null }
            : item);
          const hydrated = next.find(item => item.id === beat.id);
          if (hydrated && cloudMetaSnapshotRef.current) {
            cloudMetaSnapshotRef.current.set(beat.id, cloudBeatFingerprint(hydrated));
          }
          if (cloudLibrarySnapshotRef.current !== null) {
            cloudLibrarySnapshotRef.current = next
              .filter(item => !!item.telegram_file_id)
              .map(cloudBeatFingerprint)
              .join("\u001c");
          }
          return next;
        });
        return true;
      } catch (error) {
        console.warn(`Artwork warm failed for ${beat.name}:`, error);
        return false;
      }
    })().finally(() => {
      // Keep successful readiness memoized for this app session, but allow a
      // failed cover to retry later instead of permanently hiding the beat.
    });

    artworkLoadPromisesRef.current.set(beat.id, promise);
    void promise.then(ok => { if (!ok) artworkLoadPromisesRef.current.delete(beat.id); });
    return promise;
  }, []);

  const waitForCookingReady = useCallback(async (beat: Beat, timeoutMs = 12000): Promise<boolean> => {
    if (beat.offline_available || !beat.telegram_file_id) return true;
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      try {
        const status = await getDownloadCookingStatus();
        const entry = status.entries.find(item => item.beat_id === beat.id);
        const urlReady = cookingPlaybackUrlRef.current.get(beat.id)?.telegramFileId === beat.telegram_file_id;
        if (entry && !entry.failed && urlReady && (entry.complete || entry.downloaded_bytes >= status.ready_bytes)) return true;
        if (entry?.failed) return false;
      } catch {}
      await new Promise(resolve => window.setTimeout(resolve, 90));
    }
    return false;
  }, []);

  const waitForUploadedBeatPlaybackReady = useCallback(async (beat: Beat, timeoutMs = 15000): Promise<boolean> => {
    if (!beat.telegram_file_id) return false;

    const started = performance.now();
    void downloadCookingDiagnosticEvent("UPLOAD_PLAYBACK_GATE_BEGIN", beat.id, beat.name, "").catch(() => {});

    while (performance.now() - started < timeoutMs) {
      try {
        // Re-issue WARM explicitly on every retry. A newly-uploaded Telegram
        // document can be briefly unavailable to the download endpoint even
        // though sendDocument already returned its file_id. Rust revives a
        // previously failed cooker entry when this explicit warm is requested.
        const prewarmUrl = await warmBeatForPlayback(beat);
        if (prewarmUrl) {
          const url = prewarmUrl.replace(/[?&]prewarm=1(?:&|$)/, "").replace(/[?&]$/, "");
          cookingPlaybackUrlRef.current.set(beat.id, { telegramFileId: beat.telegram_file_id, url });
        }

        if (await waitForCookingReady(beat, 1400)) {
          void downloadCookingDiagnosticEvent(
            "UPLOAD_PLAYBACK_GATE_READY",
            beat.id,
            beat.name,
            `wait_ms=${(performance.now() - started).toFixed(1)}`
          ).catch(() => {});
          return true;
        }
      } catch (error) {
        console.debug(`Post-upload playback warm retry for ${beat.name}:`, error);
      }

      await new Promise(resolve => window.setTimeout(resolve, 180));
    }

    void downloadCookingDiagnosticEvent(
      "UPLOAD_PLAYBACK_GATE_TIMEOUT",
      beat.id,
      beat.name,
      `wait_ms=${(performance.now() - started).toFixed(1)}`
    ).catch(() => {});
    return false;
  }, [waitForCookingReady]);

  const handleWarm = useCallback((beat: Beat) => {
    void ensureWarmPlaybackUrl(beat);
  }, [ensureWarmPlaybackUrl]);

  const handlePlay = useCallback(async (beat: Beat) => {
    // Never let a stale card/queue callback bypass the upload readiness gate.
    // Read the latest Beat object because upload state can change after the
    // caller captured its render-time object.
    const latestBeat = beatsLatestRef.current.find(item => item.id === beat.id) ?? beat;
    if (beatCloudUpdateBusyIds.has(beat.id) || isBeatPlaybackBlocked(beat) || isBeatPlaybackBlocked(latestBeat)) {
      const blocked = isBeatPlaybackBlocked(latestBeat) ? latestBeat : beat;
      const reason = beatCloudUpdateBusyIds.has(beat.id) ? "SLOT_UPDATE" : String(blocked.cloud_status || "");
      void downloadCookingDiagnosticEvent("PLAY_BLOCKED_LOADING", blocked.id, blocked.name, reason).catch(() => {});
      return;
    }
    beat = latestBeat;

    const runtime = beatRuntimeStatesRef.current[beat.id] ?? createBeatRuntimeState(beat);
    // Sync and playback are independent state machines. In V7 a beat can stay in
    // sync_state=uploading until the ONE final batch INDEX commit even though its
    // MASTER is already durable and Download Cooking has made it playable. Do not
    // hold an already-ready beat hostage to the rest of the batch. cloud_status
    // (UPLOADING / PLAYBACK_PREPARING) remains the authoritative readiness gate.
    const syncStillBlocksPlayback =
      runtime.sync_state === "pending_upload" ||
      runtime.sync_state === "deleting" ||
      (runtime.sync_state === "uploading" && !beat.telegram_file_id);
    if (syncStillBlocksPlayback || runtime.playback_state === "playback_preparing") {
      void downloadCookingDiagnosticEvent(
        "PLAY_BLOCKED_RUNTIME_STATE",
        beat.id,
        beat.name,
        `${runtime.sync_state}/${runtime.playback_state}/master=${beat.telegram_file_id ? 1 : 0}`
      ).catch(() => {});
      return;
    }

    const startingPlaybackSession = audio.playingId !== beat.id || runtime.playback_state === "idle" || runtime.playback_state === "error";
    if (startingPlaybackSession) {
      if (audio.playingId && audio.playingId !== beat.id) transitionRuntime(audio.playingId, { type: "PLAYBACK_IDLE" });
      transitionRuntime(beat.id, { type: "PLAYBACK_PREPARING" }, beat);
    }

    const clickedAt = performance.now();
    void downloadCookingDiagnosticEvent("PLAY_CLICK", beat.id, beat.name, "").catch(() => {});

    // FAST PATH: a visible Cloud beat already has a localhost playback URL.
    // Set audio.src immediately. The localhost request itself promotes the beat
    // to HOT inside Rust, so no invoke/filesystem/network work is needed first.
    if (beat.telegram_file_id) {
      const cooked = cookingPlaybackUrlRef.current.get(beat.id);
      if (cooked && cooked.telegramFileId === beat.telegram_file_id) {
        void downloadCookingDiagnosticEvent("PLAY_FAST_PATH", beat.id, beat.name, `prepare_ms=${(performance.now() - clickedAt).toFixed(1)}`).catch(() => {});
        play(beat.id, [cooked.url]);
        return;
      }
    }

    // Fallback for a beat that was clicked before it ever became WARM, or for
    // local/pre-cloud audio. This path preserves the existing safety behavior.
    const playbackNeedsCloudDownload = Boolean(beat.telegram_file_id && !beat.offline_available);
    let playbackOwnsDownloadState = false;
    if (playbackNeedsCloudDownload) {
      const downloadRuntime = beatRuntimeStatesRef.current[beat.id] ?? createBeatRuntimeState(beat);
      if (downloadRuntime.download_state !== "downloading") {
        transitionRuntime(beat.id, { type: "DOWNLOAD_STARTED" }, beat);
        playbackOwnsDownloadState = true;
      }
    }
    try {
      const ready = await prepareBeatForPlayback(beat);
      void downloadCookingDiagnosticEvent("PLAY_PREPARED", beat.id, beat.name, `prepare_ms=${(performance.now() - clickedAt).toFixed(1)}`).catch(() => {});
      if (ready.telegram_file_id && ready.playback_path) {
        cookingPlaybackUrlRef.current.set(ready.id, { telegramFileId: ready.telegram_file_id, url: ready.playback_path });
      }
      // `ready.playback_path` may point at BeatGaler's private cloud cache. Do
      // not copy that transient path into the library state/localStorage.
      if (ready.cloud_status !== beat.cloud_status) {
        setBeats(bs => bs.map(b => b.id === ready.id ? { ...b, cloud_status: ready.cloud_status } : b));
      }
      // Once a Cloud MASTER exists, it is the ONLY playback source. Do not
      // silently fall back to an old local MP3/WAV if the cloud file is missing.
      const playbackSources = ready.telegram_file_id
        ? [ready.playback_path]
        : [ready.playback_path, ready.mp3_path, ready.wav_path ?? ""];
      if (playbackOwnsDownloadState) {
        transitionRuntime(beat.id, { type: "DOWNLOAD_SUCCEEDED" }, ready);
      }
      play(ready.id, playbackSources);
    } catch (e: any) {
      const message = String(e?.message || e);
      if (playbackOwnsDownloadState) {
        transitionRuntime(beat.id, { type: "DOWNLOAD_FAILED", code: "PLAYBACK_DOWNLOAD_FAILED", message, retryable: true }, beat);
      }
      if (startingPlaybackSession) {
        transitionRuntime(beat.id, { type: "PLAYBACK_FAILED", code: "PLAYBACK_PREPARE_FAILED", message, retryable: true }, beat);
      }
      await appAlert({
        title: "Beat unavailable",
        message,
        danger: true,
      });
    }
  }, [audio.playingId, play, transitionRuntime]);

  const handleUpload = useCallback((beat: Beat) => {
    if (rejectOfflineMutation("Uploading to YouTube")) return;
    setShowUpload({ initialBeat: beat, selectedIds: undefined });
  }, [rejectOfflineMutation]);

  const handleUploadTelegram = useCallback(async (beat: Beat) => {
    if (rejectOfflineMutation("Uploading a beat")) return;
    const existingCloudBeat = Boolean(beat.telegram_file_id);
    transitionRuntime(beat.id, { type: existingCloudBeat ? "SYNC_QUEUE_UPDATE" : "SYNC_QUEUE_UPLOAD" }, beat);
    transitionRuntime(beat.id, { type: existingCloudBeat ? "SYNC_UPDATE_STARTED" : "SYNC_UPLOAD_STARTED" }, beat);
    try {
      const updated = await uploadBeatToTelegram(beat);
      await syncBeatMetadataToTelegram(updated);
      transitionRuntime(updated.id, { type: existingCloudBeat ? "SYNC_UPDATE_SUCCEEDED" : "SYNC_UPLOAD_SUCCEEDED" }, updated);
      setBeats(bs => bs.map(b => b.id === updated.id ? updated : b));
    } catch (e: any) {
      const message = runtimeErrorMessage(e);
      if (existingCloudBeat && isRuntimeConflictError(e)) {
        transitionRuntime(beat.id, { type: "SYNC_CONFLICT", message }, beat);
      } else {
        transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "TELEGRAM_UPLOAD_FAILED", message, retryable: true }, beat);
      }
      await appAlert({
        title: "Cloud upload failed",
        message,
        danger: true,
      });
    }
  }, [rejectOfflineMutation, transitionRuntime]);

  const handleDownloadTelegram = useCallback(async (_beat: Beat) => {
    await appAlert({
      title: "Cloud-only library",
      message: "Files are fetched into temporary storage automatically when needed.",
    });
  }, []);

  const handleUploadProjectTelegram = useCallback(async (beat: Beat) => {
    if (rejectOfflineMutation("Uploading a project")) return;
    transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }, beat);
    transitionRuntime(beat.id, { type: "SYNC_UPDATE_STARTED" }, beat);
    try {
      await uploadProjectToTelegram(beat);
      await libraryStateManager.commitSnapshot(beatsLatestRef.current, "project-sync");
      transitionRuntime(beat.id, { type: "SYNC_UPDATE_SUCCEEDED" }, beat);
      window.dispatchEvent(new CustomEvent("beatgaler:project-cloud-updated", { detail: { beatId: beat.id } }));
      await appAlert({
        title: "Project synced to Galer Cloud",
        message: `${beat.name}.zip is stored in Galer Cloud as one PROJECT file.`,
      });
    } catch (e: any) {
      const message = runtimeErrorMessage(e);
      if (isRuntimeConflictError(e)) transitionRuntime(beat.id, { type: "SYNC_CONFLICT", message }, beat);
      else transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "PROJECT_UPLOAD_FAILED", message, retryable: true }, beat);
      await appAlert({ title: "Project upload failed", message, danger: true });
    }
  }, [rejectOfflineMutation, transitionRuntime]);

  const handleOpenProject = useCallback(async (beat: Beat) => {
    if (connectionState !== "online" && !beat.offline_available) {
      await appAlert({
        title: "Project unavailable offline",
        message: "This project was not downloaded with Available Offline. Reconnect to open it.",
      });
      return;
    }
    try {
      await openBeatProject(beat);
      await appAlert({
        title: "Project opened",
        message: "Save normally in FL Studio. When you want those changes stored in Galer Cloud, return to BeatGaler and choose “Update Project”.",
      });
    } catch (e: any) {
      await appAlert({ title: "Project unavailable", message: String(e?.message || e), danger: true });
    }
  }, [connectionState]);

  const handleUpdateProject = useCallback(async (beat: Beat) => {
    if (rejectOfflineMutation("Updating a project")) return;
    transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }, beat);
    transitionRuntime(beat.id, { type: "SYNC_UPDATE_STARTED" }, beat);
    try {
      await uploadProjectToTelegram(beat);
      await libraryStateManager.commitSnapshot(beatsLatestRef.current, "project-sync");
      transitionRuntime(beat.id, { type: "SYNC_UPDATE_SUCCEEDED" }, beat);
      window.dispatchEvent(new CustomEvent("beatgaler:project-cloud-updated", { detail: { beatId: beat.id } }));
      await appAlert({
        title: "Project updated",
        message: "The current PROJECT.zip has been synced to Galer Cloud.",
      });
    } catch (e: any) {
      const message = runtimeErrorMessage(e);
      if (isRuntimeConflictError(e)) transitionRuntime(beat.id, { type: "SYNC_CONFLICT", message }, beat);
      else transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "PROJECT_UPDATE_FAILED", message, retryable: true }, beat);
      await appAlert({
        title: "Project update failed",
        message,
        danger: true,
      });
    }
  }, [rejectOfflineMutation, transitionRuntime]);

  const handleUploadBulk = useCallback(() => {
    if (rejectOfflineMutation("Bulk upload")) return;
    setShowUpload({ initialBeat: null, selectedIds: Array.from(selectedIds) });
  }, [selectedIds, rejectOfflineMutation]);

  const handleEditBulk = useCallback(() => {
    if (rejectOfflineMutation("Editing metadata")) return;
    const firstSelected = beats.find(b => selectedIds.has(b.id));
    if (firstSelected) setDrawer({ beat: firstSelected, mode: "edit" });
  }, [beats, selectedIds, rejectOfflineMutation]);

  const handleRemoveBulk = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    const approved = await appConfirm({
      title: `Remove ${ids.length} beat${ids.length === 1 ? "" : "s"}?`,
      message: "Remove the selected beats from BeatGaler? Cloud-backed files remain stored; local-only files are moved to BeatGaler trash.",
      confirmLabel: ids.length === 1 ? "Remove beat" : "Remove beats",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!approved) return;

    const deleted = new Set<string>();
    for (const id of ids) {
      if (deleteInFlightRef.current.has(id)) continue;
      deleteInFlightRef.current.add(id);
      const beat = beats.find(item => item.id === id);
      if (beat?.telegram_file_id) {
        if (connectionState === "online") transitionRuntime(id, { type: "SYNC_DELETE_STARTED" }, beat);
        else transitionRuntime(id, { type: "SET_TRASH_SYNC_REQUIRED", required: true }, beat);
      }
      try {
        await removeBeatFromLibrary(id);
        deleted.add(id);
      } catch (err) {
        console.error(err);
        const runtime = beatRuntimeStatesRef.current[id];
        if (runtime?.sync_state === "deleting") {
          transitionRuntime(id, { type: "SYNC_FAILED", code: "DELETE_FAILED", message: runtimeErrorMessage(err), retryable: true }, beat);
        }
      } finally {
        deleteInFlightRef.current.delete(id);
      }
    }

    if (deleted.size > 0) {
      const next = beats.filter(b => !deleted.has(b.id));
      setBeats(next);
      setQueueIds(q => q.filter(id => !deleted.has(id)));

      // Offline Trash is a reversible local state, not a stale whole-index write.
      // On reconnect the server will move the CURRENT online beat objects by id.
      if (connectionState !== "online") {
        const deletedCloudIds = beats
          .filter(beat => deleted.has(beat.id) && !!beat.telegram_file_id)
          .map(beat => beat.id);
        const intentResults = await Promise.allSettled(deletedCloudIds.map(id => recordOfflineTrashIntent(id)));
        const failedIntentCount = intentResults.filter(result => result.status === "rejected").length;
        if (failedIntentCount > 0) {
          await appAlert({
            title: "Some Trash changes are local only",
            message: `${failedIntentCount} beat${failedIntentCount === 1 ? "" : "s"} could not be queued for reconnect. Restore those beats before closing BeatGaler, or reconnect and remove them again.`,
            danger: true,
          });
        }
      } else {
        const cloudBacked = next.filter(beat => !!beat.telegram_file_id);
        cloudLibrarySnapshotRef.current = cloudBacked.map(cloudBeatFingerprint).join("\u001c");
        try {
          await libraryStateManager.commitSnapshot(next, "bulk-remove");
          for (const id of deleted) forgetRuntimeState(id);
        } catch (error) {
          console.warn("Telegram library index refresh after Remove all failed:", error);
          const message = runtimeErrorMessage(error);
          for (const id of deleted) {
            const runtime = beatRuntimeStatesRef.current[id];
            if (runtime?.sync_state === "deleting") {
              transitionRuntime(id, { type: "SYNC_FAILED", code: "DELETE_INDEX_SYNC_FAILED", message, retryable: true });
            }
          }
        }
      }
    }
    if (deleted.size !== ids.length) {
      await appAlert({
        title: "Some beats were not removed",
        message: "One or more selected beats could not be removed from the library.",
        danger: true,
      });
    }
    setSelectedIds(new Set());
    setSelectMode(false);
    setAnchorIdx(null);
  }, [selectedIds, beats, connectionState, forgetRuntimeState, transitionRuntime]);

  const addToQueue = useCallback((beat: Beat) => {
    setQueueIds((ids) => (ids.includes(beat.id) ? ids : [...ids, beat.id]));
  }, []);

  const addBeats = useCallback((newBeats: Beat[]) => {
    setBeats(bs => {
      const existing = new Set(bs.map(b => b.mp3_path));
      const next = [...newBeats.filter(b => !existing.has(b.mp3_path)), ...bs];
      beatsLatestRef.current = next;
      return next;
    });
  }, []);

  const waitForCloudSessionWithBackoff = useCallback(async () => {
    const delays = [0, 1000, 2000, 5000, 10000, 30000, 60000];
    let lastError: unknown = null;

    for (const delay of delays) {
      if (delay > 0) await new Promise(resolve => window.setTimeout(resolve, delay));
      try {
        const status = await pollTelegramCloudStatus();
        if (!status.reachable) {
          lastError = new Error("Galer Cloud is temporarily unreachable.");
          setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
          continue;
        }
        if (!status.connected) return { status, error: null as unknown };
        setConnectionState("online");
        return { status, error: null as unknown };
      } catch (error) {
        lastError = error;
        setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
      }
    }

    return { status: { connected: Boolean(settings?.telegram_cloud_connected), reachable: false, username: settings?.telegram_cloud_username ?? null }, error: lastError };
  }, [settings?.telegram_cloud_connected, settings?.telegram_cloud_username]);

  const cloudifyImportedBeats = useCallback((newBeats: Beat[]) => {
    if (newBeats.length === 0) return;

    // Do not trust the React settings snapshot here. On macOS the Telegram
    // callback/SSE can complete before this closure receives the updated
    // settings value. The worker verifies the REAL backend session once.
    // Queue work immediately but never await it from the review/save UI.
    // One beat at a time keeps CPU/disk/network pressure predictable.
    for (const beat of newBeats) {
      const alreadyQueued = backgroundUploadQueueRef.current.some(item => item.id === beat.id);
      if (alreadyQueued || autoCloudUploadRef.current.has(beat.id)) continue;
      // Persist synchronously before network work begins. If the process exits
      // before full cloud finalization, startup will roll this beat back.
      markCloudUploadActive(beat);
      backgroundUploadQueueRef.current.push(beat);
      transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPLOAD" }, beat);
      setBackgroundUploadErrors(current => {
        if (!(beat.id in current)) return current;
        const next = { ...current };
        delete next[beat.id];
        return next;
      });
      setBeats(current => current.map(b =>
        b.id === beat.id ? { ...b, cloud_status: "UPLOADING" } : b
      ));
    }

    if (backgroundUploadRunningRef.current) return;
    backgroundUploadRunningRef.current = true;

    window.setTimeout(() => {
      void (async () => {
        try {
          // One explicit status check per background batch. This is NOT polling.
          // pollTelegramCloudStatus also reconciles the Rust-side settings cache,
          // which upload_beat_to_telegram validates before reading the local file.
          const verified = await waitForCloudSessionWithBackoff();
          const cloudSession = verified.status;
          const sessionCheckError = verified.error;
          if (sessionCheckError) {
            console.warn("Background upload could not verify Telegram session after backoff:", sessionCheckError);
          }

          if (!cloudSession.connected || !cloudSession.reachable) {
            const failed = backgroundUploadQueueRef.current.splice(0);
            const raw = sessionCheckError instanceof Error
              ? sessionCheckError.message
              : sessionCheckError != null
                ? String(sessionCheckError)
                : "BeatGaler could not verify cloud access for this installation.";

            const detail = [
              "UPLOAD FAILED",
              "Stage: Verify cloud session",
              "",
              raw,
              "",
              "Checks:",
              "• Confirm the Windows cloud-server and Tailscale Funnel are running.",
              "• Confirm this BeatGaler installation is signed in to the intended account.",
              "• Sign out and back in if this installation is attached to the wrong account.",
            ].join("\n");

            setBackgroundUploadErrors(current => {
              const next = { ...current };
              for (const item of failed) next[item.id] = detail;
              return next;
            });
            for (const item of failed) {
              transitionRuntime(item.id, {
                type: "SYNC_FAILED",
                code: "TELEGRAM_SESSION_UNAVAILABLE",
                message: raw,
                retryable: true,
              }, item);
            }
            setBeats(current => current.map(b =>
              failed.some(item => item.id === b.id)
                ? { ...b, cloud_status: "ERROR" }
                : b
            ));
            return;
          }

          setSettings(current =>
            current
              ? {
                  ...current,
                  telegram_cloud_connected: true,
                  telegram_cloud_username: cloudSession.username,
                }
              : current
          );

          while (backgroundUploadQueueRef.current.length > 0) {
            const original = backgroundUploadQueueRef.current.shift()!;
            if (autoCloudUploadRef.current.has(original.id)) continue;
            autoCloudUploadRef.current.add(original.id);

            let uploadStage = "Prepare upload";
            let remoteUploadCompleted = false;
            let syncCommitted = false;
            transitionRuntime(original.id, { type: "SYNC_UPLOAD_STARTED" }, original);
            try {
              let uploaded = original;

              // MASTER: only upload when the beat does not already own one.
              if (!uploaded.telegram_file_id) {
                uploadStage = "Upload MASTER audio";
                uploaded = await uploadBeatToTelegram(uploaded);
                setBeats(current => current.map(b =>
                  b.id === uploaded.id ? { ...uploaded, cloud_status: "UPLOADING" } : b
                ));
              }

              uploadStage = "Read existing cloud file slots";
              const existingFiles = await listCloudFilesForBeat(uploaded.id);
              const hasCloudWav = existingFiles.some(file => file.file_type === "WAV");

              if (uploaded.wav_path && !hasCloudWav) {
                uploadStage = "Upload WAV HQ";
                await uploadDroppedFileToTelegram(uploaded, uploaded.wav_path, "WAV");
              }

              const hasProjectSource =
                !!uploaded.flp_path || !!uploaded.als_path || uploaded.has_flp || uploaded.has_als;

              if (hasProjectSource) {
                uploadStage = "Check PROJECT cloud state";
                const currentProject = await getProjectCloudStatus(uploaded);
                if (!currentProject?.synced) {
                  uploadStage = "Build and upload PROJECT.zip";
                  await uploadProjectToTelegram(uploaded);
                }
              }

              // Every required Telegram slot is now durable. Anything that fails
              // below this point is local finalization and must not make the UI imply
              // that the remote upload itself is still pending.
              remoteUploadCompleted = true;

              // Only detach local import sources after every required cloud slot succeeds.
              uploadStage = "Finalize cloud copy and detach local sources";
              const detached = await detachLocalSourcesAfterCloudUpload(uploaded.id);

              setBackgroundUploadErrors(current => {
                if (!(detached.id in current)) return current;
                const next = { ...current };
                delete next[detached.id];
                return next;
              });

              // Upload completion and playback readiness are deliberately separate.
              // The Telegram send can finish a moment before its new MASTER can be
              // downloaded back. Keep the card blocked until Download Cooking has
              // enough real bytes for a reliable first Play.
              setBeats(current => {
                const next = current.map(b =>
                  b.id === detached.id ? { ...detached, cloud_status: "PLAYBACK_PREPARING" } : b
                );
                beatsLatestRef.current = next;
                return next;
              });

              // Artwork is part of the logical beat upload. Finish it BEFORE the
              // single authoritative index commit so MP3 + WAV + PROJECT + artwork
              // + metadata become visible in Telegram with one INDEX replacement.
              uploadStage = "Sync artwork and metadata";
              await syncBeatMetadataToTelegram(detached);

              // Durability boundary is PER BEAT, matching the proven pre-V7 behavior.
              // The LibraryStateManager still serializes all INDEX writes, so concurrent
              // imports cannot race; however, a finished beat never waits for the rest
              // of the batch before becoming authoritative.
              uploadStage = "Commit beat to authoritative INDEX";
              const indexSnapshot = beatsLatestRef.current.map(beat =>
                beat.id === detached.id
                  ? { ...detached, cloud_status: "CLOUD_ONLY" }
                  : beat
              );
              await libraryStateManager.commitSnapshot(indexSnapshot, `upload-beat:${detached.id}`);
              cloudLibrarySnapshotRef.current = indexSnapshot
                .filter(item => !!item.telegram_file_id)
                .map(cloudBeatFingerprint)
                .join("\u001c");
              syncCommitted = true;
              transitionRuntime(detached.id, { type: "SYNC_UPLOAD_SUCCEEDED" }, detached);

              // Critical: once Telegram media + INDEX are committed, this beat is no
              // longer interruptible. Clear its marker immediately, before playback
              // warming or before the next beat in the batch starts.
              clearCloudUploadActive(original.id);

              uploadStage = "Prepare uploaded MASTER for first Play";
              transitionRuntime(detached.id, { type: "PLAYBACK_PREPARING" }, detached);
              const playbackReady = await waitForUploadedBeatPlaybackReady(detached);
              if (!playbackReady) {
                const detail = [
                  "PLAYBACK PREPARATION FAILED",
                  `Beat: ${detached.name}`,
                  "",
                  "The media upload and Galer Library index are already committed, but BeatGaler could not warm the new MASTER for playback within 15 seconds.",
                  "The beat was left in Cloud safely; retrying later should not require re-uploading the file.",
                ].join("\n");
                setBackgroundUploadErrors(current => ({ ...current, [detached.id]: detail }));
                transitionRuntime(detached.id, {
                  type: "PLAYBACK_FAILED",
                  code: "MASTER_PREPARE_TIMEOUT",
                  message: detail,
                  retryable: true,
                }, detached);
                setBeats(current => {
                  const next = current.map(b => b.id === detached.id ? { ...detached, cloud_status: "ERROR" } : b);
                  beatsLatestRef.current = next;
                  return next;
                });
              } else {
                transitionRuntime(detached.id, { type: "PLAYBACK_IDLE" }, detached);
                // Green completion state is intentionally transient and UI-only,
                // and now means something precise: the MASTER is actually playable.
                setBeats(current => {
                  const next = current.map(b =>
                    b.id === detached.id ? { ...detached, cloud_status: "UPLOAD_COMPLETE" } : b
                  );
                  beatsLatestRef.current = next;
                  return next;
                });
              }

              // IMPORTANT: one HTML drop session can contain MANY beats. Never delete
              // the whole drop-staging/<session> just because one beat finished: that
              // would erase the source files of the remaining queued/review beats.
              // Clean orphan sessions only when this background batch is drained and
              // there is no active Review/import decision still depending on staging.
              if (
                backgroundUploadQueueRef.current.length === 0 &&
                reviewQueueLatestRef.current === null &&
                stagedImportPathsRef.current.size === 0
              ) {
                await cleanupOrphanedDropStaging(beatsLatestRef.current);
              }

              if (playbackReady) {
                try {
                  const audio = new Audio(uploadCompleteWav);
                  audio.volume = 0.22;
                  void audio.play().catch(() => {});
                } catch {}

                const oldTimer = uploadCompleteTimersRef.current.get(detached.id);
                if (oldTimer) window.clearTimeout(oldTimer);
                const timer = window.setTimeout(() => {
                  setBeats(current => {
                    const next = current.map(b =>
                      b.id === detached.id && b.cloud_status === "UPLOAD_COMPLETE"
                        ? { ...b, cloud_status: "CLOUD_ONLY" }
                        : b
                    );
                    beatsLatestRef.current = next;
                    return next;
                  });
                  uploadCompleteTimersRef.current.delete(detached.id);
                }, 1050);
                uploadCompleteTimersRef.current.set(detached.id, timer);
              }

            } catch (error) {
              console.warn(`Background Telegram upload failed for ${original.name} at ${uploadStage}:`, error);

              const raw = error instanceof Error
                ? error.message
                : typeof error === "string"
                  ? error
                  : (() => {
                      try { return JSON.stringify(error); }
                      catch { return String(error); }
                    })();

              const lower = raw.toLowerCase();
              let hint = "Unexpected failure. The exact raw error is included below.";
              if (lower.includes("encoder unavailable") || lower.includes("bundled ffmpeg") || lower.includes("could not start wav -> mp3")) {
                hint = "This WAV needs a MASTER MP3, but BeatGaler could not start its bundled MP3 encoder. The installer/build must include ffmpeg; the user should not need to install it manually.";
              } else if (lower.includes("wav -> mp3") || lower.includes("master generation") || lower.includes("conversion failed")) {
                hint = "BeatGaler found the WAV but could not create the temporary 320 kbps MASTER MP3. The raw converter error is shown below.";
              } else if (
                lower.includes("wav source could not be read") ||
                lower.includes("os error 3") ||
                lower.includes("file not found") ||
                lower.includes("no usable audio source") ||
                lower.includes("no longer exists")
              ) {
                hint = "The local source audio disappeared before BeatGaler could upload it. For drag/drop batches this means the temporary drop-staging source is missing; BeatGaler now keeps shared staging alive until every pending/review beat is finished.";
              } else if (lower.includes("temp") || lower.includes("prepare cloud audio copy") || lower.includes("metadata") || lower.includes("id3")) {
                hint = "BeatGaler failed while creating its temporary upload copy or embedding metadata. Check file permissions, free disk space, and whether the source audio is a valid MP3/WAV.";
              } else if (lower.includes("failed to start curl")) {
                hint = "BeatGaler could not start the system HTTP client. On macOS the app now explicitly uses /usr/bin/curl; if this still appears, the system curl executable is unavailable.";
              } else if (lower.includes("could not reach") || lower.includes("timed out") || lower.includes("couldn't connect") || lower.includes("connection")) {
                hint = "BeatGaler could not complete the request to the Cloud server. Check Internet connectivity and that the BeatGaler Cloud server is running.";
              } else if (lower.includes("http 400") || lower.includes("not connected for this beatgaler installation")) {
                hint = "The server received the request but could not verify cloud access for this BeatGaler installation. Sign out and back in, then retry.";
              } else if (lower.includes("413") || lower.includes("too large")) {
                hint = "The server rejected the file because it exceeded the configured upload limit.";
              } else if (lower.includes("invalid json") || lower.includes("<!doctype") || lower.includes("<html")) {
                hint = "The endpoint returned something other than BeatGaler JSON. This can indicate a tunnel/proxy error page or an unexpected server response.";
              } else if (lower.includes("telegram")) {
                hint = "The request reached the cloud portion of the flow. Read the server error below for the exact rejection.";
              }

              const detail = [
                "UPLOAD FAILED",
                `Beat: ${original.name}`,
                `Stage: ${uploadStage}`,
                `Platform: ${navigator.platform || "unknown"}`,
                "",
                hint,
                "",
                `Raw error: ${raw || "Unknown error"}`,
              ].join("\n");

              if (!syncCommitted) {
                transitionRuntime(original.id, {
                  type: "SYNC_FAILED",
                  code: "UPLOAD_FAILED",
                  message: detail,
                  retryable: true,
                }, original);
              } else {
                const runtime = beatRuntimeStatesRef.current[original.id];
                if (runtime?.playback_state === "playback_preparing") {
                  transitionRuntime(original.id, {
                    type: "PLAYBACK_FAILED",
                    code: "PLAYBACK_PREPARATION_FAILED",
                    message: detail,
                    retryable: true,
                  }, original);
                }
              }
              setBackgroundUploadErrors(current => ({ ...current, [original.id]: detail }));
              setBeats(current => current.map(b =>
                b.id === original.id
                  ? {
                      ...b,
                      // If Telegram already has every required slot, expose the
                      // durable cloud state even when local cleanup/finalization failed.
                      cloud_status: remoteUploadCompleted ? "CLOUD_ONLY" : "ERROR",
                    }
                  : b
              ));
            } finally {
              autoCloudUploadRef.current.delete(original.id);
            }

            // Yield between beats so React/WebView always gets a render opportunity.
            await new Promise<void>(resolve => window.setTimeout(resolve, 0));
          }

        } finally {
          backgroundUploadRunningRef.current = false;
          if (deferredLibraryReloadRef.current) {
            deferredLibraryReloadRef.current = false;
            window.dispatchEvent(new Event("beatgaler:deferred-library-reload"));
          }
        }
      })();
    }, 0);
  }, [transitionRuntime, waitForUploadedBeatPlaybackReady, waitForCloudSessionWithBackoff]);

  const retryBackgroundUpload = useCallback((beat: Beat) => {
    if (rejectOfflineMutation("Retrying an upload")) return;
    setBackgroundUploadErrors(current => {
      if (!(beat.id in current)) return current;
      const next = { ...current };
      delete next[beat.id];
      return next;
    });
    // cloudifyImportedBeats is checkpoint-aware: an existing MASTER/WAV/PROJECT
    // is detected in Telegram and skipped, so retry resumes at the first missing
    // stage instead of uploading the whole beat again.
    cloudifyImportedBeats([{ ...beat, cloud_status: "UPLOADING" }]);
  }, [cloudifyImportedBeats, rejectOfflineMutation]);

  const addBeatsAndReview = useCallback((newBeats: Beat[]) => {
    if (newBeats.length === 0) return;
    if (connectionState !== "online") {
      void appAlert({
        title: "Internet connection required",
        message: "BeatGaler does not import new beats while offline. Reconnect and import them again.",
      });
      void cleanupOrphanedDropStaging(beatsLatestRef.current);
      return;
    }
    const sanitized = newBeats.map(beat => ({ ...beat, tags: cleanTags(beat.tags || []).tags }));

    // Review candidates are NOT library beats yet.
    // Keeping them out of `beats` means:
    // 1) Cancel leaves absolutely nothing behind.
    // 2) duplicate-name checks compare only against committed library items.
    // 3) a re-dropped folder can never masquerade as an edit of the existing beat.
    setShowAdd(false);
    setReviewQueue({ beats: sanitized, index: 0, total: sanitized.length, batchId: null, preparing: false });
    // Upload begins only after Review → Save.
  }, [connectionState]);

  const skipCurrentReviewBeat = useCallback(() => {
    setReviewQueue(q => {
      if (!q) return null;
      const currentBeat = q.beats[q.index];
      const sourceKey = currentBeat ? reviewSourceKey(currentBeat) : "";
      if (sourceKey) skippedReviewSourceKeysRef.current.add(sourceKey);

      const knownLast = q.total !== null && q.index >= q.total - 1;
      if (knownLast && !q.preparing) {
        // Skip means ONLY this beat. The global Cancel Import action is separate.
        window.setTimeout(() => {
          void cleanupOrphanedDropStaging([
            ...beatsLatestRef.current,
            ...backgroundUploadQueueRef.current,
          ]);
        }, 0);
        return null;
      }
      // If discovery is still running, advance into a skeleton for Beat N+1.
      // The streaming worker will fill that exact slot as soon as it finds it.
      return { ...q, index: q.index + 1 };
    });
  }, []);

  const skipAllReviewQueue = useCallback(() => {
    importReviewRequestRunRef.current += 1;
    reviewPreparationRunRef.current += 1;
    reviewPreparationPromiseRef.current = null;
    skippedReviewSourceKeysRef.current.clear();
    setReviewPreparationDone(true);
    setReviewBootstrap(null);
    setAudioConflictBatch(null);
    setDeferredImportBatch(current => {
      if (current?.batch_id) void discardImportReviewBatch(current.batch_id);
      return null;
    });

    // Cancel means cancel the current review batch, not silently "skip" it.
    // Beats already saved before the current position stay in the library;
    // the current + remaining unsaved review candidates are removed.
    setReviewQueue(q => {
      if (!q) return null;
      if (q.batchId) void discardImportReviewBatch(q.batchId);
      window.setTimeout(() => {
        const protectedBeats = [
          ...beatsLatestRef.current,
          ...backgroundUploadQueueRef.current,
        ];
        void cleanupOrphanedDropStaging(protectedBeats);
      }, 0);
      return null;
    });
  }, []);

  const handleReviewedBeatSaved = useCallback((updated: Beat) => {
    setBeats(bs => {
      const exists = bs.some(b => b.id === updated.id);
      const next = exists
        ? bs.map(b => b.id === updated.id ? updated : b)
        : [updated, ...bs];
      beatsLatestRef.current = next;
      return next;
    });
    setReviewQueue(q => {
      if (!q) return null;
      const nextBeats = q.beats.map(b => b.id === updated.id ? updated : b);
      const knownLast = q.total !== null && q.index >= q.total - 1;
      if (knownLast && !q.preparing) return null;
      return { ...q, beats: nextBeats, index: q.index + 1 };
    });

    // Fire-and-forget. Save/next closes immediately; Telegram work is secondary.
    cloudifyImportedBeats([updated]);
  }, [cloudifyImportedBeats]);

  const handleReviewedSaveAll = useCallback(async (currentUpdated: Beat) => {
    const queue = reviewQueueLatestRef.current;
    if (!queue) return;
    const startIndex = queue.index;
    setBulkSaveAllBusy(true);

    // Save All is a UX command, not a request to wait for Review preparation.
    // Close Review immediately, commit the current beat, then let the same
    // sequential worker finish metadata for the remaining beats in background.
    setReviewQueue(null);
    setBeats(current => {
      const exists = current.some(item => item.id === currentUpdated.id);
      const next = exists
        ? current.map(item => item.id === currentUpdated.id ? currentUpdated : item)
        : [currentUpdated, ...current];
      beatsLatestRef.current = next;
      return next;
    });
    cloudifyImportedBeats([currentUpdated]);

    let allPrepared = queue.beats;
    if (reviewPreparationPromiseRef.current) {
      try {
        allPrepared = await reviewPreparationPromiseRef.current;
      } catch (error) {
        // The background preparer already surfaces the real error. Save All
        // must still keep already-prepared beats usable instead of rejecting
        // the whole batch promise.
        console.warn("Save All continued with already-prepared beats:", error);
        allPrepared = reviewQueueLatestRef.current?.beats ?? queue.beats;
      }
    }
    const remaining = allPrepared.slice(startIndex + 1);
    const committed: Beat[] = [];
    const nameConflicts: Beat[] = [];

    const queueIds = new Set(allPrepared.map(item => item.id));
    const reservedNames = new Set(
      beatsLatestRef.current
        .filter(item => !queueIds.has(item.id) && item.id !== currentUpdated.id)
        .map(item => item.name.trim().toLocaleLowerCase())
        .filter(Boolean)
    );
    const currentName = currentUpdated.name.trim().toLocaleLowerCase();
    if (currentName) reservedNames.add(currentName);

    for (const beat of remaining) {
      const nameKey = beat.name.trim().toLocaleLowerCase();
      if (nameKey && reservedNames.has(nameKey)) {
        // Duplicate review candidates are not auto-renamed. They are moved to
        // the end so Save All remains fast and the user can choose a real name.
        nameConflicts.push(beat);
        continue;
      }
      if (nameKey) reservedNames.add(nameKey);

      try {
        const bpmCheck = validateBpm(beat.bpm);
        const keyCheck = validateMusicKey(beat.key);
        if (bpmCheck.valid === false) throw new Error(`${beat.name}: ${bpmCheck.reason}`);
        if (keyCheck.valid === false) throw new Error(`${beat.name}: ${keyCheck.reason}`);

        const cleaned = cleanTags(beat.tags);
        const normalized: Beat = {
          ...beat,
          tags: cleaned.tags,
          bpm: bpmCheck.normalized,
          key: keyCheck.normalized,
        };

        const result = await saveBeatMeta({
          mp3_path: normalized.mp3_path,
          wav_path: normalized.wav_path,
          bpm: normalized.bpm,
          key: normalized.key,
          tags: normalized.tags,
          rating: normalized.rating,
          image_base64: normalized.image_base64,
          image_preview_base64: normalized.image_preview_base64 ?? null,
          image_crop: normalized.image_crop ?? null,
          update_filename: normalized.bpm !== beat.bpm || normalized.key !== beat.key,
        });

        committed.push({
          ...normalized,
          mp3_path: result.new_mp3_path || normalized.mp3_path,
          wav_path: result.new_wav_path ?? normalized.wav_path,
          playback_path: result.new_mp3_path || normalized.mp3_path || normalized.playback_path,
        });
      } catch (error) {
        console.warn(`Save All could not commit ${beat.name}:`, error);
        nameConflicts.push(beat);
      }

      // Keep WebView responsive even when hundreds of beats are selected.
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }

    if (committed.length > 0) {
      const committedIds = new Set(committed.map(beat => beat.id));
      setBeats(current => {
        const next = [
          ...committed,
          ...current.filter(beat => !committedIds.has(beat.id)),
        ];
        beatsLatestRef.current = next;
        return next;
      });
      cloudifyImportedBeats(committed);
    }

    // Local duplicate/validation conflicts are intentionally last and reopen
    // Review instead of blocking the whole Save All batch.
    if (nameConflicts.length > 0) {
      setReviewQueue({ beats: nameConflicts, index: 0, total: nameConflicts.length, batchId: queue.batchId, preparing: false });
    }
    setBulkSaveAllBusy(false);
  }, [cloudifyImportedBeats]);

  const importDroppedPaths = useCallback(async (paths: string[]) => {
    if (rejectOfflineMutation("Importing beats")) return;
    const normalized = Array.from(new Set(paths.map(p => p.trim()).filter(Boolean)));
    if (normalized.length === 0 || dropImporting) return;

    const dropStarted = performance.now();
    const diagRun = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    reviewPerfMark(`run=${diagRun} IMPORT_BEGIN path_count=${normalized.length} names=${normalized.map(fileNameFromPath).slice(0, 12).join("|")}`);
    const requestRunId = ++importReviewRequestRunRef.current;
    setDropImporting(true);
    setReviewPreparationDone(false);
    setDeferredImportBatch(null);
    setAudioConflictBatch(null);
    setDropImportBatch(null);
    skippedReviewSourceKeysRef.current.clear();
    if (REVIEW_SKELETON_ENABLED) {
      setReviewBootstrap({ total: null });
      reviewPerfMark(`run=${diagRun} SKELETON_STATE_REQUESTED elapsed_ms=${Math.round(performance.now() - dropStarted)}`);
      requestAnimationFrame(() => reviewPerfMark(`run=${diagRun} SKELETON_FRAME elapsed_ms=${Math.round(performance.now() - dropStarted)}`));
    }
    console.info("[review-perf] DROP_RECEIVED 0 ms");

    try {
      // IMPORTANT: this creates only a cursor. It does not recursively scan the
      // batch, count every beat, or inspect projects. That work is streamed by
      // prepareNextImportReviewBeat one beat at a time.
      reviewPerfMark(`run=${diagRun} STREAM_INVOKE_START elapsed_ms=${Math.round(performance.now() - dropStarted)}`);
      const stream = await startImportReviewStream(normalized);
      reviewPerfMark(`run=${diagRun} STREAM_INVOKE_END elapsed_ms=${Math.round(performance.now() - dropStarted)} batch=${stream.batch_id}`);
      if (importReviewRequestRunRef.current !== requestRunId) {
        void discardImportReviewBatch(stream.batch_id);
        return;
      }
      stagedImportPathsRef.current.set(stream.batch_id, normalized);
      console.info(`[review-perf] STREAM_READY ${Math.round(performance.now() - dropStarted)} ms`);

      // Critical path: discover only until the FIRST normal playable audio is
      // found, read its metadata/artwork, and stop. N intentionally remains
      // unknown until the background worker reaches the end of the tree.
      reviewPerfMark(`run=${diagRun} FIRST_PREPARE_INVOKE_START elapsed_ms=${Math.round(performance.now() - dropStarted)}`);
      const firstStep = await prepareNextImportReviewBeat(stream.batch_id);
      reviewPerfMark(`run=${diagRun} FIRST_PREPARE_INVOKE_END elapsed_ms=${Math.round(performance.now() - dropStarted)} has_beat=${Boolean(firstStep.beat)} discovery_complete=${firstStep.discovery_complete}`);
      if (importReviewRequestRunRef.current !== requestRunId) {
        stagedImportPathsRef.current.delete(stream.batch_id);
        void discardImportReviewBatch(stream.batch_id);
        return;
      }

      const first = firstStep.beat
        ? { ...firstStep.beat, tags: cleanTags(firstStep.beat.tags || []).tags }
        : null;

      if (first) {
        setShowAdd(false);
        setReviewQueue({
          beats: [first],
          index: 0,
          total: firstStep.total_normal,
          batchId: stream.batch_id,
          preparing: !firstStep.discovery_complete,
        });
        reviewPerfMark(`run=${diagRun} FIRST_REVIEW_STATE_SET elapsed_ms=${Math.round(performance.now() - dropStarted)} beat=${first.name}`);

        // Diagnostic paint barrier: do not let Beat 2..N work begin until the
        // first Review drawer had a real browser frame. This both proves whether
        // background preparation was starving the first paint and guarantees the
        // skeleton hands off directly to the real drawer with no blank flash.
        await new Promise<void>(resolve => {
          requestAnimationFrame(() => {
            reviewPerfMark(`run=${diagRun} FIRST_REVIEW_FRAME elapsed_ms=${Math.round(performance.now() - dropStarted)} beat=${first.name}`);
            resolve();
          });
        });
        setReviewBootstrap(null);
        reviewPerfMark(`run=${diagRun} BACKGROUND_ALLOWED elapsed_ms=${Math.round(performance.now() - dropStarted)}`);
        console.info(`[review-perf] FIRST_REVIEW_READY ${Math.round(performance.now() - dropStarted)} ms`);
      } else if (firstStep.discovery_complete) {
        const summary = await getImportReviewBatchSummary(stream.batch_id);
        setDeferredImportBatch(summary);
        setReviewBootstrap(null);
        setReviewPreparationDone(true);
        if (summary.audio_conflicts.length > 0) {
          setAudioConflictBatch(summary);
        } else if (summary.pending.length > 0) {
          setDropImportBatch(summary);
        } else {
          stagedImportPathsRef.current.delete(stream.batch_id);
          setDeferredImportBatch(null);
          await discardImportReviewBatch(stream.batch_id);
          await appAlert({ title: "Nothing to import", message: "No playable beats were found in the dropped files." });
        }
        return;
      }

      const runId = ++reviewPreparationRunRef.current;
      const preparation = (async () => {
        const prepared: Beat[] = first ? [first] : [];
        let step = firstStep;

        // Continue exactly where Rust stopped. Each invoke searches only until
        // the next normal beat, prepares that beat, then yields to the UI.
        while (!step.discovery_complete && reviewPreparationRunRef.current === runId && importReviewRequestRunRef.current === requestRunId) {
          await new Promise<void>(resolve => window.setTimeout(resolve, 0));
          const bgIndex = prepared.length + 1;
          const bgStarted = performance.now();
          reviewPerfMark(`run=${diagRun} BACKGROUND_PREPARE_START n=${bgIndex} elapsed_ms=${Math.round(bgStarted - dropStarted)}`);
          step = await prepareNextImportReviewBeat(stream.batch_id);
          reviewPerfMark(`run=${diagRun} BACKGROUND_PREPARE_END n=${bgIndex} step_ms=${Math.round(performance.now() - bgStarted)} elapsed_ms=${Math.round(performance.now() - dropStarted)} has_beat=${Boolean(step.beat)} done=${step.discovery_complete}`);
          if (reviewPreparationRunRef.current !== runId || importReviewRequestRunRef.current !== requestRunId) break;

          if (step.beat) {
            const nextBeat = { ...step.beat, tags: cleanTags(step.beat.tags || []).tags };
            prepared.push(nextBeat);
            const sourceKey = reviewSourceKey(nextBeat);
            setReviewQueue(q => {
              if (!q || q.batchId !== stream.batch_id) return q;
              if (sourceKey && skippedReviewSourceKeysRef.current.has(sourceKey)) return {
                ...q,
                total: step.total_normal ?? q.total,
                preparing: !step.discovery_complete,
              };
              if (sourceKey && q.beats.some(item => reviewSourceKey(item) === sourceKey)) return q;
              return {
                ...q,
                beats: [...q.beats, nextBeat],
                total: step.total_normal ?? q.total,
                preparing: !step.discovery_complete,
              };
            });
          }
        }

        if (reviewPreparationRunRef.current !== runId || importReviewRequestRunRef.current !== requestRunId) {
          return prepared;
        }

        const summary = await getImportReviewBatchSummary(stream.batch_id);
        setDeferredImportBatch(summary);
        setReviewPreparationDone(true);
        console.info(`[review-perf] DISCOVERY_FINISHED ${Math.round(performance.now() - dropStarted)} ms (${summary.normal_count} normal, ${summary.audio_conflicts.length} conflict)`);
        reviewPerfMark(`run=${diagRun} DISCOVERY_FINISHED elapsed_ms=${Math.round(performance.now() - dropStarted)} normal=${summary.normal_count} conflicts=${summary.audio_conflicts.length}`);

        setReviewQueue(q => {
          if (!q || q.batchId !== stream.batch_id) return q;
          // The user may have already Saved/Skipped the last currently-known beat
          // while discovery was still running. Once N is known, close any cursor
          // that is already past the end instead of leaving an eternal skeleton.
          if (q.index >= summary.normal_count) return null;
          return { ...q, total: summary.normal_count, preparing: false };
        });
        return prepared;
      })();
      reviewPreparationPromiseRef.current = preparation;

      void preparation.catch(async error => {
        console.error("Background streaming Review preparation failed:", error);
        if (reviewPreparationRunRef.current === runId && importReviewRequestRunRef.current === requestRunId) {
          setReviewPreparationDone(true);
          setReviewQueue(q => q && q.batchId === stream.batch_id ? { ...q, preparing: false } : q);
          setReviewBootstrap(null);
          await appAlert({ title: "Review preparation failed", message: String(error), danger: true });
        }
      });

    } catch (error) {
      reviewPerfMark(`run=${diagRun} IMPORT_ERROR elapsed_ms=${Math.round(performance.now() - dropStarted)} error=${String(error)}`);
      console.error(error);
      setReviewBootstrap(null);
      setReviewPreparationDone(true);
      await appAlert({ title: "Import failed", message: `Could not import the dropped files: ${String(error)}`, danger: true });
    } finally {
      setDropImporting(false);
      setDropActive(false);
    }
  }, [dropImporting, rejectOfflineMutation]);

  useEffect(() => {
    if (!deferredImportBatch || !reviewPreparationDone || bulkSaveAllBusy) return;
    if (reviewBootstrap || reviewQueue || audioConflictBatch || dropImportBatch) return;

    if (deferredImportBatch.audio_conflicts.length > 0) {
      setAudioConflictBatch(deferredImportBatch);
      return;
    }
    if (deferredImportBatch.pending.length > 0) {
      setDropImportBatch(deferredImportBatch);
      return;
    }

    const batchId = deferredImportBatch.batch_id;
    stagedImportPathsRef.current.delete(batchId);
    setDeferredImportBatch(null);
    void discardImportReviewBatch(batchId);
  }, [deferredImportBatch, reviewPreparationDone, bulkSaveAllBusy, reviewBootstrap, reviewQueue, audioConflictBatch, dropImportBatch]);

  const refreshOpenableCloudProjects = useCallback(async () => {
    try {
      const t = await import("./lib/tauri");
      const ids = await t.listOpenableCloudProjectBeatIds();
      setOpenableCloudProjectIds(new Set(ids));
    } catch (error) {
      console.warn("Could not refresh Open Project indicators", error);
    }
  }, []);

  useEffect(() => {
    void refreshOpenableCloudProjects();
  }, [beats, refreshOpenableCloudProjects]);


  useEffect(() => {
    const refresh = () => { void refreshOpenableCloudProjects(); };
    window.addEventListener("beatgaler:project-cloud-changed", refresh);
    window.addEventListener("beatgaler:project-cloud-updated", refresh);
    return () => {
      window.removeEventListener("beatgaler:project-cloud-changed", refresh);
      window.removeEventListener("beatgaler:project-cloud-updated", refresh);
    };
  }, [refreshOpenableCloudProjects]);


  const updateExistingBeatFromFolder = useCallback(async (beat: Beat, folderPath: string): Promise<boolean> => {
    if (rejectOfflineMutation("Updating beat files")) return true;
    if (isBackupFolderPath(folderPath)) {
      await appAlert({
        title: "Backup folder skipped",
        message: "BeatGaler keeps Backup/Backups folders out of PROJECT.zip so old project copies are not uploaded.",
      });
      return true;
    }

    const t = await import("./lib/tauri");

    let preview;
    try {
      preview = await t.inspectBeatUpdateFolder(folderPath);
    } catch {
      return false;
    }

    let replaceMaster = false;
    if (preview.has_mp3) {
      const alreadyHasMaster = Boolean(beat.telegram_file_id) || Boolean(beat.mp3_path?.trim());
      if (alreadyHasMaster) {
        const incoming = preview.mp3_filename || "the incoming MP3";
        const confirmed = window.confirm(
          `Replace current MASTER for "${beat.name}"?\n\n` +
          `${incoming} will become the new MASTER.\n` +
          `Its BPM, key, tags, rating and artwork will replace the current metadata.\n\n` +
          `WAV and project files from this folder will also be added or updated.`
        );
        if (!confirmed) return true;
      }
      replaceMaster = true;
    }

    setBeatCloudUpdateBusy(beat.id, true);
    const runtime = beatRuntimeStatesRef.current[beat.id] ?? createBeatRuntimeState(beat);
    if (runtime.sync_state === "synced") transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }, beat);
    transitionRuntime(beat.id, { type: "SYNC_UPDATE_STARTED" }, beat);
    try {
      let updated = await t.mergeFolderIntoExistingBeat(beat, folderPath, replaceMaster);
      setBeats(bs => bs.map(b => b.id === beat.id ? updated : b));

      if (replaceMaster) {
        updated = await t.uploadBeatToTelegram(updated);
        setBeats(bs => bs.map(b => b.id === beat.id ? updated : b));
      }

      if (preview.has_wav && updated.wav_path) {
        await t.uploadDroppedFileToTelegram(updated, updated.wav_path, "WAV");
      }

      if (preview.has_project_assets) {
        await t.uploadProjectToTelegram(updated);
      }

      if (replaceMaster && updated.telegram_file_id) {
        await t.syncBeatMetadataToTelegram(updated);
      }

      await refreshOpenableCloudProjects();
      await libraryStateManager.commitSnapshot(beatsLatestRef.current.map(item => item.id === beat.id ? updated : item), "metadata-update");
      transitionRuntime(beat.id, { type: "SYNC_UPDATE_SUCCEEDED" }, updated);
      setBeats(bs => bs.map(b => b.id === beat.id ? updated : b));
      return true;
    } catch (error) {
      console.error(error);
      const message = runtimeErrorMessage(error);
      if (isRuntimeConflictError(error)) transitionRuntime(beat.id, { type: "SYNC_CONFLICT", message }, beat);
      else transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "FOLDER_UPDATE_FAILED", message, retryable: true }, beat);
      alert(`Could not update "${beat.name}" from the dropped folder: ${message}`);
      return true;
    } finally {
      setBeatCloudUpdateBusy(beat.id, false);
    }
  }, [refreshOpenableCloudProjects, rejectOfflineMutation, transitionRuntime]);

  useEffect(() => {
    if (connectionState !== "online" || !cloudSessionVerified) return;
    const next = new Map<string, string>();
    for (const beat of beats) {
      if (!beat.telegram_file_id) continue;
      next.set(beat.id, cloudBeatFingerprint(beat));
    }

    const previous = cloudMetaSnapshotRef.current;
    cloudMetaSnapshotRef.current = next;
    if (previous === null) return;

    for (const beat of beats) {
      if (!beat.telegram_file_id) continue;
      const currentSnapshot = next.get(beat.id)!;
      if (previous.get(beat.id) === currentSnapshot) continue;

      const runtime = beatRuntimeStatesRef.current[beat.id] ?? createBeatRuntimeState(beat);
      if (runtime.sync_state === "synced") transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }, beat);

      const oldTimer = cloudMetaTimersRef.current.get(beat.id);
      if (oldTimer) window.clearTimeout(oldTimer);

      const timer = window.setTimeout(() => {
        cloudMetaTimersRef.current.delete(beat.id);
        const latestBeat = beatsLatestRef.current.find(item => item.id === beat.id) ?? beat;
        const latestRuntime = beatRuntimeStatesRef.current[beat.id] ?? createBeatRuntimeState(latestBeat);
        if (latestRuntime.sync_state === "pending_update") {
          transitionRuntime(beat.id, { type: "SYNC_UPDATE_STARTED" }, latestBeat);
        }

        void (async () => {
          try {
            await syncBeatMetadataToTelegram(latestBeat);

            // Metadata/artwork is one logical cloud transaction. Publish the
            // authoritative INDEX immediately after the artwork upload so the
            // new artwork reference becomes durable before the old artwork
            // message is reclaimed. This also prevents Refresh from observing
            // the old index after the UI already shows the new cover.
            const indexSnapshot = beatsLatestRef.current.map(item =>
              item.id === latestBeat.id ? latestBeat : item
            );
            await libraryStateManager.commitSnapshot(indexSnapshot, "upload-batch");

            // The explicit transaction above owns this commit. Cancel any
            // trailing observer timer/event that was scheduled by the artwork
            // upload itself, then seed both snapshots with the committed view
            // so it cannot produce a duplicate INDEX a moment later.
            if (cloudLibraryTimerRef.current) {
              window.clearTimeout(cloudLibraryTimerRef.current);
              cloudLibraryTimerRef.current = null;
            }
            cloudLibrarySnapshotRef.current = indexSnapshot
              .filter(item => !!item.telegram_file_id)
              .map(cloudBeatFingerprint)
              .join("\u001c");
            cloudMetaSnapshotRef.current?.set(latestBeat.id, cloudBeatFingerprint(latestBeat));

            const after = beatRuntimeStatesRef.current[beat.id];
            if (after?.sync_state === "updating") transitionRuntime(beat.id, { type: "SYNC_UPDATE_SUCCEEDED" }, latestBeat);
          } catch (error) {
            console.warn("Telegram metadata sync failed:", error);
            const message = runtimeErrorMessage(error);
            const after = beatRuntimeStatesRef.current[beat.id];
            if (after?.sync_state === "updating" || after?.sync_state === "pending_update") {
              if (isRuntimeConflictError(error)) transitionRuntime(beat.id, { type: "SYNC_CONFLICT", message }, latestBeat);
              else transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "METADATA_SYNC_FAILED", message, retryable: true }, latestBeat);
            }
          }
        })();
      }, 700);
      cloudMetaTimersRef.current.set(beat.id, timer);
    }
  }, [beats, connectionState, cloudSessionVerified, transitionRuntime]);

  useEffect(() => () => {
    for (const timer of cloudMetaTimersRef.current.values()) window.clearTimeout(timer);
    cloudMetaTimersRef.current.clear();
  }, []);

  // V7: INDEX writes are explicit transactions only.
  // There is deliberately no generic "beats changed => rewrite Telegram" observer.
  // Upload, metadata, Trash/Restore and project/file operations commit through
  // libraryStateManager at their actual logical commit boundary. This prevents
  // render/cache hydration from becoming an accidental cloud mutation.

  const handleDisconnectTelegramAccount = useCallback(async () => {
    await logoutBeatGalerAccount().catch(() => {});
    releaseFile();
    progressiveRevealRunRef.current += 1;
    cookingPlaybackUrlRef.current.clear();
    cookingWarmPromisesRef.current.clear();
    artworkLoadPromisesRef.current.clear();
    setRevealedBeatIds(new Set());
    setCloudSessionVerified(false);
    setBeats([]);
    setSelectedIds(new Set());
    setSettings(current => current ? { ...current, telegram_cloud_connected: false, telegram_cloud_username: null } : current);
  }, [releaseFile]);

  const updateBeat = useCallback((updated: Beat) => {
    if (updated.telegram_file_id && connectionState === "online") {
      const runtime = beatRuntimeStatesRef.current[updated.id] ?? createBeatRuntimeState(updated);
      if (runtime.sync_state === "synced") transitionRuntime(updated.id, { type: "SYNC_QUEUE_UPDATE" }, updated);
    }
    setBeats(bs => bs.map(b => b.id === updated.id ? updated : b));
    if (drawer?.beat.id === updated.id) setDrawer(d => d ? { ...d, beat: updated } : null);
  }, [connectionState, drawer, transitionRuntime]);

  const handleToggleOffline = useCallback(async (beat: Beat) => {
    if (offlineBusyIds.has(beat.id)) return;
    if (!beat.offline_available && connectionState !== "online") {
      await appAlert({ title: "Internet required", message: "Connect to the internet once to download this beat for Offline mode." });
      return;
    }

    setOfflineBusyIds(current => new Set(current).add(beat.id));
    let offlineOwnsDownloadState = false;
    if (!beat.offline_available) {
      const runtime = beatRuntimeStatesRef.current[beat.id] ?? createBeatRuntimeState(beat);
      if (runtime.download_state !== "downloading") {
        transitionRuntime(beat.id, { type: "DOWNLOAD_STARTED" }, beat);
        offlineOwnsDownloadState = true;
      }
    }
    try {
      if (beat.offline_available) {
        // The Offline fast path may have memoized the durable MASTER path under
        // the same telegram_file_id used by the cloud beat. Remove that memo
        // before deleting the package or the next Play would reuse a dead local
        // file and incorrectly report the Cloud MASTER as unavailable.
        if (audio.playingId === beat.id) releaseFile();
        cookingPlaybackUrlRef.current.delete(beat.id);
        cookingWarmPromisesRef.current.delete(beat.id);

        await removeBeatOfflineAvailability(beat.id);
        transitionRuntime(beat.id, { type: "SET_OFFLINE_AVAILABLE", available: false }, beat);

        if (connectionState !== "online") {
          // In an Offline-only library, removing the durable package means the
          // beat is no longer eligible to be shown at all. Remove the card in
          // the same transaction instead of leaving a visible but unusable beat.
          setBeats(current => current.filter(item => item.id !== beat.id));
          setRevealedBeatIds(current => {
            const next = new Set(current);
            next.delete(beat.id);
            return next;
          });
        } else {
          // Rehydrate the canonical cloud-backed BeatMeta after removing the
          // durable package. This clears any offline-only mp3/project paths that
          // may have come from a cold Offline start while preserving Telegram as
          // the source of truth. loadLibrary() is local SQLite work only.
          let cloudBeat: Beat = { ...beat, offline_available: false, playback_path: "" };
          try {
            const canonical = await loadLibrary();
            cloudBeat = canonical.find(item => item.id === beat.id) ?? cloudBeat;
          } catch (error) {
            console.warn("Could not rehydrate cloud beat after removing Offline availability:", error);
          }
          setBeats(current => current.map(item => item.id === beat.id ? { ...cloudBeat, offline_available: false } : item));

          // Re-enter Download Cooking immediately while online. This is only a
          // lightweight enqueue; it prevents the first post-Remove Play from
          // racing an old Offline source and restores the normal cloud fast path.
          if (cloudBeat.telegram_file_id) {
            void ensureWarmPlaybackUrl({ ...cloudBeat, offline_available: false });
          }
        }
      } else {
        const offline = await makeBeatAvailableOffline(beat);
        if (offlineOwnsDownloadState) transitionRuntime(beat.id, { type: "DOWNLOAD_SUCCEEDED" }, offline);
        transitionRuntime(beat.id, { type: "SET_OFFLINE_AVAILABLE", available: true }, offline);
        setBeats(current => current.map(item => item.id === beat.id ? {
          ...item,
          offline_available: true,
          image_base64: item.image_base64 || offline.image_base64,
          image_preview_base64: item.image_preview_base64 || offline.image_preview_base64,
        } : item));
        try {
          const audio = new Audio(downloadCompleteWav);
          audio.volume = 0.68;
          void audio.play().catch(() => {});
        } catch {}
      }
    } catch (error) {
      const message = runtimeErrorMessage(error);
      if (offlineOwnsDownloadState) {
        transitionRuntime(beat.id, { type: "DOWNLOAD_FAILED", code: "OFFLINE_DOWNLOAD_FAILED", message, retryable: true }, beat);
      }
      await appAlert({
        title: beat.offline_available ? "Could not remove offline copy" : "Offline download failed",
        message,
        danger: true,
      });
    } finally {
      setOfflineBusyIds(current => {
        const next = new Set(current);
        next.delete(beat.id);
        return next;
      });
    }
  }, [audio.playingId, connectionState, ensureWarmPlaybackUrl, offlineBusyIds, releaseFile, transitionRuntime]);

  const handleDropArtwork = useCallback(async (beat: Beat, imageBase64: string) => {
    if (rejectOfflineMutation("Changing artwork")) return;
    // Artwork is an explicit cloud transaction. Decoding/loading artwork is no
    // longer part of cloudBeatFingerprint, so only a real user artwork change
    // reaches Telegram here. Order is intentionally:
    //   upload new artwork -> commit new INDEX -> helper deletes old artwork.
    await saveBeatMeta({
      mp3_path: beat.mp3_path,
      wav_path: beat.wav_path,
      bpm: beat.bpm,
      key: beat.key,
      tags: beat.tags,
      rating: beat.rating,
      image_base64: imageBase64,
      update_filename: false,
    });

    const updated = { ...beat, image_base64: imageBase64, image_preview_base64: null };
    updateBeat(updated);

    if (updated.telegram_file_id && connectionState === "online" && cloudSessionVerified) {
      const runtime = beatRuntimeStatesRef.current[updated.id] ?? createBeatRuntimeState(updated);
      if (runtime.sync_state === "synced") transitionRuntime(updated.id, { type: "SYNC_QUEUE_UPDATE" }, updated);
      transitionRuntime(updated.id, { type: "SYNC_UPDATE_STARTED" }, updated);
      try {
        await syncBeatMetadataToTelegram(updated);
        const indexSnapshot = beatsLatestRef.current.map(item => item.id === updated.id ? updated : item);
        await libraryStateManager.commitSnapshot(indexSnapshot, "upload-batch");

        // This explicit transaction owns the INDEX commit. Prevent the generic
        // library observer/cloud-file event from immediately writing it again.
        if (cloudLibraryTimerRef.current) {
          window.clearTimeout(cloudLibraryTimerRef.current);
          cloudLibraryTimerRef.current = null;
        }
        cloudLibrarySnapshotRef.current = indexSnapshot
          .filter(item => !!item.telegram_file_id)
          .map(cloudBeatFingerprint)
          .join("\u001c");
        cloudMetaSnapshotRef.current?.set(updated.id, cloudBeatFingerprint(updated));
        transitionRuntime(updated.id, { type: "SYNC_UPDATE_SUCCEEDED" }, updated);
      } catch (error) {
        const message = runtimeErrorMessage(error);
        transitionRuntime(updated.id, { type: "SYNC_FAILED", code: "ARTWORK_SYNC_FAILED", message, retryable: true }, updated);
        throw error;
      }
    }
  }, [updateBeat, rejectOfflineMutation, connectionState, cloudSessionVerified, transitionRuntime]);


  const runBeatCloudUpdate = useCallback((beat: Beat, filePath: string, work: () => Promise<void>) => {
    if (rejectOfflineMutation("Updating beat files")) {
      setBeatFileDrop(null);
      void cleanupStagedDropPaths([filePath]);
      return;
    }
    // Once the user chose a destination, the chooser is done. The long Telegram/
    // ZIP task belongs to the beat card, not to a blocking modal.
    setBeatFileDrop(null);
    setBeatCloudUpdateBusy(beat.id, true);
    const before = beatRuntimeStatesRef.current[beat.id] ?? createBeatRuntimeState(beat);
    if (before.sync_state === "synced") transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }, beat);
    transitionRuntime(beat.id, { type: "SYNC_UPDATE_STARTED" }, beat);

    void (async () => {
      let succeeded = false;
      try {
        await work();
        transitionRuntime(beat.id, { type: "SYNC_UPDATE_SUCCEEDED" }, beat);
        succeeded = true;
        setBeatCloudUpdateBusy(beat.id, false, true);
        try {
          const audio = new Audio(uploadCompleteWav);
          audio.volume = 0.72;
          void audio.play().catch(() => {});
        } catch {}
      } catch (error) {
        console.error(error);
        const message = runtimeErrorMessage(error);
        if (isRuntimeConflictError(error)) transitionRuntime(beat.id, { type: "SYNC_CONFLICT", message }, beat);
        else transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "BEAT_UPDATE_FAILED", message, retryable: true }, beat);
        setBeatCloudUpdateBusy(beat.id, false, false);
        await appAlert({ title: "Beat update failed", message, danger: true });
      } finally {
        // Drag/drop roots are private staging copies. The user can keep working
        // while the task runs, then the staging is reclaimed regardless of outcome.
        await cleanupStagedDropPaths([filePath]).catch(() => {});
        if (!succeeded) setBeatCloudUpdateBusy(beat.id, false, false);
      }
    })();
  }, [rejectOfflineMutation, transitionRuntime]);

  const hasStoredProject = useCallback(async (beat: Beat) => {
    const status = await getProjectCloudStatus(beat);
    return status.valid || status.part_count > 0 || status.local_exists || status.state !== "LOCAL";
  }, []);

  const startProjectAssetUpdate = useCallback((beat: Beat, filePath: string, kind: "projectFile" | "projectFolder") => {
    runBeatCloudUpdate(beat, filePath, async () => {
      // A normal project folder may contain old Backup/Backups directories. They
      // are filtered from PROJECT.zip, but tell the user after the successful
      // update instead of silently dropping those files.
      const inspection = kind === "projectFolder"
        ? await inspectProjectDropSource(filePath).catch(() => null)
        : null;
      if (inspection && !inspection.valid) {
        throw new Error(inspection.reason || "This project folder could not be inspected.");
      }
      if (inspection?.has_backups) {
        setProjectUpdateNotice(
          `Backup folders were found in “${fileNameFromPath(filePath)}”. BeatGaler will skip them and continue with the project update.`
        );
      }

      await updateProjectArchiveFromSource(beat, filePath, kind);
      await uploadProjectToTelegram(beat);
      window.dispatchEvent(new CustomEvent("beatgaler:project-cloud-updated", { detail: { beatId: beat.id } }));
      await libraryStateManager.commitSnapshot(beatsLatestRef.current, "project-sync");

      if (inspection?.has_backups) {
        setProjectUpdateNotice(
          `Backup folders were skipped from “${fileNameFromPath(filePath)}” and were not added to PROJECT.zip.`
        );
      }
    });
  }, [runBeatCloudUpdate]);

  const startProjectZipReplacement = useCallback((beat: Beat, filePath: string) => {
    runBeatCloudUpdate(beat, filePath, async () => {
      await uploadDroppedFileToTelegram(beat, filePath, "PROJECT");
      window.dispatchEvent(new CustomEvent("beatgaler:project-cloud-updated", { detail: { beatId: beat.id } }));
      await libraryStateManager.commitSnapshot(beatsLatestRef.current, "project-sync");
    });
  }, [runBeatCloudUpdate]);

  const handleAutoProjectDrop = useCallback(async (beat: Beat, filePath: string): Promise<AutoProjectDropResult> => {
    const ext = extensionFromPath(filePath);
    const obviousProjectSource = ext === "zip" || ["flp", "als", "logicx", "ptx", "ptf"].includes(ext);
    if (!obviousProjectSource) return "not-project";

    let inspection;
    try {
      inspection = await inspectProjectDropSource(filePath);
    } catch (error) {
      setBeatCloudUpdateBusy(beat.id, false, false);
      await cleanupStagedDropPaths([filePath]).catch(() => {});
      await appAlert({ title: "Project check failed", message: String(error), danger: true });
      return "handled";
    }

    if (inspection.kind !== "zip" && inspection.kind !== "project_file") {
      return "not-project";
    }

    if (!inspection.valid) {
      setBeatCloudUpdateBusy(beat.id, false, false);
      await cleanupStagedDropPaths([filePath]).catch(() => {});
      await appAlert({
        title: inspection.kind === "zip" ? "Invalid PROJECT" : "Project check failed",
        message: inspection.reason || "The project could not be validated.",
        danger: true,
      });
      return "handled";
    }

    const existing = await hasStoredProject(beat).catch(() => false);
    if (existing) {
      // Inspection/staging has finished. Stop the card animation while the user is
      // making a Replace/Cancel choice; Replace starts the real update animation.
      setBeatCloudUpdateBusy(beat.id, false, false);
      const replace = await appConfirm({
        title: inspection.kind === "zip" ? "Replace PROJECT ZIP?" : "Replace project file?",
        message: inspection.kind === "zip"
          ? `"${beat.name}" already has a PROJECT ZIP. Replace it with ${fileNameFromPath(filePath)}?`
          : `"${beat.name}" already has a project file. Replace it with ${fileNameFromPath(filePath)}?`,
        confirmLabel: "Replace",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!replace) {
        await cleanupStagedDropPaths([filePath]).catch(() => {});
        return "handled";
      }
    }

    if (inspection.has_backups) {
      setProjectUpdateNotice(
        `Backup folders were found in “${fileNameFromPath(filePath)}”. BeatGaler will skip them and continue with the PROJECT ZIP.`
      );
    }

    if (inspection.kind === "zip") startProjectZipReplacement(beat, filePath);
    else startProjectAssetUpdate(beat, filePath, "projectFile");
    return "started";
  }, [hasStoredProject, startProjectAssetUpdate, startProjectZipReplacement]);

  const handleDroppedBeatFileRole = useCallback(async (role: DroppedBeatFileRole) => {
    if (!beatFileDrop) return;
    const { beat, filePath } = beatFileDrop;
    const ext = extensionFromPath(filePath);

    if (role === "loop" || role === "stems") return;

    if (role === "main") {
      if (ext !== "mp3") return;
      runBeatCloudUpdate(beat, filePath, async () => {
        await uploadDroppedFileToTelegram(beat, filePath, "MASTER");
        const refreshed = await loadLibrary();
        beatsLatestRef.current = refreshed;
        setBeats(refreshed);
        const cloudBacked = refreshed.filter(item => !!item.telegram_file_id);
        cloudLibrarySnapshotRef.current = cloudBacked.map(cloudBeatFingerprint).join("\u001c");
        await libraryStateManager.commitSnapshot(refreshed, "dropped-master");

        const updated = refreshed.find(item => item.id === beat.id);
        if (updated?.telegram_file_id) {
          const ready = await waitForUploadedBeatPlaybackReady(updated);
          if (!ready) throw new Error("The new MASTER uploaded, but did not become playback-ready in time.");
        }
      });
      return;
    }

    if (role === "wav") {
      if (ext !== "wav") return;
      runBeatCloudUpdate(beat, filePath, async () => {
        await uploadDroppedFileToTelegram(beat, filePath, "WAV");
        await libraryStateManager.commitSnapshot(beatsLatestRef.current, "project-sync");
      });
      return;
    }

    if (role === "projectFolder") {
      const existing = await hasStoredProject(beat).catch(() => false);
      if (!existing) {
        await cleanupStagedDropPaths([filePath]).catch(() => {});
        setBeatFileDrop(null);
        await appAlert({
          title: "Project file required",
          message: "Add a .flp, .als, .logicx, .ptx/.ptf file or a valid PROJECT ZIP first. Then folders can be added to that PROJECT.zip using their original folder name.",
        });
        return;
      }
      startProjectAssetUpdate(beat, filePath, "projectFolder");
    }
  }, [beatFileDrop, hasStoredProject, runBeatCloudUpdate, startProjectAssetUpdate, waitForUploadedBeatPlaybackReady]);


  // Non-Windows/browser fallback only. On Windows, WRY/Tauri is the ONE
  // external drop owner for both CF_HDROP paths and browser/Pinterest payloads.
  useEffect(() => {
    // On Windows desktop, WRY/Tauri owns the external drop. Explorer gives us
    // original paths with zero byte staging, while browser/Pinterest payloads
    // stay on that same native receiver. The HTML DataTransfer controller is
    // intentionally not installed there; otherwise the same local file drop
    // can fall back to File.arrayBuffer() and recreate the 20-40s staging delay.
    const windowsNativeDrop = isTauriAvailable && /Windows/i.test(navigator.userAgent);
    if (windowsNativeDrop) return;
    return installHtmlDropController({
      setGlobalDropActive: setDropActive,
      onArtworkDrop: async (beatId, sources) => {
        const beat = beatsLatestRef.current.find(item => item.id === beatId);
        if (!beat) throw new Error(`Dropped artwork target beat was not found: ${beatId}`);

        setBeatCloudUpdateBusy(beat.id, true);
        try {
          const conversionErrors: string[] = [];
          let imageData: string | null = null;

          // Browser drags are intentionally multi-source. Pinterest/Chromium may
          // provide a CDN URL AND a virtual File; whichever representation works
          // first wins. A failed cloud URL fetch therefore cannot kill a usable
          // virtual-file drop, and vice versa.
          for (const source of sources) {
            try {
              const candidate = source.kind === "remote"
                ? (/^data:image\//i.test(source.url) ? source.url : await fetchInternetArtworkDataUrl(source.url))
                : await artworkFileToDataUrl(source.file);
              if (!/^data:image\//i.test(candidate) || candidate.length < 32) {
                throw new Error("Artwork source returned an invalid/empty image payload.");
              }
              imageData = candidate;
              console.info(`[dragdrop/artwork] resolved via ${source.kind}`);
              break;
            } catch (error) {
              conversionErrors.push(`${source.kind}: ${String(error)}`);
              console.warn(`[dragdrop/artwork] ${source.kind} candidate failed; trying fallback`, error);
            }
          }

          if (!imageData) {
            throw new Error(`Pinterest/browser artwork could not be decoded. ${conversionErrors.join(" | ")}`);
          }

          await handleDropArtwork(beat, imageData);
        } finally {
          setBeatCloudUpdateBusy(beat.id, false);
        }
      },
      onBeatFileDrop: async (beatId, roots) => {
        const beat = beatsLatestRef.current.find(item => item.id === beatId);
        if (!beat) return;
        if (roots.length > 1) {
          await appAlert({
            title: "Drop one file at a time",
            message: "Drop a single file or folder on a beat so BeatGaler can assign it to the correct slot.",
          });
          return false;
        }
        const root = roots[0];
        if (isBackupFolderPath(root.path)) {
          await cleanupStagedDropPaths([root.path]).catch(() => {});
          await appAlert({
            title: "Backup folder skipped",
            message: "BeatGaler keeps Backup/Backups folders out of PROJECT.zip so old project copies are not uploaded.",
          });
          return false;
        }

        // Project files and PROJECT ZIPs have exactly one sensible destination,
        // so do not make the user answer a redundant "What are you adding?" page.
        // The card is already in its loading state while WebView2 stages/inspects
        // the drop, so large ZIPs never look like the app ignored them.
        const autoResult = await handleAutoProjectDrop(beat, root.path);
        if (autoResult === "started") return true;
        if (autoResult === "handled") return false;

        setBeatFileDrop({ beat, filePath: root.path, kind: root.kind });
        return false;
      },
      onBeatFileStagingChange: (beatId, active) => {
        setBeatCloudUpdateBusy(beatId, active, false);
      },
      onLibraryFileStagingChange: active => {
        if (!REVIEW_SKELETON_ENABLED) return;
        setLibraryDropStaging(active);
      },
      onLibraryFileDrop: async roots => {
        await importDroppedPaths(roots.map(root => root.path));
      },
      onEmptyFileDrop: async () => {
        await appAlert({
          title: "Nothing to import",
          message: "Windows reported a file drop, but WebView2 did not expose any files or folder contents.",
        });
      },
      onError: async error => {
        console.error("HTML5 drag & drop failed:", error);
        await appAlert({ title: "Drag & drop failed", message: String(error), danger: true });
      },
    });
  }, [handleAutoProjectDrop, handleDropArtwork, importDroppedPaths]);

  useEffect(() => {
    if (!isTauriAvailable || !/Windows/i.test(navigator.userAgent)) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let activePaths: string[] = [];
    let activeExternalImage = false;

    type NativeFsPayload = {
      paths: string[];
      position?: { x: number; y: number } | null;
    };

    type NativeExternalImageDropDetail = {
      x: number;
      y: number;
      url: string;
      source: "pinterest" | "browser";
    };

    const elementAtNativePosition = (position: { x?: number; y?: number } | null | undefined): HTMLElement | null => {
      if (!position || typeof position.x !== "number" || typeof position.y !== "number") return null;
      const scale = window.devicePixelRatio || 1;
      const candidates: Array<[number, number]> = [[position.x, position.y]];
      if (scale !== 1) candidates.push([position.x / scale, position.y / scale]);
      for (const [x, y] of candidates) {
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        if (el) return el;
      }
      return null;
    };

    const isImagePath = (path: string) => {
      const ext = extensionFromPath(path);
      return ["png", "jpg", "jpeg", "webp", "bmp", "gif", "avif"].includes(ext);
    };

    const clearNativeDragUi = () => {
      setDropActive(false);
      window.dispatchEvent(new CustomEvent("beatgaler:artwork-drag", { detail: { beatId: null, active: false } }));
      window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", { detail: { beatId: null, active: false } }));
    };

    const updateNativeExternalImageUi = (position: { x?: number; y?: number } | null | undefined) => {
      const target = elementAtNativePosition(position);
      const artwork = target?.closest?.("[data-beat-artwork-id]") as HTMLElement | null;
      const artworkBeatId = artwork?.dataset.beatArtworkId ?? null;
      setDropActive(false);
      window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", { detail: { beatId: null, active: false } }));
      window.dispatchEvent(new CustomEvent("beatgaler:artwork-drag", {
        detail: { beatId: artworkBeatId, active: Boolean(artworkBeatId) },
      }));
    };

    const updateNativeDragUi = (payload: NativeFsPayload) => {
      const target = elementAtNativePosition(payload.position);
      const artwork = target?.closest?.("[data-beat-artwork-id]") as HTMLElement | null;
      const card = target?.closest?.("[data-beat-card-id]") as HTMLElement | null;
      const library = target?.closest?.('[data-library-scroll="true"]') as HTMLElement | null;
      const localImage = payload.paths.length === 1 && isImagePath(payload.paths[0]);
      const artworkBeatId = artwork?.dataset.beatArtworkId ?? null;
      const cardBeatId = card?.dataset.beatCardId ?? null;

      if (artworkBeatId && localImage) {
        setDropActive(false);
        window.dispatchEvent(new CustomEvent("beatgaler:artwork-drag", { detail: { beatId: artworkBeatId, active: true } }));
        window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", { detail: { beatId: null, active: false } }));
        return;
      }

      if (payload.paths.length > 0 && cardBeatId) {
        setDropActive(false);
        window.dispatchEvent(new CustomEvent("beatgaler:artwork-drag", { detail: { beatId: null, active: false } }));
        window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", { detail: { beatId: cardBeatId, active: true } }));
        return;
      }

      window.dispatchEvent(new CustomEvent("beatgaler:artwork-drag", { detail: { beatId: null, active: false } }));
      window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", { detail: { beatId: null, active: false } }));
      setDropActive(Boolean(library && payload.paths.length > 0));
    };

    const resolveNativeArtwork = async (beatId: string, imagePath: string) => {
      const beat = beatsLatestRef.current.find(item => item.id === beatId);
      if (!beat) throw new Error(`Dropped artwork target beat was not found: ${beatId}`);
      const imageData = await readImagePathAsDataUrl(imagePath);
      if (!/^data:image\//i.test(imageData)) throw new Error("Dropped file is not a usable image.");
      setBeatCloudUpdateBusy(beat.id, true);
      try {
        await handleDropArtwork(beat, imageData);
      } finally {
        setBeatCloudUpdateBusy(beat.id, false);
      }
    };

    const resolveNativeExternalImage = async (detail: NativeExternalImageDropDetail) => {
      // Routing decision happens at the final drop coordinates. Pinterest/browser
      // URLs never enter Import Beat and are accepted only by an artwork target.
      const target = elementAtNativePosition(detail);
      const artwork = target?.closest?.("[data-beat-artwork-id]") as HTMLElement | null;
      const beatId = artwork?.dataset.beatArtworkId ?? null;
      if (!beatId) return;
      const beat = beatsLatestRef.current.find(item => item.id === beatId);
      if (!beat) return;

      setBeatCloudUpdateBusy(beat.id, true);
      try {
        const imageData = await fetchInternetArtworkDataUrl(detail.url);
        if (!/^data:image\//i.test(imageData) || imageData.length < 32) {
          throw new Error("Pinterest/browser artwork returned an invalid image payload.");
        }
        await handleDropArtwork(beat, imageData);
      } finally {
        setBeatCloudUpdateBusy(beat.id, false);
      }
    };

    const onNativeExternalImageDrop = (event: Event) => {
      const detail = (event as CustomEvent<NativeExternalImageDropDetail>).detail;
      if (!detail || typeof detail.x !== "number" || typeof detail.y !== "number" || typeof detail.url !== "string") return;
      void resolveNativeExternalImage(detail).catch(async error => {
        console.error("Native external artwork drop failed:", error);
        await appAlert({ title: "Artwork drop failed", message: String(error), danger: true });
      });
    };
    window.addEventListener("native-external-image-drop", onNativeExternalImageDrop);

    const handleNativeBeatDrop = async (beatId: string, paths: string[]) => {
      const beat = beatsLatestRef.current.find(item => item.id === beatId);
      if (!beat) return;
      if (paths.length !== 1) {
        await appAlert({
          title: "Drop one file at a time",
          message: "Drop a single file or folder on a beat so BeatGaler can assign it to the correct slot.",
        });
        return;
      }

      const filePath = paths[0];
      if (isBackupFolderPath(filePath)) {
        await appAlert({
          title: "Backup folder skipped",
          message: "BeatGaler keeps Backup/Backups folders out of PROJECT.zip so old project copies are not uploaded.",
        });
        return;
      }

      setBeatCloudUpdateBusy(beat.id, true, false);
      try {
        const autoResult = await handleAutoProjectDrop(beat, filePath);
        if (autoResult === "started") return;
        if (autoResult === "handled") {
          setBeatCloudUpdateBusy(beat.id, false, false);
          return;
        }
        const directory = await isDirectoryPath(filePath);
        setBeatCloudUpdateBusy(beat.id, false, false);
        setBeatFileDrop({ beat, filePath, kind: directory ? "directory" : "file" });
      } catch (error) {
        setBeatCloudUpdateBusy(beat.id, false, false);
        throw error;
      }
    };

    const handleNativeDrop = async (payload: NativeFsPayload) => {
      // Reserved external-image sentinels are intercepted in onDragDropEvent
      // before this local-filesystem router can ever be called.
      const target = elementAtNativePosition(payload.position);
      const artwork = target?.closest?.("[data-beat-artwork-id]") as HTMLElement | null;
      const card = target?.closest?.("[data-beat-card-id]") as HTMLElement | null;
      const library = target?.closest?.('[data-library-scroll="true"]') as HTMLElement | null;
      const artworkBeatId = artwork?.dataset.beatArtworkId ?? null;
      const cardBeatId = card?.dataset.beatCardId ?? null;
      clearNativeDragUi();

      reviewPerfMark(`TAURI_NATIVE_DROP path_count=${payload.paths.length} names=${payload.paths.map(fileNameFromPath).slice(0, 12).join("|")}`);

      if (payload.paths.length === 0) return;
      if (payload.paths.length > MAX_NATIVE_DROP_ITEMS) {
        await appAlert({
          title: "Too many items",
          message: `Drop up to ${MAX_NATIVE_DROP_ITEMS} files/folders at a time. A parent folder still counts as one item.`,
        });
        return;
      }

      if (artworkBeatId && payload.paths.length === 1 && isImagePath(payload.paths[0])) {
        await resolveNativeArtwork(artworkBeatId, payload.paths[0]);
        return;
      }

      if (cardBeatId) {
        await handleNativeBeatDrop(cardBeatId, payload.paths);
        return;
      }

      if (!library) return;

      // Definitive B path: Tauri gives us the original Explorer paths. No
      // DataTransfer File.arrayBuffer(), no drop-staging, and no pre-Review copy.
      if (REVIEW_SKELETON_ENABLED) setLibraryDropStaging(true);
      const started = performance.now();
      reviewPerfMark(`WINDOWS_NATIVE_LIBRARY_IMPORT_START path_count=${payload.paths.length}`);
      try {
        await importDroppedPaths(payload.paths);
        reviewPerfMark(`WINDOWS_NATIVE_LIBRARY_IMPORT_READY elapsed_ms=${Math.round(performance.now() - started)}`);
      } finally {
        if (REVIEW_SKELETON_ENABLED) setLibraryDropStaging(false);
      }
    };

    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const stop = await getCurrentWebview().onDragDropEvent(event => {
          const payload = event.payload as any;
          if (!payload) return;

          if (payload.type === "leave") {
            activePaths = [];
            activeExternalImage = false;
            clearNativeDragUi();
            return;
          }

          if (payload.type === "enter") {
            const incomingPaths = Array.isArray(payload.paths)
              ? payload.paths.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
              : [];
            const externalSignal = nativeExternalImageSignalFromPaths(incomingPaths);
            if (externalSignal?.kind === "pending") {
              activePaths = [];
              activeExternalImage = true;
              reviewPerfMark("NATIVE_EXTERNAL_IMAGE_ENTER");
              updateNativeExternalImageUi(payload.position);
              return;
            }

            activeExternalImage = false;
            activePaths = incomingPaths;
            reviewPerfMark(`TAURI_NATIVE_ENTER path_count=${activePaths.length}`);
            updateNativeDragUi({ paths: activePaths, position: payload.position });
            return;
          }

          if (payload.type === "over") {
            if (activeExternalImage) updateNativeExternalImageUi(payload.position);
            else updateNativeDragUi({ paths: activePaths, position: payload.position });
            return;
          }

          if (payload.type !== "drop") return;
          const incomingPaths = Array.isArray(payload.paths)
            ? payload.paths.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
            : activePaths;
          const externalSignal = nativeExternalImageSignalFromPaths(incomingPaths);
          const wasExternalImage = activeExternalImage;
          activePaths = [];
          activeExternalImage = false;

          if (externalSignal?.kind === "drop") {
            clearNativeDragUi();
            const position = payload.position;
            if (!position || typeof position.x !== "number" || typeof position.y !== "number") return;
            reviewPerfMark(`NATIVE_EXTERNAL_IMAGE_DROP source=${externalSignal.source}`);
            window.dispatchEvent(new CustomEvent("native-external-image-drop", {
              detail: {
                x: position.x,
                y: position.y,
                url: externalSignal.url,
                source: externalSignal.source,
              } satisfies NativeExternalImageDropDetail,
            }));
            return;
          }

          // WRY recognized a browser payload on Enter but could not resolve a
          // direct image URL on Drop. Clear feedback and intentionally no-op;
          // never reinterpret it as a local beat import.
          if (wasExternalImage) {
            clearNativeDragUi();
            reviewPerfMark("NATIVE_EXTERNAL_IMAGE_DROP unresolved");
            return;
          }

          void handleNativeDrop({ paths: incomingPaths, position: payload.position }).catch(async error => {
            console.error("Tauri native file drop failed:", error);
            await appAlert({ title: "Drag & drop failed", message: String(error), danger: true });
          });
        });
        if (cancelled) stop();
        else unlisten = stop;
      } catch (error) {
        console.error("Tauri native Windows drag/drop listener failed:", error);
        reviewPerfMark(`TAURI_NATIVE_LISTENER_ERROR error=${String(error)}`);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      activePaths = [];
      activeExternalImage = false;
      window.removeEventListener("native-external-image-drop", onNativeExternalImageDrop);
      clearNativeDragUi();
    };
  }, [handleAutoProjectDrop, handleDropArtwork, importDroppedPaths]);

  const handleCloudFiles = useCallback(async (beat: Beat) => {
    // Exporting/downloading is read-only. A durable Available Offline package
    // must remain fully usable without Telegram: MP3/WAV/PROJECT/Everything are
    // copied from its local protected files. Only cloud-only beats need network.
    if (connectionState !== "online" && !beat.offline_available) {
      await appAlert({
        title: "Files unavailable offline",
        message: "This beat was not made Available Offline. Reconnect to download its cloud files.",
      });
      return;
    }
    try {
      const files = await listCloudFilesForBeat(beat.id);
      setCloudFiles(files);
      setCloudFilesDownloadedIds(new Set());
      setCloudFilesDownloadError(null);
      setCloudFilesBeat(beat);
    } catch (error) {
      await appAlert({ title: "Cloud files", message: String(error), danger: true });
    }
  }, [connectionState]);

  const handleGetCloudFile = useCallback(async (kind: BeatDownloadKind) => {
    const beat = cloudFilesBeat;
    if (!beat || cloudFilesBusyId) return;

    const safeBase = (beat.name || "Beat")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim() || "Beat";

    const exportMeta = [String(beat.bpm || "").trim(), String(beat.key || "").trim()]
      .filter(Boolean)
      .join(" ");
    const audioSafeBase = exportMeta && !safeBase.endsWith(`[${exportMeta}]`)
      ? `${safeBase} [${exportMeta}]`
      : safeBase;

    let ownsRuntimeDownloadState = false;
    try {
      setCloudFilesDownloadError(null);

      let destination: string | null = null;
      if (kind === "MP3") destination = await chooseExportFilePath(`${audioSafeBase}.mp3`, "mp3");
      else if (kind === "WAV") destination = await chooseExportFilePath(`${audioSafeBase}.wav`, "wav");
      else if (kind === "PROJECT") destination = await chooseExportFilePath(`${safeBase}.zip`, "zip");
      else destination = await chooseExportFolder();

      if (!destination) return;

      // This invoke only STARTS a Rust worker thread and returns immediately.
      // All Telegram/network/ZIP/copy/metadata work happens after this point
      // outside the Tauri UI thread, so the Downloads modal can be closed and
      // the rest of BeatGaler stays interactive.
      const runtime = beatRuntimeStatesRef.current[beat.id] ?? createBeatRuntimeState(beat);
      if (runtime.download_state !== "downloading") {
        transitionRuntime(beat.id, { type: "DOWNLOAD_STARTED" }, beat);
        ownsRuntimeDownloadState = true;
      }
      const taskId = await startBackgroundDownload(kind, beat, destination);
      if (ownsRuntimeDownloadState) backgroundDownloadRuntimeOwnersRef.current.add(taskId);
      setCloudFilesBusyId(kind);
      setCloudDownloadNotice({
        taskId,
        kind,
        beatName: beat.name || "Beat",
        status: "downloading",
      });
    } catch (error) {
      const message = runtimeErrorMessage(error);
      if (ownsRuntimeDownloadState) {
        transitionRuntime(beat.id, { type: "DOWNLOAD_FAILED", code: "DOWNLOAD_START_FAILED", message, retryable: true }, beat);
      }
      setCloudFilesBusyId(null);
      setCloudDownloadNotice(null);
      setCloudFilesDownloadError(message);
    }
  }, [cloudFilesBeat, cloudFilesBusyId, transitionRuntime]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void listen<BackgroundDownloadEvent>("beatgaler-download-event", event => {
      if (disposed) return;
      const payload = event.payload;
      const kind = payload.kind as BeatDownloadKind;

      const ownsRuntimeDownloadState = backgroundDownloadRuntimeOwnersRef.current.delete(payload.task_id);
      if (payload.status === "error") {
        const message = payload.error || "Download failed.";
        if (ownsRuntimeDownloadState) {
          transitionRuntime(payload.beat_id, { type: "DOWNLOAD_FAILED", code: "DOWNLOAD_FAILED", message, retryable: true });
        }
        setCloudFilesBusyId(current => current === kind ? null : current);
        setCloudDownloadNotice(current => current?.taskId === payload.task_id ? null : current);
        setCloudFilesDownloadError(message);
        return;
      }

      if (ownsRuntimeDownloadState) {
        transitionRuntime(payload.beat_id, { type: "DOWNLOAD_SUCCEEDED" });
      }

      setCloudFilesBusyId(current => current === kind ? null : current);
      setCloudFilesDownloadedIds(prev => {
        const next = new Set(prev);
        // Status reflects the action the user chose. Download Everything only
        // marks the Everything row; it must not make MP3/WAV/Project look like
        // they were individually downloaded.
        next.add(kind);
        return next;
      });

      try {
        const audio = new Audio(downloadCompleteWav);
        audio.volume = 0.68;
        void audio.play().catch(() => {});
      } catch {}

      setCloudDownloadNotice({
        taskId: payload.task_id,
        kind,
        beatName: payload.beat_name || "Beat",
        status: "completed",
      });
      window.setTimeout(() => {
        setCloudDownloadNotice(current =>
          current?.taskId === payload.task_id && current.status === "completed" ? null : current
        );
      }, 1000);
    }).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(error => console.warn("Background download listener failed:", error));

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [transitionRuntime]);

  const reloadLibrary = useCallback(async () => {
    // Pre-Direct BeatGaler reload used a full loading state and then replaced the
    // rendered library from the durable source. Keep that authoritative behavior,
    // but never let Reload race an active import: until the batch INDEX commit
    // finishes, Telegram intentionally does not contain those optimistic beats.
    const refreshStarted = performance.now();
    setLibraryRefreshing(true);

    const finishRefreshAnimation = async () => {
      const elapsed = performance.now() - refreshStarted;
      if (elapsed < 320) await new Promise(resolve => window.setTimeout(resolve, 320 - elapsed));
      setLibraryRefreshing(false);
    };

    try {
      const uploadInFlight = backgroundUploadRunningRef.current || autoCloudUploadRef.current.size > 0;
      if (uploadInFlight) {
        // Critical safety rule: restoreLibraryFromTelegram reconciles SQLite to the
        // committed INDEX. During an import that INDEX is intentionally older, so
        // applying it would make the beats being uploaded disappear. Defer instead.
        deferredLibraryReloadRef.current = true;
        console.info(`[library-refresh] DEFERRED active_uploads=${autoCloudUploadRef.current.size}`);
        return;
      }

      try { localStorage.removeItem(LIBRARY_CACHE_KEY); } catch {}
      const browserOffline = typeof navigator !== "undefined" && navigator.onLine === false;

      if (settings?.telegram_cloud_connected && !browserOffline) {
        let lastError: unknown = null;
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          try {
            // Reload is also an integrity pass: if an INDEX entry points at a
            // MASTER message Telegram definitively says no longer exists, repair
            // the INDEX first and then apply the repaired authority to SQLite/UI.
            const repaired = await repairStaleCloudLibraryRefs().catch(error => {
              console.warn("Reload integrity probe deferred safely:", error);
              return 0;
            });
            if (repaired > 0) console.warn(`[library-refresh] stale_refs_repaired=${repaired}`);
            const restored = await libraryStateManager.reloadAuthoritative();
            cloudMetaSnapshotRef.current = new Map(
              restored.filter(beat => !!beat.telegram_file_id).map(beat => [beat.id, cloudBeatFingerprint(beat)])
            );
            cloudLibrarySnapshotRef.current = restored
              .filter(beat => !!beat.telegram_file_id)
              .map(cloudBeatFingerprint)
              .join("\u001c");
            setConnectionState("online");

            // Reload replaces committed library state, just like the functional
            // pre-Direct version, while preserving already-decoded artwork.
            const visible = preserveLoadedArtwork(restored, beatsLatestRef.current);
            beatsLatestRef.current = visible;
            setBeats(visible);

            startupCookingResolvedRef.current = true;
            startupPipelineStartedRef.current = false;
            progressiveRevealRunRef.current += 1;
            setRevealedBeatIds(new Set(visible.map(beat => beat.id)));
            setStartupCookingGate(false);
            setCloudSessionVerified(true);
            console.info(`[library-refresh] APPLIED beats=${visible.length} attempt=${attempt}`);
            return;
          } catch (error) {
            lastError = error;
            if (attempt < 4) await new Promise(resolve => window.setTimeout(resolve, 450 * attempt));
          }
        }
        console.warn("Telegram library refresh failed after retries; preserving verified gallery:", lastError);
        setConnectionState("poor");
        setCloudSessionVerified(false);
        return;
      }

      const offline = await loadOfflineLibrary();
      if (browserOffline) {
        setConnectionState("offline");
        setCloudSessionVerified(false);
        if (beatsLatestRef.current.length === 0) {
          beatsLatestRef.current = offline;
          setBeats(offline);
        }
        return;
      }

      if (!settings?.telegram_cloud_connected) {
        setCloudSessionVerified(false);
        beatsLatestRef.current = offline;
        setBeats(offline);
      }
    } catch (err) {
      console.error(err);
      setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
      setCloudSessionVerified(false);
    } finally {
      await finishRefreshAnimation();
      setLoading(false);
    }
  }, [settings?.telegram_cloud_connected]);

  useEffect(() => {
    const runDeferredReload = () => { void reloadLibrary(); };
    window.addEventListener("beatgaler:deferred-library-reload", runDeferredReload);
    return () => window.removeEventListener("beatgaler:deferred-library-reload", runDeferredReload);
  }, [reloadLibrary]);


  const applyBulkUpdate = useCallback((updates: Partial<Beat>, options?: { tagsMode?: "add" | "replace" | "remove" }) => {
    setBeats(bs => bs.map(b => {
      if (!selectedIds.has(b.id)) return b;
      if (!updates.tags) return { ...b, ...updates };

      const normalizedInput = Array.from(new Set(
        updates.tags.map(t => t.trim().toLowerCase()).filter(Boolean)
      ));

      if (options?.tagsMode === "replace") {
        return { ...b, ...updates, tags: normalizedInput };
      }

      if (options?.tagsMode === "remove") {
        const removeSet = new Set(normalizedInput);
        const remainingTags = b.tags.filter(tag => !removeSet.has(tag.trim().toLowerCase()));
        return { ...b, ...updates, tags: remainingTags };
      }

      const mergedTags = Array.from(new Set(
        [...b.tags, ...normalizedInput].map(t => t.trim().toLowerCase()).filter(Boolean)
      ));
      return { ...b, ...updates, tags: mergedTags };
    }));
    setSelectedIds(new Set());
    setSelectMode(false);
    setAnchorIdx(null);
  }, [selectedIds]);

  const deleteBeat = useCallback(async (beat: Beat) => {
    const approved = await appConfirm({
      title: "Remove beat?",
      message: beat.telegram_file_id
        ? `Remove "${beat.name}" from BeatGaler?\n\nIts cloud files will stay stored. The active Galer Library index will stop listing this beat after the next sync.`
        : `Are you sure you want to remove "${beat.name}"?\n\nThis will move its local files to BeatGaler trash.`,
      confirmLabel: beat.telegram_file_id ? "Remove beat" : "Move to trash",
      cancelLabel: "Cancel",
      danger: true,
    });

    // Nothing destructive happens before this exact resolved decision.
    if (!approved) return;
    if (deleteInFlightRef.current.has(beat.id)) return;

    deleteInFlightRef.current.add(beat.id);
    if (beat.telegram_file_id) {
      if (connectionState === "online") transitionRuntime(beat.id, { type: "SYNC_DELETE_STARTED" }, beat);
      else transitionRuntime(beat.id, { type: "SET_TRASH_SYNC_REQUIRED", required: true }, beat);
    }
    try {
      if (audio.playingId === beat.id) {
        transitionRuntime(beat.id, { type: "PLAYBACK_IDLE" }, beat);
        releaseFile();
      }
      await removeBeatFromLibrary(beat.id);
      let trashIntentError: unknown = null;
      if (connectionState !== "online" && beat.telegram_file_id) {
        try {
          await recordOfflineTrashIntent(beat.id);
        } catch (error) {
          trashIntentError = error;
          console.error("Could not persist Offline Trash reconciliation intent:", error);
        }
      }
      const nextLibrary = beatsLatestRef.current.filter(item => item.id !== beat.id);
      beatsLatestRef.current = nextLibrary;
      setBeats(nextLibrary);
      setQueueIds(ids => ids.filter(id => id !== beat.id));

      if (connectionState === "online" && beat.telegram_file_id) {
        try {
          await libraryStateManager.commitSnapshot(nextLibrary, "move-to-trash");
          forgetRuntimeState(beat.id);
        } catch (error) {
          const message = runtimeErrorMessage(error);
          const runtime = beatRuntimeStatesRef.current[beat.id];
          if (runtime?.sync_state === "deleting") {
            transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "DELETE_INDEX_SYNC_FAILED", message, retryable: true }, beat);
          }
          console.warn("Telegram library index refresh after Remove failed:", error);
        }
      }

      if (trashIntentError) {
        await appAlert({
          title: "Moved to Trash locally",
          message: "BeatGaler could not save the reconnect instruction for this beat. Restore it from Trash before closing the app, or reconnect and try again.",
          danger: true,
        });
      }
    } catch (err) {
      console.error(err);
      const runtime = beatRuntimeStatesRef.current[beat.id];
      if (runtime?.sync_state === "deleting") {
        transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "DELETE_FAILED", message: runtimeErrorMessage(err), retryable: true }, beat);
      }
      await appAlert({
        title: "Could not remove beat",
        message: "The beat could not be removed from the library.",
        danger: true,
      });
    } finally {
      deleteInFlightRef.current.delete(beat.id);
    }
  }, [audio.playingId, releaseFile, connectionState, forgetRuntimeState, transitionRuntime]);

  const handleToggleSelect = useCallback((beat: Beat, e: React.MouseEvent, currentFiltered: Beat[]) => {
    const idx = currentFiltered.findIndex(b => b.id === beat.id);
    if (idx < 0) return;

    if (e.shiftKey && anchorIdx !== null) {
      const lo = Math.min(idx, anchorIdx);
      const hi = Math.max(idx, anchorIdx);
      // Windows-style range selection: replace the previous range instead of
      // adding to it. The anchor stays fixed until a non-shift click.
      setSelectedIds(new Set(currentFiltered.slice(lo, hi + 1).map(b => b.id)));
    } else {
      setSelectedIds(current => {
        const next = new Set(current);
        next.has(beat.id) ? next.delete(beat.id) : next.add(beat.id);
        return next;
      });
      setAnchorIdx(idx);
    }

    if (!selectMode) setSelectMode(true);
  }, [anchorIdx, selectMode]);
  
  const tagColors = useTagColors();

const confirmTagRename = useCallback(async () => {
  if (!tagRename) return;
  const oldTag = tagRename.oldTag.trim().toLowerCase();
  const newTag = tagRename.newTag.trim().toLowerCase();
  if (!oldTag || !newTag || oldTag === newTag) return;
  const jobId = `tag-rename-${Date.now()}`;
  setTagRenameBusy(true);
  setTagRenameError(null);
  registerJob(jobId, `Rename “${oldTag}” → “${newTag}”`, "tag-rename");
  updateJob(jobId, { status: "processing", progress: 0, message: "Preparing journal…" });
  try {
    await renameTagEverywhere(oldTag, newTag, jobId);
    setBeats(current => current.map(beat => {
      if (!beat.tags.some(t => t.trim().toLowerCase() === oldTag)) return beat;
      const renamed = beat.tags.map(t => t.trim().toLowerCase() === oldTag ? newTag : t);
      return { ...beat, tags: Array.from(new Set(renamed)) };
    }));
    setIncludedTags(s => new Set([...s].map(t => t.trim().toLowerCase() === oldTag ? newTag : t)));
    setExcludedTags(s => new Set([...s].map(t => t.trim().toLowerCase() === oldTag ? newTag : t)));
    renameTagColor(oldTag, newTag);
    setTagRename(null);
  } catch (e) {
    setTagRenameError(String(e));
    updateJob(jobId, { status: "error", message: String(e) });
  } finally {
    setTagRenameBusy(false);
  }
}, [tagRename]);

const handleTagClick = useCallback((tag: string, e: React.MouseEvent) => {
  if (e.altKey) {
    // Alt/Option + click -> excluir (o quitar si ya estaba excluido)
    setExcludedTags(s => {
      const n = new Set(s);
      n.has(tag) ? n.delete(tag) : n.add(tag);
      return n;
    });
    setIncludedTags(s => { const n = new Set(s); n.delete(tag); return n; });
  } else {
    // Click normal -> incluir (o quitar si ya estaba incluido)
    setIncludedTags(s => {
      const n = new Set(s);
      n.has(tag) ? n.delete(tag) : n.add(tag);
      return n;
    });
    setExcludedTags(s => { const n = new Set(s); n.delete(tag); return n; });
  }
}, []);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { delay: 140, tolerance: 6 },
    })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = String(event.active.id);
    setActiveDragId(id);
    if (sortBy !== "rating") setSortBy("manual");
  }, [sortBy]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    setActiveDragId(null);
    if (!overId || activeId === overId) return;

    setBeats((current) => {
      const oldIndex = current.findIndex((b) => b.id === activeId);
      const newIndex = current.findIndex((b) => b.id === overId);
      if (oldIndex === -1 || newIndex === -1) return current;

      if (sortBy === "rating") {
        const moved = current[oldIndex];
        const target = current[newIndex];
        if (moved.rating !== target.rating) return current;
      }

      const next = arrayMove(current, oldIndex, newIndex);
      reorderBeats(next.map((b) => b.id)).catch(console.error);
      return next;
    });
  }, [sortBy]);

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
  }, []);

  // Global tag usage, normalized and counted once per beat. This is only a
  // presentation ranking: the order stored in ID3 metadata is left untouched.
  const tagFrequency = useMemo(() => {
    const freq = new Map<string, number>();
    for (const beat of beats) {
      const uniqueTags = new Set(
        beat.tags.map(tag => tag.trim().toLowerCase()).filter(Boolean)
      );
      for (const tag of uniqueTags) {
        freq.set(tag, (freq.get(tag) ?? 0) + 1);
      }
    }
    return freq;
  }, [beats]);

  const allTags = useMemo(() => {
    const displayByNormalized = new Map<string, string>();
    for (const beat of beats) {
      for (const rawTag of beat.tags) {
        const normalized = rawTag.trim().toLowerCase();
        if (normalized && !displayByNormalized.has(normalized)) {
          displayByNormalized.set(normalized, rawTag.trim());
        }
      }
    }
    return [...displayByNormalized.entries()]
      .sort(([a], [b]) =>
        (tagFrequency.get(b) ?? 0) - (tagFrequency.get(a) ?? 0) || a.localeCompare(b)
      )
      .map(([, display]) => display);
  }, [beats, tagFrequency]);

  const tagSuggestions = useMemo(() => {
    const freq = new Map<string, number>();
    for (const beat of beats) {
      for (const tag of beat.tags) {
        const normalized = tag.trim().toLowerCase();
        if (!normalized) continue;
        freq.set(normalized, (freq.get(normalized) ?? 0) + 1);
      }
    }
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag]) => tag);
  }, [beats]);

  const manualOrderIndex = useMemo(() => {
    const index = new Map<string, number>();
    beats.forEach((b, i) => index.set(b.id, i));
    return index;
  }, [beats]);

  const filteredBeats = beats
    .filter(b => {
      const q = search.trim().toLowerCase();
      return (!q || b.name.toLowerCase().includes(q) || b.tags.some(t => t.includes(q)) || b.key.toLowerCase().includes(q) || String(b.bpm).includes(q))
        && (includedTags.size === 0 || [...includedTags].every(t => b.tags.includes(t)))
        && (excludedTags.size === 0 || ![...excludedTags].some(t => b.tags.includes(t)));
    })
    .sort((a, b) => {
      if (sortBy === "manual") return 0;
      if (sortBy === "bpm") return Number(a.bpm || 0) - Number(b.bpm || 0);
      if (sortBy === "rating") {
        const ratingDiff = b.rating - a.rating;
        if (ratingDiff !== 0) return ratingDiff;
        return (manualOrderIndex.get(a.id) ?? 0) - (manualOrderIndex.get(b.id) ?? 0);
      }
      return a.name.localeCompare(b.name);
    });

  const filteredBeatIdsKey = filteredBeats.map(beat => beat.id).join("|");
  const displayedBeats = startupCookingGate
    ? []
    : filteredBeats.filter(beat => revealedBeatIds.has(beat.id));

  // Startup means "safe to use", not "entire MP3 downloaded". Prepare only
  // the first six beats: fresh artwork decoded, 512 KB cooking head ready,
  // localhost playback URL assigned, and the shared audio engine primed.
  useEffect(() => {
    if (startupCookingResolvedRef.current || startupPipelineStartedRef.current) return;
    if (loading || settings === null) return;
    if (connectionState === "checking") {
      setStartupCookingGate(true);
      return;
    }

    if (connectionState !== "online" || !settings.telegram_cloud_connected || filteredBeats.length === 0) {
      startupCookingResolvedRef.current = true;
      setRevealedBeatIds(new Set(filteredBeats.map(beat => beat.id)));
      setStartupCookingGate(false);
      dismissBeatGalerStartupLoader();
      return;
    }

    // Do not use the instant-paint cache as proof that a cloud beat is ready.
    // Wait until the pinned Telegram index has been restored into SQLite first.
    if (!cloudSessionVerified) {
      setStartupCookingGate(true);
      return;
    }

    startupPipelineStartedRef.current = true;
    let cancelled = false;
    const priority = filteredBeats.slice(0, STARTUP_PRIORITY_BEATS);
    setStartupCookingGate(true);
    void downloadCookingDiagnosticEvent(
      "STARTUP_GATE_BEGIN", null, null,
      `library_beats=${filteredBeats.length} priority=${priority.length}`
    ).catch(() => {});

    void (async () => {
      // Artwork, audio cooking and decoder priming overlap. Nothing here waits
      // for a full MASTER; the audio requirement is only the configured head.
      const artworkReadyPromise = Promise.all(priority.map(beat => ensureArtworkReady(beat)));
      await Promise.all(priority.map(beat => ensureWarmPlaybackUrl(beat)));
      if (cancelled) return;

      const cookingReady = new Set<string>();
      const cookingFailed = new Set<string>();
      const started = performance.now();
      let readyBytes = 0;
      let enginePrimePromise: Promise<boolean> | null = null;
      const hasCloudAudio = priority.some(beat => !!beat.telegram_file_id);

      while (!cancelled && performance.now() - started < 12000) {
        try {
          const status = await getDownloadCookingStatus();
          readyBytes = status.ready_bytes;
          const byBeat = new Map(status.entries.map(entry => [entry.beat_id, entry]));
          cookingReady.clear();
          cookingFailed.clear();
          for (const beat of priority) {
            if (beat.offline_available || !beat.telegram_file_id) {
              cookingReady.add(beat.id);
              continue;
            }
            const entry = byBeat.get(beat.id);
            if (entry?.failed) {
              cookingFailed.add(beat.id);
              continue;
            }
            const urlReady = cookingPlaybackUrlRef.current.get(beat.id)?.telegramFileId === beat.telegram_file_id;
            if (entry && urlReady && (entry.complete || entry.downloaded_bytes >= status.ready_bytes)) {
              cookingReady.add(beat.id);
            }
          }

          // Start the shared decoder as soon as the FIRST priority beat has its
          // 512 KB head. It primes in parallel while covers/other beats finish.
          if (!enginePrimePromise && hasCloudAudio) {
            const firstReady = priority.find(beat => beat.telegram_file_id && cookingReady.has(beat.id));
            const primeUrl = firstReady ? cookingPlaybackUrlRef.current.get(firstReady.id)?.url : undefined;
            if (primeUrl) {
              enginePrimePromise = (async () => {
                let ok = false;
                for (let attempt = 0; attempt < 3 && !ok && !cancelled; attempt += 1) {
                  ok = await primeAudioEngine(primeUrl).catch(() => false);
                  if (!ok) await new Promise(resolve => window.setTimeout(resolve, 220));
                }
                return ok;
              })();
            }
          }

          if (cookingReady.size + cookingFailed.size >= priority.length) break;
        } catch {}
        await new Promise(resolve => window.setTimeout(resolve, 90));
      }
      if (cancelled) return;

      const artworkReady = await artworkReadyPromise;
      const engineReady = hasCloudAudio
        ? await (enginePrimePromise ?? Promise.resolve(false))
        : true;
      startupEnginePrimeReadyRef.current = engineReady;
      if (cancelled) return;

      const usable = priority.filter((beat, index) => artworkReady[index] && cookingReady.has(beat.id));

      // Rendering must never be held hostage by decoder priming. Browsers can
      // reject an automatic prime because no user gesture has happened yet,
      // even though the exact same beat plays correctly after a click. Keep the
      // prime as a performance optimization, not as a condition for showing the
      // library.
      if (!engineReady) {
        void downloadCookingDiagnosticEvent(
          "STARTUP_ENGINE_PRIME_DEFERRED", null, null,
          `priority=${priority.length} usable=${usable.length} user_gesture_may_be_required=1`
        ).catch(() => {});
      }

      // A stale/missing historical artwork reference must not leave the entire
      // gallery in an eternal skeleton. We waited for the normal preparation
      // window already; reveal audio-ready beats with the card's stable artwork
      // fallback and let artwork recovery continue independently.
      const revealable = usable.length > 0
        ? usable
        : priority.filter(beat => cookingReady.has(beat.id));

      if (revealable.length === 0) {
        // Last-resort UI safety: the INDEX contains real beats, so stop showing
        // an infinite startup state. Cards can still surface their own local
        // loading/error state instead of blocking the whole gallery.
        void downloadCookingDiagnosticEvent(
          "STARTUP_GATE_FALLBACK_REVEAL", null, null,
          `priority=${priority.length} usable=0 cooking_ready=0`
        ).catch(() => {});
      }

      const initialIds = new Set((revealable.length > 0 ? revealable : priority).map(beat => beat.id));
      setRevealedBeatIds(initialIds);
      startupCookingResolvedRef.current = true;
      void downloadCookingDiagnosticEvent(
        "STARTUP_GATE_READY", null, null,
        `visible=${usable.length} images=${usable.length} audio=${usable.length} engine=1 ready_bytes=${readyBytes}`
      ).catch(() => {});

      requestAnimationFrame(() => {
        if (!cancelled) {
          setStartupCookingGate(false);
          dismissBeatGalerStartupLoader();
        }
      });
    })();

    return () => {
      cancelled = true;
      if (!startupCookingResolvedRef.current) startupPipelineStartedRef.current = false;
    };
  }, [
    loading, settings, cloudSessionVerified, connectionState, filteredBeatIdsKey,
    ensureArtworkReady, ensureWarmPlaybackUrl, primeAudioEngine,
  ]);

  // After the first six are usable, prepare the rest one at a time. A card is
  // added to React only after its artwork is decoded and its cooking head is
  // ready, so the user never watches a blank cover fill in later.
  useEffect(() => {
    if (startupCookingGate || loading || !cloudSessionVerified || !settings?.telegram_cloud_connected) return;
    const runId = ++progressiveRevealRunRef.current;
    const queue = filteredBeats.filter(beat => !revealedBeatIds.has(beat.id));
    if (queue.length === 0) return;

    void (async () => {
      for (const beat of queue) {
        if (progressiveRevealRunRef.current !== runId) return;
        const [artworkReady] = await Promise.all([
          ensureArtworkReady(beat),
          ensureWarmPlaybackUrl(beat),
        ]);
        if (progressiveRevealRunRef.current !== runId) return;
        const audioReady = await waitForCookingReady(beat);
        if (progressiveRevealRunRef.current !== runId) return;
        if (!audioReady) continue;

        // Missing/stale artwork is a per-card degradation, not a reason to hide
        // the beat forever. BeatCard owns the stable fallback presentation.
        if (!artworkReady) {
          void downloadCookingDiagnosticEvent(
            "PROGRESSIVE_REVEAL_ARTWORK_FALLBACK", beat.id, beat.name, "artwork=0 audio=1"
          ).catch(() => {});
        }

        setRevealedBeatIds(current => {
          if (current.has(beat.id)) return current;
          const next = new Set(current);
          next.add(beat.id);
          return next;
        });
        void downloadCookingDiagnosticEvent(
          "PROGRESSIVE_REVEAL_READY", beat.id, beat.name,
          artworkReady ? "artwork=1 audio=1" : "artwork=fallback audio=1"
        ).catch(() => {});
        await new Promise(resolve => window.setTimeout(resolve, 70));
      }
    })();

    return () => {
      if (progressiveRevealRunRef.current === runId) progressiveRevealRunRef.current += 1;
    };
  }, [
    startupCookingGate, loading, cloudSessionVerified, settings?.telegram_cloud_connected,
    filteredBeatIdsKey, ensureArtworkReady, ensureWarmPlaybackUrl, waitForCookingReady,
  ]);


  // The player/queue must never outlive the authoritative gallery. This also
  // prevents Next/Previous from navigating cached beats after Trash/Delete All
  // or after Refresh confirms an empty INDEX.
  useEffect(() => {
    const liveIds = new Set(beats.map(beat => beat.id));
    setQueueIds(ids => ids.filter(id => liveIds.has(id)));
    setSelectedIds(ids => {
      const next = new Set(Array.from(ids).filter(id => liveIds.has(id)));
      return next.size === ids.size ? ids : next;
    });
    if (audio.playingId && !liveIds.has(audio.playingId)) releaseFile();
    if (beats.length === 0) {
      setShowQueue(false);
      setAnchorIdx(null);
    }
  }, [beats, audio.playingId, releaseFile]);

  const playbackQueue = useMemo(() => {
    if (!audio.playingId) return displayedBeats;
    if (displayedBeats.some((b) => b.id === audio.playingId)) return displayedBeats;
    return beats;
  }, [audio.playingId, displayedBeats, beats]);

  const currentQueueIndex = useMemo(
    () => playbackQueue.findIndex((b) => b.id === audio.playingId),
    [playbackQueue, audio.playingId]
  );

  const playFromQueueIndex = useCallback((index: number) => {
    if (index < 0 || index >= playbackQueue.length) return;
    const target = playbackQueue[index];
    if (target) handlePlay(target);
  }, [playbackQueue, handlePlay]);

  const handleNext = useCallback((fromEnded = false) => {
    if (beats.length === 0) return;
    if (queueIds.length > 0) {
      const nextId = queueIds[0];
      const nextBeat = beats.find((b) => b.id === nextId);
      setQueueIds((ids) => ids.slice(1));
      if (nextBeat) {
        handlePlay(nextBeat);
        return;
      }
    }

    if (playbackQueue.length === 0) return;
    if (currentQueueIndex === -1) {
      playFromQueueIndex(0);
      return;
    }

    if (fromEnded && repeatMode === "one") {
      playFromQueueIndex(currentQueueIndex);
      return;
    }

    if (shuffleEnabled) {
      if (playbackQueue.length === 1) {
        if (!fromEnded || repeatMode !== "off") playFromQueueIndex(0);
        return;
      }
      let nextIndex = currentQueueIndex;
      while (nextIndex === currentQueueIndex) {
        nextIndex = Math.floor(Math.random() * playbackQueue.length);
      }
      playFromQueueIndex(nextIndex);
      return;
    }

    let nextIndex = currentQueueIndex + 1;
    if (nextIndex >= playbackQueue.length) {
      if (fromEnded && repeatMode === "off") return;
      nextIndex = 0;
    }
    playFromQueueIndex(nextIndex);
  }, [queueIds, beats, handlePlay, playbackQueue, currentQueueIndex, repeatMode, shuffleEnabled, playFromQueueIndex]);

  const handlePrev = useCallback(() => {
    if (beats.length === 0 || playbackQueue.length === 0) return;
    if (audio.progress > 0.05) {
      seek(0);
      return;
    }
    if (shuffleEnabled && playbackQueue.length > 1) {
      let prevIndex = currentQueueIndex;
      while (prevIndex === currentQueueIndex) {
        prevIndex = Math.floor(Math.random() * playbackQueue.length);
      }
      playFromQueueIndex(prevIndex);
      return;
    }
    if (currentQueueIndex <= 0) {
      playFromQueueIndex(playbackQueue.length - 1);
      return;
    }
    playFromQueueIndex(currentQueueIndex - 1);
  }, [playbackQueue, audio.progress, seek, shuffleEnabled, currentQueueIndex, playFromQueueIndex]);

  useEffect(() => {
    if (audio.endedSeq === 0) return;
    if (audio.endedSeq <= lastHandledEndedSeqRef.current) return;
    lastHandledEndedSeqRef.current = audio.endedSeq;
    handleNext(true);
  }, [audio.endedSeq, handleNext]);

  const queuedBeats = useMemo(() => {
    const map = new Map(beats.map((b) => [b.id, b] as const));
    return queueIds.map((id) => map.get(id)).filter(Boolean) as Beat[];
  }, [queueIds, beats]);

  const currentBeat = beats.find(b => b.id === audio.playingId);
  const selectedBeats = beats.filter(b => selectedIds.has(b.id));
  const activeDragBeat = activeDragId ? beats.find(b => b.id === activeDragId) ?? null : null;

  return (
    <div
      style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#0c0c0c", overflow: "hidden" }}
    >
      {(connectionState === "poor" || connectionState === "offline") && (
        <div style={{
          position: "fixed", top: 62, left: "50%", transform: "translateX(-50%)", zIndex: 20200,
          maxWidth: "min(620px, calc(100vw - 36px))", padding: "10px 14px", borderRadius: 10,
          border: "1px solid #7a6525", background: "#302913", color: "#f0d77d",
          boxShadow: "0 12px 34px rgba(0,0,0,.4)", fontSize: 11.5, lineHeight: 1.4, textAlign: "center",
        }}>
          {connectionState === "offline"
            ? "You're offline. This session can keep using already prepared audio; after restart only beats with the green Offline check are shown."
            : "Poor connection. BeatGaler is retrying automatically; cloud actions may take longer."}
        </div>
      )}
      {cloudFilesDownloadError && (
        <div style={{
          position: "fixed", top: 62, right: 18, zIndex: 20140, width: 360, maxWidth: "calc(100vw - 36px)",
          padding: "12px 42px 12px 14px", borderRadius: 10, border: "1px solid #7a2525",
          background: "#351414", color: "#ffd7d7", boxShadow: "0 14px 44px rgba(0,0,0,.65)",
          fontSize: 12, lineHeight: 1.5,
        }}>
          <button
            type="button"
            aria-label="Close download error"
            onClick={() => setCloudFilesDownloadError(null)}
            style={{
              position: "absolute", top: 8, right: 8, width: 24, height: 24, border: "none",
              borderRadius: 6, background: "transparent", color: "#ff9d9d", cursor: "pointer",
              fontSize: 16, lineHeight: "24px", padding: 0, textAlign: "center",
            }}
          >×</button>
          <div style={{ fontWeight: 700, marginBottom: 3 }}>Download failed</div>
          <div>{cloudFilesDownloadError}</div>
        </div>
      )}
      {projectUpdateNotice && (
        <div style={{
          position: "fixed", top: cloudDownloadNotice ? 116 : 62, right: 18, zIndex: 20130,
          width: 360, maxWidth: "calc(100vw - 36px)", padding: "11px 38px 11px 14px",
          borderRadius: 10, border: "1px solid #66521f", background: "#2d2714",
          color: "#f1d783", boxShadow: "0 14px 44px rgba(0,0,0,.45)", fontSize: 12, lineHeight: 1.45,
        }}>
          <button
            type="button"
            aria-label="Close project notice"
            onClick={() => setProjectUpdateNotice(null)}
            style={{
              position: "absolute", top: 7, right: 8, width: 24, height: 24, border: "none",
              borderRadius: 6, background: "transparent", color: "#d8bd67", cursor: "pointer",
              fontSize: 16, lineHeight: "24px", padding: 0, textAlign: "center",
            }}
          >×</button>
          <div style={{ fontWeight: 700, marginBottom: 2 }}>Project notice</div>
          <div>{projectUpdateNotice}</div>
        </div>
      )}
      {cloudDownloadNotice && (
        <div style={{
          position: "fixed", top: 62, right: 18, zIndex: 20120, width: 340, maxWidth: "calc(100vw - 36px)",
          padding: "11px 14px", borderRadius: 10,
          border: cloudDownloadNotice.status === "completed" ? "1px solid #257a3d" : "1px solid #303030",
          background: cloudDownloadNotice.status === "completed" ? "#12351d" : "#171717",
          color: cloudDownloadNotice.status === "completed" ? "#8ff0aa" : "#e8e8e8",
          boxShadow: "0 14px 44px rgba(0,0,0,.45)", fontSize: 12, lineHeight: 1.45,
        }}>
          {cloudDownloadNotice.status === "downloading" ? (
            cloudDownloadNotice.kind === "ALL"
              ? <>Downloading everything from &quot;{cloudDownloadNotice.beatName}&quot;...</>
              : cloudDownloadNotice.kind === "PROJECT"
                ? <>Downloading Full Project from &quot;{cloudDownloadNotice.beatName}&quot;...</>
                : <>Downloading {cloudDownloadNotice.kind} from &quot;{cloudDownloadNotice.beatName}&quot;...</>
          ) : (
            cloudDownloadNotice.kind === "ALL"
              ? <>Downloaded everything from &quot;{cloudDownloadNotice.beatName}&quot;.</>
              : cloudDownloadNotice.kind === "PROJECT"
                ? <>Downloaded Full Project from &quot;{cloudDownloadNotice.beatName}&quot;.</>
                : <>Downloaded {cloudDownloadNotice.kind} from &quot;{cloudDownloadNotice.beatName}&quot;.</>
          )}
        </div>
      )}
      {interruptedUploadNotices.length > 0 && (
        <div style={{
          position: "fixed", top: 62, right: 18, zIndex: 20000, width: 360, maxWidth: "calc(100vw - 36px)",
          padding: "12px 42px 12px 14px", borderRadius: 10, border: "1px solid #7a2525",
          background: "#351414", color: "#ffd7d7", boxShadow: "0 14px 44px rgba(0,0,0,.55)",
          fontSize: 12, lineHeight: 1.5,
        }}>
          <button
            type="button"
            aria-label="Close notification"
            title="Close"
            onClick={() => setInterruptedUploadNotices([])}
            style={{
              position: "absolute", top: 8, right: 8, width: 24, height: 24, border: "none",
              borderRadius: 6, background: "transparent", color: "#ff9d9d", cursor: "pointer",
              fontSize: 16, lineHeight: "24px", padding: 0, textAlign: "center",
            }}
          >
            ×
          </button>
          {interruptedUploadNotices.map(name => (
            <div key={name}>Your last upload of &quot;{name}&quot; was interrupted. The incomplete upload was removed.</div>
          ))}
        </div>
      )}
      {/* Top bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 24px", height: 50, flexShrink: 0, borderBottom: "1px solid #111" }}>
        <span style={{ fontWeight: 400, fontSize: 14, color: "#aaa", letterSpacing: 0.3 }}>beat galer</span>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <SearchBar value={search} onChange={setSearch} />
          <SortMenu value={sortBy} onChange={setSortBy} />
          {/* Settings gear */}
          <button
            onClick={() => setShowSettings(true)}
            title="Settings"
            style={{ width: 32, height: 32, borderRadius: 8, background: "transparent", border: "none", color: "#444", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}
            onMouseEnter={e => (e.currentTarget.style.color = "#aaa")}
            onMouseLeave={e => (e.currentTarget.style.color = "#444")}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1a1.7 1.7 0 0 0 1.1 1.6 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.1.38.3.72.6 1 .3.27.68.4 1.1.4h.1v4h-.1a1.7 1.7 0 0 0-1.7.6Z"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg></button>
          <button
            onClick={() => { clearUploadPreviewCache(); void reloadLibrary(); }}
            title={deferredLibraryReloadRef.current ? "Reload queued until uploads finish" : "Reload Library"}
            disabled={loading || libraryRefreshing}
            style={{ width: 32, height: 32, borderRadius: 8, background: "transparent", border: "none", color: (loading || libraryRefreshing) ? "#666" : "#444", cursor: (loading || libraryRefreshing) ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}
            onMouseEnter={e => { if (!loading && !libraryRefreshing) e.currentTarget.style.color = "#aaa"; }}
            onMouseLeave={e => { e.currentTarget.style.color = (loading || libraryRefreshing) ? "#666" : "#444"; }}
          ><span style={{ display: "inline-block", animation: libraryRefreshing ? "beatgaler-refresh-spin .62s linear infinite" : "none" }}>↻</span></button>
          {/* Apple-style Select / Select All / Done */}
          {selectMode ? (
            <>
              <button
                onClick={() => {
                  const allSelected = displayedBeats.every(b => selectedIds.has(b.id));
                  setSelectedIds(allSelected ? new Set() : new Set(displayedBeats.map(b => b.id)));
                }}
                style={{ padding: "5px 12px", borderRadius: 7, background: "transparent", border: "1px solid #2a2a2a", color: "#888", fontSize: 12, cursor: "pointer" }}>
                {displayedBeats.length > 0 && displayedBeats.every(b => selectedIds.has(b.id)) ? "Deselect All" : "Select All"}
              </button>
              <button
                onClick={() => { setSelectMode(false); setSelectedIds(new Set()); setAnchorIdx(null); }}
                style={{ padding: "5px 12px", borderRadius: 7, background: "transparent", border: "1px solid #2a2a2a", color: "#ccc", fontSize: 12, cursor: "pointer", fontWeight: 500 }}>
                Done
              </button>
            </>
          ) : (
            <button
              onClick={() => setSelectMode(true)}
              style={{ padding: "5px 12px", borderRadius: 7, background: "transparent", border: "1px solid #1e1e1e", color: "#555", fontSize: 12, cursor: "pointer" }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#aaa"; (e.currentTarget as HTMLElement).style.borderColor = "#2a2a2a"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "#555"; (e.currentTarget as HTMLElement).style.borderColor = "#1e1e1e"; }}>
              Select
            </button>
          )}
        </div>
      </div>

      {/* Selection toolbar */}
      {selectedIds.size > 0 && (
        <div style={{ padding: "0 24px", height: 40, display: "flex", alignItems: "center", gap: 12, background: "#111", borderBottom: "1px solid #1a1a1a", flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: "#888" }}>{selectedIds.size} selected</span>
          <button onClick={handleEditBulk}
            style={{ padding: "5px 14px", background: "#1e1e1e", border: "1px solid #2a2a2a", borderRadius: 6, color: "#ccc", fontSize: 12, cursor: "pointer" }}>
            Edit all
          </button>
          <button onClick={handleUploadBulk}
            style={{ padding: "5px 14px", background: "#202020", border: "1px solid #2e2e2e", borderRadius: 6, color: "#e0e0e0", fontSize: 12, cursor: "pointer", fontWeight: 500 }}>
            Upload to YouTube
          </button>
          <button onClick={handleRemoveBulk}
            style={{ padding: "5px 14px", background: "transparent", border: "1px solid #3d0000", borderRadius: 6, color: "#f87171", fontSize: 12, cursor: "pointer" }}>
            Remove all
          </button>
          <button onClick={() => { setSelectedIds(new Set()); setSelectMode(false); setAnchorIdx(null); }}
            style={{ marginLeft: "auto", background: "none", border: "none", color: "#444", fontSize: 12, cursor: "pointer" }}>
            Cancel
          </button>
        </div>
      )}

      {/* Tag filter */}
<div style={{ padding: "7px 24px", display: "flex", gap: 6, flexWrap: "wrap", borderBottom: "1px solid #111", flexShrink: 0 }}>
  <button
    onClick={() => { setIncludedTags(new Set()); setExcludedTags(new Set()); }}
    style={{
      padding: "4px 12px", borderRadius: 20,
      background: (!includedTags.size && !excludedTags.size) ? "#e5e5e5" : "transparent",
      border: `1px solid ${(!includedTags.size && !excludedTags.size) ? "#e5e5e5" : "#1e1e1e"}`,
      color: (!includedTags.size && !excludedTags.size) ? "#000" : "#444", fontSize: 12, cursor: "pointer",
    }}>All</button>
  {allTags.map(t => {
    const color = tagColors[t.trim().toLowerCase()];
    const included = includedTags.has(t);
    const excluded = excludedTags.has(t);
    const bg = excluded ? "rgba(248,113,113,0.14)" : included ? (color ?? "#e5e5e5") : (color ? `${color}22` : "transparent");
    const border = excluded ? "#7f1d1d" : included ? (color ?? "#e5e5e5") : (color ? `${color}55` : "#1e1e1e");
    const text = excluded ? "#f87171" : included ? (color ? "#fff" : "#000") : (color ?? "#444");
    return (
      <button key={t}
        onClick={(e) => handleTagClick(t, e)}
        onContextMenu={(e) => {
          e.preventDefault();
          window.dispatchEvent(new Event("beatcard:close-menus"));
          setTagColorMenu({ tag: t, x: e.clientX, y: e.clientY });
        }}
        style={{
          padding: "4px 12px", borderRadius: 20, background: bg,
          border: `1px solid ${border}`, color: text, fontSize: 12, cursor: "pointer",
          textDecoration: excluded ? "line-through" : "none",
          display: "inline-flex", alignItems: "center", gap: 5,
        }}>
        {t}
      </button>
    );
  })}
</div>

{tagColorMenu && (
  <TagColorMenu
    x={tagColorMenu.x}
    y={tagColorMenu.y}
    current={tagColors[tagColorMenu.tag.trim().toLowerCase()] ?? null}
    onSelect={(hex) => { setTagColor(tagColorMenu.tag, hex); setTagColorMenu(null); }}
    onRename={() => {
      const oldTag = tagColorMenu.tag.trim().toLowerCase();
      setTagColorMenu(null);
      setTagRename({ oldTag, newTag: oldTag, stage: "name" });
      setTagRenameError(null);
    }}
    onClose={() => setTagColorMenu(null)}
  />
)}


{tagRename && (() => {
  const normalizedOld = tagRename.oldTag.trim().toLowerCase();
  const affected = beats.filter(b => b.tags.some(t => t.trim().toLowerCase() === normalizedOld));
  const mp3Count = affected.filter(b => !!b.mp3_path).length;
  const wavCount = affected.filter(b => !!b.wav_path).length;
  return ReactDOM.createPortal(
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 10020, background: "rgba(0,0,0,0.72)", backdropFilter: "blur(5px)" }} />
      <div style={{ position: "fixed", zIndex: 10021, width: 430, maxWidth: "calc(100vw - 32px)", left: "50%", top: "50%", transform: "translate(-50%,-50%)", background: "#121212", border: "1px solid #292929", borderRadius: 14, padding: 22, boxShadow: "0 28px 90px rgba(0,0,0,.8)" }}>
        <div style={{ fontSize: 16, color: "#eee", fontWeight: 600 }}>Rename tag globally</div>
        {tagRename.stage === "name" ? (
          <>
            <div style={{ marginTop: 8, fontSize: 12, color: "#777" }}>The original metadata order will be preserved; only the matching tag name changes.</div>
            <input autoFocus value={tagRename.newTag} onChange={e => setTagRename({ ...tagRename, newTag: e.target.value })}
              onKeyDown={e => { if (e.key === "Enter" && tagRename.newTag.trim() && tagRename.newTag.trim().toLowerCase() !== normalizedOld) setTagRename({ ...tagRename, stage: "confirm" }); }}
              style={{ width: "100%", marginTop: 16, padding: "10px 12px", borderRadius: 8, border: "1px solid #333", background: "#191919", color: "#fff", outline: "none" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button onClick={() => setTagRename(null)} style={{ padding: "8px 13px", borderRadius: 7, border: "1px solid #333", background: "transparent", color: "#999", cursor: "pointer" }}>Cancel</button>
              <button disabled={!tagRename.newTag.trim() || tagRename.newTag.trim().toLowerCase() === normalizedOld} onClick={() => setTagRename({ ...tagRename, stage: "confirm" })} style={{ padding: "8px 13px", borderRadius: 7, border: 0, background: "#eee", color: "#111", cursor: "pointer" }}>Continue</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ marginTop: 14, padding: 14, borderRadius: 9, background: "#191919", color: "#aaa", fontSize: 12, lineHeight: 1.7 }}>
              <div><b style={{ color: "#ddd" }}>{normalizedOld}</b> → <b style={{ color: "#ddd" }}>{tagRename.newTag.trim().toLowerCase()}</b></div>
              <div style={{ marginTop: 8 }}>This will rewrite metadata in:</div>
              <div> {affected.length} beats</div><div> {mp3Count} MP3 files</div><div> {wavCount} WAV files</div>
              <div style={{ marginTop: 8, color: "#fbbf24" }}>Do not close Beat Galer while it is running. A recovery journal will roll back an interrupted operation on the next start.</div>
            </div>
            {tagRenameError && <div style={{ marginTop: 10, color: "#f87171", fontSize: 11 }}>{tagRenameError}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button disabled={tagRenameBusy} onClick={() => setTagRename({ ...tagRename, stage: "name" })} style={{ padding: "8px 13px", borderRadius: 7, border: "1px solid #333", background: "transparent", color: "#999", cursor: "pointer" }}>Back</button>
              <button disabled={tagRenameBusy || affected.length === 0} onClick={confirmTagRename} style={{ padding: "8px 13px", borderRadius: 7, border: 0, background: "#ef4444", color: "#fff", cursor: "pointer" }}>{tagRenameBusy ? "Renaming…" : "Rename everywhere"}</button>
            </div>
          </>
        )}
      </div>
    </>, document.body
  );
})()}

      {/* Grid — OS file drag-drop */}
      <div
        data-library-scroll="true"
        style={{ flex: 1, position: "relative", overflowY: "auto", padding: "28px 24px", paddingBottom: currentBeat ? 90 : 28, opacity: libraryRefreshing ? 0.82 : 1, transform: libraryRefreshing ? "scale(0.997)" : "scale(1)", transition: "opacity 150ms ease, transform 150ms ease" }}

      >
        {libraryRefreshing && (
          <div aria-hidden="true" style={{ position: "sticky", top: -28, left: 0, right: 0, height: 2, zIndex: 20, overflow: "hidden", pointerEvents: "none" }}>
            <div style={{ width: "28%", height: "100%", background: "rgba(255,255,255,.38)", animation: "beatgaler-refresh-line .72s ease-in-out infinite" }} />
          </div>
        )}
        {((loading && !cloudSessionVerified) || (startupCookingGate && beats.length > 0) || (filteredBeats.length > 0 && displayedBeats.length === 0)) ? (
          <GalleryStartupSkeleton />
        ) : filteredBeats.length === 0 ? (
          <div style={{ textAlign: "center", paddingTop: 92, color: "#383838" }}>
            {beats.length === 0 ? (
              <div>
                <div style={{ fontSize: 15, color: "#555", fontWeight: 500 }}>Empty Gallery</div>
                <div style={{ marginTop: 7, fontSize: 12, color: "#2f2f2f" }}>
                  {settings?.telegram_cloud_connected
                    ? "Add a beat to start your library."
                    : "BeatGaler Cloud is currently unavailable."}
                </div>
              </div>
            ) : <div style={{ fontSize: 13 }}>No beats match your search</div>}
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <SortableContext items={displayedBeats.map((b) => b.id)} strategy={rectSortingStrategy}>
              <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
                <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "28px 22px", alignContent: "flex-start", maxWidth: 1300 }}>
                {displayedBeats.map((beat, i) => (
                  <BeatCard
                    key={beat.id}
                    beat={beat}
                    openableProject={openableCloudProjectIds.has(beat.id) || Boolean(beat.offline_available && (beat.has_flp || beat.has_als) && (beat.flp_path || beat.als_path))}
                    cloudUploadErrorDetail={backgroundUploadErrors[beat.id]}
                    tagFrequency={tagFrequency}
                    showIncompleteWarnings={settings?.incomplete_warnings_enabled ?? true}
                    playing={audio.playingId === beat.id && audio.isPlaying}
                    selected={selectedIds.has(beat.id)}
                    selectedCount={selectedIds.size}
                    selectMode={selectMode}
                    dragEnabled={!selectMode}
                    networkOnline={connectionState === "online"}
                    offlineBusy={offlineBusyIds.has(beat.id)}
                    onToggleOffline={handleToggleOffline}
                    onRetryUpload={retryBackgroundUpload}
                    onBulkEdit={handleEditBulk}
                    onBulkUpload={handleUploadBulk}
                    onBulkDelete={handleRemoveBulk}
                    onPlay={handlePlay}
                    onWarm={handleWarm}
                    onDetail={b => setDrawer({ beat: b, mode: "detail" })}
                    onEdit={b => { if (!rejectOfflineMutation("Editing metadata")) setDrawer({ beat: b, mode: "edit" }); }}
                    onDelete={deleteBeat}
                    onAddToQueue={addToQueue}
                    onUpload={handleUpload}
                    onUploadTelegram={handleUploadTelegram}
                    onDownloadTelegram={handleDownloadTelegram}
                    onUploadProjectTelegram={handleUploadProjectTelegram}
                    onOpenProject={handleOpenProject}
                    onUpdateProject={handleUpdateProject}
                    onCloudFiles={handleCloudFiles}
                    onToggleSelect={(b, e) => handleToggleSelect(b, e, displayedBeats)}
                    animDelay={i * 0.02}
                  />
                ))}
                </div>
              </div>
            </SortableContext>
            <DragOverlay>
              {activeDragBeat ? (
                <div style={{ width: 160, borderRadius: 12, transform: "scale(1.02)", boxShadow: "0 20px 40px rgba(0,0,0,0.6)" }}>
                  <Artwork beat={activeDragBeat} size={160} playing={false} />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      {/* + Add beat */}
      {!currentBeat && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 45 }}>
          <button onClick={() => { if (!rejectOfflineMutation("Adding a beat")) setShowAdd(true); }}
            style={{ padding: "9px 20px", borderRadius: 40, background: "#161616", border: "1px solid #242424", color: "#777", fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, boxShadow: "0 4px 24px rgba(0,0,0,0.6)" }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#202020"; (e.currentTarget as HTMLElement).style.color = "#ccc"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "#161616"; (e.currentTarget as HTMLElement).style.color = "#777"; }}>
            <PlusIcon size={11} /> Add beat
          </button>
        </div>
      )}

      {cloudFilesBeat && (
        <CloudFilesModal
          beat={cloudFilesBeat}
          files={cloudFiles}
          busyId={cloudFilesBusyId}
          downloadedIds={cloudFilesDownloadedIds}
          onDownload={handleGetCloudFile}
          onClose={() => setCloudFilesBeat(null)}
        />
      )}

      {showAdd && <AddBeatModal onClose={() => setShowAdd(false)} onAdd={addBeatsAndReview} existingBeats={beats} />}

      {showSettings && (
        <SettingsPanel
          currentFolder={settings?.beats_folder ?? null}
          showIncompleteWarnings={settings?.incomplete_warnings_enabled ?? true}
          onIncompleteWarningsChanged={(enabled: boolean) => setSettings(current => current
            ? { ...current, incomplete_warnings_enabled: enabled }
            : { beats_folder: null, incomplete_warnings_enabled: enabled, custom_cursor_enabled: true })}
          customCursorEnabled={settings?.custom_cursor_enabled ?? true}
          onCustomCursorChanged={(enabled: boolean) => setSettings(current => current
            ? { ...current, custom_cursor_enabled: enabled }
            : { beats_folder: null, incomplete_warnings_enabled: true, custom_cursor_enabled: enabled })}
          telegramConnected={settings?.telegram_cloud_connected ?? false}
          networkOnline={connectionState === "online"}
          telegramUsername={settings?.telegram_cloud_username ?? null}
          onDisconnectTelegram={handleDisconnectTelegramAccount}
          onClose={() => setShowSettings(false)}
          onFolderChanged={folder => setSettings(s => s ? { ...s, beats_folder: folder } : { beats_folder: folder, incomplete_warnings_enabled: true, custom_cursor_enabled: true })}
          onBeatRestored={beat => {
            if (connectionState !== "online") {
              void loadOfflineLibrary().then(setBeats).catch(error => {
                console.warn("Could not refresh Offline library after Trash restore:", error);
              });
              return;
            }

            // Never build a Telegram INDEX from the render-time `beats` closure.
            // Trash restore can happen while Refresh/hydration is replacing the
            // visible array, so that closure may be empty/stale. Use the latest
            // verified library ref and atomically add the restored beat.
            const current = beatsLatestRef.current;
            const next = current.some(b => b.id === beat.id)
              ? current.map(b => b.id === beat.id ? beat : b)
              : [...current, beat];
            setBeats(next);
            beatsLatestRef.current = next;

            if (beat.telegram_file_id) {
              void libraryStateManager.commitSnapshot(next, "trash-restore").catch(error => {
                // The native safety barrier preserves the previous INDEX if this
                // snapshot is ever stale. Keep the visible restored card too.
                console.warn("Telegram library index refresh after trash restore failed safely:", error);
              });
            }
          }}
        />
      )}

      {drawer && !reviewQueue && !reviewBootstrap && (
        <Drawer
          beat={drawer.beat}
          mode={drawer.mode}
          tagSuggestions={tagSuggestions}
          onClose={() => { setDrawer(null); setSelectedIds(new Set()); setSelectMode(false); setAnchorIdx(null); }}
          onSaved={updateBeat}
          onReleaseAudio={() => { if (audio.playingId === drawer.beat.id) releaseFile(); }}
          selectedBeats={selectedBeats.length > 1 ? selectedBeats : undefined}
          onBulkSaved={applyBulkUpdate}
          mutationAllowed={connectionState === "online"}
        />
      )}

      {libraryDropStaging && !reviewBootstrap && !reviewQueue && REVIEW_SKELETON_ENABLED && (
        <ReviewBeatSkeleton current={1} total={null} />
      )}

      {reviewBootstrap && REVIEW_SKELETON_ENABLED && (
        <ReviewBeatSkeleton current={1} total={reviewBootstrap.total} onCancel={skipAllReviewQueue} />
      )}

      {reviewQueue && !reviewQueue.beats[reviewQueue.index] && REVIEW_SKELETON_ENABLED && (
        <ReviewBeatSkeleton current={reviewQueue.index + 1} total={reviewQueue.total} onCancel={skipAllReviewQueue} />
      )}

      {reviewQueue && reviewQueue.beats[reviewQueue.index] && (
        <Drawer
          beat={reviewQueue.beats[reviewQueue.index]}
          mode="edit"
          tagSuggestions={tagSuggestions}
          reviewInfo={{ current: reviewQueue.index + 1, total: reviewQueue.total }}
          closeAfterSave={false}
          onClose={skipCurrentReviewBeat}
          onSkipCurrent={skipCurrentReviewBeat}
          onSkipAll={skipAllReviewQueue}
          onSaveAll={handleReviewedSaveAll}
          mutationAllowed={connectionState === "online"}
          isReviewNameTaken={(candidateName, _currentBeatId) => {
            const normalized = candidateName.trim().toLocaleLowerCase();
            if (!normalized) return false;
            // Use the live React state. The previous implementation used
            // beatsLatestRef, which can lag behind immediately after adding a
            // Review candidate and allowed duplicate names through.
            return beats.some(existing =>
              existing.name.trim().toLocaleLowerCase() === normalized
            );
          }}
          onSaved={handleReviewedBeatSaved}
          onReleaseAudio={() => {
            if (audio.playingId === reviewQueue.beats[reviewQueue.index].id) releaseFile();
          }}
        />
      )}

      {beatFileDrop && (
        <BeatFileDropModal
          beat={beatFileDrop.beat}
          filePath={beatFileDrop.filePath}
          isDirectory={beatFileDrop.kind === "directory"}
          onChoose={handleDroppedBeatFileRole}
          onClose={() => {
            void cleanupStagedDropPaths([beatFileDrop.filePath]);
            setBeatFileDrop(null);
          }}
        />
      )}

      {audioConflictBatch && audioConflictBatch.audio_conflicts.length > 0 && (
        <ImportAudioConflictsModal
          batchId={audioConflictBatch.batch_id}
          conflicts={audioConflictBatch.audio_conflicts}
          onCancel={() => {
            const batchId = audioConflictBatch.batch_id;
            stagedImportPathsRef.current.delete(batchId);
            setAudioConflictBatch(null);
            setDeferredImportBatch(null);
            // Cancel only the unresolved tail. Already-saved normal beats/uploads
            // keep their staged files via the existing protected cleanup path.
            void discardImportReviewBatch(batchId);
          }}
          onResolved={(resolved) => {
            const batchId = audioConflictBatch.batch_id;
            setAudioConflictBatch(null);
            setDeferredImportBatch(current => current ? { ...current, audio_conflicts: [] } : current);
            if (resolved.length > 0) {
              setReviewQueue({ beats: resolved, index: 0, total: resolved.length, batchId, preparing: false });
            }
          }}
        />
      )}

      {dropImportBatch && (
        <ImportDecisionsModal
          batch={dropImportBatch}
          onClose={() => {
            const staged = stagedImportPathsRef.current.get(dropImportBatch.batch_id) ?? [];
            stagedImportPathsRef.current.delete(dropImportBatch.batch_id);
            void cleanupStagedDropPaths(staged);
            void discardImportReviewBatch(dropImportBatch.batch_id);
            setDeferredImportBatch(null);
            setDropImportBatch(null);
            setDropImporting(false);
          }}
          onImported={(imported) => {
            // Do not delete the captured files here. The imported BeatMeta records
            // still point at them and the Telegram upload may happen seconds later.
            stagedImportPathsRef.current.delete(dropImportBatch.batch_id);
            setDeferredImportBatch(null);
            setDropImportBatch(null);
            setDropImporting(false);
            addBeatsAndReview(imported);
          }}
        />
      )}

      {(dropActive || dropImporting) && !libraryDropStaging && !reviewBootstrap && !reviewQueue && (
        <div style={{
          position: "fixed",
          left: "50%",
          bottom: currentBeat ? 86 : 24,
          transform: "translateX(-50%)",
          zIndex: 10000,
          pointerEvents: "none",
          width: "min(620px, calc(100vw - 48px))",
        }}>
          <div style={{
            padding: "13px 18px",
            borderRadius: 12,
            border: "2px dashed #f5a623",
            background: "rgba(17,17,17,0.94)",
            textAlign: "center",
            boxShadow: "0 10px 32px rgba(0,0,0,0.42)",
          }}>
            <div style={{ fontSize: 13, color: "#eee", fontWeight: 600 }}>
              {dropImporting ? "Importando…" : "Suelta aquí para agregar como beat aparte"}
            </div>
            {!dropImporting && (
              <div style={{ fontSize: 10, color: "#777", marginTop: 4, lineHeight: 1.45 }}>
                O arrástralo encima de un beat para agregarlo a ese beat.
              </div>
            )}
          </div>
        </div>
      )}

      {currentBeat && (
        <Player
          beat={currentBeat}
          playing={audio.isPlaying}
          progress={audio.progress}
          duration={audio.duration}
          volume={audio.volume}
          queue={queuedBeats}
          currentIndex={-1}
          showQueue={showQueue}
          shuffleEnabled={shuffleEnabled}
          repeatMode={repeatMode}
          canShowQueue={queuedBeats.length > 0}
          onToggle={togglePause}
          onSeek={seek}
          onPrev={handlePrev}
          onNext={() => handleNext(false)}
          onVolumeChange={setVolume}
          onToggleShuffle={() => setShuffleEnabled((v) => !v)}
          onCycleRepeat={() => setRepeatMode((m) => (m === "off" ? "all" : m === "all" ? "one" : "off"))}
          onToggleQueue={() => setShowQueue((v) => !v)}
          onPlayQueueIndex={(index) => {
            const target = queuedBeats[index];
            if (!target) return;
            handlePlay(target);
            setQueueIds((ids) => ids.filter((id) => id !== target.id));
          }}
          onAddBeat={() => { if (!rejectOfflineMutation("Adding a beat")) setShowAdd(true); }}
          onDetail={(b) => setDrawer({ beat: b, mode: "detail" })}
          onEdit={(b) => { if (!rejectOfflineMutation("Editing metadata")) setDrawer({ beat: b, mode: "edit" }); }}
          onDelete={deleteBeat}
          onAddToQueue={addToQueue}
        />
      )}

      {showUpload && (
        <UploadModal
          initialBeat={showUpload.initialBeat}
          allBeats={beats}
          initialSelectedIds={showUpload.selectedIds}
          onClose={() => setShowUpload(null)}
        />
      )}

      <JobStatusBar />
    </div>
  );
}


export default function App() {
  return <AccountGate><BeatGalerApp /></AccountGate>;
}
