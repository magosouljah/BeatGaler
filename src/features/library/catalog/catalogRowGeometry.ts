// T08 / V03 — Geometría pura de filas (plan B §4). O(1) para límites, O(filas montadas) para render; ningún array de N.
// C columnas (leídas del grid resuelto), H altura medida border-box, G rowGap, P = H + G, V alto útil del scroller.
// Fila global floor(i/C), columna i % C; top de fila = (globalRow − originRow) × P + padTop; overscan O = min(8, max(2, ceil(ceil(V/P)/2))).

export interface RowGeometry {
  columns: number;
  rowHeight: number;
  rowGap: number;
  padTop: number;
}
export interface RowRange { start: number; end: number } // filas globales, [start, end)

export const DECLARED_TILE_HEIGHT = 239; // estimación inicial (CSS .lab-beat-tile--v2), siempre corregida por medición
export const DECLARED_TILE_WIDTH = 160;
export const DEFAULT_ROW_GAP = 28;

export function assertGeometry(g: RowGeometry): RowGeometry {
  if (!Number.isInteger(g.columns) || g.columns < 1) throw new Error("STOP-LAYOUT: columns must be a positive integer");
  if (!Number.isFinite(g.rowHeight) || g.rowHeight <= 0) throw new Error("STOP-LAYOUT: rowHeight must be positive");
  if (!Number.isFinite(g.rowGap) || g.rowGap < 0) throw new Error("STOP-LAYOUT: rowGap must be >= 0");
  if (!Number.isFinite(g.padTop) || g.padTop < 0) throw new Error("STOP-LAYOUT: padTop must be >= 0");
  return g;
}
export const rowPitch = (g: RowGeometry): number => g.rowHeight + g.rowGap;
export const rowOf = (ordinal: number, columns: number): number => Math.floor(ordinal / columns);
export const colOf = (ordinal: number, columns: number): number => ordinal % columns;
export const rowCount = (total: number, columns: number): number => (total <= 0 ? 0 : Math.ceil(total / columns));
export const firstOrdinalOfRow = (row: number, columns: number): number => row * columns;
// Ordinales de una fila dentro de [0, total): la última fila parcial alinea con las mismas columnas (no se centra).
export function ordinalsOfRow(row: number, columns: number, total: number): number[] {
  const first = row * columns;
  const out: number[] = [];
  for (let k = 0; k < columns && first + k < total; k++) out.push(first + k);
  return out;
}
export const rowTop = (globalRow: number, originRow: number, g: RowGeometry): number => (globalRow - originRow) * rowPitch(g) + g.padTop;
export function overscanRows(viewportHeight: number, pitch: number): number {
  if (pitch <= 0) return 2;
  return Math.min(8, Math.max(2, Math.ceil(Math.ceil(viewportHeight / pitch) / 2)));
}
export const maxMountedCards = (g: RowGeometry, viewportHeight: number): number => {
  const P = rowPitch(g);
  const O = overscanRows(viewportHeight, P);
  return g.columns * (Math.ceil(viewportHeight / P) + 2 * O + 2 + 1);
};

// Rango de filas a montar dado el scroll, el alto útil y el intervalo residente [firstResidentRow, lastResidentRow].
export function visibleRowRange(input: { scrollTop: number; viewportHeight: number; originRow: number; geometry: RowGeometry; firstResidentRow: number; lastResidentRow: number }): RowRange {
  const { scrollTop, viewportHeight, originRow, geometry, firstResidentRow, lastResidentRow } = input;
  const P = rowPitch(geometry);
  if (lastResidentRow < firstResidentRow) return { start: firstResidentRow, end: firstResidentRow };
  const O = overscanRows(viewportHeight, P);
  const firstVisible = originRow + Math.floor(Math.max(0, scrollTop - geometry.padTop) / P);
  const lastVisible = originRow + Math.floor(Math.max(0, scrollTop + viewportHeight - geometry.padTop - 1) / P);
  const start = Math.max(firstResidentRow, firstVisible - O);
  const end = Math.min(lastResidentRow + 1, lastVisible + O + 1);
  return { start, end: Math.max(start, end) };
}

// Altura del track: filas residentes + a lo sumo un placeholder antes y uno después (plan B §4 «sin millones de espaciadores»).
export function trackHeight(input: { residentRows: number; geometry: RowGeometry; placeholderBefore: boolean; placeholderAfter: boolean; placeholderRows?: number }): number {
  const P = rowPitch(input.geometry);
  const ph = (input.placeholderRows ?? 1) * P;
  return input.geometry.padTop + input.residentRows * P + (input.placeholderBefore ? ph : 0) + (input.placeholderAfter ? ph : 0);
}

// Ancla estable: tarjeta de referencia y su offset respecto al área útil del mismo scroller.
export interface RowAnchor { ordinal: number; beatId: string; intraRowPx: number; viewportOffsetPx: number; columns: number }
export function captureAnchor(input: { scrollTop: number; originRow: number; geometry: RowGeometry; ordinalAt: (ordinal: number) => string | null; firstResidentOrdinal: number; lastResidentOrdinal: number; focusedOrdinal?: number | null }): RowAnchor | null {
  const { scrollTop, originRow, geometry, ordinalAt, firstResidentOrdinal, lastResidentOrdinal } = input;
  if (lastResidentOrdinal < firstResidentOrdinal) return null;
  const P = rowPitch(geometry);
  let ordinal: number;
  if (input.focusedOrdinal != null && input.focusedOrdinal >= firstResidentOrdinal && input.focusedOrdinal <= lastResidentOrdinal) ordinal = input.focusedOrdinal;
  else {
    const firstVisibleRow = originRow + Math.floor(Math.max(0, scrollTop - geometry.padTop) / P);
    ordinal = Math.min(Math.max(firstVisibleRow * geometry.columns, firstResidentOrdinal), lastResidentOrdinal);
  }
  const beatId = ordinalAt(ordinal);
  if (beatId === null) return null;
  const top = rowTop(rowOf(ordinal, geometry.columns), originRow, geometry);
  return { ordinal, beatId, intraRowPx: 0, viewportOffsetPx: top - scrollTop, columns: geometry.columns };
}
// scrollTop que mantiene el ancla en el mismo offset tras cambiar origen, columnas o filas (prepend/evict/resize).
export function scrollTopForAnchor(anchor: RowAnchor, originRow: number, geometry: RowGeometry): number {
  return Math.max(0, rowTop(rowOf(anchor.ordinal, geometry.columns), originRow, geometry) - anchor.viewportOffsetPx);
}
// Delta exacto de scroll al retirar/añadir `rows` filas por arriba (originRow se mueve por las filas retiradas).
export const scrollDeltaForRows = (rows: number, geometry: RowGeometry): number => rows * rowPitch(geometry);

// Lectura de columnas desde el grid resuelto (no duplicar breakpoints en JS). Devuelve null si no es medible (jsdom sin layout).
export function readColumnsFromTemplate(gridTemplateColumns: string | null | undefined): number | null {
  if (!gridTemplateColumns || gridTemplateColumns === "none") return null;
  const repeat = /repeat\(\s*(\d+)\s*,/.exec(gridTemplateColumns);
  if (repeat) return Number(repeat[1]);
  const tracks = gridTemplateColumns.trim().split(/\s+/).filter((t) => /^[0-9.]+px$/.test(t) || /^minmax\(/.test(t) || /^[0-9.]+fr$/.test(t));
  return tracks.length > 0 ? tracks.length : null;
}
// Estimación de columnas por ancho útil cuando el grid aún no resolvió (mismos breakpoints que gallery.css, solo como fallback declarado).
export function estimateColumnsForViewportWidth(width: number): number {
  if (width <= 359) return 1;
  if (width <= 590) return 2;
  if (width <= 750) return 3;
  if (width <= 940) return 4;
  if (width <= 1160) return 5;
  if (width <= 1400) return 6;
  return 7;
}
export function estimateGapsForViewportWidth(width: number): { columnGap: number; rowGap: number } {
  if (width <= 590) return { columnGap: 13, rowGap: 22 };
  if (width <= 750) return { columnGap: 15, rowGap: 24 };
  return { columnGap: 22, rowGap: 28 };
}
