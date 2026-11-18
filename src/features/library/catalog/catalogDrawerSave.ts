// §6.1 (documento maestro 2026-11-17) — lógica pura de la Gallery POSTGRES para: guardado del Drawer (metadatos + portada + MASTER/WAV/PROJECT en
// una sola mutación del catálogo), resumen de subidas interrumpidas al arrancar y cola de revisiones de importación. Sin React: se prueba con dobles.
import type { Beat } from "../../../types";
import type { PlatformBeatEditFiles, PlatformCloudCommitProgress } from "../../../platform/contracts";
import type { CatalogBeatDto } from "./catalogApi";
import type { CatalogBeatDetail } from "./catalogCommandsApi";
import { beatFromCatalogDetail, metadataPatch, type CatalogMutations } from "./catalogMutations";
import { prepareProjectForBeat } from "./catalogProjectMerge";

/** Transferencia retenida que aún puede confirmarse (RECONCILE / tiempo agotado): nunca se reenvía. */
export const pendingTransferNotice = (name: string) => `La subida de «${name}» sigue confirmándose en el servidor. No se reenvía ni se borra nada: el beat aparecerá si se recibió; si no, se te avisará.`;

export interface DrawerSaveInput { original: Beat; updated: Beat; files: PlatformBeatEditFiles; artworkRemoved: boolean; onProgress?: (p: PlatformCloudCommitProgress) => void }
export interface DrawerSaveDeps {
  mutations: Pick<CatalogMutations, "getBeat" | "replaceBeat" | "patchBeat">;
  knownDto: (beatId: string) => (CatalogBeatDto & Partial<CatalogBeatDetail>) | undefined;
  loadProject: (beatId: string) => Promise<File | null>;
  dataUrlToFile: (dataUrl: string, name: string) => File | null;
  errorMessage: (error: unknown) => string;
}

/** Guarda el Drawer en el catálogo. Cualquier resultado distinto de un commit lanza un Error (el Drawer conserva cambios y archivos). */
export async function saveDrawerChanges(deps: DrawerSaveDeps, input: DrawerSaveInput): Promise<{ status: "committed" | "patched"; artworkRemoved: boolean }> {
  const { updated, files, artworkRemoved } = input;
  let detail = deps.knownDto(updated.id) ?? await deps.mutations.getBeat(updated.id);
  if (artworkRemoved) {
    // Quitar portada (decisión del propietario 2026-11-17): PATCH `artwork: null` con la versión esperada = desvincular en PostgreSQL. Los
    // metadatos editados viajan en el MISMO PATCH (atómico). El archivo de Telegram no se borra ni se modifica.
    const original = beatFromCatalogDetail(detail, null);
    const p = await deps.mutations.patchBeat({ beatId: detail.id, expectedVersion: detail.version, patch: { ...metadataPatch(original, updated), artwork: null } });
    if (p.status === "conflict") throw new Error("Este beat cambió en otro dispositivo. Tus cambios siguen aquí: revisa y vuelve a guardar.");
    if (p.status === "error") throw new Error(deps.errorMessage(p.error));
    const hasFiles = Boolean(files.MASTER || files.WAV || files.PROJECT);
    if (!hasFiles) return { status: "patched", artworkRemoved: true };
    // Archivos elegidos en el mismo guardado: segundo paso, con la versión ya confirmada (la portada y los metadatos ya están guardados).
    detail = await deps.mutations.getBeat(detail.id);
    try { await saveFiles(deps, detail, { ...input, original: beatFromCatalogDetail(detail, null), updated: { ...updated, image_base64: null } }); }
    catch (e) { throw Object.assign(new Error(`La portada se quitó y los metadatos se guardaron, pero los archivos no: ${String((e as Error)?.message ?? e)}`), { pending: (e as { pending?: boolean }).pending, partial: true }); }
    return { status: "committed", artworkRemoved: true };
  }
  return { ...(await saveFiles(deps, detail, input)), artworkRemoved: false };
}

async function saveFiles(deps: DrawerSaveDeps, detail: CatalogBeatDto & Partial<CatalogBeatDetail>, { original: shown, updated, files, onProgress }: DrawerSaveInput): Promise<{ status: "committed" | "patched" }> {
  const original = beatFromCatalogDetail(detail, null);
  const artworkChanged = Boolean(updated.image_base64) && updated.image_base64 !== shown.image_base64 && String(updated.image_base64).startsWith("data:");
  const project = files.PROJECT ? await prepareProjectForBeat({ beatName: detail.name, incoming: files.PROJECT, hasProject: Boolean(detail.hasProject), loadExisting: () => deps.loadProject(detail.id) }) : null;
  let outcome;
  try {
    outcome = await deps.mutations.replaceBeat({ beatId: detail.id, expectedVersion: detail.version, original, updated, onProgress,
      files: { master: files.MASTER ?? null, wav: files.WAV ?? null, project, artwork: artworkChanged ? deps.dataUrlToFile(String(updated.image_base64), updated.name) : null } });
  } catch (e) { throw new Error(deps.errorMessage(e)); }
  if (outcome.status === "conflict") throw new Error("Este beat cambió en otro dispositivo. Tus cambios siguen aquí: revisa y vuelve a guardar.");
  if (outcome.status === "error") throw new Error(deps.errorMessage(outcome.error));
  if (outcome.status === "uncertain" || outcome.status === "blocked" || outcome.status === "timeout") throw Object.assign(new Error(pendingTransferNotice(updated.name)), { pending: true });
  if (outcome.status === "failed" || outcome.status === "canceled") throw new Error(`No se guardó: ${outcome.error ? deps.errorMessage(outcome.error) : `la operación terminó en estado ${outcome.status}`}. Tus cambios siguen aquí.`);
  return { status: outcome.status === "committed" ? "committed" : "patched" };
}

type Resolved = Awaited<ReturnType<CatalogMutations["resolvePendingTransfers"]>>;
/** Resumen veraz de las subidas que quedaron a medias. `forget` = referencias terminadas sin efecto ya informadas. */
export function summarizePendingTransfers(list: Resolved): { notice: string | null; refresh: boolean; forget: string[] } {
  const names = (xs: Resolved) => xs.map((x) => x.ref.label.replace(/^(Importar|Reemplazar archivos de) /, "")).join(", ");
  const done = list.filter((x) => x.operation?.status === "COMMITTED");
  const ended = list.filter((x) => x.terminal && x.operation && x.operation.status !== "COMMITTED");
  const open = list.filter((x) => !x.terminal && x.operation); // sin respuesta del servidor (operation null) → no se afirma nada
  const parts: string[] = [];
  if (done.length) parts.push(`Subida completada: ${names(done)}.`);
  if (ended.length) parts.push(`Subida no completada (no se guardó nada; vuelve a añadirlo): ${names(ended)}.`);
  if (open.length) parts.push(`Subida aún confirmándose en el servidor (no la repitas): ${names(open)}.`);
  return { notice: parts.length ? parts.join(" ") : null, refresh: done.length > 0, forget: ended.map((x) => x.ref.operationId) };
}

/** Cola de revisiones: una visible; las demás esperan (nunca se sustituye una revisión abierta). */
export interface ReviewEntry { beat: Beat; hydrated: Promise<Beat> | null }
export function enqueueReview(current: ReviewEntry | null, queue: readonly ReviewEntry[], entry: ReviewEntry): { current: ReviewEntry; queue: ReviewEntry[] } {
  if (current && current.beat.id !== entry.beat.id) return { current, queue: [...queue.filter((x) => x.beat.id !== entry.beat.id), entry] };
  return { current: entry, queue: queue.filter((x) => x.beat.id !== entry.beat.id) };
}
export function nextReview(queue: readonly ReviewEntry[], hasFile: (beatId: string) => boolean): { next: ReviewEntry | null; queue: ReviewEntry[] } {
  const rest = queue.slice();
  while (rest.length) { const n = rest.shift()!; if (hasFile(n.beat.id)) return { next: n, queue: rest }; }
  return { next: null, queue: [] };
}
