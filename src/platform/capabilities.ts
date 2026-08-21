export type PlatformKind = "desktop" | "web";

export interface PlatformCapabilities {
  browserFileImport: boolean;
  singleBeatDrop: boolean;
  nativeFilesystemDrop: boolean;
  nativeExternalArtworkDrop: boolean;
  directGalerCloudTransport: boolean;
  offlinePackage: boolean;
  openProjectInDaw: boolean;
  revealLocalFile: boolean;
  watchFolders: boolean;
  installAppUpdates: boolean;
}

export const DESKTOP_CAPABILITIES: Readonly<PlatformCapabilities> = Object.freeze({
  browserFileImport: false,
  singleBeatDrop: false,
  nativeFilesystemDrop: true,
  nativeExternalArtworkDrop: true,
  directGalerCloudTransport: true,
  offlinePackage: true,
  openProjectInDaw: true,
  revealLocalFile: true,
  watchFolders: true,
  installAppUpdates: true,
});

/**
 * Conservative runtime matrix for the first Web foundation commit.
 * Capabilities turn true only when their Web implementation is complete.
 */
export const WEB_FOUNDATION_CAPABILITIES: Readonly<PlatformCapabilities> = Object.freeze({
  browserFileImport: false,
  singleBeatDrop: false,
  nativeFilesystemDrop: false,
  nativeExternalArtworkDrop: false,
  directGalerCloudTransport: false,
  offlinePackage: false,
  openProjectInDaw: false,
  revealLocalFile: false,
  watchFolders: false,
  installAppUpdates: false,
});
