import { getActiveWebAccountId } from "../features/auth/activeWebAccount";
import { LibraryCompositionGate } from "../features/library/catalog/LibraryCompositionGate";
import { useLibraryComposition } from "../features/library/catalog/catalogLibraryProvider";
import { CatalogGalleryWorkspace } from "../features/library/catalog/CatalogGalleryWorkspace";

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
