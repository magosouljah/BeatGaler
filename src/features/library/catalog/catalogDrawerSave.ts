import type { Beat } from "../../../types";
import type { CatalogMutations } from "./catalogMutations";
import { drawerEditError, editDrawer, type DrawerSaveDeps, type DrawerSaveInput } from "./catalogBeatEditor";

export { pendingTransferNotice, type DrawerSaveDeps, type DrawerSaveInput } from "./catalogBeatEditor";

export async function saveDrawerChanges(deps: DrawerSaveDeps, input: DrawerSaveInput): Promise<{ status: "committed" | "patched"; artworkRemoved: boolean }> {
  const result = await editDrawer(deps, input);
  if (result.reading !== "success") throw drawerEditError(result);
  return { status: result.status === "committed" ? "committed" : "patched", artworkRemoved: result.artworkRemoved };
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
