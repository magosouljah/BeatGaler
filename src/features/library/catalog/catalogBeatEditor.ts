import type { Beat } from "../../../types";
import type { PlatformBeatEditFiles, PlatformCloudCommitProgress } from "../../../platform/contracts";
import type { ArtworkDropSource } from "../../dragdrop/browserArtwork";
import { fetchInternetArtworkDataUrl } from "../../artwork/internetArtwork";
import { classifyDroppedAudio, SUPPORTED_ARTWORK_MIME, type DroppedAudioKind } from "./catalogDropKinds";
import type { CatalogBeatDto } from "./catalogApi";
import type { CatalogBeatDetail, CatalogVersionedItem } from "./catalogCommandsApi";
import { beatFromCatalogDetail, metadataPatch, type CatalogMutations, type PatchOutcome, type TransferOutcome } from "./catalogMutations";
import { prepareProjectForBeat } from "./catalogProjectMerge";

type PendingReason = "uncertain" | "blocked" | "timeout";
type RejectedReason = "conflict" | "error" | "failed" | "canceled" | "name-taken";
type Rejection = { reading: "rejected"; why: RejectedReason; status: "conflict" | "error" | "failed" | "canceled"; error: unknown };
type Reading =
  | { reading: "success"; status: "committed" | "ok" }
  | { reading: "pending"; why: PendingReason; error: unknown }
  | Rejection;

type EditFailure =
  | { reading: "pending"; why: PendingReason; message: string; partial?: boolean }
  | { reading: "rejected"; why: RejectedReason; message: string; partial?: boolean; originalError?: { value: unknown } };
type EditSuccess = { reading: "success"; status: "committed" | "ok"; artworkRemoved: boolean };
type DropSuccess = EditSuccess & { message: string };
type AudioSuccess = DropSuccess & { kind: DroppedAudioKind; replacedExisting: boolean };
type NotStarted = { reading: "not-started"; why: "cancelled" | "unsupported" };
export type EditResult =
  | (EditSuccess & { message?: string; kind?: DroppedAudioKind; replacedExisting?: boolean })
  | EditFailure
  | NotStarted;

type Detail = CatalogBeatDto & Partial<CatalogBeatDetail>;
type ReplacePort = Pick<CatalogMutations, "getBeat" | "replaceBeat">;
type DrawerPort = ReplacePort & Pick<CatalogMutations, "patchBeat">;
export interface DrawerSaveInput {
  original: Beat;
  updated: Beat;
  files: PlatformBeatEditFiles;
  artworkRemoved: boolean;
  onProgress?: (p: PlatformCloudCommitProgress) => void;
}
export interface DrawerSaveDeps {
  mutations: DrawerPort;
  knownDto: (beatId: string) => Detail | undefined;
  loadProject: (beatId: string) => Promise<File | null>;
  dataUrlToFile?: (dataUrl: string, name: string) => File | null;
  errorMessage: (error: unknown) => string;
}
export interface AudioEditOptions {
  confirm: (o: { title: string; message: string; confirmLabel: string }) => Promise<boolean>;
  onStart?: () => void;
  onProgress?: (text: string) => void;
}
export interface BeatEditor {
  saveDrawer(input: DrawerSaveInput | { mode: "manual"; updated: Beat }): Promise<EditResult>;
  replaceAudio(beatId: string, file: File, options: AudioEditOptions): Promise<EditResult>;
  replaceArtwork(beatId: string, sources: ArtworkDropSource[] | Promise<ArtworkDropSource[]>): Promise<EditResult>;
  trash(items: CatalogVersionedItem[]): Promise<EditResult>;
}

const errorText = (error: unknown): string => String((error as { message?: unknown })?.message ?? error);
const isNameTaken = (error: unknown) => (error as { code?: unknown })?.code === "NAME_TAKEN";

/** Una transferencia pendiente puede confirmarse y nunca se reenvía. */
export function readOutcome(outcome: { thrown: unknown }): Rejection;
export function readOutcome(outcome: TransferOutcome | PatchOutcome | { thrown: unknown }): Reading;
export function readOutcome(outcome: TransferOutcome | PatchOutcome | { thrown: unknown }): Reading {
  if ("thrown" in outcome) {
    const error = outcome.thrown;
    return { reading: "rejected", status: "error", why: isNameTaken(error) ? "name-taken" : "error", error };
  }
  const { status } = outcome;
  const error = "error" in outcome ? outcome.error : undefined;
  switch (status) {
    case "committed":
    case "ok":
      return { reading: "success", status };
    case "uncertain":
    case "blocked":
    case "timeout":
      return { reading: "pending", why: status, error };
    case "conflict":
      return { reading: "rejected", status, why: status, error };
    case "error":
    case "failed":
    case "canceled":
      return { reading: "rejected", status, why: isNameTaken(error) ? "name-taken" : status, error };
  }
}

function editFailure(result: Exclude<Reading, { reading: "success" }>, message: string): EditFailure {
  if (result.reading === "pending") return { reading: "pending", why: result.why, message };
  return { reading: "rejected", why: result.why, message };
}

function thrownFailure(error: unknown, message = errorText(error), preserveError = false): EditFailure {
  const result = readOutcome({ thrown: error });
  return {
    reading: result.reading, why: result.why, message,
    ...(preserveError ? { originalError: { value: error } } : {}),
  };
}

function versionedDetail(detail: Detail) {
  return { beatId: detail.id, expectedVersion: detail.version, original: beatFromCatalogDetail(detail, null) };
}

const dropMessages = {
  audio: {
    conflict: "Este beat cambió en otro dispositivo; no se reemplazó nada. Vuelve a intentarlo.",
    pending: "El reemplazo sigue confirmándose en el servidor; no lo repitas. El archivo se actualizará si se recibió.",
    current: "el beat conserva su archivo actual.",
  },
  artwork: {
    conflict: "Este beat cambió en otro dispositivo; la portada no se cambió. Vuelve a intentarlo.",
    pending: "El cambio sigue confirmándose en el servidor; no lo repitas. La portada se actualizará si se recibió.",
    current: "el beat conserva su portada actual.",
  },
};

function readDrop(outcome: TransferOutcome | PatchOutcome, intent: keyof typeof dropMessages): EditSuccess | EditFailure {
  const result = readOutcome(outcome);
  const text = dropMessages[intent];
  if (result.reading === "pending") return editFailure(result, text.pending);
  // Un PATCH no confirma que se reemplazó el archivo soltado.
  if (result.reading === "success") return result.status === "committed"
    ? { ...result, artworkRemoved: false }
    : { reading: "rejected", why: "failed", message: `La operación quedó en estado ${result.status}; ${text.current}` };
  return editFailure(result, result.status === "conflict" ? text.conflict : `La operación quedó en estado ${result.status}; ${text.current}`);
}

export async function editDroppedAudio(
  mutations: ReplacePort, beatId: string, file: File, { confirm, onStart, onProgress }: AudioEditOptions,
  loadProject?: DrawerSaveDeps["loadProject"],
): Promise<AudioSuccess | EditFailure | NotStarted> {
  const kind = classifyDroppedAudio(file);
  if (!kind) return { reading: "not-started", why: "unsupported" };
  let detail;
  try { detail = await mutations.getBeat(beatId); }
  catch (e) { return thrownFailure(e, `No se pudo leer el beat: ${errorText(e)}`); }
  const hadWav = Boolean(detail.hasWav);
  const replacing = kind === "MP3" || (kind === "WAV" ? hadWav : Boolean(detail.hasProject));
  const ok = await confirm({
    title: kind === "MP3" ? "Replace MP3?" : kind === "PROJECT" ? (replacing ? "Replace project?" : "Add project?") : hadWav ? "Replace WAV?" : "Add WAV?",
    message: kind === "MP3"
      ? `Replace the MP3 of “${detail.name}” with “${file.name}”? The current file is kept until the new one is saved.`
      : kind === "PROJECT"
        ? (replacing ? `Replace the project of “${detail.name}” with “${file.name}”? The current file is kept until the new one is saved.` : `Add “${file.name}” as the project of “${detail.name}”?`)
        : hadWav
          ? `Replace the WAV of “${detail.name}” with “${file.name}”? The current file is kept until the new one is saved.`
          : `Add “${file.name}” as the WAV of “${detail.name}”?`,
    confirmLabel: replacing ? "Replace" : "Add",
  });
  if (!ok) return { reading: "not-started", why: "cancelled" };
  onStart?.();
  const target = versionedDetail(detail);
  try {
    const project = kind === "PROJECT" ? await prepareProjectForBeat({
      beatName: detail.name, incoming: file, hasProject: Boolean(detail.hasProject),
      loadExisting: () => loadProject?.(beatId) ?? Promise.resolve(null),
    }) : null;
    const outcome = await mutations.replaceBeat({
      ...target, beatId, updated: target.original,
      files: kind === "WAV" ? { wav: file } : kind === "PROJECT" ? { project } : { master: file },
      onProgress: (p) => onProgress?.(`${p.stage} ${Math.round((p.uploadedBytes / Math.max(1, p.totalBytes)) * 100)}%`),
    });
    const result = readDrop(outcome, "audio");
    if (result.reading !== "success") return result;
    const message = kind === "MP3" ? "MP3 reemplazado."
      : kind === "PROJECT" ? (replacing ? "Proyecto reemplazado." : "Proyecto añadido.")
      : replacing ? "WAV reemplazado." : "WAV añadido.";
    return { ...result, kind, replacedExisting: replacing, message };
  } catch (e) { return thrownFailure(e); }
}

export async function editArtworkFile(mutations: ReplacePort, beatId: string, file: File): Promise<DropSuccess | EditFailure> {
  let detail;
  try { detail = await mutations.getBeat(beatId); }
  catch (e) { return thrownFailure(e, `No se pudo leer el beat: ${errorText(e)}`); }
  const target = versionedDetail(detail);
  try {
    const outcome = await mutations.replaceBeat({ ...target, beatId, updated: target.original, files: { artwork: file } });
    const result = readDrop(outcome, "artwork");
    return result.reading === "success" ? { ...result, message: "Portada actualizada." } : result;
  } catch (e) { return thrownFailure(e); }
}

const MIME_BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", bmp: "image/bmp", gif: "image/gif", avif: "image/avif" };
const EXT_BY_MIME: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/bmp": "bmp", "image/gif": "gif", "image/avif": "avif" };
const DATA_URL = /^data:([^;,]+)?(;base64)?,(.*)$/s;

function decodeArtworkBytes(data: string, base64: boolean) {
  return base64 ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(data));
}

/** Archivo de imagen con tipo MIME explícito y compatible; null si no lo es. */
export function normalizeArtworkFile(file: File): File | null {
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
  const type = (file.type || MIME_BY_EXT[ext] || "").toLowerCase();
  if (!SUPPORTED_ARTWORK_MIME.has(type)) return null;
  return file.type === type ? file : new File([file], file.name || `artwork.${EXT_BY_MIME[type]}`, { type });
}

function dataUrlToArtworkFile(dataUrl: string): File | null {
  const m = DATA_URL.exec(dataUrl);
  if (!m) return null;
  const type = (m[1] || "").toLowerCase(); if (!SUPPORTED_ARTWORK_MIME.has(type)) return null;
  try {
    const bytes = decodeArtworkBytes(m[3], Boolean(m[2]));
    return bytes.length > 0 ? new File([bytes], `artwork.${EXT_BY_MIME[type]}`, { type }) : null;
  } catch { return null; }
}

/** Primera fuente utilizable (archivo local o URL de una página); un fallo de una no impide probar la siguiente. */
export async function resolveArtworkFile(sources: ArtworkDropSource[]): Promise<File> {
  const errors: string[] = [];
  for (const source of sources) {
    try {
      const file = source.kind === "file" ? normalizeArtworkFile(source.file) : dataUrlToArtworkFile(/^data:image\//i.test(source.url) ? source.url : await fetchInternetArtworkDataUrl(source.url));
      if (file && file.size > 0) return file;
      errors.push(`${source.kind}: formato de imagen no compatible`);
    } catch (e) { errors.push(`${source.kind}: ${errorText(e)}`); }
  }
  throw new Error(errors.length ? errors.join(" | ") : "No se encontró una imagen utilizable en lo soltado.");
}

/** Transferencia retenida que aún puede confirmarse (RECONCILE / tiempo agotado): nunca se reenvía. */
export const pendingTransferNotice = (name: string) => `La subida de «${name}» sigue confirmándose en el servidor. No se reenvía ni se borra nada: el beat aparecerá si se recibió; si no, se te avisará.`;

function dataUrlToFile(dataUrl: string, name: string): File | null {
  const m = DATA_URL.exec(dataUrl);
  if (!m) return null;
  const mime = m[1] || "image/png";
  const ext = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
  try {
    const bytes = decodeArtworkBytes(m[3], Boolean(m[2]));
    return new File([bytes], `${name.replace(/[\\/:*?"<>|]+/g, "_") || "artwork"}.${ext}`, { type: mime });
  } catch { return null; }
}

const drawerConflict = "Este beat cambió en otro dispositivo. Tus cambios siguen aquí: revisa y vuelve a guardar.";
const artworkChanged = (shown: Beat, updated: Beat) =>
  Boolean(updated.image_base64) && updated.image_base64 !== shown.image_base64 && String(updated.image_base64).startsWith("data:");

function readDrawer(outcome: TransferOutcome | PatchOutcome, errorMessage: DrawerSaveDeps["errorMessage"], name: string, manual = false): EditSuccess | EditFailure {
  const result = readOutcome(outcome);
  if (result.reading === "success") return { ...result, artworkRemoved: false };
  if (result.reading === "pending") return editFailure(result, manual
    ? isNameTaken(result.error) ? errorMessage(result.error) : `La operación quedó en estado ${result.why}; el servidor conserva el resultado.`
    : pendingTransferNotice(name));
  if (result.status === "conflict") return editFailure(result, drawerConflict);
  if (result.status === "error" || (manual && result.why === "name-taken")) return editFailure(result, errorMessage(result.error));
  if (manual) return editFailure(result, `La operación quedó en estado ${result.status}; el servidor conserva el resultado.`);
  return editFailure(result, `No se guardó: ${result.error ? errorMessage(result.error) : `la operación terminó en estado ${result.status}`}. Tus cambios siguen aquí.`);
}

async function saveFiles(deps: DrawerSaveDeps, detail: Detail, { original: shown, updated, files, onProgress }: DrawerSaveInput): Promise<EditSuccess | EditFailure> {
  const target = versionedDetail(detail);
  const project = files.PROJECT ? await prepareProjectForBeat({
    beatName: detail.name, incoming: files.PROJECT, hasProject: Boolean(detail.hasProject), loadExisting: () => deps.loadProject(detail.id),
  }) : null;
  let outcome;
  try {
    outcome = await deps.mutations.replaceBeat({
      ...target, updated, onProgress, files: {
        master: files.MASTER ?? null, wav: files.WAV ?? null, project,
        artwork: artworkChanged(shown, updated) ? (deps.dataUrlToFile ?? dataUrlToFile)(String(updated.image_base64), updated.name) : null,
      },
    });
  } catch (e) { return thrownFailure(e, deps.errorMessage(e)); }
  return readDrawer(outcome, deps.errorMessage, updated.name);
}

export async function editDrawer(deps: DrawerSaveDeps, input: DrawerSaveInput | { mode: "manual"; updated: Beat }): Promise<EditSuccess | EditFailure> {
  const { updated } = input;
  try {
    const known = deps.knownDto(updated.id);
    if ("mode" in input) {
      if (!known) return thrownFailure(new Error("Este beat ya no está disponible en la ventana actual; vuelve a abrirlo."));
      const { original, ...target } = versionedDetail(known);
      const outcome = artworkChanged(original, updated)
        ? await deps.mutations.replaceBeat({ ...target, original, updated, files: { artwork: dataUrlToFile(String(updated.image_base64), updated.name) } })
        : await deps.mutations.patchBeat({ ...target, patch: metadataPatch(original, updated) });
      return readDrawer(outcome, deps.errorMessage, updated.name, true);
    }

    const detail = known ?? await deps.mutations.getBeat(updated.id);
    if (!input.artworkRemoved) return await saveFiles(deps, detail, input);

    // Portada y metadatos viajan en el mismo PATCH. Los archivos usan la versión ya confirmada.
    const { original, ...target } = versionedDetail(detail);
    const patch = await deps.mutations.patchBeat({ ...target, patch: { ...metadataPatch(original, updated), artwork: null } });
    const first = readDrawer(patch, deps.errorMessage, updated.name);
    if (first.reading !== "success") return first;
    const { MASTER, WAV, PROJECT } = input.files;
    if (!MASTER && !WAV && !PROJECT) return { ...first, artworkRemoved: true };

    const confirmed = await deps.mutations.getBeat(detail.id);
    let second;
    try {
      second = await saveFiles(deps, confirmed, { ...input, updated: { ...updated, image_base64: null } });
    } catch (e) { second = thrownFailure(e); }
    if (second.reading === "success") return { ...second, status: "committed", artworkRemoved: true };
    return { ...second, partial: true, message: `La portada se quitó y los metadatos se guardaron, pero los archivos no: ${second.message}` };
  } catch (e) { return thrownFailure(e, errorText(e), true); }
}

export function drawerEditError(result: Exclude<EditResult, { reading: "success" }>, manual = false): unknown {
  if (result.reading === "not-started") return new Error(result.why);
  if (result.reading === "rejected" && result.originalError) return result.originalError.value;
  const error = new Error(result.message);
  if (manual) return error;
  if (result.partial) return Object.assign(error, { partial: true, pending: result.reading === "pending" || undefined });
  return result.reading === "pending" ? Object.assign(error, { pending: true }) : error;
}

export function createBeatEditor(deps: DrawerSaveDeps & { mutations: Pick<CatalogMutations, "trashBeats"> }): BeatEditor {
  const { mutations, loadProject } = deps;
  return {
    saveDrawer: (input) => editDrawer(deps, input),
    replaceAudio: (beatId, file, options) => editDroppedAudio(mutations, beatId, file, options, loadProject),
    async replaceArtwork(beatId, sources) {
      try { return await editArtworkFile(mutations, beatId, await resolveArtworkFile(await sources)); }
      catch (e) { return thrownFailure(e); }
    },
    async trash(items) {
      try {
        const result = await mutations.trashBeats(items);
        if (result.status === "CONFLICT") return {
          reading: "rejected", why: "conflict", message: "La biblioteca cambió en otro dispositivo; revisa antes de borrar.",
        };
        if (result.status === "PARTIAL") return { reading: "rejected", why: "failed", message: "", partial: true };
        return { reading: "success", status: "ok", artworkRemoved: false };
      } catch (e) { return thrownFailure(e); }
    },
  };
}

type EditEffects = { refresh?: boolean; finishBusy?: boolean; complete?: boolean; forgetArtwork?: boolean; throw?: boolean };
const editEffects = {
  audio: {
    success: { finishBusy: true, complete: true, refresh: true },
    pending: { finishBusy: true },
    rejected: { finishBusy: true },
    "not-started": {},
  },
  artwork: {
    success: { finishBusy: true, complete: true, refresh: true },
    pending: { finishBusy: true },
    rejected: { finishBusy: true },
    "not-started": { finishBusy: true },
  },
  drawer: {
    success: { refresh: true, forgetArtwork: true },
    pending: { refresh: true, throw: true },
    rejected: { throw: true },
    "not-started": { throw: true },
  },
  manual: {
    success: { refresh: true },
    pending: { throw: true },
    rejected: { throw: true },
    "not-started": { throw: true },
  },
  trash: {
    success: { refresh: true },
    pending: {},
    rejected: {},
    "not-started": {},
  },
} satisfies Record<string, Record<EditResult["reading"], EditEffects>>;

function effectsFor(intent: keyof typeof editEffects, result: EditResult): EditEffects {
  const effects: EditEffects = editEffects[intent][result.reading];
  if (intent === "drawer" && (result.reading === "rejected" || result.reading === "pending") && result.partial) {
    return { ...effects, refresh: true, forgetArtwork: true };
  }
  if (intent === "trash" && result.reading === "rejected" && (result.why === "conflict" || result.partial)) {
    return { ...effects, refresh: true };
  }
  return effects;
}
interface GalleryBeatEditorPorts {
  mutations: DrawerPort & Pick<CatalogMutations, "trashBeats" | "listBeatFiles">;
  media: { downloadFile(fileId: string): Promise<{ blob: Blob }> };
  knownDto: DrawerSaveDeps["knownDto"];
  errorMessage: DrawerSaveDeps["errorMessage"];
  refreshAfterMutation(): void;
  setNotice(value: string | null): void;
  confirm: AudioEditOptions["confirm"];
  setBusy(beatId: string, busy: boolean, complete?: boolean): void;
  playingId: string | null;
  releaseFile(): void;
  forgetArtworkOf(beatId: string): void;
}

export function createGalleryBeatEditor({
  mutations, media, knownDto, errorMessage, refreshAfterMutation, setNotice, confirm, setBusy,
  playingId, releaseFile, forgetArtworkOf,
}: GalleryBeatEditorPorts) {
  const editor = createBeatEditor({
    mutations, knownDto, errorMessage,
    async loadProject(beatId) {
      const files = await mutations.listBeatFiles(beatId);
      const project = files.find((file) => file.role === "PROJECT" && file.current);
      if (!project) return null;
      const { blob } = await media.downloadFile(project.fileId);
      return new File([blob], project.filename || "project.zip", { type: "application/zip" });
    },
  });

  async function commitDrawerCloudMutation(updated: Beat) {
    const result = await editor.saveDrawer({ mode: "manual", updated });
    const effects = effectsFor("manual", result);
    if (effects.throw && result.reading !== "success") throw drawerEditError(result, true);
    if (effects.refresh) refreshAfterMutation();
  }

  function deleteBeat(beat: Beat) {
    const dto = knownDto(beat.id);
    if (!dto) return;
    if (playingId === beat.id) releaseFile();
    void editor.trash([{ beatId: dto.id, expectedVersion: dto.version }]).then((result) => {
      if (result.reading === "rejected" && !result.partial) setNotice(result.message);
      if (effectsFor("trash", result).refresh) refreshAfterMutation();
    }).catch((error) => setNotice(errorText(error)));
  }

  async function saveDrawerToCatalog(input: DrawerSaveInput) {
    const result = await editor.saveDrawer(input);
    const effects = effectsFor("drawer", result);
    if (effects.forgetArtwork && (result.reading !== "success" || result.artworkRemoved)) forgetArtworkOf(input.updated.id);
    if (effects.refresh) refreshAfterMutation();
    if (effects.throw && result.reading !== "success") throw drawerEditError(result);
  }

  async function replaceAudioByDrop(beatId: string, file: File) {
    const result = await editor.replaceAudio(beatId, file, {
      confirm, onStart: () => setBusy(beatId, true),
      onProgress: (t) => setNotice(`Reemplazando audio: ${t}`),
    });
    const effects = effectsFor("audio", result);
    if (effects.finishBusy) setBusy(beatId, false, effects.complete);
    if (result.reading === "success") setNotice(result.message ?? null);
    else if (result.reading === "not-started") setNotice(result.why === "unsupported" ? "Solo se pueden soltar archivos MP3 o WAV." : null);
    else setNotice(`No se pudo reemplazar el audio: ${result.message}`);
    if (effects.refresh) refreshAfterMutation();
  }

  async function replaceArtworkByDrop(beatId: string, sources: ArtworkDropSource[] | Promise<ArtworkDropSource[]>) {
    setBusy(beatId, true);
    let effects: EditEffects = editEffects.artwork.rejected;
    try {
      const result = await editor.replaceArtwork(beatId, sources);
      effects = effectsFor("artwork", result);
      if (result.reading === "success") setNotice(result.message ?? null);
      else if (result.reading !== "not-started") setNotice(`No se pudo cambiar la portada: ${result.message}`);
      if (effects.refresh) refreshAfterMutation();
    } catch (e) { setNotice(`No se pudo cambiar la portada: ${String((e as { message?: unknown })?.message ?? e)}`); }
    finally { if (effects.finishBusy) setBusy(beatId, false, effects.complete === true); }
  }

  return { commitDrawerCloudMutation, deleteBeat, saveDrawerToCatalog, replaceAudioByDrop, replaceArtworkByDrop };
}
