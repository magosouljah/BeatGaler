import type { GalerCloudObjectRef } from "../../domain/beat";
import type { Beat } from "../../types";
import type {
  PlatformDownloadKind,
  PlatformDownloadProgress,
  PlatformDownloadTask,
} from "../../platform/contracts";
import { buildBeatGalerId3Tag, type Mp3Artwork } from "../audio/mp3Metadata";
import type { WebTransportStreamInput, WebTransportStreamResult } from "../cloud/webTransportWorkerProtocol";

type SingleKind = Exclude<PlatformDownloadKind, "ALL">;

interface WebDownloadTransport {
  streamFile(
    input: WebTransportStreamInput,
    onChunk: (chunk: ArrayBuffer, downloadedBytes: number, totalBytes: number) => void | Promise<void>,
  ): Promise<{ completed: Promise<WebTransportStreamResult>; cancel(): void }>;
}

type BrowserWritable = {
  write(data: BufferSource | Blob | string): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
};

type BrowserFileHandle = { createWritable(): Promise<BrowserWritable> };
type BrowserDirectoryHandle = {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<BrowserDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<BrowserFileHandle>;
};

type DownloadWindow = Window & {
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<BrowserFileHandle>;
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<BrowserDirectoryHandle>;
};

type DownloadAsset = {
  kind: SingleKind;
  ref: GalerCloudObjectRef | null;
  filename: string;
  mimeType: string;
  size: number;
  inlineDataUrl: string | null;
};

type CachedArtwork = Mp3Artwork & { messageId: number | null };

function safeName(value: string, fallback: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim() || fallback;
}

function extensionForMime(mime: string): string {
  if (/jpe?g/i.test(mime)) return "jpg";
  if (/webp/i.test(mime)) return "webp";
  if (/gif/i.test(mime)) return "gif";
  if (/bmp/i.test(mime)) return "bmp";
  if (/avif/i.test(mime)) return "avif";
  return "png";
}

function messageId(ref: GalerCloudObjectRef | null): number | null {
  const match = /^direct:(\d+)$/.exec(String(ref?.object_id || ""));
  const id = Number(match?.[1] || 0);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function assetsForBeat(beat: Beat): DownloadAsset[] {
  const base = safeName(beat.name || "Beat", "Beat");
  const meta = [beat.bpm?.trim(), beat.key?.trim()].filter(Boolean).join(" ");
  const audioBase = meta && !base.endsWith(`[${meta}]`) ? `${base} [${meta}]` : base;
  const artworkMime = beat.assets?.artwork?.mime_type || beat.image_base64?.match(/^data:([^;,]+)/)?.[1] || "image/png";
  const assets: DownloadAsset[] = [
    { kind: "MP3", ref: beat.assets?.master || null, filename: `${audioBase}.mp3`, mimeType: beat.assets?.master?.mime_type || "audio/mpeg", size: beat.assets?.master?.size_bytes || 0, inlineDataUrl: null },
    { kind: "WAV", ref: beat.assets?.wav || null, filename: `${audioBase}.wav`, mimeType: beat.assets?.wav?.mime_type || "audio/wav", size: beat.assets?.wav?.size_bytes || 0, inlineDataUrl: null },
    { kind: "ARTWORK", ref: beat.assets?.artwork || null, filename: `${base}-artwork.${extensionForMime(artworkMime)}`, mimeType: artworkMime, size: beat.assets?.artwork?.size_bytes || 0, inlineDataUrl: beat.assets?.artwork ? null : beat.image_base64 || null },
    { kind: "PROJECT", ref: beat.assets?.project || null, filename: `${base}.zip`, mimeType: beat.assets?.project?.mime_type || "application/zip", size: beat.assets?.project?.size_bytes || 0, inlineDataUrl: null },
  ];
  return assets.filter(asset => messageId(asset.ref) !== null || Boolean(asset.inlineDataUrl));
}

function abortError(): DOMException {
  return new DOMException("Download cancelled.", "AbortError");
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function uniqueDirectory(root: BrowserDirectoryHandle, base: string): Promise<BrowserDirectoryHandle> {
  for (let index = 0; index < 1000; index += 1) {
    const name = index === 0 ? base : `${base} (${index + 1})`;
    try {
      await root.getDirectoryHandle(name);
    } catch {
      return root.getDirectoryHandle(name, { create: true });
    }
  }
  return root.getDirectoryHandle(`${base}-${Date.now()}`, { create: true });
}

export class WebDownloadsManager {
  private tasks = new Map<string, { cancel(): void }>();

  constructor(private readonly transport: WebDownloadTransport | Promise<WebDownloadTransport>) {}

  start(
    beat: Beat,
    kind: PlatformDownloadKind,
    onProgress?: (progress: PlatformDownloadProgress) => void,
  ): PlatformDownloadTask {
    const available = assetsForBeat(beat);
    const assets = kind === "ALL" ? available : available.filter(asset => asset.kind === kind);
    if (assets.length === 0) throw new Error(`${kind === "ALL" ? "Files are" : `${kind} is`} not available for this beat.`);

    const id = crypto.randomUUID();
    const controller = new AbortController();
    let activeCancel: (() => void) | null = null;
    let activeWritable: BrowserWritable | null = null;
    let cachedCloudArtwork: CachedArtwork | null | undefined;
    const browser = window as DownloadWindow;
    const singleHandle = kind !== "ALL" && browser.showSaveFilePicker
      ? browser.showSaveFilePicker({ suggestedName: assets[0].filename })
      : null;
    const rootHandle = kind === "ALL" && browser.showDirectoryPicker
      ? browser.showDirectoryPicker({ mode: "readwrite" })
      : null;

    const cancel = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      activeCancel?.();
      void activeWritable?.abort(abortError()).catch(() => {});
    };
    this.tasks.set(id, { cancel });

    const completed = (async (): Promise<{ cancelled: boolean }> => {
      const loadArtworkForMp3 = async (): Promise<Mp3Artwork | null> => {
        if (beat.image_base64) {
          const blob = await (await fetch(beat.image_base64)).blob();
          if (controller.signal.aborted) throw abortError();
          return { mimeType: blob.type || "image/png", bytes: await blob.arrayBuffer() };
        }
        if (cachedCloudArtwork !== undefined) return cachedCloudArtwork;
        const artworkRef = beat.assets?.artwork || null;
        const artworkMessageId = messageId(artworkRef);
        if (!artworkMessageId) {
          cachedCloudArtwork = null;
          return null;
        }
        const chunks: ArrayBuffer[] = [];
        const transport = await this.transport;
        const stream = await transport.streamFile({ messageId: artworkMessageId, mimeType: artworkRef?.mime_type || "image/png" }, chunk => {
          if (controller.signal.aborted) throw abortError();
          chunks.push(chunk);
        });
        activeCancel = stream.cancel;
        await stream.completed;
        activeCancel = null;
        if (controller.signal.aborted) throw abortError();
        cachedCloudArtwork = {
          mimeType: artworkRef?.mime_type || "image/png",
          bytes: await new Blob(chunks).arrayBuffer(),
          messageId: artworkMessageId,
        };
        return cachedCloudArtwork;
      };

      try {
        const totalBytes = assets.reduce((sum, asset) => sum + Math.max(0, asset.size), 0);
        let completedBytes = 0;
        let directory: BrowserDirectoryHandle | null = null;
        if (rootHandle) {
          const root = await rootHandle;
          if (controller.signal.aborted) throw abortError();
          directory = await uniqueDirectory(root, safeName(beat.name || "Beat", "Beat"));
        }

        for (const asset of assets) {
          if (controller.signal.aborted) throw abortError();
          const handle = singleHandle
            ? await singleHandle
            : directory
              ? await directory.getFileHandle(asset.filename, { create: true })
              : null;
          if (controller.signal.aborted) throw abortError();
          const writable = handle ? await handle.createWritable() : null;
          activeWritable = writable;
          const chunks: ArrayBuffer[] = [];
          let assetBytes = 0;

          // Cloud MASTER intentionally has no ID3. Rehydrate BeatGaler INDEX metadata and
          // the dedicated artwork slot only at export/download time.
          if (asset.kind === "MP3") {
            const artwork = await loadArtworkForMp3();
            const id3 = buildBeatGalerId3Tag({
              name: beat.name,
              bpm: beat.bpm,
              key: beat.key,
              tags: beat.tags,
              rating: beat.rating,
            }, artwork);
            const id3Buffer = exactArrayBuffer(id3);
            if (writable) await writable.write(id3Buffer);
            else chunks.push(id3Buffer);
          }

          if (asset.inlineDataUrl) {
            const blob = await (await fetch(asset.inlineDataUrl)).blob();
            const buffer = await blob.arrayBuffer();
            if (writable) await writable.write(buffer);
            else chunks.push(buffer);
            assetBytes = buffer.byteLength;
            onProgress?.({ currentKind: asset.kind, downloadedBytes: completedBytes + assetBytes, totalBytes: Math.max(totalBytes, completedBytes + assetBytes) });
          } else {
            const objectMessageId = messageId(asset.ref);
            if (!objectMessageId) throw new Error(`${asset.kind} is not available for this beat.`);

            // When Everything is exported, reuse the artwork bytes already fetched for APIC
            // instead of downloading the same Cloud object a second time.
            if (asset.kind === "ARTWORK" && cachedCloudArtwork?.messageId === objectMessageId) {
              const buffer = cachedCloudArtwork.bytes instanceof Uint8Array
                ? exactArrayBuffer(cachedCloudArtwork.bytes)
                : cachedCloudArtwork.bytes;
              if (writable) await writable.write(buffer);
              else chunks.push(buffer);
              assetBytes = buffer.byteLength;
              onProgress?.({ currentKind: asset.kind, downloadedBytes: completedBytes + assetBytes, totalBytes: Math.max(totalBytes, completedBytes + assetBytes) });
            } else {
              const transport = await this.transport;
              const stream = await transport.streamFile({ messageId: objectMessageId, mimeType: asset.mimeType }, async (chunk, downloadedBytes, streamTotal) => {
                if (controller.signal.aborted) throw abortError();
                if (writable) await writable.write(chunk);
                else chunks.push(chunk);
                assetBytes = downloadedBytes;
                onProgress?.({
                  currentKind: asset.kind,
                  downloadedBytes: completedBytes + downloadedBytes,
                  totalBytes: Math.max(totalBytes, completedBytes + streamTotal),
                });
              });
              activeCancel = stream.cancel;
              const result = await stream.completed;
              assetBytes = result.totalBytes;
            }
          }

          if (controller.signal.aborted) throw abortError();
          if (writable) await writable.close();
          else triggerBrowserDownload(new Blob(chunks, { type: asset.mimeType }), asset.filename);
          activeWritable = null;
          activeCancel = null;
          completedBytes += assetBytes;
        }
        return { cancelled: false };
      } catch (error) {
        if (!controller.signal.aborted) await activeWritable?.abort(error).catch(() => {});
        if (controller.signal.aborted || isAbort(error)) return { cancelled: true };
        throw error;
      } finally {
        this.tasks.delete(id);
        activeCancel = null;
        activeWritable = null;
      }
    })();
    void completed.catch(() => {});
    return { id, completed, cancel };
  }

  cancelAll(): void {
    for (const task of this.tasks.values()) task.cancel();
    this.tasks.clear();
  }
}
