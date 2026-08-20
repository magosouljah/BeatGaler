import {
  captureArtworkSourcesFromDataTransfer,
  looksLikeArtworkDrop,
  type ArtworkDropSource,
} from "./browserArtwork";
import { captureHtmlDrop, stageCapturedHtmlDrop, type HtmlDroppedRoot } from "./dropStaging";
import { preferredExternalDropEffect } from "./externalDropEffect";
import { reviewPerfMark } from "../perf/reviewPerf";
import { waitForNativeLibraryDropClaim } from "./nativeDropArbiter";

const MAX_HTML_DROP_ITEMS = 50;

export type HtmlDropControllerOptions = {
  setGlobalDropActive: (active: boolean) => void;
  onArtworkDrop: (beatId: string, sources: ArtworkDropSource[]) => void | Promise<void>;
  // Return true when the beat-level handler handed the busy state to a long-running
  // card update. Return false/void when staging is finished and the controller may
  // release the temporary busy state.
  onBeatFileDrop: (beatId: string, roots: HtmlDroppedRoot[]) => boolean | void | Promise<boolean | void>;
  onBeatFileStagingChange?: (beatId: string, active: boolean) => void;
  // Library drops can spend noticeable time staging WebView2 File objects before
  // Rust has real paths. Tell App at the exact DROP boundary so Instant Review
  // can paint its skeleton before any file bytes are copied.
  onLibraryFileStagingChange?: (active: boolean) => void;
  onLibraryFileDrop: (roots: HtmlDroppedRoot[]) => void | Promise<void>;
  onEmptyFileDrop?: () => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
};

function acceptExternalDrag(event: DragEvent, dataTransfer: DataTransfer): void {
  event.preventDefault();
  event.stopPropagation();
  dataTransfer.dropEffect = preferredExternalDropEffect(dataTransfer.effectAllowed);
}

function closestArtwork(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement
    ? target.closest("[data-beat-artwork-id]") as HTMLElement | null
    : null;
}

function closestCard(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement
    ? target.closest("[data-beat-card-id]") as HTMLElement | null
    : null;
}

function artworkAt(x: number, y: number): HTMLElement | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  return el?.closest?.("[data-beat-artwork-id]") as HTMLElement | null;
}

function cardAt(x: number, y: number): HTMLElement | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  return el?.closest?.("[data-beat-card-id]") as HTMLElement | null;
}

function artworkForEvent(event: DragEvent): HTMLElement | null {
  return closestArtwork(event.target) ?? artworkAt(event.clientX, event.clientY);
}

function cardForEvent(event: DragEvent): HTMLElement | null {
  return closestCard(event.target) ?? cardAt(event.clientX, event.clientY);
}

function hasFilePayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types || []).includes("Files") ||
    Array.from(dataTransfer.items || []).some(item => item.kind === "file");
}

function isLocallyOwnedDrop(event: DragEvent): boolean {
  const target = event.target as HTMLElement | null;
  return Boolean(target?.closest?.('[data-beatgaler-drop-owner="local"]'));
}

function dispatchDragUi(
  options: HtmlDropControllerOptions,
  artworkBeatId: string | null,
  beatUpdateId: string | null,
  globalActive: boolean,
) {
  options.setGlobalDropActive(globalActive);
  window.dispatchEvent(new CustomEvent("beatgaler:artwork-drag", {
    detail: { beatId: artworkBeatId, active: Boolean(artworkBeatId) },
  }));
  window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", {
    detail: { beatId: beatUpdateId, active: Boolean(beatUpdateId) },
  }));
}

export function installHtmlDropController(options: HtmlDropControllerOptions): () => void {
  let lastUiState = "";
  let lastArtworkBeatId: string | null = null;
  let lastBeatUpdateId: string | null = null;

  const setUi = (artworkBeatId: string | null, beatUpdateId: string | null, globalActive: boolean) => {
    // These are fallbacks only for the exact drop boundary where WebView2 may
    // lose event.target. They must mirror the CURRENT hover target. Keeping a
    // previous card id after the pointer moved into empty library space makes a
    // global import accidentally update that old beat.
    lastArtworkBeatId = artworkBeatId;
    lastBeatUpdateId = beatUpdateId;
    const next = `${artworkBeatId ?? ""}|${beatUpdateId ?? ""}|${globalActive ? 1 : 0}`;
    if (next === lastUiState) return;
    lastUiState = next;
    dispatchDragUi(options, artworkBeatId, beatUpdateId, globalActive);
  };
  const clearUi = () => setUi(null, null, false);
  const clearAll = () => {
    lastArtworkBeatId = null;
    lastBeatUpdateId = null;
    clearUi();
  };

  const onDragEnter = (event: DragEvent) => {
    if (isLocallyOwnedDrop(event)) return;
    const dt = event.dataTransfer;
    if (!dt) return;
    acceptExternalDrag(event, dt);
  };

  const onDragOver = (event: DragEvent) => {
    if (isLocallyOwnedDrop(event)) {
      clearAll();
      return;
    }
    const dt = event.dataTransfer;
    if (!dt) {
      clearAll();
      return;
    }

    acceptExternalDrag(event, dt);

    const artwork = artworkForEvent(event);
    const card = cardForEvent(event);
    const hasFiles = hasFilePayload(dt);

    // During dragover the HTML drag store is deliberately in protected mode:
    // types/kinds are visible, actual bytes/strings may not be. Never require
    // getData()/files here to decide whether the user is allowed to drop.
    if (artwork && (looksLikeArtworkDrop(dt) || !hasFiles)) {
      setUi(artwork.dataset.beatArtworkId ?? null, null, false);
      return;
    }

    if (hasFiles) {
      lastArtworkBeatId = null;
      if (card) setUi(null, card.dataset.beatCardId ?? null, false);
      else setUi(null, null, true);
      return;
    }

    setUi(null, null, false);
  };

  const onDrop = (event: DragEvent) => {
    const htmlDropStartedAt = performance.now();
    const dt0 = event.dataTransfer;
    reviewPerfMark(`HTML_DROP_EVENT files=${dt0?.files?.length ?? 0} items=${dt0?.items?.length ?? 0} types=${Array.from(dt0?.types ?? []).join("|")}`);
    console.info("[review-perf] HTML_DROP_RECEIVED 0 ms");
    if (isLocallyOwnedDrop(event)) {
      clearAll();
      return;
    }
    const dt = event.dataTransfer;
    if (!dt) {
      clearAll();
      return;
    }

    acceptExternalDrag(event, dt);

    const artwork = artworkForEvent(event);
    const artworkBeatId = artwork?.dataset.beatArtworkId ?? lastArtworkBeatId;
    const artworkCandidate = Boolean(artworkBeatId && looksLikeArtworkDrop(dt));

    if (artworkBeatId && artworkCandidate) {
      // IMPORTANT: start getAsFile()/getAsString() reads synchronously while the
      // `drop` event still owns the read-only drag store. The returned Promise may
      // resolve after the event, but every browser read has already been requested.
      const diagnosticTypes = Array.from(dt.types || []);
      const readableStrings = diagnosticTypes
        .filter(type => type.toLowerCase() !== "chromium/x-drag-id")
        .map(type => {
          try {
            const raw = dt.getData(type);
            const preview = raw ? raw.slice(0, 120).replace(/\s+/g, " ") : "";
            return `${type}:${raw.length}${preview ? `:${preview}` : ""}`;
          } catch {
            return `${type}:unreadable`;
          }
        });
      const diagnostic = {
        types: diagnosticTypes,
        files: Array.from(dt.files || []).map(file => `${file.name || "(unnamed)"}:${file.type || "(no-type)"}:${file.size}`),
        items: Array.from(dt.items || []).map(item => `${item.kind}:${item.type || "(no-type)"}`),
        strings: readableStrings,
      };
      const sourceCapture = captureArtworkSourcesFromDataTransfer(dt);
      clearAll();
      void (async () => {
        try {
          const sources = await sourceCapture;
          if (sources.length === 0) {
            throw new Error(
              `The browser drop reached the artwork, but the embedded browser exposed no usable image payload. ` +
              `types=[${diagnostic.types.join(", ")}], files=[${diagnostic.files.join(", ")}], ` +
              `items=[${diagnostic.items.join(", ")}], strings=[${diagnostic.strings.join(" | ")}].`,
            );
          }
          await options.onArtworkDrop(artworkBeatId, sources);
        } catch (error) {
          await options.onError?.(error);
        }
      })();
      return;
    }

    if (!hasFilePayload(dt)) {
      const hadArtworkTarget = Boolean(artworkBeatId);
      const types = Array.from(dt.types || []).join(", ") || "(none)";
      clearAll();
      if (hadArtworkTarget) {
        void options.onError?.(new Error(
          `The browser drop reached the artwork, but it advertised no image/file payload. Drag types: ${types}.`,
        ));
      }
      return;
    }

    const card = cardForEvent(event);
    if (!card && dt.files.length > MAX_HTML_DROP_ITEMS) {
      clearAll();
      void options.onError?.(new Error(
        `Drop up to ${MAX_HTML_DROP_ITEMS} files/folders at a time. A parent folder still counts as one item.`
      ));
      return;
    }
    // WebView2 can lose event.target at the exact drop boundary. Remember the card
    // seen during dragover so a project file dropped on a beat cannot fall through
    // into the global library importer (which would report "Nothing to import").
    const beatId = card?.dataset.beatCardId ?? lastBeatUpdateId;
    const capturedDrop = captureHtmlDrop(dt);
    if (beatId) options.onBeatFileStagingChange?.(beatId, true);
    clearAll();

    void (async () => {
      try {
        // macOS can expose the same Finder drop through both WebView HTML5 and
        // Tauri native paths. Give the native fast path a tiny claim window; if
        // it wins, do not copy the File payload into staging a second time.
        if (await waitForNativeLibraryDropClaim(htmlDropStartedAt)) {
          if (beatId) options.onBeatFileStagingChange?.(beatId, false);
          return;
        }
        if (!beatId) {
          // On Windows, the native OLE router owns Explorer/Pinterest drops before
          // they become DOM events. Reaching this HTML path therefore means either
          // a non-Windows build or a native-router fallback. Show feedback and stage
          // only in that fallback; the normal Windows B path never gets here.
          options.onLibraryFileStagingChange?.(true);
          reviewPerfMark(`HTML_FALLBACK_STAGING_START elapsed_ms=${Math.round(performance.now() - htmlDropStartedAt)}`);
          console.info(`[review-perf] HTML_FALLBACK_STAGING_START ${Math.round(performance.now() - htmlDropStartedAt)} ms`);
          await new Promise<void>(resolve => {
            requestAnimationFrame(() => window.setTimeout(resolve, 0));
          });
        }
        const stagingStarted = performance.now();
        const roots = await stageCapturedHtmlDrop(capturedDrop);
        if (!beatId) {
          const totalElapsed = Math.round(performance.now() - htmlDropStartedAt);
          reviewPerfMark(`HTML_FALLBACK_STAGING_FINISHED stage_ms=${Math.round(performance.now() - stagingStarted)} total_elapsed_ms=${totalElapsed} roots=${roots.length}`);
          console.info(`[review-perf] HTML_FALLBACK_STAGING_FINISHED ${totalElapsed} ms`);
        }
        if (roots.length === 0) {
          if (beatId) options.onBeatFileStagingChange?.(beatId, false);
          else options.onLibraryFileStagingChange?.(false);
          await options.onEmptyFileDrop?.();
          return;
        }
        if (beatId) {
          const keepBusy = await options.onBeatFileDrop(beatId, roots);
          if (!keepBusy) options.onBeatFileStagingChange?.(beatId, false);
        } else {
          await options.onLibraryFileDrop(roots);
          options.onLibraryFileStagingChange?.(false);
        }
      } catch (error) {
        reviewPerfMark(`HTML_DROP_ERROR elapsed_ms=${Math.round(performance.now() - htmlDropStartedAt)} error=${String(error)}`);
        if (beatId) options.onBeatFileStagingChange?.(beatId, false);
        else options.onLibraryFileStagingChange?.(false);
        await options.onError?.(error);
      }
    })();
  };

  const onDragLeave = (event: DragEvent) => {
    if (event.relatedTarget == null) clearAll();
  };

  document.addEventListener("dragenter", onDragEnter, true);
  document.addEventListener("dragover", onDragOver, true);
  document.addEventListener("drop", onDrop, true);
  document.addEventListener("dragleave", onDragLeave, true);

  return () => {
    document.removeEventListener("dragenter", onDragEnter, true);
    document.removeEventListener("dragover", onDragOver, true);
    document.removeEventListener("drop", onDrop, true);
    document.removeEventListener("dragleave", onDragLeave, true);
    clearAll();
  };
}
