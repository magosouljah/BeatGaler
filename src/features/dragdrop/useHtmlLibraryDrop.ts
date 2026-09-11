import { useCallback, useEffect } from "react";
import type { Beat } from "../../types";
import { appAlert } from "../../lib/dialog";
import { fetchInternetArtworkDataUrl } from "../artwork/internetArtwork";
import { artworkFileToDataUrl } from "./browserArtwork";
import { cleanupStagedDropPaths } from "./dropStaging";
import { installHtmlDropController } from "./htmlDropController";
import { isBackupFolderPath } from "./pathHelpers";
import { isProjectDawFileName } from "../projects/projectFileTypes";

type HtmlBeatFileDrop = {
  beat: Beat;
  filePath: string;
  kind: "file" | "directory";
};

type UseHtmlLibraryDropOptions = {
  nativeDropAvailable: boolean;
  browserFileImport: boolean;
  reviewSkeletonEnabled: boolean;
  beatsLatestRef: { current: Beat[] };
  setDropActive: (active: boolean) => void;
  setBeatCloudUpdateBusy: (beatId: string, active: boolean, success?: boolean) => void;
  setBeatFileDrop: (value: HtmlBeatFileDrop | null) => void;
  setLibraryDropStaging: (active: boolean) => void;
  handleDropArtwork: (beat: Beat, imageBase64: string) => void | Promise<void>;
  handleAutoProjectDrop: (beat: Beat, filePath: string) => "not-project" | "handled" | "started" | Promise<"not-project" | "handled" | "started">;
  handleBrowserBeatAssetDrop: (beat: Beat, file: File, kind: "MASTER" | "WAV") => Promise<boolean>;
  handleBrowserProjectDrop: (beat: Beat, file: File) => Promise<boolean>;
  importDroppedBrowserFiles: (files: File[]) => void | Promise<void>;
  importDroppedPaths: (paths: string[]) => void | Promise<void>;
};

export function useHtmlLibraryDrop({
  nativeDropAvailable,
  browserFileImport,
  reviewSkeletonEnabled,
  beatsLatestRef,
  setDropActive,
  setBeatCloudUpdateBusy,
  setBeatFileDrop,
  setLibraryDropStaging,
  handleDropArtwork,
  handleAutoProjectDrop,
  handleBrowserBeatAssetDrop,
  handleBrowserProjectDrop,
  importDroppedBrowserFiles,
  importDroppedPaths,
}: UseHtmlLibraryDropOptions): void {
  const handleBrowserBeatFileDrop = useCallback(async (beatId: string, files: File[]): Promise<boolean> => {
    const beat = beatsLatestRef.current.find(item => item.id === beatId);
    if (!beat) throw new Error(`Dropped file target beat was not found: ${beatId}`);
    if (files.length !== 1) {
      await appAlert({ title: "Drop one file at a time", message: "Drop one MP3, WAV, DAW project file, or PROJECT ZIP on a beat." });
      return false;
    }

    const file = files[0];
    const name = file.name.toLowerCase();
    const kind = name.endsWith(".mp3") ? "MASTER" : name.endsWith(".wav") ? "WAV" : (name.endsWith(".zip") || isProjectDawFileName(name)) ? "PROJECT" : null;
    if (!kind) {
      await appAlert({ title: "Unsupported file", message: "BeatGaler Web accepts MP3, WAV, .flp, .als, .logicx, .rpp, .ptx, .ptf, or PROJECT ZIP files on an existing beat." });
      return false;
    }

    if (kind === "MASTER" || kind === "WAV") {
      return handleBrowserBeatAssetDrop(beat, file, kind);
    }

    return handleBrowserProjectDrop(beat, file);
  }, [beatsLatestRef, handleBrowserBeatAssetDrop, handleBrowserProjectDrop]);

  // Browser/Pinterest controller. Windows desktop keeps the existing single native
  // owner. macOS keeps HTML enabled for browser artwork while local Finder drops
  // are claimed by the native-path fast path before staging can begin.
  useEffect(() => {
    // On Windows desktop, WRY/Tauri owns the external drop. Explorer gives us
    // original paths with zero byte staging, while browser/Pinterest payloads
    // stay on that same native receiver. The HTML DataTransfer controller is
    // intentionally not installed there; otherwise the same local file drop
    // can fall back to File.arrayBuffer() and recreate the 20-40s staging delay.
    const windowsNativeDrop = nativeDropAvailable && /Windows/i.test(navigator.userAgent);
    if (windowsNativeDrop) return;

    return installHtmlDropController({
      setGlobalDropActive: setDropActive,
      onArtworkDrop: async (beatId, sources) => {
        const beat = beatsLatestRef.current.find(item => item.id === beatId);
        if (!beat) throw new Error(`Dropped artwork target beat was not found: ${beatId}`);

        setBeatCloudUpdateBusy(beat.id, true);
        try {
          const conversionErrors: string[] = [];
          let imageData: string | null = null;

          // Browser drags are intentionally multi-source. Pinterest/Chromium may
          // provide a CDN URL AND a virtual File; whichever representation works
          // first wins. A failed cloud URL fetch therefore cannot kill a usable
          // virtual-file drop, and vice versa.
          for (const source of sources) {
            try {
              const candidate = source.kind === "remote"
                ? (/^data:image\//i.test(source.url) ? source.url : await fetchInternetArtworkDataUrl(source.url))
                : await artworkFileToDataUrl(source.file);
              if (!/^data:image\//i.test(candidate) || candidate.length < 32) {
                throw new Error("Artwork source returned an invalid/empty image payload.");
              }
              imageData = candidate;
              console.info(`[dragdrop/artwork] resolved via ${source.kind}`);
              break;
            } catch (error) {
              conversionErrors.push(`${source.kind}: ${String(error)}`);
              console.warn(`[dragdrop/artwork] ${source.kind} candidate failed; trying fallback`, error);
            }
          }

          if (!imageData) {
            throw new Error(`Pinterest/browser artwork could not be decoded. ${conversionErrors.join(" | ")}`);
          }

          await handleDropArtwork(beat, imageData);
        } finally {
          setBeatCloudUpdateBusy(beat.id, false);
        }
      },
      onBeatFileDrop: async (beatId, roots) => {
        const beat = beatsLatestRef.current.find(item => item.id === beatId);
        if (!beat) return false;
        if (roots.length > 1) {
          await appAlert({
            title: "Drop one file at a time",
            message: "Drop a single file or folder on a beat so BeatGaler can assign it to the correct slot.",
          });
          return false;
        }
        const root = roots[0];
        if (isBackupFolderPath(root.path)) {
          await cleanupStagedDropPaths([root.path]).catch(() => {});
          await appAlert({
            title: "Backup folder skipped",
            message: "BeatGaler keeps Backup/Backups folders out of PROJECT.zip so old project copies are not uploaded.",
          });
          return false;
        }

        // Project files and PROJECT ZIPs have exactly one sensible destination,
        // so do not make the user answer a redundant "What are you adding?" page.
        // The card is already in its loading state while WebView2 stages/inspects
        // the drop, so large ZIPs never look like the app ignored them.
        const autoResult = await handleAutoProjectDrop(beat, root.path);
        if (autoResult === "started") return true;
        if (autoResult === "handled") return false;

        setBeatFileDrop({ beat, filePath: root.path, kind: root.kind });
        return false;
      },
      onBeatFileStagingChange: (beatId, active) => {
        setBeatCloudUpdateBusy(beatId, active, false);
      },
      onLibraryFileStagingChange: active => {
        if (!reviewSkeletonEnabled) return;
        setLibraryDropStaging(active);
      },
      onBrowserBeatFileDrop: browserFileImport ? handleBrowserBeatFileDrop : undefined,
      onBrowserLibraryFileDrop: browserFileImport ? importDroppedBrowserFiles : undefined,
      onLibraryFileDrop: async roots => {
        await importDroppedPaths(roots.map(root => root.path));
      },
      onEmptyFileDrop: async () => {
        await appAlert({
          title: "Nothing to import",
          message: "The desktop drag source reported files, but the app could not access any usable file or folder paths.",
        });
      },
      onError: async error => {
        console.error("HTML5 drag & drop failed:", error);
        await appAlert({ title: "Drag & drop failed", message: String(error), danger: true });
      },
    });
  }, [
    nativeDropAvailable,
    browserFileImport,
    reviewSkeletonEnabled,
    beatsLatestRef,
    setDropActive,
    setBeatCloudUpdateBusy,
    setBeatFileDrop,
    setLibraryDropStaging,
    handleDropArtwork,
    handleAutoProjectDrop,
    handleBrowserBeatFileDrop,
    importDroppedBrowserFiles,
    importDroppedPaths,
  ]);
}
