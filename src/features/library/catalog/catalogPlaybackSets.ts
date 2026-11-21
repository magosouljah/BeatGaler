// Conjunto de resultados del reproductor: el servidor lo construye en segundo plano (`BUILDING`, memberCount 0 hasta terminar).
// Tomar ese BUILDING como «query vacío» (y guardarlo en caché) dejaba Siguiente/Anterior/Shuffle sin efecto: se espera a READY como hace la selección.
import { CatalogApiError, type CatalogQueryFilters, type CatalogSort } from "./catalogApi";
import type { CatalogCommandsApi } from "./catalogCommandsApi";

export const PLAYBACK_SET_READY_TIMEOUT_MS = 15_000;
export const PLAYBACK_SET_POLL_MS = 120;
export interface PlaybackSetQuery { filters: CatalogQueryFilters; sort: CatalogSort; revision: string }
export const playbackSetKey = (q: PlaybackSetQuery): string => JSON.stringify([q.filters, q.sort, q.revision]);

export async function resolveReadyQuerySet({ commands, accountId, query, timeoutMs = PLAYBACK_SET_READY_TIMEOUT_MS, pollMs = PLAYBACK_SET_POLL_MS, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), now = Date.now }: {
  commands: Pick<CatalogCommandsApi, "createQuerySet" | "getQuerySet">; accountId: string; query: PlaybackSetQuery; timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number;
}): Promise<{ setId: string; memberCount: number }> {
  let state = await commands.createQuerySet({ ...query.filters, includeTags: [...query.filters.includeTags], excludeTags: [...query.filters.excludeTags], sort: query.sort }, { id: `player-${accountId}`, kind: "SHUFFLE" });
  const started = now();
  while (state.status === "BUILDING") {
    if (now() - started > timeoutMs) throw new CatalogApiError(503, "QUERY_SET_BUILDING_BUSY", "La preparación de los resultados tarda demasiado; inténtalo de nuevo.", { setId: state.setId });
    await sleep(pollMs);
    state = await commands.getQuerySet(state.setId);
  }
  if (state.status !== "READY") throw new CatalogApiError(409, "CURSOR_STALE", `El conjunto de resultados quedó ${state.status}.`, { status: state.status, setId: state.setId });
  return { setId: state.setId, memberCount: state.memberCount };
}
