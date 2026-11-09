import { useEffect } from "react";
import App from "../App";
import LibraryUxBridge from "../features/library/LibraryUxBridge";
import WebLibraryPagination from "../features/library/WebLibraryPagination";
import { preconnectRememberedWebDirect } from "../features/playback/webRememberedDirectPreconnect";
import { getActiveWebAccountId } from "../features/auth/activeWebAccount";
import { LibraryCompositionGate } from "../features/library/catalog/LibraryCompositionGate";
import { useLibraryComposition } from "../features/library/catalog/catalogLibraryProvider";
import { CatalogGalleryWorkspace } from "../features/library/catalog/CatalogGalleryWorkspace";

// T16 / V08-A — Composición por autoridad (plan B §3; NATIVO r2.1 §2). Con VITE_CATALOG_API_ENABLED apagado (por defecto) la rama LEGACY
// es exactamente la de antes (pager + App). Con el flag encendido se resuelve /context antes de montar: POSTGRES → workspace del catálogo
// (sin pager ni INDEX); bloqueado/desconocido → estado visible, nunca LEGACY. El pager solo se monta en LEGACY.
function LegacyWorkspace() {
  useEffect(() => { preconnectRememberedWebDirect(); }, []);
  return <><LibraryUxBridge /><WebLibraryPagination /><App /></>;
}

export default function WebGalleryWorkspace() {
  const accountId = getActiveWebAccountId();
  const { state, services } = useLibraryComposition({ accountId });
  return (
    <LibraryCompositionGate
      state={state}
      legacy={<LegacyWorkspace />}
      catalog={(c) => (services && accountId
        ? <CatalogGalleryWorkspace services={services} accountId={accountId} context={{ authority_era: c.resolution.context.authority_era, authority_epoch: c.resolution.context.authority_epoch, revision: c.resolution.context.revision }} />
        : <main className="bg-product-gallery" data-catalog-mode="postgres" aria-busy="true" aria-label="Preparando el catálogo" />)}
    />
  );
}
