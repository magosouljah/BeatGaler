// T16 / V08-A — Workspace POSTGRES (rama del catálogo): Gallery virtualizada (V05) sobre el store acotado (V04), sin pager ni cache
// global de beats, con el InteractionStore (V07-A) y la sesión musical (V06) de los servicios de la cuenta. Fail-closed: cualquier
// estado del store se muestra con copy, nunca se consulta INDEX ni se construye el transporte legacy. La paridad visual completa con
// la Gallery LOCAL (chrome, tarjetas, Playbar) se valida en V09 con navegador real; aquí las tarjetas usan la geometría declarada y
// atributos estables para las pruebas DOM.
import { useEffect, useMemo, useRef } from "react";
import type { CatalogBeatDto } from "./catalogApi";
import { CatalogVirtualGallery } from "./CatalogVirtualGallery";
import type { CatalogServices } from "./catalogLibraryProvider";
import { useCatalogInteraction } from "./catalogInteractionStore";
import { useCatalogPlayback } from "./catalogPlaybackSession";

export interface CatalogGalleryWorkspaceProps {
  services: CatalogServices;
  accountId: string;
  context: { authority_era: string; authority_epoch: string; revision: string };
  viewportHeightFallback?: number;
}

export function CatalogGalleryWorkspace({ services, accountId, context, viewportHeightFallback = 800 }: CatalogGalleryWorkspaceProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const interaction = useCatalogInteraction(services.interaction);
  const playback = useCatalogPlayback(services.playback);
  const tenantKey = useMemo(() => `${accountId}:${context.authority_era}:${context.authority_epoch}`, [accountId, context.authority_era, context.authority_epoch]);
  useEffect(() => { services.store.loadFirst?.(); }, [services.store]);
  const renderCard = (item: CatalogBeatDto, ordinal: number) => {
    const selected = services.interaction.isSelected(item.id);
    const current = playback.current?.beatId === item.id;
    return (
      <article className="bg-catalog-card" data-card={item.id} data-ordinal={ordinal} data-selected={selected ? "true" : "false"} data-playing={current ? "true" : "false"} aria-selected={selected} tabIndex={0}
        onClick={(e) => { void services.interaction.toggle(item.id, { shiftKey: e.shiftKey, ordinal, query: { filters: services.store.getSnapshot().filters, sort: services.store.getSnapshot().sort, revision: services.store.getSnapshot().revision ?? context.revision } }); }}
        onDoubleClick={() => { void services.playback.play({ beatId: item.id, version: item.version, fileId: item.playback?.fileId ?? null }); }}>
        <h3 className="bg-catalog-card-name">{item.name}</h3>
        <p className="bg-catalog-card-meta">{item.bpm} · {item.key} · {item.rating}★</p>
      </article>
    );
  };
  return (
    <div className="bg-product-gallery" data-catalog-mode="postgres" data-account={accountId}>
      <div className="bg-catalog-status" role="status" aria-live="polite" data-selection-count={interaction.selection.count} data-selection-status={interaction.selection.status} data-playback-status={playback.status}>
        {interaction.selection.notice ? <p className="bg-catalog-notice">{interaction.selection.notice}</p> : null}
      </div>
      <div ref={scrollerRef} data-library-scroll="true" className="bg-catalog-scroller" style={{ overflowY: "auto", height: "100%" }}>
        <CatalogVirtualGallery store={services.store} scrollerRef={scrollerRef} tenantKey={tenantKey} renderCard={renderCard} viewportHeightFallback={viewportHeightFallback} />
      </div>
    </div>
  );
}
