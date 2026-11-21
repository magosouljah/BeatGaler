import { getActiveWebAccountId } from "../features/auth/activeWebAccount";
import { LibraryCompositionGate } from "../features/library/catalog/LibraryCompositionGate";
import { useLibraryComposition } from "../features/library/catalog/catalogLibraryProvider";
import { CatalogGalleryWorkspace } from "../features/library/catalog/CatalogGalleryWorkspace";

// T16 / V08-A — Composición por autoridad (plan B §3; NATIVO r2.1 §2). Con VITE_CATALOG_API_ENABLED apagado (por defecto) la rama LEGACY
// es exactamente la de antes (pager + App). Con el flag encendido se resuelve /context antes de montar: POSTGRES → workspace del catálogo
// (sin pager ni INDEX); bloqueado/desconocido → estado visible, nunca LEGACY. El pager solo se monta en LEGACY.
// E80: el árbol LEGACY (App + pager + puente UX) es un chunk aparte que solo se descarga si la composición resuelve LEGACY: la Gallery
// POSTGRES ya no descarga ni evalúa el código del pipeline INDEX en su arranque.
// Con el flag apagado (composición LEGACY sin petición) el chunk se pide al evaluar este módulo, sin esperar al primer render.
// T25: INDEX retirado. La Web ya no monta el árbol LEGACY (pager + App + pipeline INDEX): una composición legacy (flag forzado a
// "false") muestra un estado fail-closed visible, nunca la biblioteca INDEX. PostgreSQL es la única autoridad del catálogo.
const LegacyRetired = () => (
  <main className="bg-product-gallery" data-catalog-mode="legacy-retired" role="status">This BeatGaler version requires the PostgreSQL catalog.</main>
);

export default function WebGalleryWorkspace() {
  const accountId = getActiveWebAccountId();
  const { state, services } = useLibraryComposition({ accountId });
  return (
    <LibraryCompositionGate
      state={state}
      legacy={<LegacyRetired />}
      catalog={(c) => (services && accountId
        ? <CatalogGalleryWorkspace services={services} accountId={accountId} context={{ authority_era: c.resolution.context.authority_era, authority_epoch: c.resolution.context.authority_epoch, revision: c.resolution.context.revision }} />
        : <main className="bg-product-gallery" data-catalog-mode="postgres" aria-busy="true" aria-label="Preparando el catálogo" />)}
    />
  );
}
