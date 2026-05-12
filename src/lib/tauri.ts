import type {
  Beat, SaveMetaPayload, SaveMetaResult, RenamePayload, RenameResult,
  FolderScanResult, ResolveFilesPayload, AddFilePayload, AppSettings
} from "../types";

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type OpenFn = (options?: Record<string, unknown>) => Promise<string | string[] | null>;
type ConvertFileSrcFn = (filePath: string, protocol?: string) => string;

// Check if we're in Tauri context (not in dev/web browser mode)
const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

// Lazy load Tauri modules only if available
let invoke: InvokeFn | undefined;
let open: OpenFn | undefined;
let convertFileSrc: ConvertFileSrcFn | undefined;

async function initTauri() {
  if (!isTauri || invoke) return;
  try {
    const core = await import("@tauri-apps/api/core");
    const dialog = await import("@tauri-apps/plugin-dialog");
    invoke = core.invoke as InvokeFn;
    open = dialog.open as OpenFn;
    convertFileSrc = core.convertFileSrc as ConvertFileSrcFn;
  } catch (e) {
    console.warn("Tauri API not available (dev mode?)", e);
  }
}

// Mock beats for dev mode
function createDevBeats(): Beat[] {
  const devBeatsData = [
    { name: "Trap King", bpm: "140", key: "C Minor", color: "#FF6B6B", color2: "#FF8E8E" },
    { name: "Drill Vibe", bpm: "95", key: "A Minor", color: "#4ECDC4", color2: "#7FE5E1" },
    { name: "LoFi Chill", bpm: "85", key: "F Major", color: "#FFE66D", color2: "#FFF0A0" },
    { name: "Boom Bap", bpm: "100", key: "E Minor", color: "#95E1D3", color2: "#C7F0D8" },
    { name: "Hardtrap", bpm: "175", key: "G Minor", color: "#F38181", color2: "#FCC2C2" },
    { name: "Jazz Hop", bpm: "110", key: "Bb Major", color: "#FFEAA7", color2: "#FFF5D9" },
    { name: "Ambient Beat", bpm: "70", key: "D Minor", color: "#A8E6CF", color2: "#C7F7E0" },
    { name: "Future Bass", bpm: "128", key: "F Major", color: "#AA96DA", color2: "#D4B9F5" },
  ];

  return devBeatsData.map(b => {
    const id = `dev_${b.name.toLowerCase().replace(/\s+/g, "_")}`;
    const folderPath = `E:\\777\\app\\beatvault\\dev-beats\\${b.name}`;
    const mp3Path = `${folderPath}\\${b.name}.mp3`;
    return {
      id,
      name: b.name,
      folder_path: folderPath,
      mp3_path: mp3Path,
      wav_path: null,
      playback_path: mp3Path,
      bpm: b.bpm,
      key: b.key,
      tags: [],
      rating: 0,
      image_base64: null,
      has_wav: false,
      has_stems: false,
      has_flp: false,
      has_als: false,
      stems_path: null,
      flp_path: null,
      als_path: null,
      other_files: [],
      color: b.color,
      color2: b.color2,
    };
  });
}

export async function loadLibrary(): Promise<Beat[]> {
  await initTauri();
  if (!invoke) {
    // In dev mode, return mock beats
    return createDevBeats();
  }
  return invoke<Beat[]>("load_library");
}

export async function pickAndScanFolder(): Promise<Beat[]> {
  await initTauri();
  if (!open) {
    // In dev mode, return mock beats (simulate browsing the dev-beats folder)
    console.log("Dev mode: returning mock beats instead of file dialog");
    return createDevBeats();
  }
  const selected = await open({ directory: true, multiple: false, title: "Select ALL MY BEATS folder" });
  if (!selected || typeof selected !== "string") return [];
  if (!invoke) return [];
  return invoke<Beat[]>("preview_beats_folder", { folderPath: selected });
}

export async function importSelectedBeats(folderPaths: string[]): Promise<Beat[]> {
  await initTauri();
  if (!invoke) {
    // In dev mode, return mock beats (simulate importing from the dev-beats folder)
    console.log("Dev mode: importing mock beats", folderPaths);
    return createDevBeats();
  }
  return invoke<Beat[]>("import_selected_beats", { folderPaths });
}

export async function scanBeatFolder(folderPath: string): Promise<FolderScanResult> {
  await initTauri();
  if (!invoke) {
    return {
      needs_resolution: false,
      mp3_files: [],
      wav_files: [],
      stems_files: [],
      flp_files: [],
      beat: null,
    };
  }
  return invoke<FolderScanResult>("scan_beat_folder", { folderPath });
}

export async function resolveAndAddBeat(payload: ResolveFilesPayload): Promise<Beat> {
  await initTauri();
  if (!invoke) throw new Error("Tauri not available");
  return invoke<Beat>("resolve_beat_files", { payload });
}

export async function readBeatMeta(mp3Path: string): Promise<Beat> {
  await initTauri();
  if (!invoke) throw new Error("Tauri not available");
  return invoke<Beat>("read_beat_meta", { mp3Path });
}

export async function saveBeatMeta(payload: SaveMetaPayload): Promise<SaveMetaResult> {
  await initTauri();
  if (!invoke) {
    return {
      new_mp3_path: payload.mp3_path,
      new_wav_path: payload.wav_path,
    };
  }
  return invoke<SaveMetaResult>("save_beat_meta", { payload });
}

export async function renameBeat(payload: RenamePayload): Promise<RenameResult> {
  await initTauri();
  if (!invoke) {
    return {
      new_folder_path: payload.folder_path,
      new_mp3_path: payload.mp3_path,
      new_wav_path: null,
      new_stems_path: null,
      new_flp_path: null,
    };
  }
  return invoke<RenameResult>("rename_beat", { payload });
}

export async function reorderBeats(orderedIds: string[]): Promise<void> {
  await initTauri();
  if (!invoke) return;
  return invoke<void>("reorder_beats", { orderedIds });
}

export async function removeBeatFromLibrary(id: string): Promise<void> {
  await initTauri();
  if (!invoke) return;
  return invoke<void>("remove_beat_from_library", { id });
}

export async function revealInExplorer(path: string): Promise<void> {
  await initTauri();
  if (!invoke) return;
  return invoke<void>("reveal_in_explorer", { path });
}

export async function addFileToBeat(payload: AddFilePayload): Promise<string> {
  await initTauri();
  if (!invoke) return "";
  return invoke<string>("add_file_to_beat", { payload });
}

export function filePathToUrl(filePath: string): string {
  if (!convertFileSrc) return `file://${filePath}`;
  return convertFileSrc(filePath);
}

// Pick a single file with a filter; defaultPath opens dialog in that folder
export async function pickFile(
  filters: { name: string; extensions: string[] }[],
  defaultPath?: string
): Promise<string | null> {
  await initTauri();
  if (!open) return null;
  const result = await open({ filters, multiple: false, defaultPath: defaultPath || undefined });
  if (!result || typeof result !== "string") return null;
  return result;
}

export async function getSettings(): Promise<AppSettings> {
  await initTauri();
  if (!invoke) return { beats_folder: null };
  return invoke<AppSettings>("get_settings");
}

export async function setBeatsFolder(folder: string): Promise<void> {
  await initTauri();
  if (!invoke) return;
  return invoke<void>("set_beats_folder", { folder });
}
