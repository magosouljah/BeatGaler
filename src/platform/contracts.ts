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

export interface PlatformAccountPort {
  getInstallationId(): Promise<string>;
}

export interface PlatformDiagnosticsPort {
  reviewPerformance(message: string): void;
}

export interface PlatformImportCandidate {
  beat: Beat;
  hydrated: Promise<Beat>;
}

export interface PlatformImportPort {
  pickBeat(): Promise<PlatformImportCandidate | null>;
  fromFile(file: File): PlatformImportCandidate;
  fileForBeat(beatId: string): File | null;
  releaseBeat(beatId: string): void;
}

/** The only platform boundary React code should depend on after the migration. */
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
  cloudAuth: PlatformCloudAuthPort;
  diagnostics: PlatformDiagnosticsPort;
  importer: PlatformImportPort;
}
