// Identidades de consulta del catálogo Web. Cada variante es deliberada y NO equivale a las demás; no se unifican sin decisión (X50).
import type { CatalogQueryFilters, CatalogSort } from "./catalogApi";

/** Normalizada (q recortada y en minúsculas, tags sin duplicados y ordenados por bytes, con sort): equivale al hash del servidor; clave del store y de la caché de primer bloque. */
export function filtersKey(f: CatalogQueryFilters, sort: CatalogSort): string {
  const byBytes = (a: string, b: string) => (new TextEncoder().encode(a).join(",") < new TextEncoder().encode(b).join(",") ? -1 : 1);
  return JSON.stringify({ state: f.state, q: f.q.trim().toLowerCase(), includeMode: f.includeMode, include: [...new Set(f.includeTags)].sort(byBytes), exclude: [...new Set(f.excludeTags)].sort(byBytes), sort });
}

/** Conjunto de reproducción: JSON crudo de [filters, sort, revision]; distingue mayúsculas, orden/duplicados de tags y revisión, porque el servidor construye un conjunto por entrada literal. */
export function playbackSetKey(q: { filters: CatalogQueryFilters; sort: CatalogSort; revision: string }): string {
  return JSON.stringify([q.filters, q.sort, q.revision]);
}

/** Disparador de reproducción: filtros crudos (con includeMode) sin sort ni revisión, que el efecto observa por separado. */
export function playbackFiltersKey({ q, includeTags, excludeTags, state, includeMode }: CatalogQueryFilters): string {
  return `${q}|${includeTags.join(",")}|${excludeTags.join(",")}|${state}|${includeMode}`;
}

/** Comparación de filtros de la sesión de reproducción: JSON crudo de los filtros (orden de claves incluido), sin sort ni revisión. */
export function playbackFiltersIdentity(f: CatalogQueryFilters): string {
  return JSON.stringify(f);
}
