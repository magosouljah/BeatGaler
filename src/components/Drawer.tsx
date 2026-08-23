import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { Beat } from "../types";
import { Artwork, Stars, TagEditor, TagPill } from "./ui";
import ImageCropModal from "./ImageCropModal";
import { saveBeatMeta, renameBeat, addFileToBeat, pickFile, pickFolder, revealInExplorer, isTauriAvailable, listCloudFilesForBeat, downloadCloudFileToCache, uploadDroppedFileToTelegram, uploadProjectToTelegram, updateProjectArchiveFromSource, inspectAudioMetadata, readImagePathAsDataUrl, diagnosticLog, type CloudFileRecord, type CloudFileType, type ProjectAssetKind } from "../lib/tauri";
import { appConfirm } from "../lib/dialog";
import { sanitizeUserVisibleText } from "../lib/userVisibleError";
import { platform } from "../platform";
import type { PlatformCloudCommitProgress, PlatformBeatEditFiles, PlatformBeatEditSlotKind, PlatformImportSlotKind } from "../platform/contracts";
import { cleanTags, validateBpm, validateMusicKey } from "../lib/metadataValidation";
import { getReviewFooterState, reviewHeaderLabel } from "../features/components/componentLogic";

interface Props {
  beat: Beat;
  mode: "detail" | "edit";
  tagSuggestions?: string[];
  onClose: () => void;
  onSaved: (updated: Beat, onProgress?: (progress: PlatformCloudCommitProgress) => void) => Promise<void> | void;
  onReleaseAudio: () => void;
  selectedBeats?: Beat[];
  onBulkSaved?: (updates: Partial<Beat>, options?: { tagsMode?: "add" | "replace" | "remove" }) => void;
  reviewInfo?: { current: number; total: number | null };
  closeAfterSave?: boolean;
  onSkipCurrent?: () => void;
  onSkipAll?: () => void;
  onSaveAll?: (currentUpdated: Beat) => Promise<void> | void;
  isReviewNameTaken?: (name: string, beatId: string) => boolean;
  mutationAllowed?: boolean;
  onCloudMutationCommit?: (
    updated: Beat,
    options: { syncMetadata: boolean; reason: string },
  ) => Promise<void>;
}

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

export default function Drawer({ beat, mode, tagSuggestions = [], onClose, onSaved, onReleaseAudio, selectedBeats, onBulkSaved, reviewInfo, closeAfterSave = true, onSkipCurrent, onSkipAll, onSaveAll, isReviewNameTaken, mutationAllowed = true, onCloudMutationCommit }: Props) {
  const [data, setData] = useState<Beat>({ ...beat });
  const [pending, setPending] = useState<PendingFiles>({});
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState<PlatformCloudCommitProgress | null>(null);
  const [reviewSlotNames, setReviewSlotNames] = useState<Partial<Record<PlatformImportSlotKind, string>>>(() => {
    const slots = platform.capabilities.reviewBeatCloudCommit ? platform.importer.slotFilesForBeat(beat.id) : {};
    return Object.fromEntries(Object.entries(slots).map(([kind, file]) => [kind, file?.name]));
  });
  const [error, setError] = useState<string | null>(null);
  const [duplicateNameError, setDuplicateNameError] = useState(false);
  const [bulkFields, setBulkFields] = useState<Set<string>>(new Set());
  const [bulkTagsMode, setBulkTagsMode] = useState<"add" | "replace" | "remove">("add");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const isEdit = mode === "edit";
  const isBulk = !!selectedBeats && selectedBeats.length > 1;
  const imgRef = useRef<HTMLInputElement>(null);
  const displayedBeatIdRef = useRef(beat.id);
  const [cloudFiles, setCloudFiles] = useState<CloudFileRecord[]>([]);
  const [cloudBusy, setCloudBusy] = useState<string | null>(null);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [pendingCloud, setPendingCloud] = useState<PendingCloudFiles>({});
  const [pendingWebEdit, setPendingWebEdit] = useState<PlatformBeatEditFiles>({});
  const bpmValidation = validateBpm(data.bpm);
  const keyValidation = validateMusicKey(data.key);

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
      void diagnosticLog("project-sync", "DRAWER_UPDATE_BEGIN", `beat_id=${beat.id}`);
      await uploadProjectToTelegram(data);
      if (!onCloudMutationCommit) {
        throw new Error("Project uploaded, but the library INDEX commit handler is unavailable.");
      }
      await onCloudMutationCommit(beat, { syncMetadata: false, reason: "drawer-project-update" });
      await refreshCloudFiles();
      window.dispatchEvent(new CustomEvent("beatgaler:project-cloud-updated", { detail: { beatId: beat.id } }));
      void diagnosticLog("project-sync", "DRAWER_UPDATE_CONFIRMED", `beat_id=${beat.id}`);
    } catch (e) {
      void diagnosticLog("project-sync", "DRAWER_UPDATE_FAILED", `beat_id=${beat.id} error=${String(e)}`);
      setCloudError(String(e));
    } finally {
      setCloudBusy(null);
    }
  }, [cloudBusy, beat, data, refreshCloudFiles, onCloudMutationCommit]);

  const commonTags = useMemo(() => {
    if (!isBulk || !selectedBeats?.length) return [];
    const first = Array.from(new Set(selectedBeats[0].tags.map(t => t.trim().toLowerCase()).filter(Boolean)));
    return first.filter(tag => selectedBeats.slice(1).every(b =>
      b.tags.some(t => t.trim().toLowerCase() === tag)
    ));
  }, [isBulk, selectedBeats]);

  useEffect(() => {
    if (isBulk) {
      setData({ ...beat, tags: [] });
      return;
    }
    if (displayedBeatIdRef.current === beat.id) {
      setData(current => ({
        ...current,
        bpm: current.bpm || beat.bpm,
        key: current.key || beat.key,
        tags: current.tags.length > 0 ? current.tags : beat.tags,
        image_base64: current.image_base64 || beat.image_base64,
        image_preview_base64: current.image_preview_base64 || beat.image_preview_base64,
      }));
      return;
    }
    displayedBeatIdRef.current = beat.id;
    setData({ ...beat });
    if (platform.capabilities.reviewBeatCloudCommit) {
      const slots = platform.importer.slotFilesForBeat(beat.id);
      setReviewSlotNames(Object.fromEntries(Object.entries(slots).map(([kind, file]) => [kind, file?.name])));
    }
    setPending({});
    setPendingCloud({});
    setPendingWebEdit({});
    setDuplicateNameError(false);
  }, [beat, isBulk]);

  const toggleBulkField = (f: string) =>
    setBulkFields(s => { const n = new Set(s); n.has(f) ? n.delete(f) : n.add(f); return n; });

  const handleReviewSlotPick = useCallback(async (kind: PlatformImportSlotKind) => {
    if (saving) return;
    try {
      const file = await platform.importer.pickSlotFile(beat.id, kind);
      if (file) setReviewSlotNames(current => ({ ...current, [kind]: file.name }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [beat.id, saving]);

  const handleWebEditFilePick = useCallback(async (kind: PlatformBeatEditSlotKind) => {
    if (saving) return;
    try {
      const file = await platform.editor.pickFile(kind);
      if (file) setPendingWebEdit(current => ({ ...current, [kind]: file }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [saving]);

  const handleSave = useCallback(async (reviewAction: "next" | "all" = "next") => {
    if (!mutationAllowed) {
      setError("Connect to the internet before saving changes. Offline mode is read-only.");
      return;
    }
    const requestedName = data.name.trim();
    if (reviewInfo && isReviewNameTaken?.(requestedName, beat.id)) {
      setDuplicateNameError(true);
      setError(`A beat named "${requestedName}" already exists. Change the name to continue.`);
      return;
    }

    const cleanedTags = cleanTags(data.tags);
    const bpmCheck = validateBpm(data.bpm);
    const keyCheck = validateMusicKey(data.key);
    if (bpmCheck.valid === false) {
      setError(`Invalid BPM — ${bpmCheck.reason}`);
      return;
    }
    if (keyCheck.valid === false) {
      setError(`Invalid key — ${keyCheck.reason}`);
      return;
    }
    const validatedData: Beat = {
      ...data,
      tags: cleanedTags.tags,
      bpm: bpmCheck.normalized,
      key: keyCheck.normalized,
    };
    setData(validatedData);
    setSaving(true);
    setSaveProgress(null);
    setError(null);
    try {
      if (platform.capabilities.reviewBeatCloudCommit && reviewInfo && !isBulk) {
        const updated = { ...validatedData, cloud_status: "PENDING_UPLOAD" };
        if (reviewAction === "all" && onSaveAll) await onSaveAll(updated);
        else {
          await onSaved(updated, progress => setSaveProgress(progress));
          if (closeAfterSave) onClose();
        }
        return;
      }
      if (platform.capabilities.browserCloudEditing && !reviewInfo && !isBulk) {
        const committed = await platform.editor.commit(
          beat,
          validatedData,
          pendingWebEdit,
          progress => setSaveProgress(progress),
        );
        setPendingWebEdit({});
        await onSaved(committed);
        if (closeAfterSave) onClose();
        return;
      }
      if (isBulk && onBulkSaved) {
        const updates: Partial<Beat> = {};
        const tagsInput = Array.from(new Set(validatedData.tags.map(t => t.trim().toLowerCase()).filter(Boolean)));
        if (bulkFields.has("tags")) updates.tags = tagsInput;
        if (bulkFields.has("rating")) updates.rating = validatedData.rating;
        if (bulkFields.has("bpm")) updates.bpm = validatedData.bpm;
        if (bulkFields.has("key")) updates.key = validatedData.key;
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
            bpm: bulkFields.has("bpm") ? validatedData.bpm : b.bpm,
            key: bulkFields.has("key") ? validatedData.key : b.key,
            tags: nextTags,
            rating: bulkFields.has("rating") ? validatedData.rating : b.rating,
            image_base64: b.image_base64,
            update_filename: bulkFields.has("bpm") || bulkFields.has("key"),
          });
        }
        onBulkSaved(updates, bulkFields.has("tags") ? { tagsMode: bulkTagsMode } : undefined);
        onClose();
        return;
      }

      let committed = { ...validatedData };
      for (const [role, srcPath] of Object.entries(pending) as [keyof PendingFiles, string][]) {
        if (!srcPath) continue;
        const newPath = await addFileToBeat({
          beat_folder: validatedData.folder_path,
          file_path: srcPath,
          file_role: role,
          beat_name: validatedData.name,
          bpm: validatedData.bpm,
          key: validatedData.key,
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

      let cloudUpdated = { ...updated };

      if (pendingCloud.MASTER) {
        const uploaded = await uploadDroppedFileToTelegram(cloudUpdated, pendingCloud.MASTER, "MASTER");
        cloudUpdated = {
          ...cloudUpdated,
          telegram_file_id: uploaded.telegram_file_id ?? cloudUpdated.telegram_file_id,
          telegram_message_id: uploaded.telegram_message_id ?? cloudUpdated.telegram_message_id,
          cloud_status: "SYNCED",
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

      const finalUpdated = { ...cloudUpdated, other_files: [] };
      const metadataChanged =
        finalUpdated.name !== beat.name ||
        finalUpdated.bpm !== beat.bpm ||
        finalUpdated.key !== beat.key ||
        finalUpdated.rating !== beat.rating ||
        finalUpdated.image_base64 !== beat.image_base64 ||
        JSON.stringify(finalUpdated.tags) !== JSON.stringify(beat.tags);
      const cloudFilesChanged = Object.keys(pendingCloud).length > 0;
      const hasCloudAuthority = Boolean(finalUpdated.telegram_file_id) || cloudFiles.length > 0 || cloudFilesChanged;

      if ((metadataChanged && hasCloudAuthority) || cloudFilesChanged) {
        if (!onCloudMutationCommit) {
          throw new Error("Changes were saved locally, but the library INDEX commit handler is unavailable.");
        }
        const reason = cloudFilesChanged ? "drawer-cloud-save" : "drawer-metadata-save";
        void diagnosticLog(
          "drawer-save",
          "CLOUD_COMMIT_BEGIN",
          `beat_id=${beat.id} reason=${reason} metadata_changed=${metadataChanged} cloud_files_changed=${cloudFilesChanged}`,
        );
        await onCloudMutationCommit(finalUpdated, {
          syncMetadata: metadataChanged && Boolean(finalUpdated.telegram_file_id),
          reason,
        });
        void diagnosticLog("drawer-save", "CLOUD_COMMIT_CONFIRMED", `beat_id=${beat.id} reason=${reason}`);
      }

      setPending({});
      setPendingCloud({});
      if (cloudFilesChanged) {
        await refreshCloudFiles();
        window.dispatchEvent(new CustomEvent("beatgaler:cloud-files-updated", { detail: { beatId: beat.id } }));
        if (pendingCloud.PROJECT || projectChanged) {
          window.dispatchEvent(new CustomEvent("beatgaler:project-cloud-updated", { detail: { beatId: beat.id } }));
        }
      }

      if (reviewAction === "all" && reviewInfo && onSaveAll) {
        await onSaveAll(finalUpdated);
      } else {
        await onSaved(finalUpdated);
        if (closeAfterSave) onClose();
      }
    } catch (e: any) {
      setError(String(e));
    } finally {
      setSaving(false);
      setSaveProgress(null);
    }
  }, [beat, data, pending, pendingCloud, pendingWebEdit, cloudFiles, isBulk, selectedBeats, bulkFields, bulkTagsMode, onBulkSaved, onSaved, onClose, onReleaseAudio, closeAfterSave, refreshCloudFiles, reviewInfo, onSaveAll, isReviewNameTaken, mutationAllowed, onCloudMutationCommit]);

  useEffect(() => {
    if (!isEdit && !isBulk) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      const target = e.target as HTMLElement;
      if (target?.closest("[data-prevent-enter-save='true']")) return;
      if ((e.target as HTMLElement).tagName === "TEXTAREA") return;
      e.preventDefault();
      void handleSave("next");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isEdit, isBulk, handleSave]);

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
    setPending(p => ({ ...p, [role]: filePath }));
  };

  const handlePickSamplesFolder = async () => {
    const folderPath = await pickFolder("Select Samples folder");
    if (!folderPath) return;
    setPending(p => ({ ...p, samples: folderPath }));
  };

  useEffect(() => {
    if (!isEdit) return;
    const onNativeHover = (event: Event) => {
      const detail = (event as CustomEvent<{ target?: string | null; active?: boolean }>).detail;
      setDropTarget(detail?.active ? detail.target ?? null : null);
    };
    const onNativePath = (event: Event) => {
      const detail = (event as CustomEvent<{ target?: string; path?: string }>).detail;
      const role = detail?.target as "artwork" | "mp3" | "wav" | "stems" | "flp" | "als" | undefined;
      const path = detail?.path;
      setDropTarget(null);
      if (!role || !path) return;
      if (role !== "artwork") {
        setPending(current => ({ ...current, [role]: path }));
        void diagnosticLog("drawer-drop", "FILE_QUEUED", `role=${role}`);
        return;
      }
      void (async () => {
        try {
          void diagnosticLog("drawer-drop", "ARTWORK_READ_BEGIN", "source=native-drop");
          const image = await readImagePathAsDataUrl(path);
          setCropSrc(image);
          setError(null);
          void diagnosticLog("drawer-drop", "ARTWORK_READY", `source=native-drop data_url_bytes=${image.length}`);
        } catch (error) {
          void diagnosticLog("drawer-drop", "ARTWORK_FAILED", `source=native-drop error=${String(error)}`);
          setError(`Could not read artwork: ${String(error)}`);
        }
      })();
    };
    const onExternalArtwork = (event: Event) => {
      const imageData = (event as CustomEvent<{ imageData?: string }>).detail?.imageData;
      if (!imageData || !/^data:image\//i.test(imageData)) {
        void diagnosticLog("drawer-drop", "ARTWORK_FAILED", "source=browser-native reason=invalid-data-url");
        setError("Could not decode the dropped browser artwork.");
        return;
      }
      setCropSrc(imageData);
      setError(null);
      void diagnosticLog("drawer-drop", "ARTWORK_READY", `source=browser-native data_url_bytes=${imageData.length}`);
    };
    window.addEventListener("beatgaler:drawer-native-hover", onNativeHover);
    window.addEventListener("beatgaler:drawer-native-path", onNativePath);
    window.addEventListener("beatgaler:drawer-artwork-data", onExternalArtwork);
    return () => {
      window.removeEventListener("beatgaler:drawer-native-hover", onNativeHover);
      window.removeEventListener("beatgaler:drawer-native-path", onNativePath);
      window.removeEventListener("beatgaler:drawer-artwork-data", onExternalArtwork);
    };
  }, [isEdit]);

  const handleImageFile = (file: File) => {
    void diagnosticLog("drawer-artwork", "WEB_FILE_BEGIN", `name=${file.name || "(unnamed)"} type=${file.type || "unknown"} bytes=${file.size}`);
    if (file.type && !file.type.startsWith("image/")) {
      void diagnosticLog("drawer-artwork", "WEB_FILE_REJECTED", `reason=not-image type=${file.type}`);
      setError("Artwork must be an image file.");
      return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      const result = e.target?.result;
      if (typeof result !== "string" || !/^data:image\//i.test(result) || result.length < 32) {
        void diagnosticLog("drawer-artwork", "WEB_FILE_REJECTED", "reason=invalid-data-url");
        setError("Could not decode the selected artwork image.");
        return;
      }
      setCropSrc(result);
      setError(null);
      void diagnosticLog("drawer-artwork", "WEB_FILE_READY", `data_url_bytes=${result.length}`);
    };
    reader.onerror = () => {
      void diagnosticLog("drawer-artwork", "WEB_FILE_FAILED", `error=${String(reader.error)}`);
      setError(`Could not read artwork: ${String(reader.error ?? "FileReader failed")}`);
    };
    reader.readAsDataURL(file);
  };

  const handlePickArtwork = useCallback(async () => {
    if (!isTauriAvailable) {
      imgRef.current?.click();
      return;
    }
    setError(null);
    void diagnosticLog("drawer-artwork", "PICKER_OPEN", "source=native-dialog");
    try {
      const path = await pickFile([{
        name: "Artwork image",
        extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"],
      }], beat.folder_path || undefined);
      if (!path) {
        void diagnosticLog("drawer-artwork", "PICKER_CANCELLED", "source=native-dialog");
        return;
      }
      void diagnosticLog("drawer-artwork", "PICKER_SELECTED", "source=native-dialog");
      const image = await readImagePathAsDataUrl(path);
      setCropSrc(image);
      void diagnosticLog("drawer-artwork", "PICKER_READY", `data_url_bytes=${image.length}`);
    } catch (error) {
      void diagnosticLog("drawer-artwork", "PICKER_FAILED", `error=${String(error)}`);
      setError(`Could not load artwork: ${String(error)}`);
    }
  }, [beat.folder_path]);

  const changeBulkTagsMode = (mode: "add" | "replace" | "remove") => {
    setBulkTagsMode(mode);
    setData(d => ({ ...d, tags: [] }));
  };

  const BulkCheck = ({ field, label }: { field: string; label: string }) => isBulk ? (
    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", marginBottom: 6 }}>
      <input type="checkbox" checked={bulkFields.has(field)} onChange={() => toggleBulkField(field)}
        style={{ width: 13, height: 13, accentColor: "#fff", cursor: "pointer" }} />
      <span style={{ fontSize: 11, color: "#888", letterSpacing: 0.8 }}>{label}</span>
    </label>
  ) : <div style={{ fontSize: 12, color: "#aaa", letterSpacing: 1, marginBottom: 6, fontWeight: 600 }}>{label}</div>;

  const FileRow = ({ label, sublabel, present, path, role, hint }: {
    label: string; sublabel?: string; present: boolean; path: string | null;
    role: "mp3" | "wav" | "stems" | "flp" | "als"; hint?: string;
  }) => {
    const pendingPath = pending[role];
    const isDragging = dropTarget === role;
    const displayPath = pendingPath ?? path;
    const isPresent = !!pendingPath || present;

    return (
      <div
        data-beatgaler-drop-owner="local"
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
        <div style={{ minWidth: 48, flexShrink: 0 }}>
          <div style={{ fontSize: 12, color: isPresent ? "#ddd" : "#555" }}>{label}</div>
          {sublabel && <div style={{ fontSize: 9, color: "#666", marginTop: 1 }}>{sublabel}</div>}
        </div>
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
          ) : hint ? <div style={{ fontSize: 10, color: "#444" }}>{hint}</div> : null}
        </div>
        {isEdit && (
          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
            {present && path && !pendingPath && (
              <button onClick={() => revealInExplorer(path)} style={{ padding: "3px 8px", background: "transparent", border: "1px solid #2a2a2a", borderRadius: 5, color: "#666", fontSize: 10, cursor: "pointer" }}
                onMouseEnter={e => (e.currentTarget.style.color = "#bbb")} onMouseLeave={e => (e.currentTarget.style.color = "#666")}>show</button>
            )}
            {pendingPath ? (
              <button onClick={() => setPending(p => { const n = { ...p }; delete n[role]; return n; })}
                style={{ padding: "3px 8px", background: "#2a1a00", border: "1px solid #4a2e00", borderRadius: 5, color: "#fb923c", fontSize: 10, cursor: "pointer" }}>undo</button>
            ) : (
              <button onClick={() => handlePickFile(role, present ? path : null)}
                style={{ padding: "3px 8px", background: present ? "#2a1a00" : "#0f2a0f", border: `1px solid ${present ? "#4a2e00" : "#1a4a1a"}`, borderRadius: 5, color: present ? "#fb923c" : "#4ade80", fontSize: 10, cursor: "pointer" }}>{present ? "replace" : "+ add"}</button>
            )}
          </div>
        )}
        {!isEdit && present && path && (
          <button onClick={() => revealInExplorer(path)} style={{ padding: "3px 8px", background: "transparent", border: "1px solid #2a2a2a", borderRadius: 5, color: "#555", fontSize: 10, cursor: "pointer", flexShrink: 0 }}
            onMouseEnter={e => (e.currentTarget.style.color = "#bbb")} onMouseLeave={e => (e.currentTarget.style.color = "#555")}>show</button>
        )}
      </div>
    );
  };

  return (
    <>
      <div onClick={reviewInfo ? undefined : onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 300, backdropFilter: "blur(4px)" }} />
      <div style={{ position: "fixed", right: 0, top: 0, bottom: 0, width: 340, background: "#0f0f0f", borderLeft: "1px solid #1a1a1a", zIndex: 310, display: "flex", flexDirection: "column", animation: "drawerIn 0.22s ease" }}>
        <div style={{ padding: "18px 22px", borderBottom: "1px solid #1a1a1a", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <span style={{ fontWeight: 500, fontSize: 14, color: "#e0e0e0" }}>
              {reviewHeaderLabel({ reviewCurrent: reviewInfo?.current, reviewTotal: reviewInfo?.total, isBulk, selectedBeatsCount: selectedBeats?.length ?? 0, isEdit })}
            </span>
            {isBulk && <div style={{ fontSize: 11, color: "#777", marginTop: 2 }}>Check fields to apply to all</div>}
          </div>
          {reviewInfo ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button onClick={onSkipCurrent ?? onClose} title="Skip only this beat" style={{ background: "none", border: "none", color: "#aaa", fontSize: 12, cursor: "pointer" }}>Skip beat</button>
              <button onClick={onSkipAll ?? onClose} title="Cancel the remaining import" style={{ background: "none", border: "none", color: "#666", fontSize: 12, cursor: "pointer" }}>Cancel import</button>
            </div>
          ) : <button onClick={onClose} title="Close" style={{ background: "none", border: "none", color: "#777", fontSize: 18, cursor: "pointer" }} />}
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 22 }}>
          {!isBulk && (
            <>
              <div data-beatgaler-drop-owner="local" data-artwork-drop
                onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDropTarget("artwork"); }}
                onDragLeave={e => { e.preventDefault(); setDropTarget(null); }}
                onDrop={e => {
                  e.preventDefault(); e.stopPropagation(); setDropTarget(null);
                  const file = e.dataTransfer.files?.[0];
                  if (file) handleImageFile(file);
                  else {
                    void diagnosticLog("drawer-artwork", "HTML_DROP_EMPTY", `types=${Array.from(e.dataTransfer.types || []).join("|") || "none"}`);
                    setError("The image drop reached BeatGaler, but macOS provided no readable file. Use Add cover to select it.");
                  }
                }}
                style={{ borderRadius: 10, outline: dropTarget === "artwork" ? "1px solid #666" : "1px solid transparent", outlineOffset: 3 }}>
                <Artwork beat={data} size={296} playing={false} />
              </div>
              {isEdit && (
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <button onClick={() => void handlePickArtwork()} style={{ flex: 1, padding: "7px 12px", background: "#1a1a1a", border: "1px solid #252525", borderRadius: 7, color: "#ccc", fontSize: 12, cursor: "pointer" }}>{data.image_base64 ? "Change cover" : "Add cover"}</button>
                  {data.image_base64 && <>
                    <button onClick={() => setCropSrc(data.image_base64 || null)} style={{ padding: "7px 12px", background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 7, color: "#ffd66b", fontSize: 12, cursor: "pointer" }}>Recortar</button>
                    <button onClick={() => setData(d => ({ ...d, image_base64: null, image_preview_base64: null, image_crop: null }))} style={{ padding: "7px 12px", background: "#1a1a1a", border: "1px solid #2a1a1a", borderRadius: 7, color: "#f87171", fontSize: 12, cursor: "pointer" }}>Remove</button>
                  </>}
                </div>
              )}
              <input ref={imgRef} type="file" accept="image/jpeg,image/png,image/webp,image/bmp,image/gif,image/avif" style={{ display: "none" }} onChange={e => { const file = e.target.files?.[0]; if (file) handleImageFile(file); e.currentTarget.value = ""; }} />
            </>
          )}

          {!isBulk && <div style={{ marginTop: 16 }}>
            {isEdit ? <div>
              <input value={data.name} onChange={e => { setData(d => ({ ...d, name: e.target.value })); if (duplicateNameError) { setDuplicateNameError(false); setError(null); } }} aria-invalid={duplicateNameError}
                style={{ background: "#181818", border: duplicateNameError ? "1px solid #ef4444" : "1px solid #252525", boxShadow: duplicateNameError ? "0 0 0 2px rgba(239,68,68,0.14)" : "none", borderRadius: 8, padding: "8px 12px", color: "#fff", fontSize: 17, fontWeight: 500, width: "100%", outline: "none" }} />
              {duplicateNameError && <div style={{ marginTop: 6, color: "#ef6464", fontSize: 11 }}>A beat with this name already exists. Change the name to continue.</div>}
            </div> : <div style={{ fontWeight: 500, fontSize: 19, color: "#fff" }}>{data.name}</div>}
          </div>}

          <div style={{ marginTop: 14 }}><BulkCheck field="rating" label="RATING" /><Stars n={data.rating} onChange={(isEdit || isBulk) ? v => setData(d => ({ ...d, rating: v })) : undefined} /></div>

          <div style={{ marginTop: 14, background: "#161616", borderRadius: 8, padding: "14px", border: "1px solid #1e1e1e" }}>
            <BulkCheck field="tags" label={isBulk ? `TAGS (${bulkTagsMode.toUpperCase()})` : "TAGS"} />
            {isBulk && bulkFields.has("tags") && <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              {(["add", "replace", "remove"] as const).map(mode => <button key={mode} onClick={() => changeBulkTagsMode(mode)} style={{ padding: "4px 10px", borderRadius: 999, border: `1px solid ${bulkTagsMode === mode ? "#4a2a2a" : "#242424"}`, background: bulkTagsMode === mode ? "#2a1717" : "transparent", color: bulkTagsMode === mode ? "#ef9a9a" : "#666", fontSize: 10, cursor: "pointer" }}>{mode === "add" ? "Add tags" : mode === "replace" ? "Replace tags" : "Remove tags"}</button>)}
            </div>}
            {isBulk && bulkFields.has("tags") && bulkTagsMode === "remove" ? (
              <div data-prevent-enter-save="true">
                <div style={{ fontSize: 10, color: commonTags.length ? "#888" : "#f59e0b", marginBottom: 9, lineHeight: 1.5 }}>{commonTags.length ? "Click the common tags you want to delete. Red and crossed-out tags will be removed from every selected beat." : "These beats do not have any tags in common."}</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {commonTags.map(tag => {
                    const normalized = tag.trim().toLowerCase();
                    const marked = data.tags.some(t => t.trim().toLowerCase() === normalized);
                    return <button key={normalized} type="button" aria-pressed={marked} onClick={() => setData(d => ({ ...d, tags: marked ? d.tags.filter(t => t.trim().toLowerCase() !== normalized) : [...d.tags, normalized] }))}
                      style={{ padding: "4px 10px", borderRadius: 999, border: `1px solid ${marked ? "#7f1d1d" : "#2a2a2a"}`, background: marked ? "rgba(248,113,113,0.14)" : "transparent", color: marked ? "#f87171" : "#aaa", textDecoration: marked ? "line-through" : "none", fontSize: 11, cursor: "pointer" }}>{tag}</button>;
                  })}
                </div>
              </div>
            ) : (isEdit || isBulk) ? <TagEditor tags={data.tags} suggestions={tagSuggestions} onChange={tags => setData(d => ({ ...d, tags }))} /> : <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>{data.tags.length ? data.tags.map(t => <TagPill key={t} label={t} />) : <span style={{ fontSize: 12, color: "#444" }}>No tags</span>}</div>}
          </div>

          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div style={{ background: "#161616", borderRadius: 8, padding: "12px 14px", border: `1px solid ${bpmValidation.valid ? "#1e1e1e" : "#7f1d1d"}` }}>
              <BulkCheck field="bpm" label="BPM" />
              {(isEdit || isBulk) ? <input value={data.bpm} inputMode="decimal" aria-invalid={!bpmValidation.valid} onChange={e => setData(d => ({ ...d, bpm: e.target.value }))} onBlur={() => { const checked = validateBpm(data.bpm); if (checked.valid) setData(d => ({ ...d, bpm: checked.normalized })); }} style={{ background: "none", border: "none", outline: "none", color: bpmValidation.valid ? "#fff" : "#fca5a5", fontSize: 16, fontWeight: 500, width: "100%", marginTop: 2 }} /> : <div style={{ fontSize: 16, fontWeight: 500, color: "#fff", marginTop: 2 }}>{data.bpm || "—"}</div>}
              {bpmValidation.valid === false && <div style={{ color: "#f87171", fontSize: 9, lineHeight: 1.4, marginTop: 5 }}>{bpmValidation.reason}</div>}
              {bpmValidation.valid && (isEdit || isBulk) && <div style={{ color: "#4d4d4d", fontSize: 9, marginTop: 5 }}>60–300</div>}
            </div>
            <div style={{ background: "#161616", borderRadius: 8, padding: "12px 14px", border: `1px solid ${keyValidation.valid ? "#1e1e1e" : "#7f1d1d"}` }}>
              <BulkCheck field="key" label="KEY" />
              {(isEdit || isBulk) ? <input value={data.key} aria-invalid={!keyValidation.valid} onChange={e => setData(d => ({ ...d, key: e.target.value }))} onBlur={() => { const checked = validateMusicKey(data.key); if (checked.valid) setData(d => ({ ...d, key: checked.normalized })); }} style={{ background: "none", border: "none", outline: "none", color: keyValidation.valid ? "#fff" : "#fca5a5", fontSize: 16, fontWeight: 500, width: "100%", marginTop: 2 }} /> : <div style={{ fontSize: 16, fontWeight: 500, color: "#fff", marginTop: 2 }}>{data.key || "—"}</div>}
              {keyValidation.valid === false && <div style={{ color: "#f87171", fontSize: 9, lineHeight: 1.4, marginTop: 5 }}>{keyValidation.reason}</div>}
              {keyValidation.valid && (isEdit || isBulk) && <div style={{ color: "#4d4d4d", fontSize: 9, marginTop: 5 }}>Major: C, C#, Cb · Minor: cm, c#m, cbm</div>}
            </div>
          </div>

          {!isBulk && reviewInfo && platform.capabilities.reviewBeatCloudCommit && (
            <div style={{ marginTop: 10, background: "#161616", borderRadius: 8, padding: "14px", border: "1px solid #1e1e1e" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}><div style={{ fontSize: 12, color: "#aaa", letterSpacing: 1, fontWeight: 600 }}>FILES</div><span style={{ fontSize: 10, color: "#4ade80" }}>GALER CLOUD</span></div>
              {(["MASTER", "WAV", "PROJECT"] as PlatformImportSlotKind[]).map(kind => {
                const filename = reviewSlotNames[kind];
                const required = kind === "MASTER";
                return <div key={kind} style={{ padding: "7px 0", borderTop: "1px solid #222", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 62, fontSize: 10, color: kind === "MASTER" ? "#60a5fa" : kind === "WAV" ? "#34d399" : "#c084fc", fontWeight: 700 }}>{kind}</span>
                  <span title={filename} style={{ flex: 1, minWidth: 0, color: filename ? "#aaa" : required ? "#f87171" : "#555", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{filename || (required ? "Required MP3" : "Optional")}</span>
                  <button disabled={saving} onClick={() => void handleReviewSlotPick(kind)} style={{ padding: "4px 8px", background: "#1a1a1a", border: "1px solid #303030", borderRadius: 5, color: "#bbb", fontSize: 9, cursor: saving ? "default" : "pointer" }}>{filename ? "Replace" : `+ ${kind}`}</button>
                </div>;
              })}
              <div style={{ marginTop: 9, color: "#777", fontSize: 9, lineHeight: 1.55 }}>Each selected slot is stored as one Cloud file. Nothing is uploaded until Save.</div>
            </div>
          )}

          {!isBulk && !reviewInfo && platform.capabilities.browserCloudEditing && (
            <div style={{ marginTop: 10, background: "#161616", borderRadius: 8, padding: "14px", border: "1px solid #1e1e1e" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}><div style={{ fontSize: 12, color: "#aaa", letterSpacing: 1, fontWeight: 600 }}>FILES</div><span style={{ fontSize: 10, color: "#4ade80" }}>GALER CLOUD</span></div>
              {(["MASTER", "WAV", "PROJECT"] as PlatformBeatEditSlotKind[]).map(kind => {
                const queued = pendingWebEdit[kind];
                const current = kind === "MASTER" ? data.assets?.master : kind === "WAV" ? data.assets?.wav : data.assets?.project;
                const filename = queued?.name || current?.filename;
                return <div key={kind} style={{ padding: "7px 0", borderTop: "1px solid #222", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 62, fontSize: 10, color: kind === "MASTER" ? "#60a5fa" : kind === "WAV" ? "#34d399" : "#c084fc", fontWeight: 700 }}>{kind}</span>
                  <span title={filename || undefined} style={{ flex: 1, minWidth: 0, color: queued ? "#fb923c" : current ? "#aaa" : "#555", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{queued ? `Pending: ${queued.name}` : filename || (kind === "MASTER" ? "Cloud MASTER" : "Not added")}</span>
                  <button disabled={saving} onClick={() => void handleWebEditFilePick(kind)} style={{ padding: "4px 8px", background: queued ? "#2a1a00" : "#1a1a1a", border: `1px solid ${queued ? "#4a2e00" : "#303030"}`, borderRadius: 5, color: queued ? "#fb923c" : "#bbb", fontSize: 9, cursor: saving ? "default" : "pointer" }}>{current || queued ? "Replace" : `+ ${kind}`}</button>
                </div>;
              })}
              <div style={{ marginTop: 9, color: "#777", fontSize: 9, lineHeight: 1.55 }}>Files stay pending until Save Changes. Metadata, artwork, and replacements are then published together.</div>
            </div>
          )}

          {!isBulk && !platform.capabilities.browserCloudEditing && !platform.capabilities.reviewBeatCloudCommit && (
            <div style={{ marginTop: 10, background: "#161616", borderRadius: 8, padding: "14px", border: "1px solid #1e1e1e" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}><div style={{ fontSize: 12, color: "#aaa", letterSpacing: 1, fontWeight: 600 }}>FILES</div><span style={{ fontSize: 10, color: "#4ade80" }}>GALER CLOUD</span></div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                {(["MASTER", "WAV", "STEMS", "LOOP", "OTHER"] as CloudFileType[]).map(type => {
                  const queued = pendingCloud[type];
                  return <button key={type} disabled={saving} onClick={() => void handleCloudReplace(type)} title={queued ? queued : `Choose ${type}; Galer Cloud will not change until Save Changes`}
                    style={{ padding: "5px 8px", background: queued ? "#2a1a00" : "#1a1a1a", border: `1px solid ${queued ? "#4a2e00" : "#2a2a2a"}`, borderRadius: 6, color: queued ? "#fb923c" : "#bbb", fontSize: 10, cursor: saving ? "default" : "pointer" }}>{queued ? `PENDING ${type}` : `+ ${type}`}</button>;
                })}
              </div>
              <div style={{ padding: "7px 0", borderTop: "1px solid #222", display: "flex", gap: 8 }}><span style={{ width: 58, fontSize: 10, color: "#60a5fa", fontWeight: 700 }}>MASTER</span><span style={{ flex: 1, color: data.telegram_file_id ? "#888" : "#555", fontSize: 10 }}>{data.telegram_file_id ? "Stored in Galer Cloud" : "Uploading / not stored yet"}</span></div>
              <div style={{ padding: "9px 0", borderTop: "1px solid #222" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}><span style={{ width: 58, fontSize: 10, color: "#c084fc", fontWeight: 700 }}>PROJECT</span><span style={{ flex: 1, color: cloudFiles.some(f => f.file_type === "PROJECT") ? "#888" : "#555", fontSize: 10 }}>{cloudFiles.some(f => f.file_type === "PROJECT") ? `${data.name}.zip` : "No valid project stored"}</span></div>
                {isEdit && <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  <button disabled={saving} onClick={() => void handleProjectAsset("flp")} title={pendingCloud.PROJECT_FLP ? pendingCloud.PROJECT_FLP : "Queued until Save Changes"} style={{ padding: "4px 7px", background: pendingCloud.PROJECT_FLP ? "#2a1a00" : "#1a1a1a", border: `1px solid ${pendingCloud.PROJECT_FLP ? "#4a2e00" : "#2a2a2a"}`, borderRadius: 5, color: pendingCloud.PROJECT_FLP ? "#fb923c" : "#bbb", fontSize: 9, cursor: saving ? "default" : "pointer" }}>{pendingCloud.PROJECT_FLP ? "PENDING FLP" : "+ FLP"}</button>
                  <button disabled={saving} onClick={() => void handleProjectAsset("samples")} title={pendingCloud.PROJECT_SAMPLES ? pendingCloud.PROJECT_SAMPLES : "Queued until Save Changes"} style={{ padding: "4px 7px", background: pendingCloud.PROJECT_SAMPLES ? "#2a1a00" : "#1a1a1a", border: `1px solid ${pendingCloud.PROJECT_SAMPLES ? "#4a2e00" : "#2a2a2a"}`, borderRadius: 5, color: pendingCloud.PROJECT_SAMPLES ? "#fb923c" : "#bbb", fontSize: 9, cursor: saving ? "default" : "pointer" }}>{pendingCloud.PROJECT_SAMPLES ? "PENDING Samples" : "+ Samples"}</button>
                  <button disabled={saving} onClick={() => void handleProjectAsset("audio")} title={pendingCloud.PROJECT_AUDIO ? pendingCloud.PROJECT_AUDIO : "Queued until Save Changes"} style={{ padding: "4px 7px", background: pendingCloud.PROJECT_AUDIO ? "#2a1a00" : "#1a1a1a", border: `1px solid ${pendingCloud.PROJECT_AUDIO ? "#4a2e00" : "#2a2a2a"}`, borderRadius: 5, color: pendingCloud.PROJECT_AUDIO ? "#fb923c" : "#bbb", fontSize: 9, cursor: saving ? "default" : "pointer" }}>{pendingCloud.PROJECT_AUDIO ? "PENDING Audio" : "+ Audio"}</button>
                  {cloudFiles.some(f => f.file_type === "PROJECT") && <button disabled={cloudBusy !== null} onClick={() => void handleManualProjectUpdate()} style={{ padding: "4px 7px", background: "#171f17", border: "1px solid #294029", borderRadius: 5, color: "#86efac", fontSize: 9, cursor: cloudBusy ? "default" : "pointer" }}>{cloudBusy === "PROJECT-UPDATE" ? "Updating…" : "Update Project"}</button>}
                </div>}
              </div>
              {cloudFiles.filter(file => file.file_type !== "PROJECT").map(file => <div key={file.cloud_file_id} style={{ padding: "7px 0", borderTop: "1px solid #222", display: "flex", alignItems: "center", gap: 8 }}><span style={{ width: 58, fontSize: 10, color: "#8b8b8b", fontWeight: 700 }}>{file.file_type}</span><div style={{ flex: 1, minWidth: 0 }}><div title={file.filename} style={{ color: "#bbb", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.filename}</div><div style={{ color: "#555", fontSize: 9, marginTop: 2 }}>{formatCloudSize(file.original_size)}{file.part_count > 1 ? ` · ${file.part_count} parts` : ""}</div></div></div>)}
              <div style={{ marginTop: 9, color: "#777", fontSize: 9, lineHeight: 1.55 }}>Files marked PENDING are local selections only. Galer Cloud is not changed until you click Save Changes. Cancel closes the editor without uploading those selections.<br />PLAY always uses the MASTER MP3; WAV is HQ/download only.</div>
              {cloudError && <div style={{ marginTop: 8, color: "#f87171", fontSize: 10 }}>{sanitizeUserVisibleText(cloudError)}</div>}
            </div>
          )}

          {error && <div style={{ marginTop: 12, padding: "10px 14px", background: "#3d0000", border: "1px solid #7f1d1d", borderRadius: 8, fontSize: 12, color: "#fca5a5", lineHeight: 1.5 }}>{sanitizeUserVisibleText(error)}</div>}
        </div>

        {(isEdit || isBulk) && <div style={{ padding: "14px 22px", borderTop: "1px solid #1a1a1a" }}>
          {(() => {
            const footerState = getReviewFooterState({
              mutationAllowed, saving, isBulk, bulkFieldCount: bulkFields.size, bulkTagsMode, tagsCount: data.tags.length,
              selectedBeatsCount: selectedBeats?.length ?? 0, bpmValid: bpmValidation.valid, keyValid: keyValidation.valid,
              bulkHasBpm: bulkFields.has("bpm"), bulkHasKey: bulkFields.has("key"), bulkHasTags: bulkFields.has("tags"),
              reviewCurrent: reviewInfo?.current, reviewTotal: reviewInfo?.total, hasOnSaveAll: !!onSaveAll,
              pendingFileCount: Object.keys(pending).length + Object.keys(pendingCloud).length + Object.keys(pendingWebEdit).length,
            });
            const { disabled, label, canSaveAll } = footerState;
            return <div style={{ display: "flex", gap: canSaveAll ? 8 : 0 }}>
              <button onClick={() => void handleSave("next")} disabled={disabled} style={{ flex: 1, width: "100%", padding: "10px", background: disabled ? "#1e1e1e" : "#fff", border: "none", borderRadius: 8, color: disabled ? "#3a3a3a" : "#000", fontWeight: 500, fontSize: 14, cursor: disabled ? "default" : "pointer" }}>
                {saving && saveProgress ? `Saving ${Math.round((saveProgress.uploadedBytes / Math.max(1, saveProgress.totalBytes)) * 100)}%…` : label}
              </button>
              {canSaveAll && <button onClick={() => void handleSave("all")} disabled={disabled} style={{ flex: 1, padding: "10px", background: disabled ? "#1e1e1e" : "#171717", border: `1px solid ${disabled ? "#222" : "#353535"}`, borderRadius: 8, color: disabled ? "#3a3a3a" : "#e7e7e7", fontWeight: 500, fontSize: 14, cursor: disabled ? "default" : "pointer" }}>Save all</button>}
            </div>;
          })()}
        </div>}
      </div>

      {cropSrc && <ImageCropModal imageSrc={cropSrc} onCancel={() => setCropSrc(null)} onConfirm={(croppedDataUrl, crop) => {
        setData(d => ({ ...d, image_base64: croppedDataUrl, image_preview_base64: croppedDataUrl, image_crop: crop }));
        setCropSrc(null);
      }} />}
    </>
  );
}
