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
  /** E83: tarjetas provisionales de subidas en curso: ocupan los primeros huecos de la rejilla (posición = ordinal + n) y se retiran en el mismo render en que llega la real. */
  leadCards?: ReadonlyArray<{ id: string; node: ReactNode }>;
  onGoToStart?: () => void;
  /** Acciones del estado vacío (paridad con la Gallery anterior): «Add beat» en biblioteca vacía y «Clear filters» sin resultados. */
  onAddBeat?: () => void;
  onClearFilters?: () => void;
  onMountCard?: (id: string, ordinal: number) => void;
  onUnmountCard?: (id: string) => void;
  statusCopy?: Partial<Record<CatalogStoreSnapshot["status"], string>>;
  /** Atributos estables (data-*) sobre la celda de cada tarjeta, para pruebas DOM/e2e sin añadir nodos visibles (T16/V08). */
  cardAttributes?: (item: CatalogBeatDto, ordinal: number) => Record<string, string>;
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

// `mediaKey` = referencia de la portada vigente: con la actualización en el sitio (E79) una tarjeta sigue montada cuando PostgreSQL confirma
// un cambio, así que `onMount` (carga perezosa de la portada) se repite también cuando la referencia cambia, no solo al montar.
// El ordinal se entrega al montar (no es dependencia): una tarjeta que cambia de fila se vuelve a montar y su desmontaje anterior ya lo había olvidado.
function Card({ id, ordinal, mediaKey, children, onMount, onUnmount }: { id: string; ordinal: number; mediaKey: string; children: ReactNode; onMount?: (id: string, ordinal: number) => void; onUnmount?: (id: string) => void }) {
  useEffect(() => { onMount?.(id, ordinal); }, [id, mediaKey, onMount]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onUnmount?.(id), [id, onUnmount]);
  return <>{children}</>;
}

export function CatalogVirtualGallery(props: CatalogVirtualGalleryProps) {
  const { store, scrollerRef, renderCard, tenantKey } = props;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const sampleRef = useRef<HTMLDivElement | null>(null);
  const leadCards = snapshot.firstOrdinal === 0 ? props.leadCards ?? [] : [];
  const lead = leadCards.length;
  const rows = useCatalogVirtualRows({ store, snapshot, scrollerRef, trackRef, sampleCardRef: sampleRef, lead, measure: props.measure, geometryOverride: props.geometryOverride, viewportHeightFallback: props.viewportHeightFallback });
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
  const statusLike = !["ready", "loading", "resolving", "idle"].includes(snapshot.status) && !(lead > 0 && snapshot.status === "empty");
  const error = snapshot.edgeError;

  return (
    <>
    {/* Avisos de recarga/enlace antiguo fuera del track (V09: dentro se superponían a las filas absolutas). */}
    {snapshot.staleReset && <div role="status" className="bg-catalog-status bg-catalog-track-notice" data-catalog-stale-reset="true">La biblioteca cambió; se recargó el inicio con tus filtros.</div>}
    {snapshot.legacy && snapshot.legacy.resolution === "last" && <div role="status" className="bg-catalog-status bg-catalog-track-notice" data-catalog-legacy="last">La posición del enlace antiguo ya no existe; se abrió el último bloque.</div>}
    <div ref={trackRef} className="bg-catalog-track" role="feed" aria-busy={snapshot.status === "loading" || snapshot.status === "resolving" || snapshot.loadingForward || snapshot.loadingBackward}
      data-catalog-generation={snapshot.queryGeneration} data-catalog-revision={snapshot.revision ?? ""} data-resident-rows={residentRows} style={{ height: statusLike ? undefined : height }}>
      {statusLike && (
        <div className="bg-catalog-status" role="status" data-catalog-state={snapshot.status}>
          <div>{snapshot.status === "error" && error?.code === "LEGACY_OFFSET_UNRESOLVABLE" ? LEGACY_UNRESOLVABLE_COPY : copy[snapshot.status] ?? copy.error}</div>
          {snapshot.status === "empty" && props.onAddBeat && <div><div style={{ marginTop: 7, fontSize: 12, color: "#888" }}>Add a beat to start your library.</div><button type="button" className="bg-button bg-button--secondary" onClick={() => props.onAddBeat?.()}>Add beat</button></div>}
          {snapshot.status === "no-results" && props.onClearFilters && <div><button type="button" className="bg-button bg-button--ghost" onClick={() => props.onClearFilters?.()}>Clear filters</button></div>}
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
        const positions = ordinalsOfRow(globalRow, geometry.columns, Number.MAX_SAFE_INTEGER);
        const ordinals = positions.filter((p) => p >= lead).map((p) => p - lead).filter((i) => i >= snapshot.firstOrdinal && i < snapshot.endOrdinal);
        return (
          <div key={`${snapshot.queryGeneration}:${geometry.columns}:${globalRow}`} className="bg-catalog-row" role="presentation" data-catalog-row={globalRow} style={{ top: topOf(globalRow), height: geometry.rowHeight }}>
            {positions.filter((p) => p < lead).map((p) => (
              <article key={`lead:${leadCards[p].id}`} className="lab-gallery-item" data-pending-import={leadCards[p].id}>{leadCards[p].node}</article>
            ))}
            {ordinals.map((ordinal, col) => {
              const item = store.itemAt(ordinal);
              if (!item) return <div key={`gap-${ordinal}`} aria-hidden="true" />;
              const ref = globalRow === range.start && col === 0 ? sampleRef : undefined;
              return (
                <article key={`${tenantKey}:${item.id}`} ref={ref} className="lab-gallery-item" data-catalog-ordinal={ordinal} aria-posinset={ordinal + 1} aria-setsize={total ?? -1} {...(props.cardAttributes ? props.cardAttributes(item, ordinal) : {})}>
                  <Card id={item.id} ordinal={ordinal} mediaKey={item.artwork ? `${item.artwork.fileId}:${item.artwork.revision}` : ""} onMount={props.onMountCard} onUnmount={props.onUnmountCard}>{renderCard(item, ordinal)}</Card>
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
    </>
  );
}
export default CatalogVirtualGallery;
