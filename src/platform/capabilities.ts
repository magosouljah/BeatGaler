export type PlatformKind = "desktop" | "web";

export interface PlatformCapabilities {
  browserFileImport: boolean;
  singleBeatDrop: boolean;
  browserObjectPlayback: boolean;
  authorizedCloudPlayback: boolean;
  reviewBeatCloudCommit: boolean;
  browserCloudDownloads: boolean;
  browserCloudEditing: boolean;
  nativeFilesystemDrop: boolean;
  nativeExternalArtworkDrop: boolean;
  directGalerCloudTransport: boolean;
  offlinePackage: boolean;
  openProjectInDaw: boolean;
  revealLocalFile: boolean;
  watchFolders: boolean;
  installAppUpdates: boolean;
  trashLifecycle: boolean;
  cloudTrashTransactions: boolean;
  playbackCache: boolean;
  developerTools: boolean;
  localHelper: boolean;
  manualLibraryReorder: boolean;
}

export const DESKTOP_CAPABILITIES: Readonly<PlatformCapabilities> = Object.freeze({
  browserFileImport: false,
  singleBeatDrop: false,
  browserObjectPlayback: false,
  authorizedCloudPlayback: false,
  reviewBeatCloudCommit: false,
  browserCloudDownloads: false,
  browserCloudEditing: false,
  nativeFilesystemDrop: true,
  nativeExternalArtworkDrop: true,
  directGalerCloudTransport: true,
  offlinePackage: true,
  openProjectInDaw: true,
  revealLocalFile: true,
  watchFolders: true,
  installAppUpdates: true,
  trashLifecycle: true,
  cloudTrashTransactions: false,
  playbackCache: true,
  developerTools: true,
  localHelper: true,
  manualLibraryReorder: true,
});

/**
 * Conservative runtime matrix for the first Web foundation commit.
 * Capabilities turn true only when their Web implementation is complete.
 */
export const WEB_FOUNDATION_CAPABILITIES: Readonly<PlatformCapabilities> = Object.freeze({
  browserFileImport: true,
  singleBeatDrop: true,
  browserObjectPlayback: true,
  authorizedCloudPlayback: true,
  reviewBeatCloudCommit: true,
  browserCloudDownloads: true,
  browserCloudEditing: true,
  nativeFilesystemDrop: false,
  nativeExternalArtworkDrop: false,
  directGalerCloudTransport: false,
  offlinePackage: false,
  openProjectInDaw: false,
  revealLocalFile: false,
  watchFolders: false,
  installAppUpdates: false,
  trashLifecycle: true,
  cloudTrashTransactions: true,
  playbackCache: false,
  developerTools: false,
  localHelper: false,
  manualLibraryReorder: false,
});
