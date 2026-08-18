import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from "react";
import UploadScheduler from "./UploadSchedulerNew";
import type { Beat, UploadMode, VisualType, Visibility, BeatUploadJob, UploadTemplate, YouTubeChannel } from "../types";
import { Artwork, TagEditor, TagPill } from "./ui";
import {
  pickImageFile, pickVideoFile, applyTemplate,
  getTemplatesDir, listTemplateFiles, readTemplateFile, writeTemplateFile, deleteTemplateFile,
  deleteTemplateToTrash,
  filePathToUrl, pickFile, getYouTubeChannel,
  connectYouTubeChannel, uploadToYouTube, disconnectYouTube, startYoutubeUpload,
  pickFolder, saveTemplateDialog, setTemplatesFolder,
} from "../lib/tauri";
import { listen } from '@tauri-apps/api/event';
import { registerJob } from "../lib/jobStore";
import { hashFilePath } from "../utils/hash";
import { getCachedUpload, setCachedUpload } from "../utils/uploadCache";
import { appAlert, appConfirm } from "../lib/dialog";

interface Props {
  initialBeat: Beat | null;
  allBeats: Beat[];
  onClose: () => void;
  // optional list of beat ids that should be pre-selected when opening in bulk
  initialSelectedIds?: string[];
}

const STEP_LABELS = ["Mode & Beats", "Visual", "Title / Desc / Tags", "Visibility & Schedule", "YouTube & Upload"];

const EMPTY_TEMPLATE: UploadTemplate = {
  name: "",
  title_template: "",
  description_template: "",
  tags: [],
};



// Presets are .txt files in a managed "templates" folder (backend-owned,
// same pattern as the beats folder) — this is just the "last used" pointer,
// a tiny localStorage cache so the modal can paint the right preset
// instantly on open instead of flashing empty while the folder loads.
const LAST_PRESET_KEY = "beatvault:last-used-preset";

function loadLastUsedPreset(): UploadTemplate | null {
  try {
    const raw = localStorage.getItem(LAST_PRESET_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveLastUsedPreset(t: UploadTemplate) {
  try { localStorage.setItem(LAST_PRESET_KEY, JSON.stringify(t)); } catch { /* ignore */ }
}

function sanitizeFileName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]/g, "_") || "preset";
}

// A preset as tracked in this component — same shape as UploadTemplate plus
// the .txt path it lives at, so save/delete know exactly which file to touch.
interface StoredPreset extends UploadTemplate {
  path: string;
}



function makeJob(beat: Beat, template: UploadTemplate): BeatUploadJob {
  const mergedTags = Array.from(new Set([...template.tags]));
  const { title, description } = applyTemplate(template, {
    title: beat.name,
    bpm: beat.bpm || "",
    key: beat.key || "",
    collaborator: "",
  });
  return {
    beat,
    visual_type: "image",
    image_base64: beat.image_base64,
    image_path: null,
    video_path: null,
    video_loop: true,
    title,
    description,
    tags: mergedTags,
    visibility: "public",
    scheduled_at: null,
    collaborator: "",
    upload_status: "pending",
    upload_progress: 0,
  };
}

export default function UploadModal({ initialBeat, allBeats, onClose, initialSelectedIds }: Props) {
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<UploadMode>(initialBeat ? "single" : "bulk");
  const [bulkBeatIds, setBulkBeatIds] = useState<Set<string>>(() => {
    if (initialBeat) return new Set([initialBeat.id]);
    if ((globalThis as any).__INITIAL_UPLOAD_SELECTED_IDS__) {
      // backward compatibility (not expected)
    }
    return new Set(initialSelectedIds ?? []);
  });
  const [presets, setPresets] = useState<StoredPreset[]>([]);
  const [templatesDir, setTemplatesDir] = useState<string>("");
  // Every upload must make an explicit preset decision.
  // Do not silently prefill the previous preset into a new upload session.
  const initialTemplate = useMemo(() => EMPTY_TEMPLATE, []);
  const [jobs, setJobs] = useState<BeatUploadJob[]>(() => (initialBeat ? [makeJob(initialBeat, initialTemplate)] : []));
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [template, setTemplate] = useState<UploadTemplate>(initialTemplate);
  const [jobPresetMap, setJobPresetMap] = useState<Record<string, string>>({});
  const [applyScope, setApplyScope] = useState<"all" | "active">("all");
  const [channel, setChannel] = useState<YouTubeChannel>({
    id: "mock-youtube-channel",
    name: "",
    avatar_url: null,
    connected: false,
  });

  // syncTemplate=true also repaints the currently-edited template with the
  // authoritative disk version of the last-used preset — only appropriate on
  // initial modal load (to replace the localStorage cache), never when just
  // reopening the presets dropdown mid-session, or it would silently wipe
  // whatever the user is currently editing.
  const refreshPresets = async (syncTemplate: boolean = false) => {
    try {
      const dir = await getTemplatesDir();
      setTemplatesDir(dir);
      const paths = await listTemplateFiles();
      const loaded: StoredPreset[] = [];
      for (const path of paths) {
        try {
          const t = await readTemplateFile(path);
          loaded.push({ ...t, path });
        } catch {
          // skip unreadable file
        }
      }
      setPresets(loaded);
      if (syncTemplate) {
        const lastUsedName = loadLastUsedPreset()?.name;
        if (lastUsedName) {
          const authoritative = loaded.find(p => p.name === lastUsedName);
          if (authoritative) {
            setTemplate(authoritative);
            recomputeJobsFromTemplate(authoritative, applyScope, activeJob?.beat.id ?? null);
          }
        }
      }
    } catch {
      // ignore
    }
  };
  const [isConnecting, setIsConnecting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNavigationLocked, setUploadNavigationLocked] = useState(false);
  const [validationFlashStep, setValidationFlashStep] = useState<number | null>(null);
  const validationTimerRef = useRef<number | null>(null);
  const [acceptedStepSignatures, setAcceptedStepSignatures] = useState<Record<number, string>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (jobs.length > 0 && !activeJobId) selectJob(jobs[0].beat.id);
  }, [jobs, activeJobId]);

  // Load every saved preset from the templates folder. If the last-used
  // preset (from the localStorage pointer) still exists on disk, swap the
  // instant-paint cached copy for the authoritative file version once it's in.
  useEffect(() => {
    let alive = true;
    (async () => {
      await refreshPresets();
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const existing = await getYouTubeChannel();
      if (alive && existing) {
        setChannel(existing);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const activeJob = useMemo(
    () => {
      const found = jobs.find(j => j.beat.id === activeJobId);
      if (found) return found;
      if (jobs[0]) return jobs[0];
      // Fallback safe job to avoid runtime renders when jobs is empty
      return {
        beat: { id: "", name: "", folder_path: "", bpm: "", key: "", has_wav: false, mp3_path: "", wav_path: "", playback_path: "" },
        visual_type: "image",
        image_base64: null,
        image_path: null,
        video_path: null,
        video_loop: true,
        title: "",
        description: "",
        tags: [],
        visibility: "public",
        scheduled_at: null,
        collaborator: "",
        upload_status: "pending",
        upload_progress: 0,
      } as any;
    },
    [jobs, activeJobId]
  );

  const selectionSignature = useMemo(() => {
    const ids = mode === "single"
      ? (jobs[0] ? [jobs[0].beat.id] : Array.from(bulkBeatIds))
      : Array.from(bulkBeatIds).sort();
    return JSON.stringify({ mode, ids });
  }, [mode, bulkBeatIds, jobs]);

  const visualSignature = useMemo(() => JSON.stringify(jobs.map(j => ({
    id: j.beat.id,
    visual_type: j.visual_type,
    image_path: j.image_path ?? null,
    image_base64: j.image_base64 ?? null,
    video_path: j.video_path ?? null,
    video_loop: j.video_loop,
  }))), [jobs]);

  const metadataSignature = useMemo(() => JSON.stringify(jobs.map(j => ({
    id: j.beat.id,
    title: j.title.trim(),
    description: j.description.trim(),
    tags: j.tags,
    collaborator: j.collaborator,
    preset: jobPresetMap[j.beat.id] ?? null,
  }))), [jobs, jobPresetMap]);

  const scheduleSignature = useMemo(() => JSON.stringify(jobs.map(j => ({
    id: j.beat.id,
    visibility: j.visibility,
    scheduled_at: j.scheduled_at ?? null,
  }))), [jobs]);

  const currentStepSignature = useCallback((whichStep: number): string => {
    if (whichStep === 0) return selectionSignature;
    if (whichStep === 1) return visualSignature;
    if (whichStep === 2) return metadataSignature;
    if (whichStep === 3) return scheduleSignature;
    return "";
  }, [selectionSignature, visualSignature, metadataSignature, scheduleSignature]);

  const isStepClean = useCallback((whichStep: number): boolean => {
    const accepted = acceptedStepSignatures[whichStep];
    return !!accepted && accepted === currentStepSignature(whichStep);
  }, [acceptedStepSignatures, currentStepSignature]);

  const isStepEffectivelyClean = useCallback((whichStep: number): boolean => {
    for (let i = 0; i <= whichStep; i++) {
      if (!isStepClean(i)) return false;
    }
    return true;
  }, [isStepClean]);

  const flashInvalidStep = useCallback((whichStep: number) => {
    setValidationFlashStep(whichStep);
    if (validationTimerRef.current != null) window.clearTimeout(validationTimerRef.current);
    validationTimerRef.current = window.setTimeout(() => {
      setValidationFlashStep(null);
      validationTimerRef.current = null;
    }, 900);
  }, []);

  useEffect(() => () => {
    if (validationTimerRef.current != null) window.clearTimeout(validationTimerRef.current);
  }, []);

  const recomputeJobsFromTemplate = useCallback((nextTemplate: UploadTemplate, scope: "all" | "active", activeId: string | null) => {
    setJobs(js => js.map(j => {
      if (scope === "active" && j.beat.id !== activeId) return j;
      const { title, description } = applyTemplate(nextTemplate, {
        title: j.beat.name,
        bpm: j.beat.bpm || "",
        key: j.beat.key || "",
        collaborator: j.collaborator,
      });
      return {
        ...j,
        title,
        description,
        tags: Array.from(new Set([...nextTemplate.tags])),
      };
    }));
  }, []);

  const setModeAndInit = (m: UploadMode) => {
    setMode(m);
    if (m === "single" && initialBeat) {
      setBulkBeatIds(new Set([initialBeat.id]));
      setJobs([makeJob(initialBeat, template)]);
    } else if (m === "single") {
      const first = allBeats[0];
      if (first) {
        setBulkBeatIds(new Set([first.id]));
        setJobs([makeJob(first, template)]);
      } else {
        setBulkBeatIds(new Set());
        setJobs([]);
      }
    } else {
      setBulkBeatIds(new Set());
      setJobs([]);
    }
  };

  const toggleBulkBeat = (beat: Beat) => {
    setBulkBeatIds(prev => {
      const next = new Set(prev);
      if (next.has(beat.id)) {
        next.delete(beat.id);
      } else {
        next.add(beat.id);
      }
      return next;
    });
  };

  const finalizeSelection = () => {
    const ids = mode === "single" && jobs.length === 1
      ? [jobs[0].beat.id]
      : Array.from(bulkBeatIds);
    const beats = allBeats.filter(b => ids.includes(b.id));
    const nextJobs = beats.map(b => makeJob(b, template));
    setJobs(nextJobs);
    selectJob(beats[0]?.id ?? null);
    setAcceptedStepSignatures(prev => ({
      ...prev,
      0: JSON.stringify({ mode, ids: mode === "single" ? ids : [...ids].sort() }),
    }));
    setStep(1);
  };

  const removeJob = (beatId: string) => {
    setJobs(js => {
      const next = js.filter(j => j.beat.id !== beatId);
      if (next.length === 0) {
        selectJob(null);
      } else if (!next.find(j => j.beat.id === activeJobId)) {
        selectJob(next[0].beat.id);
      }
      return next;
    });
  };

  const reorderJobs = (fromIndex: number, toIndex: number) => {
    setJobs(js => {
      const next = js.slice();
      if (fromIndex < 0 || fromIndex >= next.length || toIndex < 0 || toIndex >= next.length) return next;
      const [m] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, m);
      return next;
    });
  };

  const updateJob = (beatId: string, patch: Partial<BeatUploadJob>) => {
    setJobs(js => js.map(j => (j.beat.id === beatId ? { ...j, ...patch } : j)));
  };

  const selectJob = (beatId: string | null, assignedPreset?: StoredPreset | null) => {
    // avoid re-selecting same id
    if (beatId === activeJobId) return;
    if (!beatId) {
      setActiveJobId(null);
      return;
    }
    const job = jobs.find(j => j.beat.id === beatId);
    setActiveJobId(beatId);
    setApplyScope("active");
    if (job) {
      // If caller supplied an assigned preset, use it; otherwise consult jobPresetMap.
      const stored = assignedPreset ?? (jobPresetMap[beatId] ? presets.find(p => p.name === jobPresetMap[beatId]) : null);
      if (stored) {
        // start from the stored preset so the editor shows the template
        const nextTemplate: UploadTemplate = {
          name: stored.name,
          title_template: stored.title_template,
          description_template: stored.description_template,
          tags: stored.tags,
        };
        setTemplate(nextTemplate);
      } else {
        // no assigned preset: show the beat's concrete values in the editor
        const nextTemplate: UploadTemplate = {
          name: "",
          title_template: job.title || "",
          description_template: job.description || "",
          tags: job.tags || [],
        };
        setTemplate(nextTemplate);
      }
    }
  };

  const updateActive = (patch: Partial<BeatUploadJob>) => {
    if (!activeJob) return;
    if (applyScope === "all") {
      setJobs(js => js.map(j => ({ ...j, ...patch })));
    } else {
      updateJob(activeJob.beat.id, patch);
    }
  };

  const updateTemplate = (patch: Partial<UploadTemplate>) => {
    const next = { ...template, ...patch };
    setTemplate(next);
    // Editing stays local to the selected beat. Applying a preset to every beat
    // is an explicit action via the "Apply to all" button.
    recomputeJobsFromTemplate(next, "active", activeJob?.beat.id ?? null);
  };

  const applyCurrentPresetToAll = () => {
    const presetName = template.name.trim();
    const preset = presets.find(p => p.name === presetName);
    if (!preset) return;

    const { path: _path, ...storedTemplate } = preset;
    recomputeJobsFromTemplate(storedTemplate, "all", activeJob?.beat.id ?? null);

    const nextMap: Record<string, string> = {};
    for (const job of jobs) nextMap[job.beat.id] = preset.name;
    setJobPresetMap(nextMap);

    // Keep the current beat selected; this is a one-shot action, not a mode.
    setApplyScope("active");
  };

  // Applies a saved preset by name — used from the dropdown, and marks it
  // as "last used" so it's what greets the user next time they open Upload.
  const onSelectPreset = (name: string) => {
    const preset = presets.find(p => p.name === name);
    if (!preset) return;
    const { path, ...rest } = preset;
    setTemplate(rest);
    saveLastUsedPreset(rest);
    // Selecting a preset edits/assigns the currently selected beat only.
    // Bulk assignment is always an explicit "Apply to all" action.
    recomputeJobsFromTemplate(rest, "active", activeJob?.beat.id ?? null);
    if (activeJob) {
      setJobPresetMap(prev => ({ ...prev, [activeJob.beat.id]: name }));
      try { selectJob(activeJob.beat.id, preset); } catch {}
    }
    setApplyScope("active");
  };

  // Saves the current template as a .txt preset via a Save dialog (Save as...)
  // The user chooses the filename and location; the file is written and then
  // remembered as the last-used preset.
  const onSavePreset = async () => {
    try {
      const defaultName = sanitizeFileName(template.name || template.title_template || "preset");
      const target = await saveTemplateDialog(defaultName + ".txt", templatesDir || undefined);
      if (!target) return; // user cancelled
      const base = target.split(/[/\\]/).pop() || defaultName;
      const name = base.replace(/\.txt$/i, "");
      const withName: UploadTemplate = { ...template, name };
      const ok = await writeTemplateFile(target, withName);
      if (!ok) {
        await appAlert({ title: "Could not save preset", message: "Check that the selected location is writable.", danger: true });
        return;
      }
      setPresets(prev => {
        const existing = prev.find(p => p.name === name);
        const stored: StoredPreset = { ...withName, path: target };
        return existing ? prev.map(p => (p.name === name ? stored : p)) : [...prev, stored];
      });
      saveLastUsedPreset(withName);
    } catch (e: any) {
      await appAlert({ title: "Could not save preset", message: String(e), danger: true });
    }
  };

// Moves a saved preset to the recoverable trash (same pattern as beats).
  // If it was the one currently loaded in the editor, clears the editor back
  // to blank instead of leaving a now-orphaned preset's text behind.
  const onDeletePreset = async (name: string) => {
    const preset = presets.find(p => p.name === name);
    if (!preset) return;
    try {
      await deleteTemplateToTrash(preset.path);
      setPresets(prev => prev.filter(p => p.name !== name));
      if (template.name.trim() === name) {
        setTemplate(EMPTY_TEMPLATE);
      }
      setJobPresetMap(prev => {
        const next = { ...prev };
        for (const k of Object.keys(next)) {
          if (next[k] === name) delete next[k];
        }
        return next;
      });
    } catch (e: any) {
      await appAlert({ title: "Could not delete preset", message: String(e), danger: true });
    }
  };

  const onChooseTemplatesDir = async () => {
    try {
      const chosen = await pickFolder("Select template folder");
      if (!chosen) return;
      // Use the folder the user selected directly (no extra subfolder)
      await setTemplatesFolder(chosen);
      // Attempt to move existing presets into the new folder
      for (const p of presets) {
        try {
          const t = await readTemplateFile(p.path);
          const newPath = `${chosen}/${sanitizeFileName(p.name)}.txt`;
          await writeTemplateFile(newPath, t);
          await deleteTemplateFile(p.path);
        } catch {
          // skip failures per-file
        }
      }
      // Refresh authoritative list from disk
      await refreshPresets();
      setTemplatesDir(chosen);
    } catch (e: any) {
      await appAlert({ title: "Could not change template directory", message: String(e), danger: true });
    }
  };

  const connectChannel = async (): Promise<YouTubeChannel | null> => {
    setIsConnecting(true);
    setUploadError(null);
    try {
      const existing = await getYouTubeChannel();
      if (existing?.connected) {
        setChannel(existing);
        return existing;
      }

      // OAuth client configuration is bundled at build time.
      // Never ask the end user to select a client_secret JSON file.
      const connected = await connectYouTubeChannel();
      setChannel(connected);
      return connected;
    } catch (error) {
      const message = typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : String(error || "Could not connect YouTube.");
      setChannel({
        id: "",
        name: "",
        avatar_url: null,
        connected: false,
      });
      setUploadError(message);
      return null;
    } finally {
      setIsConnecting(false);
    }
  };

  const disconnectChannel = async (): Promise<void> => {
    try {
      setIsConnecting(true);
      await disconnectYouTube();
      setChannel({ id: "", name: "", avatar_url: null, connected: false });
      setUploadError(null);
    } catch (error) {
      const message = typeof error === "string" ? error : error instanceof Error ? error.message : "Could not disconnect YouTube.";
      setUploadError(message);
    } finally {
      setIsConnecting(false);
    }
  };

  const startUpload = async () => {
    try {
      let connectedChannel = channel;
      if (!connectedChannel.connected) {
        connectedChannel = await connectChannel() ?? connectedChannel;
        if (!connectedChannel.connected) return;
      }

      // From this point the upload workflow is committed. Navigation to earlier
      // configuration steps stays locked even after generation/upload finishes.
      setUploadNavigationLocked(true);
      setIsUploading(true);
      setUploadError(null);
      for (const job of jobs) {
      const id = job.beat.id;
      try {
        setJobs(js => js.map(j => j.beat.id === id
          ? { ...j, upload_status: "generating", upload_progress: 25, error_message: undefined }
          : j));

        // Try to dedupe by hashing the audio and checking a local cache.
        const audioPath = job.beat.mp3_path || job.beat.wav_path || job.beat.playback_path;
        let audioHash: string | null = null;
        try {
          if (audioPath) {
            audioHash = await hashFilePath(audioPath);
            const cached = getCachedUpload(audioHash);
            if (cached) {
              // Use cached result and skip upload
              setJobs(js => js.map(j => j.beat.id === id
                ? { ...j, upload_status: 'done', upload_progress: 100, upload_result_url: cached.url }
                : j));
              continue; // next job
            }
          }
        } catch (e) {
          // hashing failed -> fall back to normal upload
          console.warn("Could not compute audio hash:", e);
        }

        // Start background upload and get job id
        const jobId = await startYoutubeUpload({
          audio_path: audioPath,
          image_base64: job.image_base64,
          image_path: job.image_path,
          video_path: job.video_path,
          video_loop: job.video_loop,
          title: job.title,
          description: job.description,
          tags: job.tags,
          visibility: job.visibility,
          scheduled_at: job.scheduled_at,
        });

        // Register in the global job tray so progress survives closing this modal.
        registerJob(jobId, job.beat.name);

        // Listen for completion or error for this job
        const unlistenDone = await listen('youtube:done', (e: any) => {
          try {
            const payload = e.payload as any;
            if (payload?.job_id === jobId) {
              setJobs(js => js.map(j => j.beat.id === id
                ? { ...j, upload_status: 'done', upload_progress: 100, upload_result_url: payload.result?.url ?? undefined }
                : j));
              // Cache the result keyed by audio hash when available
              try { if (audioHash && payload?.result?.url) setCachedUpload(audioHash, payload.result.url); } catch {}
              unlistenDone();
            }
          } catch (_) { /* ignore */ }
        });
        const unlistenErr = await listen('youtube:error', (e: any) => {
          try {
            const payload = e.payload as any;
            if (payload?.job_id === jobId) {
              const message = payload?.error ?? 'Upload failed';
              setJobs(js => js.map(j => j.beat.id === id
                ? { ...j, upload_status: 'error', upload_progress: 0, error_message: message }
                : j));
              setUploadError(message);
              unlistenErr();
            }
          } catch (_) { /* ignore */ }
        });

      } catch (error) {
        const message = typeof error === "string"
          ? error
          : error instanceof Error
            ? error.message
            : "Upload failed.";
        setJobs(js => js.map(j => j.beat.id === id
          ? { ...j, upload_status: "error", upload_progress: 0, error_message: message }
          : j));
        setUploadError(message);
      }
    }
      setIsUploading(false);
    } catch (err: any) {
      const message = err && err.stack ? err.stack : String(err);
      console.error("startUpload error:", message);
      setUploadError(message);
      setIsUploading(false);
    }
  };

  const canNextStep0 = useMemo(() => {
    if (mode === "single") return jobs.length === 1 || bulkBeatIds.size === 1;
    return bulkBeatIds.size >= 1;
  }, [mode, jobs.length, bulkBeatIds.size]);

  const canNextStep1 = useMemo(() => jobs.length > 0 && jobs.every(j => {
    if (j.visual_type === "image") return !!j.image_base64 || !!j.image_path;
    return !!j.video_path;
  }), [jobs]);

  // Metadata is only accepted when EVERY beat has an explicitly assigned saved preset.
  // Manual title/description edits are allowed after choosing a preset, but a preset
  // must always be the base decision for the beat.
  const canNextStep2 = useMemo(
    () => jobs.length > 0 && jobs.every(j => {
      const presetName = jobPresetMap[j.beat.id];
      return !!presetName
        && presets.some(p => p.name === presetName)
        && j.title.trim().length > 0
        && j.description.trim().length > 0;
    }),
    [jobs, jobPresetMap, presets]
  );

  // Scheduling is deliberate in Beat Galer: every beat must have a date before
  // YouTube & Upload becomes reachable.
  const canNextStep3 = useMemo(
    () => jobs.length > 0 && jobs.every(j => !!j.scheduled_at),
    [jobs]
  );

  const canUpload = channel.connected && jobs.length > 0 && !isUploading;

  const stepIsValid = useCallback((whichStep: number) => {
    if (whichStep === 0) return canNextStep0;
    if (whichStep === 1) return canNextStep1;
    if (whichStep === 2) return canNextStep2;
    if (whichStep === 3) return canNextStep3;
    return true;
  }, [canNextStep0, canNextStep1, canNextStep2, canNextStep3]);

  const acceptCurrentStepAndAdvance = useCallback(() => {
    if (uploadNavigationLocked) return;

    if (!stepIsValid(step)) {
      flashInvalidStep(step);
      return;
    }

    if (step === 0) {
      finalizeSelection();
      return;
    }

    if (step >= 1 && step <= 3) {
      setAcceptedStepSignatures(prev => ({
        ...prev,
        [step]: currentStepSignature(step),
      }));
      setStep(step + 1);
    }
  }, [
    uploadNavigationLocked, step, stepIsValid, flashInvalidStep,
    finalizeSelection, currentStepSignature
  ]);

  const canNavigateToStep = useCallback((targetStep: number) => {
    if (uploadNavigationLocked) return targetStep === step;
    if (targetStep === step) return true;

    // Backwards is allowed until Generate & Upload commits the workflow.
    if (targetStep < step) return true;

    // A future step is reachable only if EVERY prerequisite has previously
    // been explicitly accepted and is still unchanged ("clean").
    for (let prerequisite = 0; prerequisite < targetStep; prerequisite++) {
      if (!isStepClean(prerequisite)) return false;
    }
    return true;
  }, [uploadNavigationLocked, step, isStepClean]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }

      if (e.key !== "Enter" || uploadNavigationLocked || step >= 4) return;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isTypingControl =
        tag === "textarea" ||
        tag === "input" ||
        tag === "select" ||
        target?.isContentEditable;

      // Enter inside text/date/select controls keeps its normal editing behavior.
      if (isTypingControl) return;

      e.preventDefault();
      acceptCurrentStepAndAdvance();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, uploadNavigationLocked, step, acceptCurrentStepAndAdvance]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)", backdropFilter: "blur(4px)", zIndex: 500, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 24 }}>
      <div style={{
        width: "min(1080px, 98vw)",
        maxHeight: "94vh",
        background: "#0f0f0f",
        border: "1px solid #1c1c1c",
        borderRadius: 14,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        boxShadow: "0 24px 80px rgba(0,0,0,0.8)",
        fontFamily: "'DM Sans', sans-serif",
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid #181818", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 15, fontWeight: 500, color: "#e5e5e5" }}>Upload to YouTube</span>
            <span style={{ fontSize: 11, color: "#555" }}>{jobs.length} beat{jobs.length !== 1 ? "s" : ""}</span>
          </div>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 6, background: "transparent", border: "none", color: "#666", cursor: "pointer", fontSize: 16 }}></button>
        </div>

        {/* Stepper */}
        <div style={{ padding: "12px 20px 0", display: "flex", gap: 4, flexShrink: 0, overflowX: "auto" }}>
          {STEP_LABELS.map((label, i) => {
            const done = i < 4 && isStepEffectivelyClean(i);
            const active = i === step;
            return (
              <button key={label}
                disabled={uploadNavigationLocked}
                onClick={() => {
                  if (uploadNavigationLocked) return;

                  // Clicking the immediate next tab is exactly the same action
                  // as pressing Continue: validate + accept the current step.
                  if (i === step + 1) {
                    acceptCurrentStepAndAdvance();
                    return;
                  }

                  if (!canNavigateToStep(i)) return;
                  setStep(i);
                }}
                style={{
                  flexShrink: 0,
                  padding: "8px 14px",
                  borderRadius: 8,
                  border: `1px solid ${active ? "#3a3a3a" : "#1a1a1a"}`,
                  background: active ? "#1a1a1a" : done ? "#121212" : "transparent",
                  color: active ? "#fff" : done ? "#999" : canNavigateToStep(i) ? "#777" : "#3a3a3a",
                  fontSize: 12,
                  cursor: canNavigateToStep(i) && !uploadNavigationLocked
                    ? "pointer"
                    : "default",
                  display: "flex", alignItems: "center", gap: 8,
                }}>
                <span style={{
                  width: 18, height: 18, borderRadius: "50%",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  fontSize: 10, fontWeight: 600,
                  background: active ? "#fff" : done ? "#2a2a2a" : "#1a1a1a",
                  color: active ? "#000" : done ? "#aaa" : "#444",
                }}>{done ? "" : i + 1}</span>
                {label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "20px", minHeight: 0 }}>
          {step === 0 && <Step0 mode={mode} setMode={setModeAndInit} initialBeat={initialBeat} allBeats={allBeats} bulkBeatIds={bulkBeatIds} toggleBulkBeat={toggleBulkBeat} jobs={jobs} />}
          {step === 1 && activeJob && <Step1 jobs={jobs} activeJob={activeJob} setActiveJobId={setActiveJobId} applyScope={applyScope} setApplyScope={setApplyScope} updateJob={updateJob} updateActive={updateActive} removeJob={removeJob} onSelectJob={selectJob} validationFlash={validationFlashStep === 1} />}
          {step === 2 && activeJob && <Step2 jobs={jobs} activeJob={activeJob} setActiveJobId={setActiveJobId} applyScope={applyScope} setApplyScope={setApplyScope} updateJob={updateJob} updateActive={updateActive} template={template} updateTemplate={updateTemplate} presets={presets} onSelectPreset={onSelectPreset} onSavePreset={onSavePreset} onDeletePreset={onDeletePreset} onChooseTemplatesDir={onChooseTemplatesDir} onApplyCurrentPresetToAll={applyCurrentPresetToAll} validationFlash={validationFlashStep === 2} onApplyPresetToBeat={(id, name) => {
            setJobPresetMap(prev => ({ ...prev, [id]: name }));
            const p = presets.find(x => x.name === name);
            // apply template preview immediately and switch to active editing for that beat
            try { if (p) { setTemplate({ name: p.name, title_template: p.title_template, description_template: p.description_template, tags: p.tags }); selectJob(id, p); } else { selectJob(id); } } catch {}
          }} jobPresetMap={jobPresetMap} onRefreshPresets={refreshPresets} onSelectJob={selectJob} />}
          {step === 3 && activeJob && <Step3 jobs={jobs} activeJob={activeJob} setActiveJobId={setActiveJobId} applyScope={applyScope} setApplyScope={setApplyScope} updateJob={updateJob} updateActive={updateActive} onSelectJob={selectJob} reorderJobs={reorderJobs} validationFlash={validationFlashStep === 3} />}
          {step === 4 && (
            <Step4
              jobs={jobs}
              activeJob={activeJob}
              setActiveJobId={setActiveJobId}
              channel={channel}
              connectChannel={connectChannel}
              disconnectChannel={disconnectChannel}
              isConnecting={isConnecting}
              isUploading={isUploading}
              startUpload={startUpload}
              reorderJobs={reorderJobs}
              onSelectJob={selectJob}
              canUpload={canUpload}
              uploadError={uploadError}
              updateJob={updateJob}
              setApplyScope={setApplyScope}
            />
          )}
        </div>

        {/* Footer nav */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderTop: "1px solid #181818", flexShrink: 0, background: "#0a0a0a" }}>
          <button
            onClick={() => setStep(s => Math.max(0, s - 1))}
            disabled={step === 0 || uploadNavigationLocked}
            style={{ padding: "8px 18px", borderRadius: 8, background: "#161616", border: "1px solid #222", color: step === 0 || uploadNavigationLocked ? "#444" : "#bbb", fontSize: 13, cursor: step === 0 || uploadNavigationLocked ? "not-allowed" : "pointer" }}
          >Back</button>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={onClose} style={{ padding: "8px 18px", borderRadius: 8, background: "transparent", border: "1px solid #222", color: "#888", fontSize: 13, cursor: isUploading ? "not-allowed" : "pointer" }} disabled={isUploading}>Cancel</button>
            {step < 4 ? (
              <button
                onClick={acceptCurrentStepAndAdvance}
                disabled={uploadNavigationLocked}
                style={{
                  padding: "8px 22px", borderRadius: 8,
                  background: stepIsValid(step) ? "#fff" : "#1a1a1a",
                  border: "1px solid " + (stepIsValid(step) ? "#fff" : "#2a2a2a"),
                  color: stepIsValid(step) ? "#000" : "#777",
                  fontSize: 13, fontWeight: 500,
                  // Invalid means "do not advance", not "dead button": clicking
                  // still triggers the short red validation hint.
                  cursor: uploadNavigationLocked ? "not-allowed" : "pointer",
                }}
              >Continue</button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================= STEP 0 ================= */
function Step0({
  mode, setMode, initialBeat, allBeats, bulkBeatIds, toggleBulkBeat, jobs,
}: {
  mode: UploadMode;
  setMode: (m: UploadMode) => void;
  initialBeat: Beat | null;
  allBeats: Beat[];
  bulkBeatIds: Set<string>;
  toggleBulkBeat: (b: Beat) => void;
  jobs: BeatUploadJob[];
}) {
  return (
        <div style={{ display: "flex", flexDirection: "column", gap: 18, flex: 1, overflowY: "auto", padding: "12px 20px" }}>
      <div style={{ display: "flex", justifyContent: "center" }}>
        <div style={{ display: "flex", gap: 2, background: "#141414", borderRadius: 10, padding: 4 }}>
          {(["single", "bulk"] as UploadMode[]).map(m => (
            <button key={m}
              onClick={() => setMode(m)}
              style={{
                padding: "8px 32px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 500,
                background: mode === m ? "#fff" : "transparent",
                color: mode === m ? "#000" : "#777",
                border: "none",
                cursor: "pointer",
                textTransform: "capitalize",
              }}>{m}</button>
          ))}
        </div>
      </div>

      {mode === "single" ? (
        <div style={{ border: "1px solid #1c1c1c", borderRadius: 12, padding: 20, background: "#121212" }}>
          <div style={{ fontSize: 12, color: "#777", marginBottom: 12 }}>Selected beat</div>
          {jobs.length > 0 ? (
            <BeatPreviewRow beat={jobs[0].beat} compact />
          ) : (
            <div style={{ fontSize: 13, color: "#555", textAlign: "center", padding: 20 }}>No beats in library. Close this dialog and add some beats first.</div>
          )}
          {!initialBeat && jobs.length > 0 && allBeats.length > 1 && (
            <BeatGridPicker allBeats={allBeats} selectedIds={bulkBeatIds} onToggle={toggleBulkBeat} singleMode />
          )}
        </div>
      ) : (
        <div style={{ border: "1px solid #1c1c1c", borderRadius: 12, padding: 20, background: "#121212" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: "#777" }}>{bulkBeatIds.size} selected</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => {
                  for (const b of allBeats) {
                    if (!bulkBeatIds.has(b.id)) toggleBulkBeat(b);
                  }
                }}
                style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, background: "#181818", border: "1px solid #222", color: "#888", cursor: "pointer" }}
              >Select all</button>
              <button
                onClick={() => { for (const b of Array.from(bulkBeatIds).map(id => allBeats.find(x => x.id === id)).filter(Boolean) as Beat[]) toggleBulkBeat(b); }}
                style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, background: "#181818", border: "1px solid #222", color: "#888", cursor: "pointer" }}
              >Clear</button>
            </div>
          </div>
          <BeatGridPicker allBeats={allBeats} selectedIds={bulkBeatIds} onToggle={toggleBulkBeat} />
        </div>
      )}
    </div>
  );
}

function BeatPreviewRow({ beat, compact }: { beat: Beat; compact?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, padding: compact ? 8 : 12, background: "#0d0d0d", borderRadius: 10, border: "1px solid #1a1a1a" }}>
      <Artwork beat={beat} size={compact ? 48 : 64} playing={false} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: "#ddd", fontWeight: 500 }}>{beat.name}</div>
        <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>
          {beat.bpm || "— bpm"}{beat.bpm && beat.key ? " · " : ""}{beat.key || ""}
        </div>
        {!compact && beat.tags.length > 0 && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 6 }}>
            {beat.tags.slice(0, 6).map(t => <TagPill key={t} label={t} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function BeatGridPicker({ allBeats, selectedIds, onToggle, singleMode }: { allBeats: Beat[]; selectedIds: Set<string>; onToggle: (b: Beat) => void; singleMode?: boolean }) {
  const [q, setQ] = useState("");
  const filtered = allBeats.filter(b => {
    const s = q.trim().toLowerCase();
    return !s || b.name.toLowerCase().includes(s) || b.tags.some(t => t.includes(s));
  });
  return (
    <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <input
        value={q} onChange={e => setQ(e.target.value)}
        placeholder="Search beats…"
        style={{
          background: "#0d0d0d", border: "1px solid #202020", borderRadius: 8,
          padding: "8px 12px", color: "#ddd", fontSize: 12, outline: "none",
        }}
      />
      {filtered.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: "#444", fontSize: 12 }}>No beats</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 8, maxHeight: 340, overflowY: "auto", paddingRight: 4 }}>
          {filtered.map(b => {
            const selected = selectedIds.has(b.id);
            return (
              <div key={b.id}
                onClick={() => onToggle(b)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: 8, borderRadius: 8,
                  cursor: "pointer",
                  background: selected ? "#1a1a1a" : "transparent",
                  border: `1px solid ${selected ? "#3a3a3a" : "#181818"}`,
                }}>
                <div style={{
                  width: 18, height: 18, borderRadius: singleMode ? "50%" : 4,
                  background: selected ? "#fff" : "transparent",
                  border: `1.5px solid ${selected ? "#fff" : "#333"}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0,
                }}>
                  {selected && <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: '#000' }} />}
                </div>
                <Artwork beat={b} size={36} playing={false} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "#ccc", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b.name}</div>
                  <div style={{ fontSize: 10, color: "#444" }}>{b.bpm || "—"} · {b.key || "—"}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ================= STEP 1 ================= */
function Step1({
  jobs, activeJob, setActiveJobId, applyScope, setApplyScope, updateJob, updateActive, removeJob,
  onSelectJob, validationFlash,
}: {
  jobs: BeatUploadJob[];
  activeJob: BeatUploadJob;
  setActiveJobId: (id: string) => void;
  applyScope: "all" | "active";
  setApplyScope: (s: "all" | "active") => void;
  updateJob: (id: string, patch: Partial<BeatUploadJob>) => void;
  updateActive: (patch: Partial<BeatUploadJob>) => void;
  removeJob: (id: string) => void;
  onSelectJob: (id: string) => void;
  validationFlash: boolean;
}) {
  const vt: VisualType = activeJob.visual_type;
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [imageDragOver, setImageDragOver] = useState(false);

  const onPickImage = async () => {
    const path = await pickImageFile(activeJob.beat.folder_path);
    if (!path) return;
    let b64: string | null = activeJob.image_base64;
    try {
      const resp = await fetch(filePathToUrl(path));
      const blob = await resp.blob();
      b64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch {}
    updateActive({ visual_type: "image", image_path: path, image_base64: b64 });
  };

  const onPickVideo = async () => {
    const path = await pickVideoFile(activeJob.beat.folder_path);
    if (!path) return;
    updateActive({ visual_type: "video", video_path: path });
  };

  const useEmbedded = () => {
    if (applyScope === "all") {
      for (const j of jobs) {
        updateJob(j.beat.id, {
          visual_type: "image",
          image_base64: j.beat.image_base64,
          image_path: null,
        });
      }
    } else {
      updateActive({
        visual_type: "image",
        image_base64: activeJob.beat.image_base64,
        image_path: null,
      });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {validationFlash && (
        <div style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #7f1d1d", background: "#241010", color: "#fca5a5", fontSize: 11 }}>
          Choose a valid image or video before continuing.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ border: "1px solid #1c1c1c", borderRadius: 12, padding: 12, background: "#121212", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h3 style={{ fontSize: 14, fontWeight: 500, color: "#ddd", margin: 0 }}>Audio</h3>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 420, overflowY: "auto", paddingTop: 8 }}>
            {jobs.map(j => (
              <div key={j.beat.id} onMouseEnter={() => setHoveredId(j.beat.id)} onMouseLeave={() => setHoveredId(null)} style={{ position: "relative", display: "flex", gap: 10, alignItems: "center", padding: 8, borderRadius: 8, background: j.beat.id === activeJob.beat.id ? "#1a1a1a" : "transparent", border: `1px solid ${j.beat.id === activeJob.beat.id ? "#333" : "#181818"}` }}>
                <div style={{ position: "absolute", right: 8, top: 8, opacity: hoveredId === j.beat.id ? 1 : 0, transition: "opacity 120ms" }}>
                  <button onClick={() => removeJob(j.beat.id)} style={{ background: "transparent", border: "none", color: "#f87171", cursor: "pointer" }}></button>
                </div>
                <div onClick={() => { onSelectJob(j.beat.id); }} style={{ display: "flex", gap: 12, alignItems: "center", width: "100%", cursor: "pointer" }}>
                  <Artwork beat={j.beat} size={64} playing={false} />
                  <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
                    <div style={{ fontSize: 13, color: j.beat.id === activeJob.beat.id ? "#fff" : "#ccc", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{j.beat.name}</div>
                    <div style={{ fontSize: 11, color: "#666" }}>{j.beat.bpm || "—"} · {j.beat.key || "—"}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ border: "1px solid #1c1c1c", borderRadius: 12, padding: 18, background: "#121212", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h3 style={{ fontSize: 14, fontWeight: 500, color: "#ddd", margin: 0 }}>Visualizer</h3>
            <div style={{ display: "flex", gap: 2, background: "#161616", borderRadius: 8, padding: 2 }}>
              {(["image", "video"] as VisualType[]).map(v => (
                <button key={v}
                  onClick={() => updateActive({ visual_type: v })}
                  style={{
                    padding: "5px 14px", borderRadius: 6, border: "none", cursor: "pointer",
                    fontSize: 11, fontWeight: 500, textTransform: "capitalize",
                    background: vt === v ? "#fff" : "transparent",
                    color: vt === v ? "#000" : "#777",
                  }}>{v}</button>
              ))}
            </div>
          </div>

          {vt === "image" ? (
            <>
              <div
                data-beatgaler-drop-owner="local"
                onDragOver={(e) => { e.preventDefault(); setImageDragOver(true); }}
                onDragLeave={() => setImageDragOver(false)}
                onDrop={e => {
                  if (!e.dataTransfer.types.includes("Files")) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setImageDragOver(false);
                  const file = Array.from(e.dataTransfer.files).find(f => f.type.startsWith("image/"));
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    if (typeof reader.result === "string") updateActive({ visual_type: "image", image_base64: reader.result, image_path: null });
                  };
                  reader.readAsDataURL(file);
                }}
                style={{ aspectRatio: "1 / 1", maxWidth: 280, margin: "0 auto", width: "100%", borderRadius: 10, overflow: "hidden", border: "1px solid #1f1f1f", background: "#0a0a0a", position: "relative" }}>
                {activeJob.image_base64 ? (
                  <img src={activeJob.image_base64} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt="" />
                ) : activeJob.image_path ? (
                  <img src={filePathToUrl(activeJob.image_path)} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt="" />
                ) : (
                  <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#333", fontSize: 12 }}>No image</div>
                )}
                {imageDragOver && (
                  <div style={{ position: "absolute", inset: 0, borderRadius: 10, background: "rgba(250,204,21,0.12)", border: "2px dashed rgba(250,204,21,0.25)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 600, color: "#ffd66b" }}>
                    Drop to set cover
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
                <button onClick={useEmbedded} style={{ padding: "7px 12px", background: "#1a1a1a", border: "1px solid #262626", borderRadius: 7, color: "#aaa", fontSize: 11, cursor: "pointer" }}>Use embedded artwork</button>
                <button onClick={onPickImage} style={{ padding: "7px 12px", background: "#fff", border: "1px solid #fff", borderRadius: 7, color: "#000", fontSize: 11, cursor: "pointer", fontWeight: 500 }}>Upload image</button>
              </div>
              {!activeJob.image_base64 && !activeJob.image_path && (
                <div style={{ fontSize: 11, color: "#b45309", textAlign: "center" }}> No image. The MP3 has no embedded artwork — upload one above.</div>
              )}
            </>
          ) : (
            <>
              <div style={{ aspectRatio: "16 / 9", maxWidth: 320, margin: "0 auto", width: "100%", borderRadius: 10, overflow: "hidden", border: "1px solid #1f1f1f", background: "#0a0a0a", display: "flex", alignItems: "center", justifyContent: "center" }}>
                {activeJob.video_path ? (
                  <video src={filePathToUrl(activeJob.video_path)} controls style={{ width: "100%", height: "100%", background: "#000" }} />
                ) : (
                  <div style={{ color: "#333", fontSize: 12 }}>No video selected</div>
                )}
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "center", fontSize: 11, color: "#888" }}>
                <input type="checkbox" checked={activeJob.video_loop} onChange={e => updateActive({ video_loop: e.target.checked })} />
                Loop short videos
              </label>
              <div style={{ display: "flex", justifyContent: "center" }}>
                <button onClick={onPickVideo} style={{ padding: "7px 14px", background: "#fff", border: "1px solid #fff", borderRadius: 7, color: "#000", fontSize: 11, cursor: "pointer", fontWeight: 500 }}>Upload video</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ================= STEP 2 ================= */
function Step2({
  jobs, activeJob, setActiveJobId, applyScope, setApplyScope, updateJob, updateActive,
  template, updateTemplate, presets, onSelectPreset, onSavePreset, onDeletePreset, onChooseTemplatesDir,
  onApplyCurrentPresetToAll, onApplyPresetToBeat, jobPresetMap, onRefreshPresets,
  onSelectJob, validationFlash,
}: {
  jobs: BeatUploadJob[];
  activeJob: BeatUploadJob;
  setActiveJobId: (id: string) => void;
  applyScope: "all" | "active";
  setApplyScope: (s: "all" | "active") => void;
  updateJob: (id: string, patch: Partial<BeatUploadJob>) => void;
  updateActive: (patch: Partial<BeatUploadJob>) => void;
  template: UploadTemplate;
  updateTemplate: (p: Partial<UploadTemplate>) => void;
  presets: StoredPreset[];
  onSelectPreset: (name: string) => void;
  onSavePreset: () => void;
  onDeletePreset: (name: string) => void;
  onChooseTemplatesDir: () => void;
  onApplyCurrentPresetToAll: () => void;
  onApplyPresetToBeat: (id: string, name: string) => void;
  // jobPresetBaseline removed: determined by comparing job values against stored presets
  jobPresetMap: Record<string, string>;
  onRefreshPresets: () => Promise<void>;
  onSelectJob: (id: string) => void;
  validationFlash: boolean;
}) {
  const tagsStr = template.tags.join(",");
  const isSavedPreset = presets.some(p => p.name === template.name.trim() && template.name.trim() !== "");
  const [showPresetsMenu, setShowPresetsMenu] = useState(false);
  const presetsMenuRef = useRef<HTMLDivElement | null>(null);

  const activeSavedPreset = presets.find(p => p.name === template.name.trim());
  const isGlobalPresetModified = activeSavedPreset ? (
    JSON.stringify({ t: activeSavedPreset.title_template, d: activeSavedPreset.description_template, tags: activeSavedPreset.tags }) !==
    JSON.stringify({ t: template.title_template, d: template.description_template, tags: template.tags })
  ) : false;
  // The "Editing ... only" label always shows the beat's own name — never
  // template/preset text — regardless of applyScope, so it can't get out
  // of sync if applyScope isn't perfectly tracked.
  const displayName = activeJob ? activeJob.beat.name : "";
  
  // Close presets menu when clicking outside
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!showPresetsMenu) return;
      const node = presetsMenuRef.current;
      if (node && !node.contains(e.target as Node)) setShowPresetsMenu(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [showPresetsMenu]);

  // Refresh presets when opening menu
  useEffect(() => {
    if (showPresetsMenu) onRefreshPresets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPresetsMenu]);

  const missingPresetCount = jobs.filter(j => {
    const presetName = jobPresetMap[j.beat.id];
    return !presetName || !presets.some(p => p.name === presetName);
  }).length;
  const missingMetadataCount = jobs.filter(j => !j.title.trim() || !j.description.trim()).length;

  const presetBlock = (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#121212", border: "1px solid #1c1c1c", borderRadius: 10, padding: "10px 14px", flexWrap: "wrap", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "#888" }}>Preset:</span>
        <div style={{ position: "relative" }} ref={presetsMenuRef}>
          <button onClick={() => setShowPresetsMenu(s => !s)} style={{
            background: "#0d0d0d",
            border: `1px solid ${validationFlash && !isSavedPreset ? "#ef4444" : "#222"}`,
            boxShadow: validationFlash && !isSavedPreset ? "0 0 0 1px rgba(239,68,68,0.22)" : "none",
            borderRadius: 6, padding: "6px 10px", color: "#ddd", fontSize: 12,
            cursor: "pointer", fontStyle: isGlobalPresetModified ? "italic" : "normal",
            transition: "border-color 160ms ease, box-shadow 160ms ease",
          }}>
            {isSavedPreset ? template.name.trim() + (isGlobalPresetModified ? " *" : "") : (presets.length === 0 ? "No saved presets yet" : "Presets")}
          </button>
          {showPresetsMenu && (
            <div style={{ position: "absolute", top: "110%", left: 0, background: "#0b0b0b", border: "1px solid #222", borderRadius: 6, padding: 8, minWidth: 180, zIndex: 60 }}>
              {presets.length === 0 ? <div style={{ color: "#666", fontSize: 12 }}>No saved presets</div> : presets.map(p => (
                <div key={p.name} onClick={() => { onSelectPreset(p.name); setShowPresetsMenu(false); }} style={{ padding: "6px 8px", cursor: "pointer", color: "#ddd", borderRadius: 4 }}>
                  {p.name}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {jobs.length > 1 && (
          <button
            onClick={onApplyCurrentPresetToAll}
            disabled={!isSavedPreset}
            title={isSavedPreset ? "Apply this preset to every selected beat" : "Select a saved preset first"}
            style={{
              padding: "6px 12px",
              fontSize: 11,
              background: isSavedPreset ? "#1b1b1b" : "#141414",
              border: `1px solid ${isSavedPreset ? "#303030" : "#202020"}`,
              borderRadius: 6,
              color: isSavedPreset ? "#d0d0d0" : "#555",
              cursor: isSavedPreset ? "pointer" : "not-allowed",
              fontWeight: 500,
            }}
          >
            Apply to all
          </button>
        )}
        <button onClick={onChooseTemplatesDir} style={{ padding: "6px 10px", fontSize: 11, background: "#161616", border: "1px solid #222", borderRadius: 6, color: "#ccc", cursor: "pointer" }}>Template directory</button>
        <button onClick={onSavePreset} style={{ padding: "6px 12px", fontSize: 11, background: "#222", border: "1px solid #2e2e2e", borderRadius: 6, color: "#ddd", cursor: "pointer" }}>Save</button>
        {isSavedPreset && (
          <button
            onClick={async () => {
              const name = template.name.trim();
              const approved = await appConfirm({
                title: "Delete preset?",
                message: `Are you sure you want to delete the preset "${name}"?`,
                confirmLabel: "Delete preset",
                cancelLabel: "Cancel",
                danger: true,
              });
              if (approved) await onDeletePreset(name);
            }}
            style={{ padding: "6px 12px", fontSize: 11, background: "#2a1414", border: "1px solid #4a1f1f", borderRadius: 6, color: "#f87171", cursor: "pointer" }}
          >Eliminar</button>
        )}
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {validationFlash && (missingPresetCount > 0 || missingMetadataCount > 0) && (
        <div style={{ padding: "9px 12px", borderRadius: 8, border: "1px solid #7f1d1d", background: "#241010", color: "#fca5a5", fontSize: 11 }}>
          {missingPresetCount > 0
            ? `Choose a saved preset for every beat before continuing. Missing on ${missingPresetCount} beat${missingPresetCount !== 1 ? "s" : ""}.`
            : `Every beat needs a title and description before continuing. Missing on ${missingMetadataCount} beat${missingMetadataCount !== 1 ? "s" : ""}.`}
        </div>
      )}

      {/* preset control block - shown at top in single mode, below assign block in bulk mode */}
      {jobs.length <= 1 && presetBlock}
      {jobs.length > 1 && (
        <div style={{ border: "1px solid #1c1c1c", borderRadius: 10, padding: "12px 14px", background: "#121212", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, color: "#777" }}>Assign a different preset per beat</div>
          {presets.length === 0 ? (
            <div style={{ fontSize: 11, color: "#3a3a3a" }}>Save a preset above first, then assign it to individual beats here.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 160, overflowY: "auto" }}>
              {jobs.map(j => (
                <div key={j.beat.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <button onClick={() => { onSelectJob(j.beat.id); }} style={{ background: j.beat.id === activeJob.beat.id ? "#1a1a1a" : "#0d0d0d", border: `1px solid ${j.beat.id === activeJob.beat.id ? "#333" : "#1c1c1c"}`, padding: "6px 10px", borderRadius: 8, textAlign: "left", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: j.beat.id === activeJob.beat.id ? "#fff" : "#ccc", fontSize: 12, display: "inline-block" }}>{j.beat.name}</button>
                  {(() => {
                    const assignedName = jobPresetMap[j.beat.id];
                    const p = assignedName ? presets.find(x => x.name === assignedName) : null;
                    let isBeatModified = false;
                    if (p) {
                      // Compare what the preset would produce for this beat vs the current job values
                      const applied = applyTemplate(p, { title: j.beat.name, bpm: j.beat.bpm || "", key: j.beat.key || "", collaborator: j.collaborator });
                      const titlesEqual = applied.title === j.title;
                      const descEqual = applied.description === j.description;
                      const tagsEqual = JSON.stringify((p.tags || []).slice().sort()) === JSON.stringify((j.tags || []).slice().sort());
                      isBeatModified = !(titlesEqual && descEqual && tagsEqual);
                    }
					return (
                      <div style={{ position: "relative", flexShrink: 0 }}>
                        <select
                          value={isBeatModified ? "__modified__" : (assignedName ?? "")}
                          onChange={e => {
                            const presetName = e.target.value;
                            if (presetName === "__modified__") return; // not a real preset, ignore
                            const preset = presets.find(p => p.name === presetName);
                            if (!preset) return;
                            const { title, description } = applyTemplate(preset, {
                              title: j.beat.name, bpm: j.beat.bpm || "", key: j.beat.key || "", collaborator: j.collaborator,
                            });
                            updateJob(j.beat.id, { title, description, tags: Array.from(new Set([...preset.tags])) });
                            try { onApplyPresetToBeat(j.beat.id, presetName); } catch {}
                          }}
                          style={{
                            background: "#0d0d0d",
                            border: `1px solid ${validationFlash && !assignedName ? "#ef4444" : "#222"}`,
                            boxShadow: validationFlash && !assignedName ? "0 0 0 1px rgba(239,68,68,0.22)" : "none",
                            borderRadius: 6, fontSize: 11, padding: "4px 6px",
                            color: isBeatModified ? "transparent" : "#aaa",
                            transition: "border-color 160ms ease, box-shadow 160ms ease",
                          }}
                        >
                          {/* hidden placeholders — just keep the value domain valid, never shown in the open list */}
                          <option value="" style={{ display: "none" }}></option>
                          <option value="__modified__" style={{ display: "none" }}></option>
                          {presets.map(p => (
                            <option key={p.name} value={p.name} style={{ color: "#ddd", background: "#0d0d0d" }}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                        {isBeatModified && assignedName && (
                          <span style={{
                            position: "absolute", left: 7, top: "50%", transform: "translateY(-50%)",
                            fontSize: 11, fontStyle: "italic", color: "#ccc",
                            pointerEvents: "none", whiteSpace: "nowrap",
                          }}>
                            {assignedName} *
                          </span>
                        )}
                      </div>
                    );
                  })()}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {jobs.length > 1 && presetBlock}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Left: what you're editing */}
        <div style={{ border: "1px solid #1c1c1c", borderRadius: 12, padding: 16, background: "#121212", display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: "#aaa", fontWeight: 500 }}>
              Editing "{displayName}" only
            </div>
            <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>
              Changes apply instantly — the preview on the right always matches what you type here.
              Use {"{{title}}"}, {"{{bpm}}"}, {"{{key}}"}, {"{{collaborator}}"} to fill in each beat's own info.
            </div>
          </div>

          <Field label="Title">
            <textarea
              rows={2}
              value={template.title_template}
              onChange={e => updateTemplate({ title_template: e.target.value })}
              style={{
                ...taStyle,
                borderColor: validationFlash && !activeJob.title.trim() ? "#ef4444" : "#202020",
                boxShadow: validationFlash && !activeJob.title.trim() ? "0 0 0 1px rgba(239,68,68,0.25)" : "none",
                transition: "border-color 160ms ease, box-shadow 160ms ease",
              }}
            />
          </Field>

          <Field label="Description">
            <textarea
              rows={10}
              value={template.description_template}
              onChange={e => updateTemplate({ description_template: e.target.value })}
              style={{
                ...taStyle,
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 11,
                borderColor: validationFlash && !activeJob.description.trim() ? "#ef4444" : "#202020",
                boxShadow: validationFlash && !activeJob.description.trim() ? "0 0 0 1px rgba(239,68,68,0.25)" : "none",
                transition: "border-color 160ms ease, box-shadow 160ms ease",
              }}
            />
          </Field>

          <Field label="Collaborator (fills {{collaborator}} above)">
            <input
              value={activeJob.collaborator}
              onChange={e => {
                const val = e.target.value;
                const patch: Partial<BeatUploadJob> = { collaborator: val };
                if (applyScope === "all") {
                  for (const j of jobs) {
                    const { description } = applyTemplate(template, {
                      title: j.beat.name, bpm: j.beat.bpm || "", key: j.beat.key || "", collaborator: val,
                    });
                    updateJob(j.beat.id, { collaborator: val, description });
                  }
                } else {
                  const { description } = applyTemplate(template, {
                    title: activeJob.beat.name, bpm: activeJob.beat.bpm || "", key: activeJob.beat.key || "", collaborator: val,
                  });
                  patch.description = description;
                  updateActive(patch);
                }
              }}
              style={{ ...taStyle, fontFamily: "'DM Sans', sans-serif", height: "auto", padding: "7px 10px", fontSize: 12 }}
              placeholder="e.g. @prodbyxyz"
            />
          </Field>

          <Field label="Tags">
            <TagEditor
              tags={template.tags}
              onChange={ts => updateTemplate({ tags: ts })}
              suggestions={[]}
            />
          </Field>
        </div>

        {/* Right: exactly what will be uploaded for the beat currently selected above */}
        <div style={{ border: "1px solid #1c1c1c", borderRadius: 12, padding: 16, background: "#121212", display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: "#aaa", fontWeight: 500 }}>Preview · {activeJob.beat.name}</div>
            <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>What actually gets uploaded to YouTube for this beat.</div>
          </div>

          <Field label="Title">
            <div style={{ fontSize: 18, fontWeight: 700, color: "#fff", lineHeight: 1.2, padding: "8px 0", wordBreak: "break-word" }}>{activeJob.title || <span style={{ color: "#3a3a3a" }}>—</span>}</div>
          </Field>

          <Field label="Description">
            <div style={{ fontSize: 14, color: "#cbd5e1", whiteSpace: "pre-wrap", paddingTop: 6, wordBreak: "break-word" }}>{activeJob.description || <span style={{ color: "#3a3a3a" }}>—</span>}</div>
          </Field>

          <Field label="Tags">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, paddingTop: 4 }}>
              {activeJob.tags.length === 0
                ? <span style={{ fontSize: 12, color: "#3a3a3a" }}>—</span>
                : activeJob.tags.map(t => (
                  <span key={t} style={{ fontSize: 10, color: "#999", background: "#1a1a1a", border: "1px solid #262626", borderRadius: 999, padding: "2px 8px" }}>{t}</span>
                ))}
            </div>
          </Field>
        </div>
      </div>
    </div>
  );
}

const taStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box",
  background: "#0d0d0d", border: "1px solid #202020",
  borderRadius: 8, padding: "9px 11px", color: "#ddd",
  fontSize: 12, outline: "none", resize: "vertical",
  lineHeight: 1.5,
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ fontSize: 11, color: "#666" }}>{label}</div>
      {children}
    </div>
  );
}

/* ================= STEP 3 ================= */
function Step3({
  jobs, activeJob, setActiveJobId, applyScope, setApplyScope, updateJob, updateActive,
  onSelectJob, reorderJobs, validationFlash,
}: {
  jobs: BeatUploadJob[];
  activeJob: BeatUploadJob;
  setActiveJobId: (id: string) => void;
  applyScope: "all" | "active";
  setApplyScope: (s: "all" | "active") => void;
  updateJob: (id: string, patch: Partial<BeatUploadJob>) => void;
  updateActive: (patch: Partial<BeatUploadJob>) => void;
  onSelectJob: (id: string) => void;
  reorderJobs: (fromIndex: number, toIndex: number) => void;
  validationFlash: boolean;
}) {
  const vis: Visibility = activeJob.visibility;

  const setVisibility = (v: Visibility) => updateActive({ visibility: v });

  // Bulk auto-scheduler: reuses whatever date/time is already set on the
  // calendar above (for the active beat) as the starting point — no second
  // date picker — and just spreads the rest of the queue out every N days.
  const [bulkIntervalDays, setBulkIntervalDays] = useState(1);
  const dragFrom = useRef<number | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const didPointerDrag = useRef(false);

  // FLIP animation: whenever the row order changes, measure where each row
  // just moved FROM, then animate it sliding into its new spot instead of
  // just snapping there — this is what makes the reorder feel alive.
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevRectsRef = useRef<Map<string, DOMRect>>(new Map());

  useLayoutEffect(() => {
    const prevRects = prevRectsRef.current;
    jobs.forEach(j => {
      const el = rowRefs.current.get(j.beat.id);
      if (!el) return;
      const prev = prevRects.get(j.beat.id);
      if (!prev) return;
      const next = el.getBoundingClientRect();
      const deltaY = prev.top - next.top;
      if (deltaY !== 0) {
        el.style.transition = "none";
        el.style.transform = `translateY(${deltaY}px)`;
        requestAnimationFrame(() => {
          el.style.transition = "transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)";
          el.style.transform = "";
        });
      }
    });
    requestAnimationFrame(() => {
      const map = new Map<string, DOMRect>();
      jobs.forEach(j => {
        const el = rowRefs.current.get(j.beat.id);
        if (el) map.set(j.beat.id, el.getBoundingClientRect());
      });
      prevRectsRef.current = map;
    });
  }, [jobs]);

  const applyBulkSchedule = () => {
    if (!activeJob.scheduled_at) return; // guarded by disabling the button below
    const start = new Date(activeJob.scheduled_at);
    jobs.forEach((j, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i * bulkIntervalDays);
      updateJob(j.beat.id, { scheduled_at: d.toISOString() });
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* On Step2 we removed the top scope/job picker; selection is via clicking beat names in the list below. */}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ border: "1px solid #1c1c1c", borderRadius: 12, padding: 18, background: "#121212", display: "flex", flexDirection: "column", gap: 12 }}>
            <h3 style={{ fontSize: 14, fontWeight: 500, color: "#ddd", margin: 0 }}>Visibility</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {([
              ["public", "Public", "Visible to everyone"],
              ["unlisted", "Unlisted", "Anyone with the link can view"],
              ["private", "Private", "Only you can view"],
            ] as [Visibility, string, string][]).map(([v, name, desc]) => (
              <div key={v}
                onClick={() => setVisibility(v)}
                style={{
                  padding: "10px 12px", borderRadius: 9, cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  background: vis === v ? "#1a1a1a" : "#0d0d0d",
                  border: `1px solid ${vis === v ? "#3a3a3a" : "#1a1a1a"}`,
                }}>
                <div>
                  <div style={{ fontSize: 12, color: vis === v ? "#fff" : "#aaa", fontWeight: 500, textTransform: "capitalize" }}>{name}</div>
                  <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>{desc}</div>
                </div>
                <div style={{
                  width: 16, height: 16, borderRadius: "50%",
                  background: vis === v ? "#fff" : "transparent",
                  border: `1.5px solid ${vis === v ? "#fff" : "#333"}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>{vis === v && <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 5, background: '#000' }} />}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{
          border: `1px solid ${validationFlash && jobs.some(j => !j.scheduled_at) ? "#7f1d1d" : "#1c1c1c"}`,
          boxShadow: validationFlash && jobs.some(j => !j.scheduled_at) ? "0 0 0 1px rgba(239,68,68,0.18)" : "none",
          borderRadius: 12, padding: 18, background: "#121212", display: "flex", flexDirection: "column", gap: 12,
          transition: "border-color 160ms ease, box-shadow 160ms ease",
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h3 style={{ fontSize: 14, fontWeight: 500, color: "#ddd", margin: 0 }}>Schedule</h3>
            <div>
              <button onClick={() => {
                const patch: Partial<BeatUploadJob> = { scheduled_at: null };
                if (applyScope === "all") for (const j of jobs) updateJob(j.beat.id, patch);
                else updateActive(patch);
              }} style={{ padding: "6px 10px", fontSize: 11, borderRadius: 7, background: "#1a1a1a", border: "1px solid #262626", color: "#888", cursor: "pointer" }}>Clear{applyScope === "all" ? " all" : ""}</button>
            </div>
          </div>

          <Field label="Schedule (date & time)">
            <UploadScheduler
              value={activeJob.scheduled_at ? new Date(activeJob.scheduled_at) : null}
              minDate={new Date()}
              onChange={d => {
                const iso = d ? d.toISOString() : null;
                // Always update only the active beat here
                if (activeJob) updateJob(activeJob.beat.id, { scheduled_at: iso });
              }}
            />
          </Field>
          <div style={{ fontSize: 11, color: activeJob.scheduled_at ? "#22c55e" : "#555", minHeight: 16 }}>
            {activeJob.scheduled_at
              ? `Scheduled: ${new Date(activeJob.scheduled_at).toLocaleString()}`
              : validationFlash ? "Schedule required before continuing" : "Not scheduled yet"}
          </div>

          {jobs.length > 1 && (
            <div style={{ marginTop: 8, borderTop: "1px solid #1a1a1a", paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 11, color: "#777" }}>Auto-schedule the whole queue</div>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <label style={{ fontSize: 10, color: "#666" }}>Every (days)</label>
                  <input type="number" min={1} value={bulkIntervalDays}
                    onChange={e => setBulkIntervalDays(Math.max(1, parseInt(e.target.value) || 1))}
                    style={{ width: 70, padding: "7px 9px", background: "#1a1a1a", border: "1px solid #262626", borderRadius: 7, color: "#ddd", fontSize: 12 }} />
                </div>
                <button onClick={applyBulkSchedule} disabled={!activeJob.scheduled_at}
                  style={{
                    padding: "8px 14px", border: "none", borderRadius: 7, fontSize: 12, fontWeight: 500,
                    background: activeJob.scheduled_at ? "#fff" : "#1e1e1e",
                    color: activeJob.scheduled_at ? "#000" : "#555",
                    cursor: activeJob.scheduled_at ? "pointer" : "not-allowed",
                  }}>
                  Apply to {jobs.length} beats
                </button>
              </div>
              <div style={{ fontSize: 10, color: "#555" }}>
                {activeJob.scheduled_at
                  ? <>Beat 1 uploads {new Date(activeJob.scheduled_at).toLocaleString()}, beat 2 {bulkIntervalDays} day{bulkIntervalDays !== 1 ? "s" : ""} later, and so on.</>
                  : "Set a date on the calendar above first — that becomes beat 1's upload time."}
              </div>
            </div>
          )}

			{jobs.length > 1 && (
            <div style={{ marginTop: 8, borderTop: "1px solid #1a1a1a", paddingTop: 12 }}>
              <div style={{ fontSize: 11, color: "#777", marginBottom: 8 }}>Schedule per beat</div>
              <div style={{ maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, paddingRight: 4 }}>
               {jobs.map((j, idx) => (
                  <div
                    key={j.beat.id}
                    ref={el => {
                      if (el) rowRefs.current.set(j.beat.id, el);
                      else rowRefs.current.delete(j.beat.id);
                    }}
                    data-schedule-index={idx}
                    onPointerDown={e => {
                      if (e.button !== 0) return;
                      dragFrom.current = idx;
                      didPointerDrag.current = false;
                      setDraggingId(j.beat.id);
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }}
                    onPointerMove={e => {
                      if (dragFrom.current == null || draggingId == null) return;
                      const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
                      const row = target?.closest?.("[data-schedule-index]") as HTMLElement | null;
                      if (!row) return;
                      const overIndex = Number(row.dataset.scheduleIndex);
                      if (!Number.isInteger(overIndex)) return;
                      const from = dragFrom.current;
                      if (from !== overIndex) {
                        didPointerDrag.current = true;
                        reorderJobs(from, overIndex);
                        dragFrom.current = overIndex;
                      }
                    }}
                    onPointerUp={e => {
                      dragFrom.current = null;
                      setDraggingId(null);
                      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                        e.currentTarget.releasePointerCapture(e.pointerId);
                      }
                    }}
                    onPointerCancel={e => {
                      dragFrom.current = null;
                      setDraggingId(null);
                      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                        e.currentTarget.releasePointerCapture(e.pointerId);
                      }
                    }}
                    onClick={() => {
                      if (didPointerDrag.current) {
                        didPointerDrag.current = false;
                        return;
                      }
                      onSelectJob(j.beat.id);
                    }}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
                      borderRadius: 6, background: j.beat.id === activeJob.beat.id ? "#1a1a1a" : "#0d0d0d",
                      border: `1px solid ${
                        validationFlash && !j.scheduled_at
                          ? "#7f1d1d"
                          : j.beat.id === activeJob.beat.id ? "#333" : "#181818"
                      }`,
                      cursor: draggingId === j.beat.id ? "grabbing" : "grab",
                      touchAction: "none",
                      userSelect: "none",
                      opacity: draggingId === j.beat.id ? 0.48 : 1,
                      transition: "opacity 120ms ease, background 120ms ease, border-color 120ms ease",
                    }}>
                    <span style={{ color: "#3a3a3a", fontSize: 12, flexShrink: 0, letterSpacing: -2 }}>⋮⋮</span>
                    {/* pointerEvents: none forces the drag to always originate
                        from this row's div, never from the <img> inside
                        Artwork — browsers natively make images draggable,
                        which otherwise hijacks the drag instead of the row. */}
                    <div style={{ pointerEvents: "none" }}>
                      <Artwork beat={j.beat} size={28} playing={false} />
                    </div>
                    <div style={{ fontSize: 12, color: "#ccc", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.beat.name}</div>
                    <div style={{ fontSize: 10, color: j.scheduled_at ? "#22c55e" : "#555", flexShrink: 0 }}>
                      {j.scheduled_at ? new Date(j.scheduled_at).toLocaleDateString() + " " + new Date(j.scheduled_at).toTimeString().slice(0, 5) : "now"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ================= STEP 4 ================= */
function Step4({
  jobs, activeJob, setActiveJobId, channel, connectChannel, disconnectChannel, isConnecting, isUploading, startUpload, canUpload, uploadError,
  updateJob, reorderJobs, setApplyScope,
  onSelectJob,
}: {
  jobs: BeatUploadJob[];
  activeJob: BeatUploadJob | null;
  setActiveJobId: (id: string) => void;
  channel: YouTubeChannel;
  connectChannel: () => Promise<YouTubeChannel | null>;
  disconnectChannel: () => Promise<void>;
  isConnecting: boolean;
  isUploading: boolean;
  startUpload: () => void;
  canUpload: boolean;
  uploadError: string | null;
  updateJob: (id: string, patch: Partial<BeatUploadJob>) => void;
  reorderJobs: (fromIndex: number, toIndex: number) => void;
  setApplyScope: (s: "all" | "active") => void;
  onSelectJob: (id: string) => void;
}) {
  const allDone = jobs.length > 0 && jobs.every(j => j.upload_status === "done");
  const anyActive = jobs.some(j => j.upload_status === "generating" || j.upload_status === "uploading");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ border: "1px solid #1c1c1c", borderRadius: 12, padding: 18, background: "#121212", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 44, height: 44, borderRadius: "50%", background: "#1a1a1a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, border: "1px solid #222" }}>
            {channel.connected ? "" : ""}
          </div>
          <div>
            <div style={{ fontSize: 13, color: "#ddd", fontWeight: 500 }}>
              {channel.connected ? channel.name || "YouTube channel" : "Connect YouTube channel"}
            </div>
            <div style={{ fontSize: 11, color: channel.connected ? "#22c55e" : "#777" }}>
              {channel.connected ? "Connected" : "Not connected — click the button to sign in with Google"}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            disabled={channel.connected || isConnecting}
            onClick={connectChannel}
            style={{
              padding: "9px 18px", borderRadius: 9, fontSize: 12, fontWeight: 500, cursor: channel.connected || isConnecting ? "not-allowed" : "pointer",
              background: channel.connected ? "#161616" : "#fff",
              color: channel.connected ? "#666" : "#000",
              border: "1px solid " + (channel.connected ? "#222" : "#fff"),
            }}
          >{isConnecting ? "Connecting…" : channel.connected ? "Connected" : "Connect YouTube"}</button>
          {channel.connected ? (
            <button
              disabled={isConnecting}
              onClick={async () => {
                await disconnectChannel();
              }}
              style={{
                padding: "9px 12px",
                borderRadius: 9,
                fontSize: 12,
                fontWeight: 500,
                cursor: isConnecting ? "not-allowed" : "pointer",
                background: "#111",
                color: "#fff",
                border: "1px solid #222",
              }}
            >Disconnect</button>
          ) : null}
        </div>
      </div>

      {uploadError && (
        <div style={{ padding: "10px 12px", borderRadius: 8, background: "#311313", border: "1px solid #5f1f1f", color: "#fca5a5", fontSize: 12 }}>
          {uploadError}
        </div>
      )}

      <div style={{ border: "1px solid #1c1c1c", borderRadius: 12, padding: 18, background: "#121212", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 style={{ fontSize: 14, fontWeight: 500, color: "#ddd", margin: 0 }}>Upload queue ({jobs.length})</h3>
          <button
            disabled={!canUpload}
            onClick={startUpload}
            style={{
              padding: "10px 24px", borderRadius: 9, fontSize: 13, fontWeight: 600,
              cursor: canUpload ? "pointer" : "not-allowed",
              background: canUpload ? "#fff" : "#1a1a1a",
              color: canUpload ? "#000" : "#444",
              border: "1px solid " + (canUpload ? "#fff" : "#222"),
            }}>
            {isUploading ? "Uploading…" : allDone ? "Re-upload all" : "Generate & Upload"}</button>
        </div>

        {allDone && (
          <div style={{ padding: "10px 12px", borderRadius: 8, background: "#0a1f0a", border: "1px solid #163a16", color: "#4ade80", fontSize: 12 }}>
            All {jobs.length} beat{jobs.length !== 1 ? "s" : ""} processed successfully.
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 380, overflowY: "auto", paddingRight: 4 }}>
          {jobs.map((j, idx) => {
            const isActive = activeJob?.beat.id === j.beat.id;
            const statusColor =
              j.upload_status === "done" ? "#22c55e" :
              j.upload_status === "error" ? "#ef4444" :
              j.upload_status === "generating" || j.upload_status === "uploading" ? "#f59e0b" : "#555";
            const statusLabel =
              j.upload_status === "done" ? "Done" :
              j.upload_status === "error" ? `Error: ${j.error_message || "failed"}` :
              j.upload_status === "generating" ? "Generating video…" :
              j.upload_status === "uploading" ? "Uploading to YouTube…" : "Pending";
            return (
              <div key={j.beat.id}
                onClick={() => onSelectJob(j.beat.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 12px", borderRadius: 9, cursor: "pointer",
                  background: isActive ? "#1a1a1a" : "#0d0d0d",
                  border: `1px solid ${isActive ? "#333" : "#181818"}`,
                }}>
                <div style={{ fontSize: 11, color: "#444", width: 20, textAlign: "center" }}>{idx + 1}</div>
                <Artwork beat={j.beat} size={40} playing={false} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "#ddd", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{j.title}</div>
                  <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>
                    {j.beat.name} · {j.visibility}
                    {j.scheduled_at ? ` · scheduled ${new Date(j.scheduled_at).toLocaleDateString()}` : ""}
                  </div>
                  {(j.upload_status === "generating" || j.upload_status === "uploading") && (
                    <div style={{ marginTop: 6, height: 4, background: "#1a1a1a", borderRadius: 2, overflow: "hidden" }}>
                      <div style={{ height: "100%", background: "#f59e0b", width: `${j.upload_progress}%`, transition: "width 0.25s" }} />
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0, minWidth: 140 }}>
                  <div style={{ fontSize: 11, color: statusColor, textAlign: "right" }}>{statusLabel}</div>
                  {j.upload_status === "done" && j.upload_result_url && (
                    <a href={j.upload_result_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "#93c5fd", textDecoration: "underline" }}>Open on YouTube</a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}


