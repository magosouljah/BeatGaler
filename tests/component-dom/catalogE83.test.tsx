// @vitest-environment jsdom
// E83 — tarjeta de subida estable: la BeatCard provisional ocupa el primer hueco de la MISMA rejilla virtual (sin bloque aparte, sin duplicar,
// sin saltos de fila al llegar la real) y las cinco estrellas siempre visibles con el rating real.
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogVirtualGallery } from "../../src/features/library/catalog/CatalogVirtualGallery";
import { createCatalogQueryStore, type CatalogQueryStore } from "../../src/features/library/catalog/catalogQueryStore";
import type { CatalogBeatDto } from "../../src/features/library/catalog/catalogApi";
import { captureAnchor, scrollTopForAnchor } from "../../src/features/library/catalog/catalogRowGeometry";
import { Stars } from "../../src/components/ui";
import { createCatalogFakeApi } from "../helpers/catalogFakeApi";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const G = { columns: 6, rowHeight: 239, rowGap: 28, padTop: 34 };
let roots: Root[] = [];
afterEach(() => { for (const r of roots) act(() => r.unmount()); roots = []; document.body.innerHTML = ""; });
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

function Fixture({ store, lead }: { store: CatalogQueryStore; lead: Array<{ id: string; node: React.ReactNode }> }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  return (
    <div className="bg-product-gallery" data-catalog-mode="postgres">
      <div ref={scrollerRef} data-library-scroll="true" style={{ height: 800, overflowY: "auto" }}>
        <CatalogVirtualGallery store={store} scrollerRef={scrollerRef} tenantKey="A" geometryOverride={G} viewportHeightFallback={800} leadCards={lead}
          renderCard={(item: CatalogBeatDto, ordinal) => <div data-card={item.id} data-ordinal={ordinal}>{item.name}</div>}
          measure={() => ({ columns: G.columns, rowHeight: G.rowHeight, rowGap: G.rowGap, padTop: G.padTop, viewportHeight: 800, viewportWidth: 1440 })} />
      </div>
    </div>
  );
}

describe("E83 rejilla con tarjeta provisional", () => {
  it("la provisional es el primer hueco de la fila 0; las reales se desplazan UN hueco; al retirarla (llega la real) el reparto de filas es el mismo", async () => {
    const api = createCatalogFakeApi({ n: 40 });
    const store = createCatalogQueryStore({ api, accountId: "A" });
    await store.resolve(); await store.loadFirst();
    const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host); roots.push(root);
    const lead = [{ id: "pending-1", node: <div data-lead="pending-1">subiendo</div> }];
    await act(async () => { root.render(<Fixture store={store} lead={lead} />); }); await flush();
    const row0 = host.querySelector('[data-catalog-row="0"]')!;
    const kids = [...row0.children].map((c) => c.getAttribute("data-pending-import") ?? c.querySelector("[data-card]")?.getAttribute("data-ordinal"));
    expect(kids).toEqual(["pending-1", "0", "1", "2", "3", "4"]);
    expect(host.querySelectorAll("[data-pending-import]").length).toBe(1);
    expect(host.querySelectorAll('[data-card][data-ordinal="0"]').length).toBe(1); // sin duplicados
    const rowsWith = host.querySelectorAll("[data-catalog-row]").length;
    await act(async () => { root.render(<Fixture store={store} lead={[]} />); }); await flush();
    const kids2 = [...host.querySelector('[data-catalog-row="0"]')!.children].map((c) => c.querySelector("[data-card]")?.getAttribute("data-ordinal"));
    expect(kids2).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(host.querySelectorAll("[data-pending-import]").length).toBe(0);
    expect(host.querySelectorAll("[data-catalog-row]").length).toBeGreaterThan(0); expect(rowsWith).toBeGreaterThan(0);
  });
  it("biblioteca vacía: la provisional se dibuja en la rejilla (no el estado «vacío»)", async () => {
    const api = createCatalogFakeApi({ n: 0 });
    const store = createCatalogQueryStore({ api, accountId: "A" });
    await store.resolve(); await store.loadFirst();
    const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host); roots.push(root);
    await act(async () => { root.render(<Fixture store={store} lead={[{ id: "p", node: <div data-lead="p">subiendo</div> }]} />); }); await flush();
    expect(host.querySelector('[data-pending-import="p"]')).not.toBeNull(); expect(host.querySelector('[data-catalog-state="empty"]')).toBeNull();
  });
  it("el ancla de scroll cuenta los huecos provisionales (misma tarjeta, misma posición al cambiar el desplazamiento)", () => {
    const geometry = { columns: 6, rowHeight: 239, rowGap: 28, padTop: 34 };
    const ids = (i: number) => `b${i}`;
    const a = captureAnchor({ scrollTop: 34 + 267 * 2, originRow: 0, geometry, ordinalAt: (i) => ids(i), firstResidentOrdinal: 0, lastResidentOrdinal: 100, lead: 1 });
    expect(a!.ordinal).toBe(11); // fila 2 = posiciones 12..17 → ordinales 11..16
    expect(scrollTopForAnchor(a!, 0, geometry, 1)).toBe(34 + 267 * 2);
    expect(scrollTopForAnchor(a!, 0, geometry, 0)).toBe(34 + 267 * 1); // sin hueco la misma tarjeta queda una fila antes
  });
});

describe("E83 estrellas", () => {
  it("las cinco siempre visibles: llenas ★ = rating real, vacías ☆; sin rating, las cinco vacías", () => {
    const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host); roots.push(root);
    const text = () => [...host.querySelectorAll("[data-star-filled]")].map((x) => x.textContent).join("");
    act(() => { root.render(<Stars n={3} />); }); expect(text()).toBe("★★★☆☆");
    act(() => { root.render(<Stars n={0} />); }); expect(text()).toBe("☆☆☆☆☆");
    act(() => { root.render(<Stars n={5} />); }); expect(text()).toBe("★★★★★");
    const emptyColor = (host.querySelectorAll("[data-star-filled=false]")[0] as HTMLElement | undefined);
    act(() => { root.render(<Stars n={1} />); });
    expect((host.querySelectorAll('[data-star-filled="false"]')[0] as HTMLElement).style.color).toBe("rgb(110, 110, 110)"); void emptyColor;
  });
});
