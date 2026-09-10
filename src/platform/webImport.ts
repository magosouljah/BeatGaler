import type { Beat } from "../types";
import { parseId3FromFile } from "../features/import/webAudioMetadata";
import { createWebWavMaster } from "../features/import/webWavMaster";
import type { PlatformImportCandidate, PlatformImportPort, PlatformImportSlotFiles, PlatformImportSlotKind } from "./contracts";

const webFiles = new Map<string, { file: File; objectUrl: string; slots: PlatformImportSlotFiles; ready: Promise<void>; controller: AbortController }>();

export async function waitForWebImportFiles(id: string): Promise<PlatformImportSlotFiles> {
  const entry = webFiles.get(id);
  if (!entry) throw new Error("The import was cancelled.");
  await entry.ready;
  if (webFiles.get(id) !== entry) throw new Error("The import was cancelled.");
  return { ...entry.slots };
}

function createId(): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `web-import-${suffix}`;
}

function isSupportedAudio(file: File): boolean {
  return /\.(mp3|wav)$/i.test(file.name) || file.type === "audio/mpeg" || file.type === "audio/wav" || file.type === "audio/x-wav";
}

export function createWebImportCandidate(file: File): PlatformImportCandidate {
  if (!isSupportedAudio(file)) {
    throw new Error("Choose one MP3 or WAV file.");
  }

  const id = createId();
  const isWav = /\.wav$/i.test(file.name) || /wav/i.test(file.type);
  const objectUrl = isWav ? "" : URL.createObjectURL(file);
  const beat: Beat = {
    id,
    name: file.name.replace(/\.[^.]+$/, ""),
    folder_path: `web-file://${id}`,
    mp3_path: isWav ? "" : file.name,
    wav_path: isWav ? file.name : null,
    playback_path: objectUrl,
    bpm: "",
    key: "",
    needs_resolution: false,
    tags: [],
    rating: 0,
    image_base64: null,
    has_wav: isWav,
    has_stems: false,
    has_samples: false,
    samples_path: null,
    has_flp: false,
    has_als: false,
    stems_path: null,
    flp_path: null,
    als_path: null,
    other_files: [],
    color: "#7a7a7a",
    color2: "#a0a0a0",
    has_loop: false,
    loop_path: null,
    cloud_status: "PENDING_UPLOAD",
  };

  const entry = {
    file,
    objectUrl,
    slots: (isWav ? { WAV: file } : { MASTER: file }) as PlatformImportSlotFiles,
    ready: Promise.resolve(),
    controller: new AbortController(),
  };
  webFiles.set(id, entry);
  if (isWav) {
    entry.ready = createWebWavMaster(file, entry.controller.signal).then(master => {
      if (webFiles.get(id) !== entry) throw new Error("The import was cancelled.");
      entry.objectUrl = URL.createObjectURL(master);
      entry.slots.MASTER = master;
    });
  }
  const hydrated = Promise.all([parseId3FromFile(file), entry.ready]).then(([metadata]) => ({
    ...beat, mp3_path: entry.slots.MASTER?.name || "", playback_path: entry.objectUrl,
    bpm: metadata.bpm, key: metadata.key, tags: metadata.tags, image_base64: metadata.image_base64,
  }));
  // Review opens immediately. Save still observes preparation failures via entry.ready.
  void hydrated.catch(() => {});
  return { beat, hydrated };
}

async function pickOneAudioFile(): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".mp3,.wav,audio/mpeg,audio/wav,audio/x-wav";
    input.multiple = false;
    input.style.display = "none";
    document.body.appendChild(input);

    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      input.remove();
      resolve(file);
    };
    const onFocus = () => window.setTimeout(() => finish(input.files?.[0] ?? null), 0);
    input.addEventListener("change", () => finish(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    window.addEventListener("focus", onFocus, { once: true });
    input.click();
  });
}

export async function pickWebSlotFile(kind: PlatformImportSlotKind): Promise<File | null> {
  const accept = kind === "MASTER"
    ? ".mp3,audio/mpeg"
    : kind === "WAV"
      ? ".wav,audio/wav,audio/x-wav"
      : ".zip,application/zip,application/x-zip-compressed";
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = false;
    input.style.display = "none";
    document.body.appendChild(input);
    const finish = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => finish(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    input.click();
  });
}

export const webImportPort: PlatformImportPort = {
  async pickBeat() {
    const file = await pickOneAudioFile();
    if (!file) return null;
    return createWebImportCandidate(file);
  },
  fromFile: createWebImportCandidate,
  fileForBeat(id) {
    return webFiles.get(id)?.file ?? null;
  },
  slotFilesForBeat(id) {
    return { ...(webFiles.get(id)?.slots || {}) };
  },
  async pickSlotFile(id, kind) {
    const entry = webFiles.get(id);
    if (!entry) throw new Error("The Review file is no longer available.");
    const file = await pickWebSlotFile(kind);
    if (!file) return null;
    entry.slots[kind] = file;
    return file;
  },
  releaseBeat(id) {
    const entry = webFiles.get(id);
    if (!entry) return;
    entry.controller.abort();
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    webFiles.delete(id);
  },
};
