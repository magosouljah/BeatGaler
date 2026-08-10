import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { Beat } from "../types";
import { Artwork, Stars, TagEditor, TagPill } from "./ui";
import ImageCropModal from "./ImageCropModal";
import { saveBeatMeta, renameBeat, addFileToBeat, pickFile, pickFolder, revealInExplorer, isTauriAvailable, listCloudFilesForBeat, downloadCloudFileToCache, uploadDroppedFileToTelegram, uploadProjectToTelegram, updateProjectArchiveFromSource, inspectAudioMetadata, readImagePathAsDataUrl, type CloudFileRecord, type CloudFileType, type ProjectAssetKind } from "../lib/tauri";
import { appConfirm } from "../lib/dialog";
import { listen } from "@tauri-apps/api/event";

interface Props {
  beat: Beat;
  mode: "detail" | "edit";
  tagSuggestions?: string[];
  onClose: () => void;
  onSaved: (updated: Beat) => void;
  onReleaseAudio: () => void;
  selectedBeats?: Beat[];
  onBulkSaved?: (updates: Partial<Beat>, options?: { tagsMode?: "add" | "replace" | "remove" }) => void;
  reviewInfo?: { current: number; total: number };
  closeAfterSave?: boolean;
  onSkipAll?: () => void;
}

// Pending file assignment — only committed on Save
type PendingFiles = {
  mp3?: string;
  wav?: string;
  samples?: string;
  stems?: string;
  flp?: string;
  als?: string;
};

type PendingCloudKey = CloudFileType | "PROJECT_FLP" | "PROJECT_SAMPLES" | "PROJECT_AUDIO";
type PendingCloudFiles = Partial<Record<PendingCloudKey, string>>;

const LABEL: Record<string, string> = { mp3: "MP3", wav: "WAV", stems: "Stems", flp: "FLP", als: "ALS" };

function formatCloudSize(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const CLOUD_PICKERS: Record<CloudFileType, { name: string; extensions: string[] }> = {
  MASTER: { name: "Main playback audio", extensions: ["mp3"] },
  WAV: { name: "HQ WAV", extensions: ["wav"] },
  PROJECT: { name: "Project archive", extensions: ["zip", "flp", "als"] },
  STEMS: { name: "Stems", extensions: ["zip", "wav"] },
  LOOP: { name: "Loop", extensions: ["mp3", "wav", "zip"] },
  OTHER: { name: "Any file", extensions: ["mp3", "wav", "zip", "flp", "als", "mid", "midi", "txt", "pdf", "png", "jpg", "jpeg"] },
};

export default function Drawer({ beat, mode, tagSuggestions = [], onClose, onSaved, onReleaseAudio, selectedBeats, onBulkSaved, reviewInfo, closeAfterSave = true, onSkipAll }: Props) {
  const [data, setData] = useState<Beat>({ ...beat });
  // pending holds files chosen by the user but NOT yet written to disk
  const [pending, setPending] = useState<PendingFiles>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bulkFields, setBulkFields] = useState<Set<string>>(new Set());
  const [bulkTagsMode, setBulkTagsMode] = useState<"add" | "replace" | "remove">("add");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const isEdit = mode === "edit";
  const isBulk = !!selectedBeats && selectedBeats.length > 1;
  const imgRef = useRef<HTMLInputElement>(null);
  const [cloudFiles, setCloudFiles] = useState<CloudFileRecord[]>([]);
  const [cloudBusy, setCloudBusy] = useState<string | null>(null);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [pendingCloud, setPendingCloud] = useState<PendingCloudFiles>({});
  const hasPending = Object.keys(pending).length > 0 || Object.keys(pendingCloud).length > 0;

  const refreshCloudFiles = useCallback(async () => {
    if (!beat.telegram_file_id) {
      setCloudFiles([]);
      return;
    }
    try {
      setCloudFiles(await listCloudFilesForBeat(beat.id));
      setCloudError(null);
    } catch (e) {
      setCloudError(String(e));
    }
  }, [beat.id, beat.telegram_file_id]);

  useEffect(() => {
    void refreshCloudFiles();
  }, [refreshCloudFiles]);

  const handleCloudDownload = useCallback(async (file: CloudFileRecord) => {
    if (cloudBusy) return;
    setCloudBusy(file.cloud_file_id);
    setCloudError(null);
    try {
      const path = await downloadCloudFileToCache(file.cloud_file_id);
      await revealInExplorer(path);
    } catch (e) {
      setCloudError(String(e));
    } finally {
      setCloudBusy(null);
    }
  }, [cloudBusy]);

  const handleCloudReplace = useCallback(async (type: CloudFileType) => {
    if (saving) return;
    const picker = CLOUD_PICKERS[type];
    const source = await pickFile([picker], beat.folder_path || undefined);
    if (!source) return;

    // Picking a file is NEVER a Telegram mutation. It stays pending until Save.
    if (type === "MASTER") {
      try {
        const preview = await inspectAudioMetadata(source);
        if (preview.has_metadata) {
          const useIncoming = await appConfirm({
            title: "MP3 metadata",
            message: "This MP3 contains metadata. Use its BPM, key, tags, rating and artwork?\n\nChoose Cancel to keep the current BeatGaler metadata. The MP3 will still be queued for replacement.",
            confirmLabel: "Use MP3 metadata",
            cancelLabel: "Keep current metadata",
          });
          if (useIncoming) {
            setData(current => ({
              ...current,
              bpm: preview.bpm || current.bpm,
              key: preview.key || current.key,
              tags: preview.tags.length > 0 ? preview.tags : current.tags,
              rating: preview.rating > 0 ? preview.rating : current.rating,
              image_base64: preview.image_base64 || current.image_base64,
            }));
          }
        }
      } catch (error) {
        setCloudError(`Could not inspect MP3 metadata: ${String(error)}`);
        return;
      }
    }

    setPendingCloud(current => ({ ...current, [type]: source }));
    setCloudError(null);
  }, [saving, beat.folder_path]);

  const handleProjectAsset = useCallback(async (kind: ProjectAssetKind) => {
    if (saving) return;
    let source: string | null = null;
    if (kind === "flp") {
      source = await pickFile([{ name: "FL Studio project", extensions: ["flp"] }], beat.folder_path || undefined);
    } else {
      source = await pickFolder(kind === "samples" ? "Select Samples folder" : "Select Audio folder");
    }
    if (!source) return;
    const key: PendingCloudKey = kind === "flp" ? "PROJECT_FLP" : kind === "samples" ? "PROJECT_SAMPLES" : "PROJECT_AUDIO";
    setPendingCloud(current => ({ ...current, [key]: source! }));
    setCloudError(null);
  }, [saving, beat.folder_path]);

  const handleManualProjectUpdate = useCallback(async () => {
    if (cloudBusy) return;
    setCloudBusy("PROJECT-UPDATE");
    setCloudError(null);
    try {
      await uploadProjectToTelegram(data);
      await refreshCloudFiles();
      window.dispatchEvent(new CustomEvent("beatgaler:project-cloud-updated", { detail: { beatId: beat.id } }));
    } catch (e) {
      setCloudError(String(e));
    } finally {
      setCloudBusy(null);
    }
  }, [cloudBusy, beat.id, data, refreshCloudFiles]);

  const commonTags = useMemo(() => {
    if (!isBulk || !selectedBeats?.length) return [];
    const first = Array.from(new Set(selectedBeats[0].tags.map(t => t.trim().toLowerCase()).filter(Boolean)));
    return first.filter(tag => selectedBeats.slice(1).every(b =>
      b.tags.some(t => t.trim().toLowerCase() === tag)
    ));
  }, [isBulk, selectedBeats]);

  useEffect(() => {
    if (isBulk) {
      // In bulk mode, tags are additive inputs (start empty to avoid copying one beat's tags to all).
      setData({ ...beat, tags: [] });
      return;
    }
    setData({ ...beat });
    setPending({});
    setPendingCloud({});
  }, [beat, isBulk]);

  const toggleBulkField = (f: string) =>
    setBulkFields(s => { const n = new Set(s); n.has(f) ? n.delete(f) : n.add(f); return n; });

  // ── Save ────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      if (isBulk && onBulkSaved) {
        const updates: Partial<Beat> = {};
        const tagsInput = Array.from(new Set(data.tags.map(t => t.trim().toLowerCase()).filter(Boolean)));
        if (bulkFields.has("tags")) updates.tags = tagsInput;
        if (bulkFields.has("rating")) updates.rating = data.rating;
        if (bulkFields.has("bpm")) updates.bpm = data.bpm;
        if (bulkFields.has("key")) updates.key = data.key;
        for (const b of selectedBeats!) {
          const nextTags = bulkFields.has("tags")
            ? bulkTagsMode === "replace"
              ? tagsInput
              : bulkTagsMode === "remove"
                ? b.tags.filter(tag => !new Set(tagsInput).has(tag.trim().toLowerCase()))
                : Array.from(new Set([...b.tags, ...tagsInput].map(t => t.trim().toLowerCase()).filter(Boolean)))
            : b.tags;
          await saveBeatMeta({
            mp3_path: b.mp3_path, wav_path: b.wav_path,
            bpm: bulkFields.has("bpm") ? data.bpm : b.bpm,
            key: bulkFields.has("key") ? data.key : b.key,
            tags: nextTags,
            rating: bulkFields.has("rating") ? data.rating : b.rating,
            image_base64: b.image_base64,
            update_filename: bulkFields.has("bpm") || bulkFields.has("key"),
          });
        }
        onBulkSaved(updates, bulkFields.has("tags") ? { tagsMode: bulkTagsMode } : undefined);
        onClose();
        return;
      }

      // Commit any pending file assignments FIRST
      let committed = { ...data };
      for (const [role, srcPath] of Object.entries(pending) as [keyof PendingFiles, string][]) {
        if (!srcPath) continue;
        const newPath = await addFileToBeat({
          beat_folder: data.folder_path,
          file_path: srcPath,
          file_role: role,
          beat_name: data.name,
          bpm: data.bpm,
          key: data.key,
        });
        if (role === "mp3") committed = { ...committed, mp3_path: newPath, playback_path: newPath };
        if (role === "wav") committed = { ...committed, wav_path: newPath, has_wav: true };
        if (role === "samples") committed = { ...committed, samples_path: newPath, has_samples: true };
        if (role === "stems") committed = { ...committed, stems_path: newPath, has_stems: true };
        if (role === "flp") committed = { ...committed, flp_path: newPath, has_flp: true };
        if (role === "als") committed = { ...committed, als_path: newPath, has_als: true };
      }
      const nameChanged = committed.name.trim() !== beat.name;
      const bpmOrKeyChanged = committed.bpm !== beat.bpm || committed.key !== beat.key;
      const hasBpmKey = committed.bpm.length > 0 || committed.key.length > 0;
      const updateFilename = bpmOrKeyChanged && hasBpmKey && !nameChanged;

      const result = await saveBeatMeta({
        mp3_path: committed.mp3_path,
        wav_path: committed.wav_path,
        bpm: committed.bpm,
        key: committed.key,
        tags: committed.tags,
        rating: committed.rating,
        image_base64: committed.image_base64,
        image_preview_base64: committed.image_preview_base64 ?? null,
        image_crop: committed.image_crop ?? null,
        update_filename: updateFilename,
      });

      let updated: Beat = {
        ...committed,
        mp3_path: result.new_mp3_path || committed.mp3_path,
        wav_path: result.new_wav_path ?? committed.wav_path,
        playback_path: result.new_mp3_path || committed.mp3_path || committed.playback_path,
      };

      if (nameChanged && !beat.telegram_file_id) {
        onReleaseAudio();
        await new Promise(r => setTimeout(r, 400));
        const renamed = await renameBeat({
          mp3_path: beat.mp3_path,
          folder_path: beat.folder_path,
          new_name: committed.name.trim(),
        });
        updated = {
          ...updated,
          name: committed.name.trim(),
          folder_path: renamed.new_folder_path,
          mp3_path: renamed.new_mp3_path || updated.mp3_path,
          wav_path: renamed.new_wav_path ?? updated.wav_path,
          stems_path: renamed.new_stems_path ?? updated.stems_path,
          flp_path: renamed.new_flp_path ?? updated.flp_path,
          playback_path: renamed.new_mp3_path || updated.mp3_path || updated.playback_path,
        };
      }

      // Apply cloud file transaction ONLY AFTER Save Changes was pressed and
      // local metadata validation succeeded. Until this point Telegram has not
      // been modified by anything selected in FILES.
      let cloudUpdated = { ...updated };

      if (pendingCloud.MASTER) {
        const uploaded = await uploadDroppedFileToTelegram(cloudUpdated, pendingCloud.MASTER, "MASTER");
        cloudUpdated = {
          ...cloudUpdated,
          telegram_file_id: uploaded.telegram_file_id ?? cloudUpdated.telegram_file_id,
          telegram_message_id: uploaded.telegram_message_id ?? cloudUpdated.telegram_message_id,
          cloud_status: "SYNCED",
          // Force the next Play through prepareBeatForPlayback so the new
          // Telegram MASTER MP3 wins over every old local/cache path.
          playback_path: "",
        };
      }

      if (pendingCloud.WAV) {
        await uploadDroppedFileToTelegram(cloudUpdated, pendingCloud.WAV, "WAV");
      }
      for (const type of ["STEMS", "LOOP", "OTHER"] as CloudFileType[]) {
        const source = pendingCloud[type];
        if (source) await uploadDroppedFileToTelegram(cloudUpdated, source, type);
      }
      if (pendingCloud.PROJECT) {
        await uploadDroppedFileToTelegram(cloudUpdated, pendingCloud.PROJECT, "PROJECT");
      }

      const projectChanges: [ProjectAssetKind, string | undefined][] = [
        ["flp", pendingCloud.PROJECT_FLP],
        ["samples", pendingCloud.PROJECT_SAMPLES],
        ["audio", pendingCloud.PROJECT_AUDIO],
      ];
      let projectChanged = false;
      for (const [kind, source] of projectChanges) {
        if (!source) continue;
        await updateProjectArchiveFromSource(cloudUpdated, source, kind);
        projectChanged = true;
      }
      if (projectChanged) {
        await uploadProjectToTelegram(cloudUpdated);
      }

      setPending({});
      setPendingCloud({});
      if (Object.keys(pendingCloud).length > 0) {
        await refreshCloudFiles();
        window.dispatchEvent(new CustomEvent("beatgaler:cloud-files-updated", { detail: { beatId: beat.id } }));
        if (pendingCloud.PROJECT || projectChanged) {
          window.dispatchEvent(new CustomEvent("beatgaler:project-cloud-updated", { detail: { beatId: beat.id } }));
        }
      }

      // Clear other_files — after rename old paths are gone; Rust re-scans on next load
      onSaved({ ...cloudUpdated, other_files: [] });
      if (closeAfterSave) onClose();
    } catch (e: any) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [beat, data, pending, pendingCloud, isBulk, selectedBeats, bulkFields, bulkTagsMode, onBulkSaved, onSaved, onClose, onReleaseAudio, closeAfterSave, refreshCloudFiles]);

  // ── Enter to save ───────────────────────────────────────────
  useEffect(() => {
    if (!isEdit && !isBulk) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      const target = e.target as HTMLElement;
      if (target?.closest("[data-prevent-enter-save='true']")) return;
      if ((e.target as HTMLElement).tagName === "TEXTAREA") return;
      e.preventDefault();
      handleSave();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isEdit, isBulk, handleSave]);

  // ── Pick a file (just queues it, no disk write) ─────────────
  const handlePickFile = async (
    role: "mp3" | "wav" | "stems" | "flp" | "als",
    existingPath?: string | null
  ) => {
    const filters: Record<string, { name: string; extensions: string[] }[]> = {
      mp3: [{ name: "MP3", extensions: ["mp3"] }],
      wav: [{ name: "WAV", extensions: ["wav"] }],
      stems: [{ name: "Stems", extensions: ["zip"] }],
      flp: [{ name: "FL Studio Project", extensions: ["flp", "zip"] }],
      als: [{ name: "Ableton Project", extensions: ["als"] }],
    };
    const defaultPath = existingPath
      ? existingPath.replace(/[/\\][^/\\]+$/, "")
      : data.folder_path;
    const filePath = await pickFile(filters[role], defaultPath);
    if (!filePath) return;
    // Just queue it — no disk write yet
    setPending(p => ({ ...p, [role]: filePath }));
  };

  const handlePickSamplesFolder = async () => {
    const folderPath = await pickFolder("Select Samples folder");
    if (!folderPath) return;
    setPending(p => ({ ...p, samples: folderPath }));
  };

  // ── Tauri drag-drop — queues into pending ───────────────────
  const dropTargetRef = useRef<string | null>(null);
  useEffect(() => { dropTargetRef.current = dropTarget; }, [dropTarget]);

  useEffect(() => {
    if (!isEdit) return;
    if (!isTauriAvailable) return;
    const unlisteners: (() => void)[] = [];

    const targetAtPosition = (pos: { x: number; y: number }): string | null => {
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      const points: [number, number][] = [[pos.x, pos.y]];
      if (ratio !== 1) points.push([pos.x / ratio, pos.y / ratio]);

      for (const [x, y] of points) {
        const el = document.elementFromPoint(x, y);
        if (!el) continue;
        if (el.closest("[data-artwork-drop]")) return "artwork";
        const row = el.closest("[data-filerole]");
        const role = row?.getAttribute("data-filerole");
        if (role) return role;
      }
      return null;
    };

    // Track drag position to know which row/artwork is hovered. Tauri can report
    // physical pixels on a scaled display, so test both raw and DPR-adjusted points.
    listen<{ position?: { x: number; y: number } }>("tauri://drag-over", (event) => {
      const pos = (event.payload as any)?.position;
      if (!pos) return;
      setDropTarget(targetAtPosition(pos));
    }).then(fn => unlisteners.push(fn));

    // On drop, queue a file role or load artwork into the crop editor.
    listen<{ paths?: string[] }>("tauri://drag-drop", async (event) => {
      const paths: string[] = (event.payload as any)?.paths ?? [];
      const role = dropTargetRef.current as "artwork" | "mp3" | "wav" | "stems" | "flp" | "als" | null;
      setDropTarget(null);
      if (!role || paths.length === 0) return;

      if (role === "artwork") {
        const imagePath = paths[0];
        if (!/\.(png|jpe?g|webp|bmp|gif)$/i.test(imagePath)) {
          setError("Artwork must be an image file.");
          return;
        }
        try {
          setCropSrc(await readImagePathAsDataUrl(imagePath));
          setError(null);
        } catch (error) {
          setError(`Could not read artwork: ${String(error)}`);
        }
        return;
      }

      setPending(p => ({ ...p, [role]: paths[0] }));
    }).then(fn => unlisteners.push(fn));

    listen("tauri://drag-leave", () => setDropTarget(null))
      .then(fn => unlisteners.push(fn));

    return () => { unlisteners.forEach(fn => fn()); };
  }, [isEdit]);

  const handleImageFile = (file: File) => {
    if (file.type && !file.type.startsWith("image/")) {
      setError("Artwork must be an image file.");
      return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      setCropSrc(e.target?.result as string);
      setError(null);
    };
    reader.onerror = () => setError("Could not read artwork.");
    reader.readAsDataURL(file);
  };

  const changeBulkTagsMode = (mode: "add" | "replace" | "remove") => {
    setBulkTagsMode(mode);
    setData(d => ({ ...d, tags: [] }));
  };

  // ── Helpers ─────────────────────────────────────────────────
  const BulkCheck = ({ field, label }: { field: string; label: string }) => isBulk ? (
    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", marginBottom: 6 }}>
      <input type="checkbox" checked={bulkFields.has(field)} onChange={() => toggleBulkField(field)}
        style={{ width: 13, height: 13, accentColor: "#fff", cursor: "pointer" }} />
      <span style={{ fontSize: 11, color: "#888", letterSpacing: 0.8 }}>{label}</span>
    </label>
  ) : <div style={{ fontSize: 12, color: "#aaa", letterSpacing: 1, marginBottom: 6, fontWeight: 600 }}>{label}</div>;

  // File row — shows pending state preview, no disk write until Save
  const FileRow = ({
    label, sublabel, present, path, role, hint
  }: {
    label: string; sublabel?: string; present: boolean; path: string | null;
    role: "mp3" | "wav" | "stems" | "flp" | "als"; hint?: string;
  }) => {
    const pendingPath = pending[role];
    const isDragging = dropTarget === role;
    const displayPath = pendingPath ?? path;
    const isPresent = !!pendingPath || present;

    return (
      <div
        data-filerole={role}
        onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDropTarget(role); }}
        onDragLeave={e => { e.preventDefault(); setDropTarget(null); }}
        onDrop={e => { e.preventDefault(); e.stopPropagation(); }}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          marginBottom: 6, padding: "7px 10px", borderRadius: 7,
          background: isDragging ? "#162216" : pendingPath ? "#1a1a0a" : "transparent",
          border: `1px solid ${isDragging ? "#2d5a2d" : pendingPath ? "#3a3a10" : "transparent"}`,
          transition: "background 0.12s, border-color 0.12s",
        }}
      >
        {/* Label */}
        <div style={{ minWidth: 48, flexShrink: 0 }}>
          <div style={{ fontSize: 12, color: isPresent ? "#ddd" : "#555" }}>{label}</div>
          {sublabel && <div style={{ fontSize: 9, color: "#666", marginTop: 1 }}>{sublabel}</div>}
        </div>

        {/* Filename / hint */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          {pendingPath ? (
            <div style={{ fontSize: 10, color: "#aaa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <span style={{ color: "#fb923c", marginRight: 4, fontSize: 9 }}>PENDING</span>
              {pendingPath.split(/[/\\]/).pop()}
            </div>
          ) : present && displayPath ? (
            <div style={{ fontSize: 10, color: "#666", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {displayPath.split(/[/\\]/).pop()}
            </div>
          ) : hint ? (
            <div style={{ fontSize: 10, color: "#444" }}>{hint}</div>
          ) : null}
        </div>

        {/* Buttons */}
        {isEdit && (
          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
            {present && path && !pendingPath && (
              <button
                onClick={() => revealInExplorer(path)}
                style={{ padding: "3px 8px", background: "transparent", border: "1px solid #2a2a2a", borderRadius: 5, color: "#666", fontSize: 10, cursor: "pointer" }}
                onMouseEnter={e => (e.currentTarget.style.color = "#bbb")}
                onMouseLeave={e => (e.currentTarget.style.color = "#666")}
              >show</button>
            )}
            {pendingPath ? (
              // Cancel pending
              <button
                onClick={() => setPending(p => { const n = { ...p }; delete n[role]; return n; })}
                style={{ padding: "3px 8px", background: "#2a1a00", border: "1px solid #4a2e00", borderRadius: 5, color: "#fb923c", fontSize: 10, cursor: "pointer" }}
              >undo</button>
            ) : (
              <button
                onClick={() => handlePickFile(role, present ? path : null)}
                style={{ padding: "3px 8px", background: present ? "#2a1a00" : "#0f2a0f", border: `1px solid ${present ? "#4a2e00" : "#1a4a1a"}`, borderRadius: 5, color: present ? "#fb923c" : "#4ade80", fontSize: 10, cursor: "pointer" }}
              >{present ? "replace" : "+ add"}</button>
            )}
          </div>
        )}
        {!isEdit && present && path && (
          <button
            onClick={() => revealInExplorer(path)}
            style={{ padding: "3px 8px", background: "transparent", border: "1px solid #2a2a2a", borderRadius: 5, color: "#555", fontSize: 10, cursor: "pointer", flexShrink: 0 }}
            onMouseEnter={e => (e.currentTarget.style.color = "#bbb")}
            onMouseLeave={e => (e.currentTarget.style.color = "#555")}
          >show</button>
        )}
      </div>
    );
  };

  return (
    <>
      <div onClick={reviewInfo ? undefined : onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 300, backdropFilter: "blur(4px)" }} />
      <div style={{ position: "fixed", right: 0, top: 0, bottom: 0, width: 340, background: "#0f0f0f", borderLeft: "1px solid #1a1a1a", zIndex: 310, display: "flex", flexDirection: "column", animation: "drawerIn 0.22s ease" }}>

        {/* Header */}
        <div style={{ padding: "18px 22px", borderBottom: "1px solid #1a1a1a", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <span style={{ fontWeight: 500, fontSize: 14, color: "#e0e0e0" }}>
              {reviewInfo ? `Review beat ${reviewInfo.current} of ${reviewInfo.total}` : isBulk ? `Edit ${selectedBeats!.length} beats` : isEdit ? "Edit metadata" : "Beat detail"}
            </span>
            {isBulk && <div style={{ fontSize: 11, color: "#777", marginTop: 2 }}>Check fields to apply to all</div>}
          </div>
          <button onClick={reviewInfo ? (onSkipAll ?? onClose) : onClose} title={reviewInfo ? "Skip all remaining reviews" : "Close"} style={{ background: "none", border: "none", color: "#777", fontSize: reviewInfo ? 12 : 18, cursor: "pointer" }}>{reviewInfo ? "Skip all" : ""}</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 22 }}>

          {/* Artwork */}
          {!isBulk && (
            <>
              <div
                data-artwork-drop
                onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDropTarget("artwork"); }}
                onDragLeave={e => { e.preventDefault(); setDropTarget(null); }}
                onDrop={e => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDropTarget(null);
                  const file = e.dataTransfer.files?.[0];
                  if (file) handleImageFile(file);
                }}
                style={{
                  borderRadius: 10,
                  outline: dropTarget === "artwork" ? "1px solid #666" : "1px solid transparent",
                  outlineOffset: 3,
                }}
              >
                <Artwork beat={data} size={296} playing={false} />
              </div>
              {isEdit && (
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <button onClick={() => imgRef.current?.click()}
                    style={{ flex: 1, padding: "7px 12px", background: "#1a1a1a", border: "1px solid #252525", borderRadius: 7, color: "#ccc", fontSize: 12, cursor: "pointer" }}>
                    {data.image_base64 ? "Change cover" : "Add cover"}
                  </button>
                  {data.image_base64 && (
                    <>
                      <button onClick={() => setCropSrc(data.image_base64 || null)}
                        style={{ padding: "7px 12px", background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 7, color: "#ffd66b", fontSize: 12, cursor: "pointer" }}>Recortar</button>
                      <button onClick={() => setData(d => ({ ...d, image_base64: null, image_preview_base64: null, image_crop: null }))}
                        style={{ padding: "7px 12px", background: "#1a1a1a", border: "1px solid #2a1a1a", borderRadius: 7, color: "#f87171", fontSize: 12, cursor: "pointer" }}>Remove</button>
                    </>
                  )}
                </div>
              )}
              <input ref={imgRef} type="file" accept="image/jpeg,image/png,image/webp,image/bmp,image/gif" style={{ display: "none" }}
                onChange={e => e.target.files?.[0] && handleImageFile(e.target.files[0])} />
            </>
          )}

          {/* Name */}
          {!isBulk && (
            <div style={{ marginTop: 16 }}>
              {isEdit ? (
                <input value={data.name} onChange={e => setData(d => ({ ...d, name: e.target.value }))}
                  style={{ background: "#181818", border: "1px solid #252525", borderRadius: 8, padding: "8px 12px", color: "#fff", fontSize: 17, fontWeight: 500, width: "100%", outline: "none" }} />
              ) : (
                <div style={{ fontWeight: 500, fontSize: 19, color: "#fff" }}>{data.name}</div>
              )}
            </div>
          )}

          {/* Rating */}
          <div style={{ marginTop: 14 }}>
            <BulkCheck field="rating" label="RATING" />
            <Stars n={data.rating} onChange={(isEdit || isBulk) ? v => setData(d => ({ ...d, rating: v })) : undefined} />
          </div>

          {/* Tags */}
          <div style={{ marginTop: 14, background: "#161616", borderRadius: 8, padding: "14px", border: "1px solid #1e1e1e" }}>
            <BulkCheck field="tags" label={isBulk ? `TAGS (${bulkTagsMode.toUpperCase()})` : "TAGS"} />
            {isBulk && bulkFields.has("tags") && (
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <button
                  onClick={() => changeBulkTagsMode("add")}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 999,
                    border: `1px solid ${bulkTagsMode === "add" ? "#3a3a3a" : "#242424"}`,
                    background: bulkTagsMode === "add" ? "#202020" : "transparent",
                    color: bulkTagsMode === "add" ? "#d0d0d0" : "#666",
                    fontSize: 10,
                    cursor: "pointer",
                  }}
                >
                  Add tags
                </button>
                <button
                  onClick={() => changeBulkTagsMode("replace")}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 999,
                    border: `1px solid ${bulkTagsMode === "replace" ? "#4a2a2a" : "#242424"}`,
                    background: bulkTagsMode === "replace" ? "#2a1717" : "transparent",
                    color: bulkTagsMode === "replace" ? "#ef9a9a" : "#666",
                    fontSize: 10,
                    cursor: "pointer",
                  }}
                >
                  Replace tags
                </button>
                <button
                  onClick={() => changeBulkTagsMode("remove")}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 999,
                    border: `1px solid ${bulkTagsMode === "remove" ? "#5a2525" : "#242424"}`,
                    background: bulkTagsMode === "remove" ? "#321717" : "transparent",
                    color: bulkTagsMode === "remove" ? "#fca5a5" : "#666",
                    fontSize: 10,
                    cursor: "pointer",
                  }}
                >
                  Remove tags
                </button>
              </div>
            )}
            {isBulk && bulkFields.has("tags") && bulkTagsMode === "remove" ? (
              <div data-prevent-enter-save="true">
                <div style={{ fontSize: 10, color: commonTags.length ? "#888" : "#f59e0b", marginBottom: 9, lineHeight: 1.5 }}>
                  {commonTags.length
                    ? "Click the common tags you want to delete. Red and crossed-out tags will be removed from every selected beat."
                    : "These beats do not have any tags in common."}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {commonTags.map(tag => {
                    const normalized = tag.trim().toLowerCase();
                    const marked = data.tags.some(t => t.trim().toLowerCase() === normalized);
                    return (
                      <button
                        key={normalized}
                        type="button"
                        aria-pressed={marked}
                        onClick={() => setData(d => ({
                          ...d,
                          tags: marked
                            ? d.tags.filter(t => t.trim().toLowerCase() !== normalized)
                            : [...d.tags, normalized],
                        }))}
                        style={{
                          padding: "4px 10px",
                          borderRadius: 999,
                          border: `1px solid ${marked ? "#7f1d1d" : "#2a2a2a"}`,
                          background: marked ? "rgba(248,113,113,0.14)" : "transparent",
                          color: marked ? "#f87171" : "#aaa",
                          textDecoration: marked ? "line-through" : "none",
                          fontSize: 11,
                          cursor: "pointer",
                        }}
                        title={marked ? `Will remove ${tag}` : `Keep ${tag}`}
                      >
                        {tag}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (isEdit || isBulk) ? (
              <TagEditor
                tags={data.tags}
                suggestions={tagSuggestions}
                onChange={tags => setData(d => ({ ...d, tags }))}
              />
            ) : (
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {data.tags.length ? data.tags.map(t => <TagPill key={t} label={t} />) : <span style={{ fontSize: 12, color: "#444" }}>No tags</span>}
              </div>
            )}
          </div>

          {/* BPM + Key */}
          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {(["BPM", "Key"] as const).map(label => {
              const k = label === "BPM" ? "bpm" : "key";
              return (
                <div key={k} style={{ background: "#161616", borderRadius: 8, padding: "12px 14px", border: "1px solid #1e1e1e" }}>
                  <BulkCheck field={k} label={label} />
                  {(isEdit || isBulk) ? (
                    <input value={(data as any)[k]} onChange={e => setData(d => ({ ...d, [k]: e.target.value }))}
                      style={{ background: "none", border: "none", outline: "none", color: "#fff", fontSize: 16, fontWeight: 500, width: "100%", marginTop: 2 }} />
                  ) : (
                    <div style={{ fontSize: 16, fontWeight: 500, color: "#fff", marginTop: 2 }}>{(data as any)[k] || "—"}</div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Telegram is the only persistent beat storage in V1. */}
          {!isBulk && (
            <div style={{ marginTop: 10, background: "#161616", borderRadius: 8, padding: "14px", border: "1px solid #1e1e1e" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: "#aaa", letterSpacing: 1, fontWeight: 600 }}>FILES</div>
                <span style={{ fontSize: 10, color: "#4ade80" }}>TELEGRAM</span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                {(["MASTER", "WAV", "STEMS", "LOOP", "OTHER"] as CloudFileType[]).map(type => {
                  const queued = pendingCloud[type];
                  return (
                    <button key={type} disabled={saving} onClick={() => void handleCloudReplace(type)}
                      title={queued ? queued : `Choose ${type}; Telegram will not change until Save Changes`}
                      style={{ padding: "5px 8px", background: queued ? "#2a1a00" : "#1a1a1a", border: `1px solid ${queued ? "#4a2e00" : "#2a2a2a"}`, borderRadius: 6, color: queued ? "#fb923c" : "#bbb", fontSize: 10, cursor: saving ? "default" : "pointer" }}>
                      {queued ? `PENDING ${type}` : `+ ${type}`}
                    </button>
                  );
                })}
              </div>
              <div style={{ padding: "7px 0", borderTop: "1px solid #222", display: "flex", gap: 8 }}>
                <span style={{ width: 58, fontSize: 10, color: "#60a5fa", fontWeight: 700 }}>MASTER</span>
                <span style={{ flex: 1, color: data.telegram_file_id ? "#888" : "#555", fontSize: 10 }}>
                  {data.telegram_file_id ? "Stored in Telegram" : "Uploading / not stored yet"}
                </span>
              </div>
              <div style={{ padding: "9px 0", borderTop: "1px solid #222" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                  <span style={{ width: 58, fontSize: 10, color: "#c084fc", fontWeight: 700 }}>PROJECT</span>
                  <span style={{ flex: 1, color: cloudFiles.some(f => f.file_type === "PROJECT") ? "#888" : "#555", fontSize: 10 }}>
                    {cloudFiles.some(f => f.file_type === "PROJECT") ? `${data.name}.zip` : "No valid project stored"}
                  </span>
                </div>
                {isEdit && (
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    <button disabled={saving} onClick={() => void handleProjectAsset("flp")}
                      title={pendingCloud.PROJECT_FLP ? pendingCloud.PROJECT_FLP : "Queued until Save Changes"}
                      style={{ padding: "4px 7px", background: pendingCloud.PROJECT_FLP ? "#2a1a00" : "#1a1a1a", border: `1px solid ${pendingCloud.PROJECT_FLP ? "#4a2e00" : "#2a2a2a"}`, borderRadius: 5, color: pendingCloud.PROJECT_FLP ? "#fb923c" : "#bbb", fontSize: 9, cursor: saving ? "default" : "pointer" }}>
                      {pendingCloud.PROJECT_FLP ? "PENDING FLP" : "+ FLP"}
                    </button>
                    <button disabled={saving} onClick={() => void handleProjectAsset("samples")}
                      title={pendingCloud.PROJECT_SAMPLES ? pendingCloud.PROJECT_SAMPLES : "Queued until Save Changes"}
                      style={{ padding: "4px 7px", background: pendingCloud.PROJECT_SAMPLES ? "#2a1a00" : "#1a1a1a", border: `1px solid ${pendingCloud.PROJECT_SAMPLES ? "#4a2e00" : "#2a2a2a"}`, borderRadius: 5, color: pendingCloud.PROJECT_SAMPLES ? "#fb923c" : "#bbb", fontSize: 9, cursor: saving ? "default" : "pointer" }}>
                      {pendingCloud.PROJECT_SAMPLES ? "PENDING Samples" : "+ Samples"}
                    </button>
                    <button disabled={saving} onClick={() => void handleProjectAsset("audio")}
                      title={pendingCloud.PROJECT_AUDIO ? pendingCloud.PROJECT_AUDIO : "Queued until Save Changes"}
                      style={{ padding: "4px 7px", background: pendingCloud.PROJECT_AUDIO ? "#2a1a00" : "#1a1a1a", border: `1px solid ${pendingCloud.PROJECT_AUDIO ? "#4a2e00" : "#2a2a2a"}`, borderRadius: 5, color: pendingCloud.PROJECT_AUDIO ? "#fb923c" : "#bbb", fontSize: 9, cursor: saving ? "default" : "pointer" }}>
                      {pendingCloud.PROJECT_AUDIO ? "PENDING Audio" : "+ Audio"}
                    </button>
                    {cloudFiles.some(f => f.file_type === "PROJECT") && (
                      <button disabled={cloudBusy !== null} onClick={() => void handleManualProjectUpdate()}
                        style={{ padding: "4px 7px", background: "#171f17", border: "1px solid #294029", borderRadius: 5, color: "#86efac", fontSize: 9, cursor: cloudBusy ? "default" : "pointer" }}>
                        {cloudBusy === "PROJECT-UPDATE" ? "Updating…" : "Update Project"}
                      </button>
                    )}
                  </div>
                )}
              </div>
              {cloudFiles.filter(file => file.file_type !== "PROJECT").map(file => (
                <div key={file.cloud_file_id} style={{ padding: "7px 0", borderTop: "1px solid #222", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 58, fontSize: 10, color: "#8b8b8b", fontWeight: 700 }}>{file.file_type}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div title={file.filename} style={{ color: "#bbb", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.filename}</div>
                    <div style={{ color: "#555", fontSize: 9, marginTop: 2 }}>
                      {formatCloudSize(file.original_size)}{file.part_count > 1 ? ` · ${file.part_count} parts` : ""}
                    </div>
                  </div>
                </div>
              ))}
              <div style={{ marginTop: 9, color: "#777", fontSize: 9, lineHeight: 1.55 }}>
                Files marked PENDING are local selections only. Telegram is not changed until you click Save Changes. Cancel closes the editor without uploading those selections.
                <br />PLAY always uses the MASTER MP3; WAV is HQ/download only.
              </div>
              {cloudError && <div style={{ marginTop: 8, color: "#f87171", fontSize: 10 }}>{cloudError}</div>}
            </div>
          )}

          {error && (
            <div style={{ marginTop: 12, padding: "10px 14px", background: "#3d0000", border: "1px solid #7f1d1d", borderRadius: 8, fontSize: 12, color: "#fca5a5", lineHeight: 1.5 }}>
              {error}
            </div>
          )}
        </div>

        {(isEdit || isBulk) && (
          <div style={{ padding: "14px 22px", borderTop: "1px solid #1a1a1a" }}>
            {(() => {
              const removeNothingSelected = isBulk && bulkFields.has("tags") && bulkTagsMode === "remove" && data.tags.length === 0;
              const disabled = saving || (isBulk && bulkFields.size === 0) || removeNothingSelected;
              const label = saving
                ? "Saving…"
                : isBulk && bulkTagsMode === "remove" && bulkFields.has("tags")
                  ? `Remove ${data.tags.length || "selected"} tag${data.tags.length === 1 ? "" : "s"} from ${selectedBeats!.length} beats`
                  : isBulk
                    ? `Apply to ${selectedBeats!.length} beats`
                    : reviewInfo
                      ? (reviewInfo.current === reviewInfo.total ? "Save and finish" : "Save and next")
                      : hasPending
                        ? `Save changes (${Object.keys(pending).length + Object.keys(pendingCloud).length} file${Object.keys(pending).length + Object.keys(pendingCloud).length > 1 ? "s" : ""} pending)`
                        : "Save changes";
              return (
                <button onClick={handleSave} disabled={disabled}
                  style={{ width: "100%", padding: "10px", background: disabled ? "#1e1e1e" : "#fff", border: "none", borderRadius: 8, color: disabled ? "#3a3a3a" : "#000", fontWeight: 500, fontSize: 14, cursor: disabled ? "default" : "pointer" }}>
                  {label}
                </button>
              );
            })()}
          </div>
        )}
      </div>

      {cropSrc && (
        <ImageCropModal
          imageSrc={cropSrc}
          onCancel={() => setCropSrc(null)}
          onConfirm={(croppedDataUrl, crop) => {
            // The confirmed crop is the actual artwork that Save changes persists
            // and later syncs to Telegram. Do not keep the previous image_base64.
            setData(d => ({
              ...d,
              image_base64: croppedDataUrl,
              image_preview_base64: croppedDataUrl,
              image_crop: crop,
            }));
            setCropSrc(null);
          }}
        />
      )}
    </>
  );
}
