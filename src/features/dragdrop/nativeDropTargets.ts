import { extensionFromPath } from "./pathHelpers";

export type NativeDropPosition = { x?: number; y?: number } | null | undefined;

export type NativeDropTargetEnvironment = {
  devicePixelRatio?: number;
  elementFromPoint?: (x: number, y: number) => Element | null;
};

export type NativeFilesystemDropDestination =
  | { kind: "drawer"; target: string }
  | { kind: "card-artwork"; beatId: string }
  | { kind: "beat-card"; beatId: string }
  | { kind: "library" }
  | { kind: "none" };

export type NativeFilesystemDropRouting = {
  destination: NativeFilesystemDropDestination;
  hasAnyTarget: boolean;
  shouldClaimNativeLibraryDrop: boolean;
  diagnosticTarget: string;
};

export type NativeExternalImageDropDestination =
  | { kind: "drawer-artwork" }
  | { kind: "card-artwork"; beatId: string }
  | { kind: "none" };

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif", "avif"]);

function elementAtNativePosition(
  position: NativeDropPosition,
  environment: NativeDropTargetEnvironment = {},
): HTMLElement | null {
  if (!position || typeof position.x !== "number" || typeof position.y !== "number") return null;
  const scale = (environment.devicePixelRatio ?? (typeof window !== "undefined" ? window.devicePixelRatio : 1)) || 1;
  const elementFromPoint = environment.elementFromPoint ?? ((x: number, y: number) => {
    if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") return null;
    return document.elementFromPoint(x, y);
  });
  const candidates: Array<[number, number]> = [[position.x, position.y]];
  if (scale !== 1) candidates.push([position.x / scale, position.y / scale]);
  for (const [x, y] of candidates) {
    const element = elementFromPoint(x, y) as HTMLElement | null;
    if (element) return element;
  }
  return null;
}

function locateNativeDropTargets(
  position: NativeDropPosition,
  environment: NativeDropTargetEnvironment = {},
) {
  const target = elementAtNativePosition(position, environment);
  const artwork = target?.closest?.("[data-beat-artwork-id]") as HTMLElement | null;
  const card = target?.closest?.("[data-beat-card-id]") as HTMLElement | null;
  const library = target?.closest?.('[data-library-scroll="true"]') as HTMLElement | null;
  const drawerArtwork = target?.closest?.("[data-artwork-drop]") as HTMLElement | null;
  const drawerFileRow = target?.closest?.("[data-filerole]") as HTMLElement | null;
  return {
    artworkBeatId: artwork?.dataset.beatArtworkId ?? null,
    cardBeatId: card?.dataset.beatCardId ?? null,
    library: Boolean(library),
    drawerArtwork: Boolean(drawerArtwork),
    drawerTarget: drawerArtwork ? "artwork" : drawerFileRow?.dataset.filerole ?? null,
  };
}

export function isNativeImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionFromPath(path));
}

export function resolveNativeFilesystemDropTarget(
  paths: string[],
  position: NativeDropPosition,
  environment: NativeDropTargetEnvironment = {},
): NativeFilesystemDropRouting {
  const found = locateNativeDropTargets(position, environment);
  const localImage = paths.length === 1 && isNativeImagePath(paths[0]);
  let destination: NativeFilesystemDropDestination = { kind: "none" };
  if (found.drawerTarget) destination = { kind: "drawer", target: found.drawerTarget };
  else if (found.artworkBeatId && localImage) destination = { kind: "card-artwork", beatId: found.artworkBeatId };
  else if (paths.length > 0 && found.cardBeatId) destination = { kind: "beat-card", beatId: found.cardBeatId };
  else if (paths.length > 0 && found.library) destination = { kind: "library" };
  return {
    destination,
    hasAnyTarget: Boolean(found.drawerTarget || found.artworkBeatId || found.cardBeatId || found.library),
    shouldClaimNativeLibraryDrop: Boolean(found.cardBeatId || found.library),
    diagnosticTarget: found.drawerTarget ?? (found.artworkBeatId ? "card-artwork" : found.cardBeatId ? "beat-card" : found.library ? "library" : "none"),
  };
}

export function resolveNativeExternalImageDropTarget(
  position: NativeDropPosition,
  environment: NativeDropTargetEnvironment = {},
): NativeExternalImageDropDestination {
  const found = locateNativeDropTargets(position, environment);
  if (found.drawerArtwork) return { kind: "drawer-artwork" };
  if (found.artworkBeatId) return { kind: "card-artwork", beatId: found.artworkBeatId };
  return { kind: "none" };
}
