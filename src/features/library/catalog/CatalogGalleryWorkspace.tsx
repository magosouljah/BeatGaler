// T16 / V08-A — Workspace POSTGRES (rama del catálogo): monta el shell aprobado (GalleryChrome, BeatCards, Playbar, Drawer) sobre los
// servicios del catálogo. Sin pager, sin cache global de beats y sin INDEX: cualquier estado del store se muestra con copy (fail-closed).
// Importa las hojas del diseño aprobado igual que el AppShell legacy (GalleryChrome ya trae tokens/gallery/product-gallery) más la
// geometría de filas virtuales (solo selectores scoped por data-catalog-mode="postgres").
import "./catalog-gallery.css";
import { CatalogAppShell } from "./CatalogAppShell";
import type { CatalogServices } from "./catalogLibraryProvider";

export interface CatalogGalleryWorkspaceProps {
  services: CatalogServices;
  accountId: string;
  context: { authority_era: string; authority_epoch: string; revision: string };
  viewportHeightFallback?: number;
}

export function CatalogGalleryWorkspace(props: CatalogGalleryWorkspaceProps) {
  return <CatalogAppShell {...props} />;
}
