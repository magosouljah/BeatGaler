import type { Beat } from "../types";
import type { PlatformCapabilities, PlatformKind } from "./capabilities";

export type PlatformUnlisten = () => void;
export type PlatformEventHandler<T> = (payload: T) => void;

export interface PlatformLibraryPort {
  load(): Promise<Beat[]>;
  loadOffline(): Promise<Beat[]>;
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

export interface PlatformAccountPort {
  getInstallationId(): Promise<string>;
}

export interface PlatformDiagnosticsPort {
  reviewPerformance(message: string): void;
}

/** The only platform boundary React code should depend on after the migration. */
export interface PlatformAdapter {
  kind: PlatformKind;
  capabilities: Readonly<PlatformCapabilities>;
  clientId: string;
  library: PlatformLibraryPort;
  media: PlatformMediaPort;
  events: PlatformEventPort;
  external: PlatformExternalPort;
  account: PlatformAccountPort;
  cloudAuth: PlatformCloudAuthPort;
  diagnostics: PlatformDiagnosticsPort;
}
