// T08 / V05 — Gallery virtualizada del catálogo (plan B §§3–7). Un solo scroller (el `[data-library-scroll]` de AppShell, pasado
// por ref), filas absolutas sobre un track de altura acotada, placeholders de frontera con reintento contextual, sin pager y
// sin re-sort/filtro local. Las tarjetas se montan solo en el rango y se desmontan de verdad al salir. Composición de producto
// apagada en T08: este componente se usa en fixtures; AppShell lo monta en T16.
import React, { useEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import type { CatalogBeatDto } from "./catalogApi";
import type { CatalogQueryStore, CatalogStoreSnapshot } from "./catalogQueryStore";
import { ordinalsOfRow, rowPitch, rowTop, type RowGeometry } from "./catalogRowGeometry";
import { useCatalogVirtualRows, type VirtualRowsMeasure } from "./useCatalogVirtualRows";
import { LEGACY_GO_TO_START_ACTION, LEGACY_UNRESOLVABLE_COPY } from "./catalogNavigation";

export interface CatalogVirtualGalleryProps {
  store: CatalogQueryStore;
  scrollerRef: RefObject<HTMLElement | null>;
  renderCard: (item: CatalogBeatDto, ordinal: number) => ReactNode;
  tenantKey: string;
  measure?: () => VirtualRowsMeasure;
  geometryOverride?: Partial<RowGeometry>;
  viewportHeightFallback?: number;
  onGoToStart?: () => void;
  onMountCard?: (id: string) => void;
  onUnmountCard?: (id: string) => void;
  statusCopy?: Partial<Record<CatalogStoreSnapshot["status"], string>>;
}

const DEFAULT_COPY: Record<string, string> = {
  empty: "Empty Gallery",
  "no-results": "No beats match your search",
  offline: "Reconnect to verify your Galer Cloud library.",
  unavailable: "El catálogo no está disponible en este momento.",
  unauthenticated: "Session expired. Sign in again.",
  reset_required: "Esta biblioteca requiere un reinicio nativo antes de usarse.",
  quarantined: "Esta biblioteca está en cuarentena temporal. Inténtalo más tarde.",
  integrity: "Se detectó una inconsistencia en el catálogo. Recarga la Gallery.",
  error: "No se pudo cargar la Gallery.",
};

function Card({ id, children, onMount, onUnmount }: { id: string; children: ReactNode; onMount?: (id: string) => void; onUnmount?: (id: string) => void }) {
  useEffect(() => { onMount?.(id); return () => onUnmount?.(id); }, [id, onMount, onUnmount]);
  return <>{children}</>;
}

export function CatalogVirtualGallery(props: CatalogVirtualGalleryProps) {
  const { store, scrollerRef, renderCard, tenantKey } = props;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const sampleRef = useRef<HTMLDivElement | null>(null);
  const rows = useCatalogVirtualRows({ store, snapshot, scrollerRef, trackRef, sampleCardRef: sampleRef, measure: props.measure, geometryOverride: props.geometryOverride, viewportHeightFallback: props.viewportHeightFallback });
  const { geometry, originRow, range, firstResidentRow, lastResidentRow } = rows;
  const P = rowPitch(geometry);

  // Listener de scroll pasivo sobre el scroller externo (único).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const handler = () => rows.onScroll();
    el.addEventListener("scroll", handler, { passive: true });
    return () => el.removeEventListener("scroll", handler);
  }, [scrollerRef, rows.onScroll]);

  const residentRows = Math.max(0, lastResidentRow - firstResidentRow + 1);
  const before = snapshot.hasBefore || snapshot.loadingBackward;
  const after = snapshot.hasAfter || snapshot.loadingForward;
  const height = geometry.padTop + residentRows * P + (before ? P : 0) + (after ? P : 0);
  const rowOffset = before ? P : 0; // placeholder anterior ocupa una fila física
  const topOf = (globalRow: number) => rowTop(globalRow, originRow, geometry) + rowOffset;
  const total = snapshot.totalMatched;
  const copy = { ...DEFAULT_COPY, ...(props.statusCopy ?? {}) };
  const statusLike = !["ready", "loading", "resolving", "idle"].includes(snapshot.status);
  const error = snapshot.edgeError;

  return (
    <div ref={trackRef} className="bg-catalog-track" role="feed" aria-busy={snapshot.status === "loading" || snapshot.status === "resolving" || snapshot.loadingForward || snapshot.loadingBackward}
      data-catalog-generation={snapshot.queryGeneration} data-catalog-revision={snapshot.revision ?? ""} data-resident-rows={residentRows} style={{ height: statusLike ? undefined : height }}>
      {snapshot.staleReset && <div role="status" className="bg-catalog-status" data-catalog-stale-reset="true">La biblioteca cambió; se recargó el inicio con tus filtros.</div>}
      {snapshot.legacy && snapshot.legacy.resolution === "last" && <div role="status" className="bg-catalog-status" data-catalog-legacy="last">La posición del enlace antiguo ya no existe; se abrió el último bloque.</div>}
      {statusLike && (
        <div className="bg-catalog-status" role="status" data-catalog-state={snapshot.status}>
          <div>{snapshot.status === "error" && error?.code === "LEGACY_OFFSET_UNRESOLVABLE" ? LEGACY_UNRESOLVABLE_COPY : copy[snapshot.status] ?? copy.error}</div>
          {(snapshot.status === "error" || snapshot.status === "offline" || snapshot.status === "unavailable") && (
            <div>
              {error?.code === "LEGACY_OFFSET_UNRESOLVABLE" || error?.code === "LEGACY_OFFSET_INVALID"
                ? <button type="button" className="bg-button bg-button--secondary" onClick={() => props.onGoToStart?.()}>{LEGACY_GO_TO_START_ACTION}</button>
                : <button type="button" className="bg-button bg-button--secondary" onClick={() => { void store.retry(); }}>Reintentar</button>}
            </div>
          )}
        </div>
      )}
      {!statusLike && before && (
        <div className="bg-catalog-placeholder" data-catalog-placeholder="before" style={{ top: geometry.padTop, height: geometry.rowHeight }} aria-hidden={!error}>
          {error && error.direction === "backward" ? <button type="button" className="bg-button bg-button--ghost" onClick={() => { void store.retry(); }}>Reintentar</button> : null}
        </div>
      )}
      {!statusLike && Array.from({ length: Math.max(0, range.end - range.start) }, (_, k) => range.start + k).map((globalRow) => {
        const ordinals = ordinalsOfRow(globalRow, geometry.columns, Number.MAX_SAFE_INTEGER).filter((i) => i >= snapshot.firstOrdinal && i < snapshot.endOrdinal);
        return (
          <div key={`${snapshot.queryGeneration}:${geometry.columns}:${globalRow}`} className="bg-catalog-row" role="presentation" data-catalog-row={globalRow} style={{ top: topOf(globalRow), height: geometry.rowHeight }}>
            {ordinals.map((ordinal, col) => {
              const item = store.itemAt(ordinal);
              if (!item) return <div key={`gap-${ordinal}`} aria-hidden="true" />;
              const ref = globalRow === range.start && col === 0 ? sampleRef : undefined;
              return (
                <article key={`${tenantKey}:${item.id}`} ref={ref} className="lab-gallery-item" data-catalog-ordinal={ordinal} aria-posinset={ordinal + 1} aria-setsize={total ?? -1}>
                  <Card id={item.id} onMount={props.onMountCard} onUnmount={props.onUnmountCard}>{renderCard(item, ordinal)}</Card>
                </article>
              );
            })}
          </div>
        );
      })}
      {!statusLike && after && (
        <div className="bg-catalog-placeholder" data-catalog-placeholder="after" style={{ top: geometry.padTop + rowOffset + residentRows * P, height: geometry.rowHeight }} aria-hidden={!error}>
          {error && error.direction === "forward" ? <button type="button" className="bg-button bg-button--ghost" onClick={() => { void store.retry(); }}>Reintentar</button> : null}
        </div>
      )}
    </div>
  );
}
export default CatalogVirtualGallery;
