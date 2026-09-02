import type { AppSettings, Beat, TelegramCloudStatus } from "../types";
import type { PlatformCapabilities, PlatformKind } from "./capabilities";

export type PlatformUnlisten = () => void;
export type PlatformEventHandler<T> = (payload: T) => void;

export interface PlatformLibraryPort {
  load(): Promise<Beat[]>;
  loadOffline(): Promise<Beat[]>;
  restoreAuthoritative(): Promise<void>;
  commitSnapshot(beats: Beat[]): Promise<PlatformLibrarySyncResult>;
  flushOfflineTrashIntents(): Promise<number>;
}

export interface PlatformLibrarySyncResult {
  telegram_file_id: string;
  telegram_message_id: number;
  updated: boolean;
  beat_count: number;
}

export interface PlatformPreferencesPort {
  load(): Promise<AppSettings>;
  setIncompleteWarnings(enabled: boolean): Promise<void>;
  setCustomCursor(enabled: boolean): Promise<void>;
}

export interface PlatformTrashItem {
  id: string;
  beat_name: string;
  trashed_at: number;
  is_cloud: boolean;
}

export interface PlatformPresetTrashItem {
  id: string;
  preset_name: string;
  trashed_at: number;
}

export interface PlatformTrashPort {
  moveBeats(ids: string[]): Promise<string[]>;
  listBeats(): Promise<PlatformTrashItem[]>;
  restoreBeat(id: string): Promise<Beat>;
  purgeBeats(): Promise<number>;
  listPresets(): Promise<PlatformPresetTrashItem[]>;
  restorePreset(id: string): Promise<void>;
  purgePresets(): Promise<number>;
}

export interface PlatformPlaybackCacheStatus {
  used_bytes: number;
  limit_mb: number;
}

export interface PlatformPlaybackCachePort {
  status(): Promise<PlatformPlaybackCacheStatus>;
  setLimitMb(limitMb: number): Promise<PlatformPlaybackCacheStatus>;
  clear(): Promise<PlatformPlaybackCacheStatus>;
}

export interface PlatformUpdateInfo {
  available: boolean;
  version: string | null;
  notes: string | null;
}

export interface PlatformSystemPort {
  getLogDirectory(): Promise<string>;
  getTemplatesDirectory(): Promise<string>;
  revealPath(path: string): Promise<void>;
  checkForUpdate(): Promise<PlatformUpdateInfo>;
  installUpdate(): Promise<void>;
}

export interface PlatformStartupSnapshot {
  settings: AppSettings;
  beats: Beat[];
  connectionState: "online" | "offline" | "poor";
  libraryVerified: boolean;
}

export interface PlatformStartupPort {
  loadAuthenticatedShell(): Promise<PlatformStartupSnapshot | null>;
}

export interface PlatformMediaPort {
  resolveUrl(source: string): string;
  preparePlayback(beat: Beat): Promise<{ url: string; completed: Promise<void> }>;
  loadArtwork(beat: Beat): Promise<string | null>;
  releasePlayback(beatId: string | null): void;
}

export interface PlatformEventPort {
  listen<T>(event: string, handler: PlatformEventHandler<T>): Promise<PlatformUnlisten>;
}

export interface PlatformExternalPort {
  openUrl(url: string): Promise<void>;
}

export interface PlatformCloudAuthPort {
  syncSession(token: string | null, cloudApiBase: string): Promise<void>;
}

export interface PlatformCloudPort {
  status(): Promise<TelegramCloudStatus>;
}

export interface PlatformCloudUploadProgress {
  uploadedBytes: number;
  totalBytes: number;
}

export interface PlatformCloudCommitProgress extends PlatformCloudUploadProgress {
  stage: "preparing" | "master" | "wav" | "artwork" | "project" | "library";
}

export interface PlatformCloudUploadResult {
  telegram_file_id: string;
  telegram_message_id: number;
  filename: string;
  original_size: number;
  parts: Array<{
    telegram_file_id: string;
    telegram_message_id: number;
    index: number;
    size: number;
    filename: string;
  }>;
  transport: "direct-web";
}

export interface PlatformCloudDataPort {
  upload(input: {
    file: File;
    filename: string;
    beatId: string;
    beatName: string;
    kind: "MASTER" | "WAV" | "LOOP" | "PROJECT" | "STEMS" | "ARTWORK" | "OTHER";
  }, onProgress?: (progress: PlatformCloudUploadProgress) => void): Promise<PlatformCloudUploadResult>;
  commitImportedBeat(beat: Beat, onProgress?: (progress: PlatformCloudCommitProgress) => void): Promise<Beat>;
  disconnect(): Promise<void>;
}

export type PlatformDownloadKind = "MP3" | "WAV" | "ARTWORK" | "PROJECT" | "ALL";

export interface PlatformDownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  currentKind: Exclude<PlatformDownloadKind, "ALL">;
}

export interface PlatformDownloadTask {
  id: string;
  completed: Promise<{ cancelled: boolean }>;
  cancel(): void;
}

export interface PlatformDownloadsPort {
  start(beat: Beat, kind: PlatformDownloadKind, onProgress?: (progress: PlatformDownloadProgress) => void): PlatformDownloadTask;
  cancelAll(): void;
}

export type PlatformBeatEditSlotKind = "MASTER" | "WAV" | "PROJECT";
export type PlatformBeatEditFiles = Partial<Record<PlatformBeatEditSlotKind, File>>;

export interface PlatformBeatEditorPort {
  pickFile(kind: PlatformBeatEditSlotKind): Promise<File | null>;
  commit(original: Beat, updated: Beat, files: PlatformBeatEditFiles, onProgress?: (progress: PlatformCloudCommitProgress) => void): Promise<Beat>;
}

export interface PlatformAccountPort {
  getInstallationId(): Promise<string>;
}

export interface PlatformDiagnosticsPort {
  reviewPerformance(message: string): void;
  audioEvent(event: string, beatId: string | null, beatName: string | null, detail: string): Promise<void>;
}

export interface PlatformImportCandidate {
  beat: Beat;
  hydrated: Promise<Beat>;
}

export type PlatformImportSlotKind = "MASTER" | "WAV" | "PROJECT";
export type PlatformImportSlotFiles = Partial<Record<PlatformImportSlotKind, File>>;

export interface PlatformImportPort {
  pickBeat(): Promise<PlatformImportCandidate | null>;
  fromFile(file: File): PlatformImportCandidate;
  fileForBeat(beatId: string): File | null;
  slotFilesForBeat(beatId: string): PlatformImportSlotFiles;
  pickSlotFile(beatId: string, kind: PlatformImportSlotKind): Promise<File | null>;
  releaseBeat(beatId: string): void;
}

export interface PlatformAdapter {
  kind: PlatformKind;
  capabilities: Readonly<PlatformCapabilities>;
  clientId: string;
  library: PlatformLibraryPort;
  preferences: PlatformPreferencesPort;
  trash: PlatformTrashPort;
  playbackCache: PlatformPlaybackCachePort;
  system: PlatformSystemPort;
  startup: PlatformStartupPort;
  media: PlatformMediaPort;
  events: PlatformEventPort;
  external: PlatformExternalPort;
  account: PlatformAccountPort;
  cloud: PlatformCloudPort;
  cloudData: PlatformCloudDataPort;
  downloads: PlatformDownloadsPort;
  editor: PlatformBeatEditorPort;
  cloudAuth: PlatformCloudAuthPort;
  diagnostics: PlatformDiagnosticsPort;
  importer: PlatformImportPort;
}
