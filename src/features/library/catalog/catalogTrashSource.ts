// Papelera NATIVA del catálogo para el panel de Ajustes → Trash. Sin esto el panel usaba `platform.trash` (transporte web LEGACY del INDEX):
// no listaba la papelera PostgreSQL y «Empty trash» llamaba a la ruta legacy. Aquí: listar = beats en estado TRASH; restaurar = restoreBeats con
// la versión esperada; vaciar = purga durable (operación del servidor, con sondeo acotado).
import type { Beat } from "../../../types";
import type { PlatformTrashItem } from "../../../platform/contracts";
import { DEFAULT_FILTERS, type CatalogApi, type CatalogBeatDto } from "./catalogApi";
import { beatFromCatalogDetail, type CatalogMutations } from "./catalogMutations";

export interface CatalogTrashSource { listBeats(): Promise<PlatformTrashItem[]>; restoreBeat(id: string): Promise<Beat>; purgeBeats(): Promise<number> }

export function createCatalogTrashSource({ api, mutations, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), pollMs = 800, pollMax = 25 }: {
  api: Pick<CatalogApi, "listBeats">; mutations: Pick<CatalogMutations, "restoreBeats" | "purgeTrash" | "purgeState">; sleep?: (ms: number) => Promise<void>; pollMs?: number; pollMax?: number;
}): CatalogTrashSource {
  const known = new Map<string, CatalogBeatDto>();
  async function list(): Promise<CatalogBeatDto[]> {
    const out: CatalogBeatDto[] = []; let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page: Awaited<ReturnType<CatalogApi["listBeats"]>> = await api.listBeats({ ...DEFAULT_FILTERS, state: "TRASH", sort: "manual", limit: 200, cursor });
      const body = (page as unknown as { body?: { items: CatalogBeatDto[]; nextCursor?: string | null } }).body ?? (page as unknown as { items: CatalogBeatDto[]; nextCursor?: string | null });
      out.push(...body.items); cursor = body.nextCursor ?? null; if (!cursor) break;
    }
    return out;
  }
  return {
    async listBeats() {
      const items = await list(); known.clear(); for (const d of items) known.set(d.id, d);
      return items.map((d) => ({ id: d.id, beat_name: d.name, trashed_at: Date.parse((d as { trash?: { trashedAt?: string } }).trash?.trashedAt ?? "") || Date.now(), is_cloud: true }));
    },
    async restoreBeat(id) {
      const dto = known.get(id); if (!dto) throw new Error("Este beat ya no está en la papelera; recarga la lista.");
      const r = await mutations.restoreBeats([{ beatId: id, expectedVersion: dto.version }]);
      if (r.status !== "COMPLETED") {
        const code = (r.conflict?.error as { code?: string } | undefined)?.code;
        throw new Error(code === "NAME_TAKEN" ? `No se puede restaurar «${dto.name}»: ya existe un beat activo con ese nombre. Renombra uno de los dos primero.` : r.status === "CONFLICT" ? "El beat cambió en otro dispositivo; recarga la papelera." : "No se pudo restaurar el beat.");
      }
      known.delete(id); return beatFromCatalogDetail(dto, null);
    },
    // §6.1-4 / E81: «eliminado» = los beats salieron de la biblioteca PostgreSQL (purga PURGED). La limpieza de sus archivos en Telegram sigue
    // en segundo plano en el servidor y no bloquea nada (ni depende de restore_hold/cleanup). Pendiente/bloqueada/parcial → mensaje veraz.
    async purgeBeats() {
      const before = known.size || (await list()).length;
      const started = await mutations.purgeTrash();
      let status = started.status; let operation: { progress?: { purged?: number; blocked?: number } } | null = started.operation;
      for (let i = 0; i < pollMax && status === "pending"; i++) { await sleep(pollMs); const st = await mutations.purgeState(started.operationId); status = st.status; operation = st.operation; }
      if (status === "pending") throw new Error("La eliminación definitiva sigue en curso en el servidor; todavía no se ha confirmado el borrado de ningún beat.");
      if (status === "partial") throw new Error(`Se eliminaron ${operation?.progress?.purged ?? "algunos"} beat(s); ${operation?.progress?.blocked ?? "otros"} siguen en la papelera sin cambios (una subida en curso o archivos no identificables) y no se borró nada de ellos.`);
      if (status === "blocked") throw new Error("No se pudo eliminar definitivamente ningún beat: siguen en la papelera sin cambios y no se borró nada.");
      if (status === "cancelled") throw new Error("La eliminación definitiva se canceló; no se eliminó ningún beat más.");
      return before;
    },
  };
}
