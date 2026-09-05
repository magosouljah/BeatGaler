import { jsPDF } from "jspdf";
import JSZip from "jszip";
import type { Beat, BeatAssetRef } from "../../types";
import type { WebGalerCloudTransport } from "../cloud/webGalerCloudTransport";

export type WebDownloadKind = "mp3" | "wav" | "project" | "everything" | "covers_pdf";
export type WebDownloadProgress = { done: number; total: number; message: string };
export interface WebDownloadHandle { cancel(): void; done: Promise<void>; }

type Slot = { label: string; asset: BeatAssetRef | null | undefined; fallbackName: string };

function directMessageId(value: string | null | undefined): number | null {
  const match = /^direct:(\d+)$/.exec(String(value || "").trim());
  const messageId = Number(match?.[1] || 0);
  return Number.isInteger(messageId) && messageId > 0 ? messageId : null;
}
function extensionForMime(mime: string | null | undefined, fallback: string): string {
  const value = String(mime || "").toLowerCase();
  if (value.includes("wav")) return "wav"; if (value.includes("zip")) return "zip"; if (value.includes("png")) return "png"; if (value.includes("webp")) return "webp"; if (value.includes("jpeg") || value.includes("jpg")) return "jpg"; return fallback;
}
function safeName(value: string): string { return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim() || "Beat"; }
function downloadBlob(blob: Blob, filename: string): void { const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.style.display = "none"; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 0); }
function assetSlot(beat: Beat, kind: "MASTER" | "WAV" | "PROJECT" | "ARTWORK"): BeatAssetRef | null | undefined { return kind === "MASTER" ? beat.assets?.master : kind === "WAV" ? beat.assets?.wav : kind === "PROJECT" ? beat.assets?.project : beat.assets?.artwork; }
function slotFor(beat: Beat, kind: Exclude<WebDownloadKind, "everything" | "covers_pdf">): Slot | null {
  const name = safeName(beat.name); if (kind === "mp3") return { label: "MP3", asset: assetSlot(beat, "MASTER"), fallbackName: `${name}.mp3` }; if (kind === "wav") return { label: "WAV", asset: assetSlot(beat, "WAV"), fallbackName: `${name}.wav` }; if (kind === "project") return { label: "Project", asset: assetSlot(beat, "PROJECT"), fallbackName: `${name}.zip` }; return null;
}
function everythingSlots(beat: Beat): Slot[] { const name = safeName(beat.name); return [
  { label: "MP3", asset: beat.assets?.master, fallbackName: `${name}.mp3` },
  { label: "WAV", asset: beat.assets?.wav, fallbackName: `${name}.wav` },
  { label: "Project", asset: beat.assets?.project, fallbackName: `${name}.zip` },
  { label: "Artwork", asset: beat.assets?.artwork, fallbackName: `${name}.${extensionForMime(beat.assets?.artwork?.mime_type, "jpg")}` },
].filter(slot => directMessageId(slot.asset?.object_id)); }

export class WebDownloadsManager {
  private active = new Set<() => void>();
  constructor(private readonly transport: Promise<WebGalerCloudTransport>) {}
  start(beat: Beat, kind: WebDownloadKind, onProgress?: (progress: WebDownloadProgress) => void): WebDownloadHandle {
    let cancelled = false; let streamCancel: (() => void) | null = null; const cancel = () => { cancelled = true; streamCancel?.(); }; this.active.add(cancel);
    const report = (done: number, total: number, message: string) => onProgress?.({ done, total, message });
    const done = (async () => {
      try {
        const transport = await this.transport; if (cancelled) throw new DOMException("Download cancelled.", "AbortError");
        if (kind === "covers_pdf") {
          const artwork = beat.assets?.artwork; const messageId = directMessageId(artwork?.object_id); if (!messageId) throw new Error("This beat has no artwork to export."); report(0, 1, "Downloading artwork…");
          const chunks: ArrayBuffer[] = []; const stream = await transport.streamFile({ messageId, mimeType: artwork?.mime_type || "image/jpeg", purpose: "export" }, chunk => { if (cancelled) throw new DOMException("Download cancelled.", "AbortError"); chunks.push(chunk); }); streamCancel = stream.cancel; const result = await stream.completed;
          const blob = new Blob(chunks, { type: result.mimeType || artwork?.mime_type || "image/jpeg" }); const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
          const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: [1000, 1000] }); const format = blob.type.includes("png") ? "PNG" : "JPEG"; pdf.addImage(dataUrl, format, 0, 0, 1000, 1000, undefined, "FAST"); downloadBlob(pdf.output("blob"), `${safeName(beat.name)}-cover.pdf`); report(1, 1, "Cover PDF ready"); return;
        }
        const slots = kind === "everything" ? everythingSlots(beat) : [slotFor(beat, kind)].filter((slot): slot is Slot => Boolean(slot)); const present = slots.filter(slot => directMessageId(slot.asset?.object_id)); if (present.length === 0) throw new Error("The requested file is not available for this beat.");
        const zip = kind === "everything" ? new JSZip() : null; let completedSlots = 0;
        for (const slot of present) {
          if (cancelled) throw new DOMException("Download cancelled.", "AbortError"); const messageId = directMessageId(slot.asset?.object_id)!; report(completedSlots, present.length, `Downloading ${slot.label}…`); const chunks: ArrayBuffer[] = [];
          const stream = await transport.streamFile({ messageId, mimeType: slot.asset?.mime_type || "application/octet-stream", purpose: "export" }, chunk => { if (cancelled) throw new DOMException("Download cancelled.", "AbortError"); chunks.push(chunk); }); streamCancel = stream.cancel; const result = await stream.completed; const filename = safeName(slot.asset?.filename || slot.fallbackName); const blob = new Blob(chunks, { type: result.mimeType || slot.asset?.mime_type || "application/octet-stream" }); if (zip) zip.file(filename, blob); else downloadBlob(blob, filename); completedSlots += 1; report(completedSlots, present.length, `${slot.label} ready`);
        }
        if (zip) { report(present.length, present.length, "Building ZIP…"); downloadBlob(await zip.generateAsync({ type: "blob" }), `${safeName(beat.name)}-everything.zip`); }
      } finally { this.active.delete(cancel); }
    })();
    return { cancel, done };
  }
  cancelAll(): void { for (const cancel of Array.from(this.active)) cancel(); this.active.clear(); }
}
