import type {
  Beat, SaveMetaPayload, SaveMetaResult, RenamePayload, RenameResult,
  FolderScanResult, ResolveFilesPayload, AddFilePayload, AppSettings,
  UploadTemplate, YouTubeChannel, YouTubeUploadPayload, YouTubeUploadResult
} from "../types";

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type OpenFn = (options?: Record<string, unknown>) => Promise<string | string[] | null>;
type SaveFn = (options?: Record<string, unknown>) => Promise<string | null>;
type ConvertFileSrcFn = (filePath: string, protocol?: string) => string;

// Check if we're in Tauri context (not in dev/web browser mode)
const isTauri = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
export const isTauriAvailable = isTauri;

// Lazy load Tauri modules only if available
let invoke: InvokeFn | undefined;
let open: OpenFn | undefined;
let save: SaveFn | undefined;
let convertFileSrc: ConvertFileSrcFn | undefined;
let fsReadTextFile: ((path: string) => Promise<string>) | undefined;
let fsWriteTextFile: ((path: string, contents: string) => Promise<void>) | undefined;

async function initTauri() {
  if (!isTauri || invoke) return;
  try {
    const core = await import("@tauri-apps/api/core");
    const dialog = await import("@tauri-apps/plugin-dialog");
    const fs = await import("@tauri-apps/plugin-fs");
    invoke = core.invoke as InvokeFn;
    open = dialog.open as OpenFn;
    save = dialog.save as SaveFn;
    convertFileSrc = core.convertFileSrc as ConvertFileSrcFn;
    fsReadTextFile = fs.readTextFile;
    fsWriteTextFile = fs.writeTextFile;
  } catch (e) {
    console.warn("Tauri API not available (dev mode?)", e);
  }
}

export async function pickFiles(
  filters: { name: string; extensions: string[] }[],
  defaultPath?: string
): Promise<string[] | null> {
  await initTauri();
  if (!open) return null;
  const result = await open({ filters, multiple: true, defaultPath: defaultPath || undefined });
  if (!result) return null;
  if (Array.isArray(result)) return result as string[];
  return [result as string];
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
      needs_resolution: false,
      tags: [],
      rating: 0,
      image_base64: null,
      has_wav: false,
      has_stems: false,
      has_samples: false,
      samples_path: null,
      has_flp: false,
      has_als: false,
      stems_path: null,
      flp_path: null,
      als_path: null,
      other_files: [],
      color: b.color,
      color2: b.color2,
      has_loop: false,
      loop_path: null,
    };
  });
}

export async function loadLibrary(): Promise<Beat[]> {
  await initTauri();
  if (!invoke) {
    // In dev mode, don't auto-load mock beats. Return empty and let user 'Scan all beats folder'
    return [];
  }
  return invoke<Beat[]>("load_library");
}

// Parse ID3 tags from a browser File object using jsmediatags (dev-mode only)
export async function parseId3FromFile(file: File): Promise<{ bpm: string; key: string; tags: string[]; image_base64: string | null }> {
  // Use runtime UMD from CDN to avoid Vite/esbuild package entry resolution issues.
  // This keeps the dev-mode parser out of the dependency graph so Vite won't fail.
  try {
    const globalName = (window as any).jsmediatags;
    if (!globalName) {
      // inject script
      await new Promise<void>((resolve, reject) => {
        const src = 'https://cdn.jsdelivr.net/npm/jsmediatags@3.9.5/dist/jsmediatags.min.js';
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Failed to load jsmediatags from CDN'));
        document.head.appendChild(s);
      });
    }
    const jm: any = (window as any).jsmediatags;
    if (!jm || typeof jm.read !== 'function') return { bpm: "", key: "", tags: [], image_base64: null };
    return await new Promise((resolve) => {
      try {
        jm.read(file, {
          onSuccess: (result: any) => {
            const t = result.tags || {};
            // Extract genre/tags
            const genre = String(t.TCON || t.genre || "");
            const tags = String(genre || "").split(/[,;\/]/).map((s: string) => s.trim().toLowerCase()).filter(Boolean);

            // Heuristic search for BPM and Key across tag fields
            let bpm = "";
            let key = "";
            const bpmRe = /^\d{2,3}$/;
            const keyRe = /^[A-G](?:b|#)?(?:\s*(?:maj|major|min|minor|m)?)?$/i;

            // Check known fields first
            const knownBpm = [t.TBPM, t.bpm, t.BPM, t.tbpm].find(Boolean);
            if (knownBpm) bpm = String(knownBpm).trim();
            const knownKey = [t.TKEY, t.key, t.INITIALKEY, t.initialkey].find(Boolean);
            if (knownKey) key = String(knownKey).trim();

            // Fallback: scan all string fields for bpm/key patterns
            if (!bpm || !key) {
              for (const k of Object.keys(t)) {
                if (bpm && key) break;
                try {
                  const v = t[k];
                  if (typeof v === 'string') {
                    const s = v.trim();
                    if (!bpm && bpmRe.test(s)) bpm = s;
                    const sKey = s.split(/[\[\]\(\)\-_,]/)[0].trim();
                    if (!key && keyRe.test(sKey)) key = sKey;
                  }
                  // jsmediatags may provide picture in t.picture
                } catch (_e) { /* ignore */ }
              }
            }

            // Normalize key: convert single-letter like 'C' to 'C Major' if ambiguous? Keep raw for now

            let image_base64: string | null = null;
            const pic = t.picture || t.PICTURE || null;
            if (pic && pic.data && pic.format) {
              const arr = pic.data as number[];
              let binary = '';
              for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
              const b64 = btoa(binary);
              image_base64 = `data:${pic.format};base64,${b64}`;
            }
            resolve({ bpm: String(bpm || ""), key: String(key || ""), tags, image_base64 });
          },
          onError: (_err: any) => resolve({ bpm: "", key: "", tags: [], image_base64: null }),
        });
      } catch (e) {
        resolve({ bpm: "", key: "", tags: [], image_base64: null });
      }
    });
  } catch (e) {
    return { bpm: "", key: "", tags: [], image_base64: null };
  }
}

export async function pickAndScanFolder(): Promise<Beat[]> {
  await initTauri();
  if (!open) {
    // Dev mode: try to use the browser File System Access API to pick a directory
    // If not available, fall back to mock beats
    if (typeof (window as any).showDirectoryPicker === "function") {
      try {
        const dirHandle = await (window as any).showDirectoryPicker();
        const beats: Beat[] = [];
        // Iterate top-level entries (expected: one directory per beat)
        for await (const entry of dirHandle.values()) {
          try {
            if (entry.kind !== "directory") continue;
            const folderHandle = entry as any;
            let foundFile: File | null = null;
            // Look for the first mp3 or wav inside the folder
            for await (const child of folderHandle.values()) {
              if (child.kind !== "file") continue;
              const name = (child.name || "").toLowerCase();
              if (name.endsWith(".mp3") || name.endsWith(".wav")) {
                foundFile = await child.getFile();
                break;
              }
            }
            if (!foundFile) continue;
            const url = URL.createObjectURL(foundFile);
            // Try to read ID3 tags client-side in dev mode
            const meta = await parseId3FromFile(foundFile);
            const beat: Beat = {
              id: `local_${folderHandle.name}`,
              name: folderHandle.name,
              folder_path: folderHandle.name,
              mp3_path: foundFile.name,
              wav_path: null,
              playback_path: url,
              bpm: meta.bpm,
              key: meta.key,
              needs_resolution: false,
              tags: meta.tags,
              rating: 0,
              image_base64: meta.image_base64,
              has_wav: false,
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
            };
            beats.push(beat);
          } catch (err) {
            console.warn("Error reading folder entry", err);
          }
        }
        return beats;
      } catch (err) {
        console.warn("Directory picker failed or was cancelled", err);
        return createDevBeats();
      }
    }
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

// Opens a file (FLP, ALS, etc.) with its OS-registered default app —
// same as double-clicking it in Explorer/Finder.
export async function openProjectFile(path: string): Promise<void> {
  await initTauri();
  if (!invoke) return;
  return invoke<void>("open_project_file", { path });
}

export async function addFileToBeat(payload: AddFilePayload): Promise<string> {
  await initTauri();
  if (!invoke) return "";
  return invoke<string>("add_file_to_beat", { payload });
}

export async function readImagePathAsDataUrl(filePath: string): Promise<string> {
  await initTauri();
  if (!convertFileSrc) throw new Error("Tauri file conversion is not available");

  const url = convertFileSrc(filePath);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not read dropped image (${response.status})`);
  }

  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error("Dropped file is not an image");
  }

  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error("Could not convert dropped image"));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read dropped image"));
    reader.readAsDataURL(blob);
  });
}

export function filePathToUrl(filePath: string): string {
  if (!convertFileSrc) {
    // If already a blob/data/http URL, return as-is
    if (filePath.startsWith("blob:") || filePath.startsWith("data:") || filePath.startsWith("http:" ) || filePath.startsWith("https:")) {
      return filePath;
    }
    return `file://${filePath}`;
  }
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

export async function pickFolder(title = "Select folder"): Promise<string | null> {
  await initTauri();
  if (!open) return null;
  const result = await open({ directory: true, multiple: false, title });
  if (!result || typeof result !== "string") return null;
  return result;
}

export async function getSettings(): Promise<AppSettings> {
  await initTauri();
  if (!invoke) return { beats_folder: null, incomplete_warnings_enabled: true, custom_cursor_enabled: true };
  return invoke<AppSettings>("get_settings");
}

export async function setBeatsFolder(folder: string): Promise<void> {
  await initTauri();
  if (!invoke) return;
  return invoke<void>("set_beats_folder", { folder });
}

export async function setIncompleteWarningsEnabled(enabled: boolean): Promise<void> {
  await initTauri();
  if (!invoke) return;
  return invoke<void>("set_incomplete_warnings_enabled", { enabled });
}

export async function setCustomCursorEnabled(enabled: boolean): Promise<void> {
  await initTauri();
  if (!invoke) return;
  return invoke<void>("set_custom_cursor_enabled", { enabled });
}

export interface RenameTagResult {
  beats_updated: number;
  files_updated: number;
}

export async function renameTagEverywhere(oldTag: string, newTag: string, jobId: string): Promise<RenameTagResult> {
  await initTauri();
  if (!invoke) return { beats_updated: 0, files_updated: 0 };
  return invoke<RenameTagResult>("rename_tag_everywhere", { oldTag, newTag, jobId });
}

export async function getTemplatesDir(): Promise<string> {
  await initTauri();
  if (!invoke) return "";
  return invoke<string>("get_templates_dir");
}

export async function listTemplateFiles(): Promise<string[]> {
  await initTauri();
  if (!invoke) return [];
  return invoke<string[]>("list_template_files");
}

export async function deleteTemplateFile(path: string): Promise<void> {
  await initTauri();
  if (!invoke) return;
  return invoke<void>("delete_template_file", { path });
}

export async function setTemplatesFolder(folder: string): Promise<void> {
  await initTauri();
  if (!invoke) return;
  return invoke<void>("set_templates_folder", { folder });
}

export async function saveYouTubeOAuthConfig(rawJson: string): Promise<void> {
  await initTauri();
  if (!invoke) throw new Error("Tauri not available");
  return invoke<void>("save_youtube_oauth_config", { rawJson });
}

export async function getYouTubeChannel(): Promise<YouTubeChannel | null> {
  await initTauri();
  if (!invoke) return null;
  try {
    return await invoke<YouTubeChannel>("get_youtube_channel");
  } catch {
    return null;
  }
}

export async function connectYouTubeChannel(): Promise<YouTubeChannel> {
  await initTauri();
  if (!invoke) throw new Error("Tauri not available");
  return invoke<YouTubeChannel>("connect_youtube_channel");
}

export async function uploadToYouTube(payload: YouTubeUploadPayload): Promise<YouTubeUploadResult> {
  await initTauri();
  if (!invoke) throw new Error("Tauri not available");
  return invoke<YouTubeUploadResult>("upload_to_youtube", { payload });
}

export async function startYoutubeUpload(payload: YouTubeUploadPayload): Promise<string> {
  await initTauri();
  if (!invoke) throw new Error("Tauri not available");
  return invoke<string>("start_youtube_upload", { payload });
}

export async function cancelYoutubeUpload(jobId: string): Promise<void> {
  await initTauri();
  if (!invoke) return;
  return invoke<void>("cancel_youtube_upload", { jobId });
}

// ── Trash (soft delete) ──

export interface TrashItem {
  id: string;
  beat_name: string;
  trashed_at: number;
}

export async function listTrash(): Promise<TrashItem[]> {
  await initTauri();
  if (!invoke) return [];
  return invoke<TrashItem[]>("list_trash");
}

export async function restoreBeatFromTrash(trashId: string): Promise<Beat> {
  await initTauri();
  if (!invoke) throw new Error("Tauri not available");
  return invoke<Beat>("restore_beat_from_trash", { trashId });
}

// Permanently deletes everything currently in the trash (bypassing the
// normal 14-day auto-purge). Irreversible — confirm with the user first.
export async function purgeTrashNow(): Promise<number> {
  await initTauri();
  if (!invoke) return 0;
  return invoke<number>("purge_trash_now");
}

export async function getLogDir(): Promise<string> {
  await initTauri();
  if (!invoke) return "";
  return invoke<string>("get_log_dir");
}

export async function disconnectYouTube(): Promise<void> {
  await initTauri();
  if (!invoke) return;
  return invoke<void>("disconnect_youtube");
}

// ── Smart multi-root import (fuzzy matcher) ──

export interface PendingDecision {
  path: string;
  display_name: string;
  suggested_beat_name: string;
  suggested_role: string;
  score: number;
}

export interface ImportBatchPreview {
  batch_id: string;
  confirmed_count: number;
  pending: PendingDecision[];
}

export interface ImportDecisionInput {
  path: string;
  action: "assign" | "independent" | "ignore";
  target_beat_name?: string | null;
  role?: string | null;
}

// Scans one or more root paths (folders or loose files) recursively, groups
// everything that matches at 100% confidence, and returns whatever is left
// ambiguous for the user to resolve. Nothing is copied to the vault yet.
export async function previewImportBatch(rootPaths: string[]): Promise<ImportBatchPreview> {
  await initTauri();
  if (!invoke) throw new Error("Tauri not available");
  return invoke<ImportBatchPreview>("preview_import_batch", { rootPaths });
}

// Applies the user's decisions for a previewed batch, copies everything into
// the vault, and returns the beats that were actually created.
export async function resolveImportDecisions(batchId: string, decisions: ImportDecisionInput[]): Promise<Beat[]> {
  await initTauri();
  if (!invoke) throw new Error("Tauri not available");
  return invoke<Beat[]>("resolve_import_decisions", { batchId, decisions });
}

export async function pickImageFile(defaultPath?: string): Promise<string | null> {
  await initTauri();
  if (!open) return null;
  const result = await open({
    multiple: false,
    filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }],
    defaultPath: defaultPath || undefined,
  });
  if (!result || typeof result !== "string") return null;
  return result;
}

export async function pickVideoFile(defaultPath?: string): Promise<string | null> {
  await initTauri();
  if (!open) return null;
  const result = await open({
    multiple: false,
    filters: [{ name: "Video", extensions: ["mp4", "mov", "mkv", "avi", "webm"] }],
    defaultPath: defaultPath || undefined,
  });
  if (!result || typeof result !== "string") return null;
  return result;
}

export async function pickTemplateFile(defaultPath?: string): Promise<string | null> {
  await initTauri();
  if (!open) return null;
  const result = await open({
    multiple: false,
    filters: [{ name: "Template", extensions: ["txt"] }],
    defaultPath: defaultPath || undefined,
  });
  if (!result || typeof result !== "string") return null;
  return result;
}

function ensureTemplateExtension(path: string): string {
  return /\.txt$/i.test(path) ? path : `${path}.txt`;
}

export async function saveTemplateDialog(defaultName = "template", defaultPath?: string): Promise<string | null> {
  await initTauri();
  if (!save) return null;
  const result = await save({
    filters: [{ name: "Template", extensions: ["txt"] }],
    defaultPath: defaultPath ? `${defaultPath}/${defaultName}` : defaultName,
  });
  if (!result || typeof result !== "string") return null;
  return ensureTemplateExtension(result);
}

export function serializeTemplate(template: UploadTemplate): string {
  const tagsLine = template.tags.join(",");
  return `<title>
${template.title_template}
</title>

<description>
${template.description_template}
</description>

<tags>
${tagsLine}
</tags>`;
}

export function parseTemplate(raw: string, name = "Untitled"): UploadTemplate {
  const getBlock = (tag: string): string => {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
    const m = raw.match(re);
    return m ? m[1].trim() : "";
  };
  const title = getBlock("title");
  const description = getBlock("description");
  const tagsRaw = getBlock("tags");
  const tags = tagsRaw
    .split(/[\n,;]/)
    .map(s => s.trim())
    .filter(Boolean);
  return { name, title_template: title, description_template: description, tags };
}

export async function readTemplateFile(path: string): Promise<UploadTemplate> {
  await initTauri();
  if (!invoke) throw new Error("Tauri not available");
  return invoke<UploadTemplate>("read_template_file", { path });
}

export async function writeTemplateFile(path: string, template: UploadTemplate): Promise<boolean> {
  await initTauri();
  if (!invoke) return false;
  try {
    await invoke<void>("write_template_file", { path, template });
    return true;
  } catch {
    return false;
  }
}

export function applyTemplate(
  template: UploadTemplate,
  ctx: { title: string; bpm: string; key: string; collaborator?: string }
): { title: string; description: string } {
  const title = template.title_template
    .replace(/\{\{title\}\}/g, ctx.title)
    .replace(/\{\{bpm\}\}/g, ctx.bpm)
    .replace(/\{\{key\}\}/g, ctx.key);
  const description = template.description_template
    .replace(/\{\{title\}\}/g, ctx.title)
    .replace(/\{\{bpm\}\}/g, ctx.bpm)
    .replace(/\{\{key\}\}/g, ctx.key)
    .replace(/\{\{collaborator\}\}/g, ctx.collaborator ?? "");
  return { title, description };
}

export interface TemplateTrashItem {
  id: string;
  preset_name: string;
  trashed_at: number;
}

export async function deleteTemplateToTrash(path: string): Promise<void> {
  await initTauri();
  if (!invoke) return;
  return invoke<void>("delete_template_to_trash", { path });
}

export async function listTemplateTrash(): Promise<TemplateTrashItem[]> {
  await initTauri();
  if (!invoke) return [];
  return invoke<TemplateTrashItem[]>("list_template_trash");
}

export async function restoreTemplateFromTrash(trashId: string): Promise<UploadTemplate> {
  await initTauri();
  if (!invoke) throw new Error("Tauri not available");
  return invoke<UploadTemplate>("restore_template_from_trash", { trashId });
}

export async function purgeTemplateTrashNow(): Promise<number> {
  await initTauri();
  if (!invoke) return 0;
  return invoke<number>("purge_template_trash_now");
}