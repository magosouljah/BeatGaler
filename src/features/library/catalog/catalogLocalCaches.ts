// E80 — Almacenamiento local del catálogo en este dispositivo, para Settings: las tres cachés existentes (metadatos de arranque E66,
// prefijos MP3 E71 y portadas originales E79), con su uso para la cuenta activa y su limpieza. Todas son copias prescindibles: limpiarlas solo
// libera espacio aquí; jamás toca PostgreSQL ni Telegram (no hay ninguna petición de red en este módulo). Los límites mostrados son los que
// las cachés ya aplican; este módulo no define ninguno nuevo.
import { safe } from "./catalogIdb";
import { ARTWORK_CACHE_DEFAULTS, type ArtworkCache } from "./catalogArtworkCache";
import type { FirstBlockCache } from "./catalogFirstBlockCache";
import { PREFIX_CACHE_DEFAULTS, type PrefixCache } from "./catalogPrefixCache";

export type CatalogLocalCacheKind = "metadata" | "prefixes" | "artwork";
export interface CatalogLocalCacheUsage { kind: CatalogLocalCacheKind; available: boolean; entries: number; bytes: number; limitBytes: number | null }
export interface CatalogLocalCaches {
  usage(): Promise<CatalogLocalCacheUsage[]>;
  clear(kind: CatalogLocalCacheKind | "all"): Promise<CatalogLocalCacheUsage[]>;
}

export function createCatalogLocalCaches({ accountId, firstBlockCache, prefixCache, artworkCache }: { accountId: string; firstBlockCache: FirstBlockCache | null; prefixCache: PrefixCache | null; artworkCache: ArtworkCache | null }): CatalogLocalCaches {
  const none = { entries: 0, bytes: 0 };
  const safeUsage = (fn: () => Promise<{ entries: number; bytes: number }>) => safe(fn, none);
  async function usage(): Promise<CatalogLocalCacheUsage[]> {
    const metadataOn = Boolean(firstBlockCache?.available);
    const [metadata, prefixes, artwork] = await Promise.all([
      metadataOn ? safeUsage(() => firstBlockCache!.usage(accountId)) : none,
      prefixCache ? safeUsage(() => prefixCache.usage(accountId)) : none,
      artworkCache ? safeUsage(() => artworkCache.usage(accountId)) : none,
    ]);
    return [
      { kind: "metadata", available: metadataOn, ...metadata, limitBytes: null },
      { kind: "prefixes", available: Boolean(prefixCache?.available), ...prefixes, limitBytes: PREFIX_CACHE_DEFAULTS.maxBytes },
      { kind: "artwork", available: Boolean(artworkCache), ...artwork, limitBytes: ARTWORK_CACHE_DEFAULTS.maxBytes },
    ];
  }
  async function clear(kind: CatalogLocalCacheKind | "all"): Promise<CatalogLocalCacheUsage[]> {
    const jobs: Promise<unknown>[] = [];
    if ((kind === "all" || kind === "metadata") && firstBlockCache?.available) jobs.push(firstBlockCache.invalidateAccount(accountId));
    if ((kind === "all" || kind === "prefixes") && prefixCache) jobs.push(prefixCache.dropAccount(accountId));
    if ((kind === "all" || kind === "artwork") && artworkCache) jobs.push(artworkCache.dropAccount(accountId));
    await Promise.allSettled(jobs);
    return usage();
  }
  return Object.freeze({ usage, clear });
}
