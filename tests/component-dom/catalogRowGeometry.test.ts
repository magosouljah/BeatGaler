// T08 / V03-C — Geometría pura (plan B §4): filas/columnas/top/rango/overscan/DOM máximo/ancla; coste independiente de N.
import { describe, expect, it } from "vitest";
import {
  assertGeometry, captureAnchor, colOf, estimateColumnsForViewportWidth, maxMountedCards, ordinalsOfRow, overscanRows, readColumnsFromTemplate,
  rowCount, rowOf, rowPitch, rowTop, scrollDeltaForRows, scrollTopForAnchor, trackHeight, visibleRowRange, type RowGeometry,
} from "../../src/features/library/catalog/catalogRowGeometry";

const G = (columns: number, rowHeight = 239, rowGap = 28, padTop = 34): RowGeometry => ({ columns, rowHeight, rowGap, padTop });

describe("catalogRowGeometry", () => {
  it("fila floor(i/C), columna i%C, conteo de filas y última fila parcial alineada para N = 0/1/239/240/241/100k/1M y C = 1..7", () => {
    for (const N of [0, 1, 239, 240, 241, 100_000, 1_000_000]) {
      for (let C = 1; C <= 7; C++) {
        const rows = rowCount(N, C);
        expect(rows).toBe(N === 0 ? 0 : Math.ceil(N / C));
        if (N > 0) {
          const last = N - 1;
          expect(rowOf(last, C)).toBe(rows - 1);
          expect(colOf(last, C)).toBe(last % C);
          const lastRow = ordinalsOfRow(rows - 1, C, N);
          expect(lastRow[0]).toBe((rows - 1) * C);
          expect(lastRow.length).toBe(N - (rows - 1) * C);
          expect(lastRow.length).toBeLessThanOrEqual(C);
          expect(ordinalsOfRow(0, C, N).length).toBe(Math.min(C, N));
        }
      }
    }
    expect(rowOf(240, 7)).toBe(34); expect(colOf(240, 7)).toBe(2);
    expect(ordinalsOfRow(34, 7, 241)).toEqual([238, 239, 240]);
  });

  it("pitch, top relativo al originRow móvil, overscan min(8,max(2,ceil(ceil(V/P)/2))) y DOM máximo C×(ceil(V/P)+2O+3)", () => {
    const g = G(7);
    expect(rowPitch(g)).toBe(267);
    expect(rowTop(10, 10, g)).toBe(34);
    expect(rowTop(12, 10, g)).toBe(34 + 2 * 267);
    expect(overscanRows(800, 267)).toBe(2);   // ceil(800/267)=3 → ceil(1.5)=2
    expect(overscanRows(2000, 267)).toBe(4);  // 8 filas → 4
    expect(overscanRows(10_000, 267)).toBe(8); // tope 8
    expect(overscanRows(0, 267)).toBe(2);
    expect(maxMountedCards(g, 800)).toBe(7 * (3 + 4 + 3));
    expect(() => assertGeometry(G(0))).toThrow(/STOP-LAYOUT/);
    expect(() => assertGeometry(G(3, NaN))).toThrow(/STOP-LAYOUT/);
  });

  it("rango de filas: viewport + overscan recortado al intervalo residente; mismo número de objetos para N = 1.000 y N = 1.000.000", () => {
    const g = G(5);
    const small = visibleRowRange({ scrollTop: 0, viewportHeight: 800, originRow: 0, geometry: g, firstResidentRow: 0, lastResidentRow: rowCount(1000, 5) - 1 });
    const huge = visibleRowRange({ scrollTop: 0, viewportHeight: 800, originRow: 0, geometry: g, firstResidentRow: 0, lastResidentRow: rowCount(1_000_000, 5) - 1 });
    expect(small).toEqual(huge);
    expect(small.end - small.start).toBeLessThanOrEqual(Math.ceil(800 / 267) + 2 * 2 + 1);
    // scroll profundo con origen móvil: el rango cae dentro del residente [originRow, lastResidentRow]
    const deep = visibleRowRange({ scrollTop: 34 + 267 * 10, viewportHeight: 800, originRow: 1000, geometry: g, firstResidentRow: 1000, lastResidentRow: 1047 });
    expect(deep.start).toBeGreaterThanOrEqual(1000); expect(deep.end).toBeLessThanOrEqual(1048);
    expect(deep.start).toBe(1008); // fila visible 1010 − overscan 2
    const empty = visibleRowRange({ scrollTop: 0, viewportHeight: 800, originRow: 0, geometry: g, firstResidentRow: 0, lastResidentRow: -1 });
    expect(empty).toEqual({ start: 0, end: 0 });
  });

  it("track acotado: filas residentes + a lo sumo un placeholder antes y otro después, nunca ceil(N/C)×P", () => {
    const g = G(4);
    expect(trackHeight({ residentRows: 60, geometry: g, placeholderBefore: false, placeholderAfter: true })).toBe(34 + 60 * 267 + 267);
    expect(trackHeight({ residentRows: 60, geometry: g, placeholderBefore: true, placeholderAfter: true })).toBe(34 + 62 * 267);
    expect(trackHeight({ residentRows: 60, geometry: g, placeholderBefore: true, placeholderAfter: true })).toBeLessThan(rowCount(1_000_000, 4) * 267);
  });

  it("ancla: captura la primera tarjeta visible y conserva su offset tras prepend/evict/resize/cambio de columnas (deriva 0 px en aritmética)", () => {
    const g = G(6);
    const ids = (i: number) => (i >= 600 && i < 1800 ? `w${i}` : null);
    const scrollTop = 34 + 267 * 120 + 100; // fila 120 visible parcialmente
    const anchor = captureAnchor({ scrollTop, originRow: 100, geometry: g, ordinalAt: ids, firstResidentOrdinal: 600, lastResidentOrdinal: 1799 });
    expect(anchor).toMatchObject({ ordinal: 220 * 6, beatId: "w1320", columns: 6 });
    expect(anchor!.viewportOffsetPx).toBe(-100);
    // prepend de 240 DTO (40 filas): el origen baja 40 filas → scrollTop sube exactamente 40 × P
    expect(scrollTopForAnchor(anchor!, 60, g) - scrollTop).toBe(scrollDeltaForRows(40, g));
    // evict por arriba de 240: origen sube 40 filas → scrollTop baja 40 × P
    expect(scrollTopForAnchor(anchor!, 140, g) - scrollTop).toBe(-scrollDeltaForRows(40, g));
    // cambio de columnas 6 → 4: mismo beat, misma posición relativa; nueva fila floor(1320/4)
    const g4 = G(4);
    const expected = rowTop(rowOf(1320, 4), 150, g4) - anchor!.viewportOffsetPx;
    expect(scrollTopForAnchor(anchor!, 150, g4)).toBe(expected);
    // foco de teclado activo manda sobre la primera visible
    expect(captureAnchor({ scrollTop, originRow: 100, geometry: g, ordinalAt: ids, firstResidentOrdinal: 600, lastResidentOrdinal: 1799, focusedOrdinal: 700 })!.ordinal).toBe(700);
    expect(captureAnchor({ scrollTop, originRow: 100, geometry: g, ordinalAt: () => null, firstResidentOrdinal: 600, lastResidentOrdinal: 1799 })).toBeNull();
  });

  it("columnas desde grid-template-columns resuelto (repeat o tracks), nunca duplicando breakpoints; fallback declarado solo si no es medible", () => {
    expect(readColumnsFromTemplate("repeat(7, minmax(0px, 160px))")).toBe(7);
    expect(readColumnsFromTemplate("160px 160px 160px 160px")).toBe(4);
    expect(readColumnsFromTemplate("minmax(0px, 160px) minmax(0px, 160px)")).toBe(2);
    expect(readColumnsFromTemplate("none")).toBeNull();
    expect(readColumnsFromTemplate("")).toBeNull();
    expect([1440, 1400, 1160, 940, 750, 590, 359, 320].map(estimateColumnsForViewportWidth)).toEqual([7, 6, 5, 4, 3, 2, 1, 1]);
  });
});
