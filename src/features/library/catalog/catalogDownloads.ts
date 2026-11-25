import type { Beat } from "../../../types";
import type { CatalogMutations } from "./catalogMutations";
// «Download» de una BeatCard de la Gallery POSTGRES (MP3 / WAV / PROJECT / todo): lista los archivos actuales del beat y los baja por el
// cliente de medios del catálogo (concesión + partes + verificación de tamaño/hash) guardándolos con el navegador. Copias independientes.
import type { CatalogBeatFile } from "./catalogCommandsApi";
import { buildBeatGalerId3Tag, readBlobAsArrayBuffer, type BeatGalerMp3Metadata, type Mp3Artwork } from "../../audio/mp3Metadata";

export type DownloadKind = "MP3" | "WAV" | "PROJECT" | "ALL";
const ROLE_OF: Record<Exclude<DownloadKind, "ALL">, string> = { MP3: "MASTER", WAV: "WAV", PROJECT: "PROJECT" };

/** Archivos vigentes (en un slot actual) que corresponden al tipo pedido. */
export function filesForDownload(kind: DownloadKind, files: CatalogBeatFile[]): CatalogBeatFile[] {
  const current = files.filter((f) => f.current && f.status !== "DELETED");
  return kind === "ALL" ? current.filter((f) => ["MASTER", "WAV", "PROJECT"].includes(f.role)) : current.filter((f) => f.role === ROLE_OF[kind]).slice(0, 1);
}

export function safeDownloadName(file: CatalogBeatFile, beatName: string): string {
  const raw = (file.filename || "").trim();
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(raw)?.[0] ?? (file.role === "WAV" ? ".wav" : file.role === "PROJECT" ? ".zip" : ".mp3");
  const base = (raw ? raw.replace(/\.[A-Za-z0-9]{1,8}$/, "") : beatName).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim() || "beat";
  return `${base}${ext}`;
}

export type DownloadResult = { status: "done"; saved: string[] } | { status: "empty" } | { status: "failed"; saved: string[]; message: string };

/** Metadatos ID3 del MP3 descargado (E82): salen de PostgreSQL (nombre, BPM, tonalidad, tags, rating) y de la portada vigente, igual que la descarga legacy. */
export interface Mp3TagSource { metadata: BeatGalerMp3Metadata; artwork?: () => Promise<Mp3Artwork | null> }

/** El MP3 de la nube se guarda sin ID3 (stripId3MetadataForCloud); al descargar se antepone un ID3v2.3 nuevo. Un MP3 que ya trae ID3 no se toca. */
export async function withBeatGalerId3(blob: Blob, source: Mp3TagSource): Promise<Blob> {
  const head = new Uint8Array(await readBlobAsArrayBuffer(blob.slice(0, 3)));
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return blob;
  let artwork: Mp3Artwork | null = null;
  try { artwork = (await source.artwork?.()) ?? null; } catch { artwork = null; } // sin portada legible el MP3 se descarga igualmente con el resto de tags
  const tag = buildBeatGalerId3Tag(source.metadata, artwork);
  return new Blob([tag as unknown as BlobPart, blob], { type: blob.type || "audio/mpeg" });
}

export async function downloadBeatFiles({ files, kind, beatName, download, save, mp3Tags }: {
  files: CatalogBeatFile[]; kind: DownloadKind; beatName: string;
  download: (fileId: string) => Promise<{ blob: Blob }>; save: (blob: Blob, filename: string) => void; mp3Tags?: Mp3TagSource;
}): Promise<DownloadResult> {
  const picked = filesForDownload(kind, files);
  if (!picked.length) return { status: "empty" };
  const saved: string[] = [];
  for (const f of picked) {
    try { let { blob } = await download(f.fileId); if (f.role === "MASTER" && mp3Tags) blob = await withBeatGalerId3(blob, mp3Tags); const name = safeDownloadName(f, beatName); save(blob, name); saved.push(name); }
    catch (e) { return { status: "failed", saved, message: String((e as { message?: unknown })?.message ?? e) }; }
  }
  return { status: "done", saved };
}

export function saveBlobWithBrowser(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob); const a = document.createElement("a");
  a.href = url; a.download = filename; a.style.display = "none"; document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}


export interface GalleryDownloadFiles {
  beat: Beat;
  files: CatalogBeatFile[];
}

export interface GalleryDownloadsSnapshot {
  cloudFiles: GalleryDownloadFiles | null;
  downloadBusy: DownloadKind | null;
  downloaded: Set<string>;
}

export interface GalleryDownloadsPorts {
  mutations: Pick<CatalogMutations, "listBeatFiles">;
  media: { downloadFile(fileId: string): Promise<{ blob: Blob }> };
  rejectOfflineMutation(action: string): boolean;
  setNotice(value: string | null): void;
  save: typeof saveBlobWithBrowser;
}

/** Almacén observable de las descargas de la Gallery: la UI solo se suscribe (useSyncExternalStore). `ports` se lee en cada uso (puertos vivos del render). */
export function createGalleryDownloadsStore(ports: () => GalleryDownloadsPorts) {
  let snap: GalleryDownloadsSnapshot = { cloudFiles: null, downloadBusy: null, downloaded: new Set() };
  const listeners = new Set<() => void>();
  let openToken = 0; // gana la ÚLTIMA apertura solicitada; cerrar también invalida respuestas pendientes
  const set = (patch: Partial<GalleryDownloadsSnapshot>) => { snap = { ...snap, ...patch }; for (const l of [...listeners]) l(); };

  function openDownloads(beat: Beat) {
    const { mutations, rejectOfflineMutation, setNotice } = ports();
    if (rejectOfflineMutation("Downloading")) return;
    set({ downloaded: new Set() });
    const token = ++openToken;
    void mutations.listBeatFiles(beat.id).then((files) => { if (token === openToken) set({ cloudFiles: { beat, files } }); }).catch((error) =>
      token === openToken && setNotice(`No se pudo leer los archivos del beat: ${String((error as { message?: unknown })?.message ?? error)}`));
  }

  function downloadKind(kind: DownloadKind) {
    const { media, setNotice, save } = ports();
    if (!snap.cloudFiles || snap.downloadBusy) return;
    set({ downloadBusy: kind });
    const { beat, files } = snap.cloudFiles;
    const artFile = files.find((file) => file.role === "ARTWORK" && file.current && file.status !== "DELETED");
    const { name, bpm, key, tags, rating } = beat;
    const mp3Tags = {
      metadata: { name, bpm, key, tags, rating },
      artwork: artFile ? async () => {
        const { blob } = await media.downloadFile(artFile.fileId);
        return { mimeType: blob.type || artFile.mime || "image/png", bytes: await readBlobAsArrayBuffer(blob) };
      } : undefined,
    };
    void downloadBeatFiles({ files, kind, beatName: name, download: (id) => media.downloadFile(id), save, mp3Tags }).then((result) => {
      if (result.status === "done") {
        set({ downloaded: new Set(snap.downloaded).add(kind) });
        setNotice(result.saved.length > 1 ? `${result.saved.length} archivos descargados.` : `«${result.saved[0]}» descargado.`);
      } else if (result.status === "empty") setNotice("Ese archivo no está disponible para este beat.");
      else setNotice(`No se pudo descargar: ${result.message}`);
    }).finally(() => set({ downloadBusy: null }));
  }

  function closeDownloads() { openToken++; set({ cloudFiles: null, downloadBusy: null }); }

  return {
    openDownloads, downloadKind, closeDownloads,
    getSnapshot: () => snap,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export type GalleryDownloadsStore = ReturnType<typeof createGalleryDownloadsStore>;
