// T08 / V05 — Hook de filas virtuales: un ResizeObserver de geometría, listener de scroll pasivo + rAF, rango de filas por V03,
// compensación de ancla en layout effect (antes de paint, sin smooth) y aviso de viewport al store para protección/prefetch.
import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { CatalogQueryStore, CatalogStoreSnapshot } from "./catalogQueryStore";
import {
  DECLARED_TILE_HEIGHT, DEFAULT_ROW_GAP, assertGeometry, captureAnchor, estimateColumnsForViewportWidth, estimateGapsForViewportWidth,
  readColumnsFromTemplate, rowOf, rowPitch, scrollTopForAnchor, visibleRowRange, type RowAnchor, type RowGeometry, type RowRange,
} from "./catalogRowGeometry";

export interface VirtualRowsMeasure { columns: number | null; rowHeight: number | null; rowGap: number | null; padTop: number | null; viewportHeight: number | null; viewportWidth: number | null }
export interface UseCatalogVirtualRowsOptions {
  store: CatalogQueryStore;
  snapshot: CatalogStoreSnapshot;
  scrollerRef: RefObject<HTMLElement | null>;
  trackRef: RefObject<HTMLElement | null>;
  sampleCardRef?: RefObject<HTMLElement | null>;
  measure?: () => VirtualRowsMeasure;          // inyectable para fixtures sin layout
  geometryOverride?: Partial<RowGeometry>;
  viewportHeightFallback?: number;
}
export interface VirtualRowsState {
  geometry: RowGeometry;
  viewportHeight: number;
  originRow: number;
  range: RowRange;
  firstResidentRow: number;
  lastResidentRow: number;
  rowsResident: number;
}

function defaultMeasure(scroller: HTMLElement | null, track: HTMLElement | null, card: HTMLElement | null): VirtualRowsMeasure {
  if (!scroller || typeof getComputedStyle !== "function") return { columns: null, rowHeight: null, rowGap: null, padTop: null, viewportHeight: null, viewportWidth: null };
  const cs = track ? getComputedStyle(track) : null;
  const columns = cs ? readColumnsFromTemplate(cs.gridTemplateColumns) : null;
  const rowGap = cs ? Number.parseFloat(cs.rowGap || cs.gap || "") : NaN;
  const padTop = cs ? Number.parseFloat(cs.paddingTop || "") : NaN;
  const rowHeight = card ? card.getBoundingClientRect().height : NaN; // border-box sin transform de hover (tarjeta patrón)
  return {
    columns, rowHeight: Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : null, rowGap: Number.isFinite(rowGap) ? rowGap : null,
    padTop: Number.isFinite(padTop) ? padTop : null, viewportHeight: scroller.clientHeight || null, viewportWidth: scroller.clientWidth || null,
  };
}

export function useCatalogVirtualRows(o: UseCatalogVirtualRowsOptions): VirtualRowsState & { onScroll: () => void } {
  const { store, snapshot, scrollerRef, trackRef, sampleCardRef } = o;
  const [tick, setTick] = useState(0);
  const [measured, setMeasured] = useState<VirtualRowsMeasure>({ columns: null, rowHeight: null, rowGap: null, padTop: null, viewportHeight: null, viewportWidth: null });
  const anchorRef = useRef<RowAnchor | null>(null);
  const prevKey = useRef<string>("");
  const rafRef = useRef<number | null>(null);

  const geometry = useMemo<RowGeometry>(() => {
    const width = measured.viewportWidth ?? 1440;
    const gaps = estimateGapsForViewportWidth(width);
    return assertGeometry({
      columns: o.geometryOverride?.columns ?? measured.columns ?? estimateColumnsForViewportWidth(width),
      rowHeight: o.geometryOverride?.rowHeight ?? measured.rowHeight ?? DECLARED_TILE_HEIGHT,
      rowGap: o.geometryOverride?.rowGap ?? measured.rowGap ?? gaps.rowGap ?? DEFAULT_ROW_GAP,
      padTop: o.geometryOverride?.padTop ?? measured.padTop ?? 0,
    });
  }, [measured, o.geometryOverride]);
  const viewportHeight = measured.viewportHeight ?? o.viewportHeightFallback ?? 800;

  // Origen físico = primera fila residente; top de fila relativo a ella (track = intervalo residente, no toda la biblioteca).
  const firstResidentRow = rowOf(snapshot.firstOrdinal, geometry.columns);
  const lastResidentRow = snapshot.endOrdinal > snapshot.firstOrdinal ? rowOf(snapshot.endOrdinal - 1, geometry.columns) : firstResidentRow - 1;
  const originRow = firstResidentRow;
  const scrollTop = scrollerRef.current?.scrollTop ?? 0;
  const range = visibleRowRange({ scrollTop, viewportHeight, originRow, geometry, firstResidentRow, lastResidentRow });

  // Medición: un ResizeObserver sobre scroller/track/tarjeta patrón.
  useLayoutEffect(() => {
    const doMeasure = () => {
      const m = o.measure ? o.measure() : defaultMeasure(scrollerRef.current, trackRef.current, sampleCardRef?.current ?? null);
      setMeasured((prev) => (JSON.stringify(prev) === JSON.stringify(m) ? prev : m));
    };
    doMeasure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => doMeasure());
    if (scrollerRef.current) ro.observe(scrollerRef.current);
    if (trackRef.current) ro.observe(trackRef.current);
    if (sampleCardRef?.current) ro.observe(sampleCardRef.current);
    return () => ro.disconnect();
  }, [scrollerRef, trackRef, sampleCardRef, o.measure, tick]);

  // Compensación de ancla antes de paint cuando cambian origen/columnas/filas (prepend, evict, resize).
  const key = `${snapshot.queryGeneration}|${geometry.columns}|${snapshot.firstOrdinal}|${snapshot.endOrdinal}|${geometry.rowHeight}|${geometry.rowGap}`;
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (prevKey.current && prevKey.current !== key && anchorRef.current && anchorRef.current.ordinal >= snapshot.firstOrdinal && anchorRef.current.ordinal < snapshot.endOrdinal) {
      const sameGen = prevKey.current.split("|")[0] === String(snapshot.queryGeneration);
      if (sameGen) {
        const target = scrollTopForAnchor(anchorRef.current, originRow, geometry);
        if (Math.abs(target - scroller.scrollTop) >= 1) scroller.scrollTop = target;
      }
    }
    prevKey.current = key;
  }, [key, originRow, geometry, scrollerRef, snapshot.firstOrdinal, snapshot.endOrdinal, snapshot.queryGeneration]);

  // Scroll pasivo + rAF: recalcular rango, capturar ancla y avisar al store (protección + prefetch).
  const onScroll = () => {
    if (rafRef.current !== null) return;
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn: FrameRequestCallback) => setTimeout(() => fn(0), 16) as unknown as number;
    rafRef.current = raf(() => {
      rafRef.current = null;
      const scroller = scrollerRef.current;
      if (!scroller) return;
      anchorRef.current = captureAnchor({ scrollTop: scroller.scrollTop, originRow, geometry, ordinalAt: (i) => store.itemAt(i)?.id ?? null, firstResidentOrdinal: snapshot.firstOrdinal, lastResidentOrdinal: snapshot.endOrdinal - 1 });
      const r = visibleRowRange({ scrollTop: scroller.scrollTop, viewportHeight, originRow, geometry, firstResidentRow, lastResidentRow });
      const perViewport = Math.max(1, Math.ceil(viewportHeight / rowPitch(geometry))) * geometry.columns;
      store.observeViewport({ firstOrdinal: r.start * geometry.columns, lastOrdinal: Math.max(r.start * geometry.columns, r.end * geometry.columns - 1), perViewport });
      setTick((t) => t + 1);
    });
  };

  return { geometry, viewportHeight, originRow, range, firstResidentRow, lastResidentRow, rowsResident: Math.max(0, lastResidentRow - firstResidentRow + 1), onScroll };
}
