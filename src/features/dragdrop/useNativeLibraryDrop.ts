import { useEffect } from "react";
import type { Beat } from "../../types";
import { appAlert } from "../../lib/dialog";
import { diagnosticLog, isDirectoryPath, readImagePathAsDataUrl } from "../../lib/tauri";
import { fetchInternetArtworkDataUrl } from "../artwork/internetArtwork";
import { reviewPerfMark } from "../perf/reviewPerf";
import { nativeExternalImageSignalFromPaths } from "./nativeExternalImage";
import { claimNativeLibraryDrop } from "./nativeDropArbiter";
import { fileNameFromPath, isBackupFolderPath } from "./pathHelpers";
import { isNativeImagePath, resolveNativeExternalImageDropTarget, resolveNativeFilesystemDropTarget } from "./nativeDropTargets";

const MAX_NATIVE_DROP_ITEMS = 50;

type NativeBeatFileDrop = {
  beat: Beat;
  filePath: string;
  kind: "file" | "directory";
};

type UseNativeLibraryDropOptions = {
  nativeDropAvailable: boolean;
  reviewSkeletonEnabled: boolean;
  beatsLatestRef: { current: Beat[] };
  setDropActive: (active: boolean) => void;
  setBeatCloudUpdateBusy: (beatId: string, active: boolean, success?: boolean) => void;
  setBeatFileDrop: (value: NativeBeatFileDrop | null) => void;
  setLibraryDropStaging: (active: boolean) => void;
  handleDropArtwork: (beat: Beat, imageBase64: string) => void | Promise<void>;
  handleAutoProjectDrop: (
    beat: Beat,
    filePath: string,
  ) => "not-project" | "handled" | "started" | Promise<"not-project" | "handled" | "started">;
  importDroppedPaths: (paths: string[]) => void | Promise<void>;
};

export function useNativeLibraryDrop({
  nativeDropAvailable,
  reviewSkeletonEnabled,
  beatsLatestRef,
  setDropActive,
  setBeatCloudUpdateBusy,
  setBeatFileDrop,
  setLibraryDropStaging,
  handleDropArtwork,
  handleAutoProjectDrop,
  importDroppedPaths,
}: UseNativeLibraryDropOptions): void {
  useEffect(() => {
    if (!nativeDropAvailable) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let activePaths: string[] = [];
    let activeExternalImage = false;

    type NativeFsPayload = {
      paths: string[];
      position?: { x: number; y: number } | null;
    };

    type NativeExternalImageDropDetail = {
      x: number;
      y: number;
      url: string;
      source: "pinterest" | "browser";
    };


    const clearNativeDragUi = () => {
      setDropActive(false);
      window.dispatchEvent(new CustomEvent("beatgaler:artwork-drag", { detail: { beatId: null, active: false } }));
      window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", { detail: { beatId: null, active: false } }));
      window.dispatchEvent(new CustomEvent("beatgaler:drawer-native-hover", { detail: { target: null, active: false } }));
    };

    const updateNativeExternalImageUi = (position: { x?: number; y?: number } | null | undefined) => {
      const destination = resolveNativeExternalImageDropTarget(position);
      const artworkBeatId = destination.kind === "card-artwork" ? destination.beatId : null;
      const drawerArtwork = destination.kind === "drawer-artwork";
      setDropActive(false);
      window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", { detail: { beatId: null, active: false } }));
      window.dispatchEvent(new CustomEvent("beatgaler:artwork-drag", {
        detail: { beatId: artworkBeatId, active: Boolean(artworkBeatId) },
      }));
      window.dispatchEvent(new CustomEvent("beatgaler:drawer-native-hover", {
        detail: { target: drawerArtwork ? "artwork" : null, active: Boolean(drawerArtwork) },
      }));
    };

    const updateNativeDragUi = (payload: NativeFsPayload) => {
      const routing = resolveNativeFilesystemDropTarget(payload.paths, payload.position);
      const drawerTarget = routing.destination.kind === "drawer" ? routing.destination.target : null;
      const artworkBeatId = routing.destination.kind === "card-artwork" ? routing.destination.beatId : null;
      const cardBeatId = routing.destination.kind === "beat-card" ? routing.destination.beatId : null;

      if (drawerTarget) {
        setDropActive(false);
        window.dispatchEvent(new CustomEvent("beatgaler:artwork-drag", { detail: { beatId: null, active: false } }));
        window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", { detail: { beatId: null, active: false } }));
        window.dispatchEvent(new CustomEvent("beatgaler:drawer-native-hover", {
          detail: { target: drawerTarget, active: true },
        }));
        return;
      }

      window.dispatchEvent(new CustomEvent("beatgaler:drawer-native-hover", { detail: { target: null, active: false } }));

      if (artworkBeatId) {
        setDropActive(false);
        window.dispatchEvent(new CustomEvent("beatgaler:artwork-drag", { detail: { beatId: artworkBeatId, active: true } }));
        window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", { detail: { beatId: null, active: false } }));
        return;
      }

      if (payload.paths.length > 0 && cardBeatId) {
        setDropActive(false);
        window.dispatchEvent(new CustomEvent("beatgaler:artwork-drag", { detail: { beatId: null, active: false } }));
        window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", { detail: { beatId: cardBeatId, active: true } }));
        return;
      }

      window.dispatchEvent(new CustomEvent("beatgaler:artwork-drag", { detail: { beatId: null, active: false } }));
      window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", { detail: { beatId: null, active: false } }));
      setDropActive(routing.destination.kind === "library");
    };

    const resolveNativeArtwork = async (beatId: string, imagePath: string) => {
      const beat = beatsLatestRef.current.find(item => item.id === beatId);
      if (!beat) throw new Error(`Dropped artwork target beat was not found: ${beatId}`);
      const imageData = await readImagePathAsDataUrl(imagePath);
      if (!/^data:image\//i.test(imageData)) throw new Error("Dropped file is not a usable image.");
      setBeatCloudUpdateBusy(beat.id, true);
      try {
        await handleDropArtwork(beat, imageData);
      } finally {
        setBeatCloudUpdateBusy(beat.id, false);
      }
    };

    const resolveNativeExternalImage = async (detail: NativeExternalImageDropDetail) => {
      // Routing decision happens at the final drop coordinates. Pinterest/browser
      // URLs never enter Import Beat and are accepted only by an artwork target.
      const destination = resolveNativeExternalImageDropTarget(detail);
      const drawerArtwork = destination.kind === "drawer-artwork";
      const beatId = destination.kind === "card-artwork" ? destination.beatId : null;
      if (drawerArtwork) {
        const imageData = await fetchInternetArtworkDataUrl(detail.url);
        if (!/^data:image\//i.test(imageData) || imageData.length < 32) {
          throw new Error("Pinterest/browser artwork returned an invalid image payload.");
        }
        window.dispatchEvent(new CustomEvent("beatgaler:drawer-artwork-data", { detail: { imageData } }));
        return;
      }
      if (!beatId) return;
      const beat = beatsLatestRef.current.find(item => item.id === beatId);
      if (!beat) return;

      setBeatCloudUpdateBusy(beat.id, true);
      try {
        const imageData = await fetchInternetArtworkDataUrl(detail.url);
        if (!/^data:image\//i.test(imageData) || imageData.length < 32) {
          throw new Error("Pinterest/browser artwork returned an invalid image payload.");
        }
        await handleDropArtwork(beat, imageData);
      } finally {
        setBeatCloudUpdateBusy(beat.id, false);
      }
    };

    const onNativeExternalImageDrop = (event: Event) => {
      const detail = (event as CustomEvent<NativeExternalImageDropDetail>).detail;
      if (!detail || typeof detail.x !== "number" || typeof detail.y !== "number" || typeof detail.url !== "string") return;
      void resolveNativeExternalImage(detail).catch(async error => {
        console.error("Native external artwork drop failed:", error);
        await appAlert({ title: "Artwork drop failed", message: String(error), danger: true });
      });
    };
    window.addEventListener("native-external-image-drop", onNativeExternalImageDrop);

    const handleNativeBeatDrop = async (beatId: string, paths: string[]) => {
      const beat = beatsLatestRef.current.find(item => item.id === beatId);
      if (!beat) return;
      if (paths.length !== 1) {
        await appAlert({
          title: "Drop one file at a time",
          message: "Drop a single file or folder on a beat so BeatGaler can assign it to the correct slot.",
        });
        return;
      }

      const filePath = paths[0];
      if (isBackupFolderPath(filePath)) {
        await appAlert({
          title: "Backup folder skipped",
          message: "BeatGaler keeps Backup/Backups folders out of PROJECT.zip so old project copies are not uploaded.",
        });
        return;
      }

      setBeatCloudUpdateBusy(beat.id, true, false);
      try {
        const autoResult = await handleAutoProjectDrop(beat, filePath);
        if (autoResult === "started") return;
        if (autoResult === "handled") {
          setBeatCloudUpdateBusy(beat.id, false, false);
          return;
        }
        const directory = await isDirectoryPath(filePath);
        setBeatCloudUpdateBusy(beat.id, false, false);
        setBeatFileDrop({ beat, filePath, kind: directory ? "directory" : "file" });
      } catch (error) {
        setBeatCloudUpdateBusy(beat.id, false, false);
        throw error;
      }
    };

    const handleNativeDrop = async (payload: NativeFsPayload) => {
      // Reserved external-image sentinels are intercepted in onDragDropEvent
      // before this local-filesystem router can ever be called.
      const routing = resolveNativeFilesystemDropTarget(payload.paths, payload.position);
      const drawerTarget = routing.destination.kind === "drawer" ? routing.destination.target : null;
      const artworkBeatId = routing.destination.kind === "card-artwork" ? routing.destination.beatId : null;
      const cardBeatId = routing.destination.kind === "beat-card" ? routing.destination.beatId : null;
      const library = routing.destination.kind === "library";
      clearNativeDragUi();

      reviewPerfMark(`TAURI_NATIVE_DROP path_count=${payload.paths.length} target=${routing.diagnosticTarget} names=${payload.paths.map(fileNameFromPath).slice(0, 12).join("|")}`);

      if (payload.paths.length === 0) {
        if (routing.hasAnyTarget) {
          await appAlert({
            title: "Drop could not be read",
            message: "The drop reached BeatGaler, but macOS supplied no filesystem path. Try selecting the file with the button instead.",
            danger: true,
          });
        }
        return;
      }
      if (drawerTarget) {
        if (payload.paths.length !== 1) {
          await appAlert({ title: "Drop one file", message: "Choose one file for this field." });
          return;
        }
        if (drawerTarget === "artwork" && !isNativeImagePath(payload.paths[0])) {
          await appAlert({ title: "Artwork must be an image", message: "Choose a PNG, JPEG, WebP, GIF, BMP, or AVIF image." });
          return;
        }
        window.dispatchEvent(new CustomEvent("beatgaler:drawer-native-path", {
          detail: { target: drawerTarget, path: payload.paths[0] },
        }));
        return;
      }
      if (routing.shouldClaimNativeLibraryDrop) claimNativeLibraryDrop();
      if (payload.paths.length > MAX_NATIVE_DROP_ITEMS) {
        await appAlert({
          title: "Too many items",
          message: `Drop up to ${MAX_NATIVE_DROP_ITEMS} files/folders at a time. A parent folder still counts as one item.`,
        });
        return;
      }

      if (artworkBeatId) {
        await resolveNativeArtwork(artworkBeatId, payload.paths[0]);
        return;
      }

      if (cardBeatId) {
        await handleNativeBeatDrop(cardBeatId, payload.paths);
        return;
      }

      if (!library) return;

      // Native fast path: Tauri gives us the original Finder/Explorer paths. No
      // DataTransfer File.arrayBuffer(), no drop-staging, and no pre-Review copy.
      if (reviewSkeletonEnabled) setLibraryDropStaging(true);
      const started = performance.now();
      reviewPerfMark(`NATIVE_LIBRARY_IMPORT_START path_count=${payload.paths.length}`);
      try {
        await importDroppedPaths(payload.paths);
        reviewPerfMark(`NATIVE_LIBRARY_IMPORT_READY elapsed_ms=${Math.round(performance.now() - started)}`);
      } finally {
        if (reviewSkeletonEnabled) setLibraryDropStaging(false);
      }
    };

    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const stop = await getCurrentWebview().onDragDropEvent(event => {
          const payload = event.payload as any;
          if (!payload) return;
          const eventPaths = Array.isArray(payload.paths)
            ? payload.paths.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
            : [];
          const eventPosition = payload.position && typeof payload.position.x === "number" && typeof payload.position.y === "number"
            ? `${Math.round(payload.position.x)},${Math.round(payload.position.y)}`
            : "none";
          if (payload.type !== "over") {
            reviewPerfMark(
              `TAURI_NATIVE_EVENT type=${String(payload.type)} path_count=${eventPaths.length} active_path_count=${activePaths.length} position=${eventPosition} names=${eventPaths.map(fileNameFromPath).slice(0, 8).join("|")}`,
            );
          }

          if (payload.type === "leave") {
            activePaths = [];
            activeExternalImage = false;
            clearNativeDragUi();
            return;
          }

          if (payload.type === "enter") {
            const incomingPaths = eventPaths;
            const externalSignal = nativeExternalImageSignalFromPaths(incomingPaths);
            if (externalSignal?.kind === "pending") {
              activePaths = [];
              activeExternalImage = true;
              reviewPerfMark("NATIVE_EXTERNAL_IMAGE_ENTER");
              updateNativeExternalImageUi(payload.position);
              return;
            }

            activeExternalImage = false;
            activePaths = incomingPaths;
            reviewPerfMark(`TAURI_NATIVE_ENTER path_count=${activePaths.length}`);
            updateNativeDragUi({ paths: activePaths, position: payload.position });
            return;
          }

          if (payload.type === "over") {
            if (activeExternalImage) updateNativeExternalImageUi(payload.position);
            else updateNativeDragUi({ paths: activePaths, position: payload.position });
            return;
          }

          if (payload.type !== "drop") return;
          const incomingPaths = eventPaths.length > 0 ? eventPaths : activePaths;
          const externalSignal = nativeExternalImageSignalFromPaths(incomingPaths);
          const wasExternalImage = activeExternalImage;
          activePaths = [];
          activeExternalImage = false;

          if (externalSignal?.kind === "drop") {
            clearNativeDragUi();
            const position = payload.position;
            if (!position || typeof position.x !== "number" || typeof position.y !== "number") return;
            reviewPerfMark(`NATIVE_EXTERNAL_IMAGE_DROP source=${externalSignal.source}`);
            window.dispatchEvent(new CustomEvent("native-external-image-drop", {
              detail: {
                x: position.x,
                y: position.y,
                url: externalSignal.url,
                source: externalSignal.source,
              } satisfies NativeExternalImageDropDetail,
            }));
            return;
          }

          // WRY recognized a browser payload on Enter but could not resolve a
          // direct image URL on Drop. Clear feedback and intentionally no-op;
          // never reinterpret it as a local beat import.
          if (wasExternalImage) {
            clearNativeDragUi();
            reviewPerfMark("NATIVE_EXTERNAL_IMAGE_DROP unresolved");
            void diagnosticLog(
              "native-drop",
              "EXTERNAL_IMAGE_UNRESOLVED",
              "macOS exposed a browser drag type but no usable http(s) image URL",
            );
            void appAlert({
              title: "Could not read the dragged browser image",
              message: "The browser did not expose an image URL to BeatGaler. Try opening the full-size image before dragging it, or use the artwork button to choose a downloaded file.",
            });
            return;
          }

          void handleNativeDrop({ paths: incomingPaths, position: payload.position }).catch(async error => {
            console.error("Tauri native file drop failed:", error);
            await appAlert({ title: "Drag & drop failed", message: String(error), danger: true });
          });
        });
        if (cancelled) stop();
        else unlisten = stop;
      } catch (error) {
        console.error("Tauri native drag/drop listener failed:", error);
        reviewPerfMark(`TAURI_NATIVE_LISTENER_ERROR error=${String(error)}`);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      activePaths = [];
      activeExternalImage = false;
      window.removeEventListener("native-external-image-drop", onNativeExternalImageDrop);
      clearNativeDragUi();
    };
  }, [handleAutoProjectDrop, handleDropArtwork, importDroppedPaths]);

}
