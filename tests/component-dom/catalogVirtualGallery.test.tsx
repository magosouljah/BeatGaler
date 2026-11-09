// @vitest-environment jsdom
// T08 / V05 — Grid virtualizado en fixture: solo filas del rango montadas, desmontaje real contado, placeholders de frontera con
// reintento, sin pager ni re-sort local, estados de error/vacío, bgPage legacy → bloque + ancla, A→B.
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogVirtualGallery } from "../../src/features/library/catalog/CatalogVirtualGallery";
import { createCatalogQueryStore, type CatalogQueryStore } from "../../src/features/library/catalog/catalogQueryStore";
import type { CatalogBeatDto } from "../../src/features/library/catalog/catalogApi";
import { createCatalogFakeApi } from "../helpers/catalogFakeApi";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const G = { columns: 6, rowHeight: 239, rowGap: 28, padTop: 34 };
const P = G.rowHeight + G.rowGap;
let roots: Root[] = [];
afterEach(() => { for (const r of roots) act(() => r.unmount()); roots = []; document.body.innerHTML = ""; });
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

function Fixture({ store, onMount, onUnmount, viewport = 800, onGoToStart }: { store: CatalogQueryStore; onMount: (id: string) => void; onUnmount: (id: string) => void; viewport?: number; onGoToStart?: () => void }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  return (
    <div className="bg-product-gallery" data-catalog-mode="postgres">
      <div ref={scrollerRef} data-library-scroll="true" style={{ height: viewport, overflowY: "auto" }}>
        <CatalogVirtualGallery store={store} scrollerRef={scrollerRef} tenantKey="A" geometryOverride={G} viewportHeightFallback={viewport} onMountCard={onMount} onUnmountCard={onUnmount} onGoToStart={onGoToStart}
          renderCard={(item: CatalogBeatDto, ordinal) => <div data-card={item.id} data-ordinal={ordinal}>{item.name}</div>}
          measure={() => ({ columns: G.columns, rowHeight: G.rowHeight, rowGap: G.rowGap, padTop: G.padTop, viewportHeight: viewport, viewportWidth: 1440 })} />
      </div>
    </div>
  );
}
async function mount(store: CatalogQueryStore, viewport = 800, onGoToStart?: () => void) {
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host); roots.push(root);
  const mounted = new Map<string, number>(); const unmounted = new Map<string, number>();
  await act(async () => { root.render(<Fixture store={store} viewport={viewport} onGoToStart={onGoToStart} onMount={(id) => mounted.set(id, (mounted.get(id) || 0) + 1)} onUnmount={(id) => unmounted.set(id, (unmounted.get(id) || 0) + 1)} />); });
  await flush();
  const scroller = host.querySelector("[data-library-scroll]") as HTMLDivElement;
  const scrollTo = async (top: number) => { Object.defineProperty(scroller, "scrollTop", { configurable: true, value: top, writable: true }); await act(async () => { scroller.dispatchEvent(new Event("scroll")); await new Promise((r) => setTimeout(r, 20)); }); await flush(); };
  return { host, scroller, mounted, unmounted, scrollTo, cards: () => [...host.querySelectorAll("[data-card]")].map((e) => e.getAttribute("data-card")!), rows: () => host.querySelectorAll("[data-catalog-row]").length };
}

describe("CatalogVirtualGallery", () => {
  it("monta solo las filas del viewport + overscan (nunca los 240 DTO), con aria feed/article y posinset/setsize; placeholder posterior presente", async () => {
    const api = createCatalogFakeApi({ n: 1000 });
    const store = createCatalogQueryStore({ api, accountId: "A" });
    await store.resolve(); await store.loadFirst();
    const f = await mount(store);
    const expectedRows = Math.ceil(800 / P) + 2 * 2; // 3 visibles + overscan 2 a cada lado (recortado al inicio)
    expect(f.rows()).toBeLessThanOrEqual(expectedRows);
    expect(f.cards().length).toBeLessThan(240);
    expect(f.cards().length).toBeLessThanOrEqual(G.columns * (Math.ceil(800 / P) + 2 * 2 + 2 + 1));
    expect(f.host.querySelector('[role="feed"]')).not.toBeNull();
    const first = f.host.querySelector("article")!;
    expect([first.getAttribute("aria-posinset"), first.getAttribute("aria-setsize")]).toEqual(["1", "1000"]);
    expect(f.host.querySelector('[data-catalog-placeholder="after"]')).not.toBeNull();
    expect(f.host.querySelector('[data-catalog-placeholder="before"]')).toBeNull();
    expect(f.host.textContent).not.toMatch(/Previous|Next|Página|Page \d/);
    expect(f.cards()).toEqual(api.fake.sorted("rating").slice(0, f.cards().length));
  });

  it("al hacer scroll las tarjetas que salen del overscan se desmontan de verdad y las nuevas se montan; el orden sigue siendo el del servidor (sin re-sort local)", async () => {
    const api = createCatalogFakeApi({ n: 1000 });
    const store = createCatalogQueryStore({ api, accountId: "A" });
    await store.resolve(); await store.loadFirst();
    const f = await mount(store);
    const initial = f.cards();
    await f.scrollTo(G.padTop + 20 * P); // fila 20
    const after = f.cards();
    expect(after[0]).not.toBe(initial[0]);
    const gone = initial.filter((id) => !after.includes(id));
    expect(gone.length).toBeGreaterThan(0);
    for (const id of gone) expect(f.unmounted.get(id)).toBe(1);
    const ordinals = [...f.host.querySelectorAll("[data-ordinal]")].map((e) => Number(e.getAttribute("data-ordinal")));
    expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));
    const sorted = api.fake.sorted("rating");
    expect(after).toEqual(ordinals.map((o) => sorted[o]));
    // prefetch: al acercarse al final del bloque, el store pidió el siguiente y el track creció sin huecos
    await f.scrollTo(G.padTop + 36 * P);
    const s = store.getSnapshot();
    expect(s.endOrdinal).toBeGreaterThanOrEqual(480);
    expect(f.host.querySelector("[data-resident-rows]")!.getAttribute("data-resident-rows")).toBe(String(Math.ceil(s.endOrdinal / G.columns)));
  });

  it("frontera en error muestra reintento contextual sin pager y conserva lo residente; el reintento completa el bloque", async () => {
    const api = createCatalogFakeApi({ n: 1000 });
    const store = createCatalogQueryStore({ api, accountId: "A" });
    await store.resolve(); await store.loadFirst();
    const f = await mount(store);
    api.fake.setFailure({ kind: "status", status: 503, code: "CATALOG_QUERY_TIMEOUT" });
    await f.scrollTo(G.padTop + 36 * P);
    expect(store.getSnapshot().edgeError?.code).toBe("CATALOG_QUERY_TIMEOUT");
    const retry = f.host.querySelector('[data-catalog-placeholder="after"] button') as HTMLButtonElement;
    expect(retry?.textContent).toBe("Reintentar");
    expect(f.cards().length).toBeGreaterThan(0);
    api.fake.setFailure(null);
    await act(async () => { retry.click(); }); await flush();
    expect(store.getSnapshot().edgeError).toBeNull();
    expect(store.getSnapshot().endOrdinal).toBe(480);
  });

  it("estados: empty / no-results / offline / unauthenticated / reset_required con copy y sin tarjetas; stale reset muestra aviso", async () => {
    const empty = createCatalogFakeApi({ n: 0 });
    const es = createCatalogQueryStore({ api: empty, accountId: "A" });
    await es.resolve(); await es.loadFirst();
    const fe = await mount(es);
    expect(fe.host.querySelector('[data-catalog-state="empty"]')!.textContent).toContain("Empty Gallery");
    expect(fe.cards()).toEqual([]);
    const api = createCatalogFakeApi({ n: 600 }); // > 240 para que exista nextCursor y el stale sea observable
    const store = createCatalogQueryStore({ api, accountId: "A" });
    await store.resolve(); await store.setQuery({ state: "ACTIVE", q: "zzz", includeTags: [], excludeTags: [], includeMode: "any" }, "rating");
    const f = await mount(store);
    expect(f.host.querySelector('[data-catalog-state="no-results"]')!.textContent).toContain("No beats match your search");
    api.fake.setFailure({ kind: "offline" });
    await act(async () => { await store.setQuery({ state: "ACTIVE", q: "", includeTags: [], excludeTags: [], includeMode: "any" }, "rating"); }); await flush();
    expect(f.host.querySelector('[data-catalog-state="offline"]')).not.toBeNull();
    expect(f.host.querySelector('[data-catalog-state="offline"] button')?.textContent).toBe("Reintentar");
    api.fake.setFailure({ kind: "status", status: 401, code: "UNAUTHENTICATED" });
    await act(async () => { await store.resolve(); }); await flush();
    expect(f.host.querySelector('[data-catalog-state="unauthenticated"]')!.textContent).toContain("Sign in again");
    api.fake.setFailure({ kind: "status", status: 409, code: "LIBRARY_RESET_REQUIRED" });
    await act(async () => { await store.resolve(); }); await flush();
    expect(f.host.querySelector('[data-catalog-state="reset_required"]')).not.toBeNull();
    api.fake.setFailure(null);
    await act(async () => { await store.resolve(); await store.loadFirst(); }); await flush();
    api.fake.bumpRevision();
    await act(async () => { await store.loadNext(); }); await flush();
    expect(f.host.querySelector('[data-catalog-stale-reset="true"]')).not.toBeNull();
  });

  it("bgPage legacy: resolver → bloque + ancla sin pager; fuera de rango abre el último bloque con aviso; >10.000 muestra el copy r4 y la acción Ir al inicio", async () => {
    const api = createCatalogFakeApi({ n: 20_500 });
    const store = createCatalogQueryStore({ api, accountId: "A" });
    await store.resolve();
    let goToStart = 0;
    const f = await mount(store, 800, () => { goToStart++; });
    await act(async () => { await store.loadLegacy(240); }); await flush();
    expect(store.getSnapshot().firstOrdinal).toBe(240);
    expect(Number(f.host.querySelector("article")!.getAttribute("aria-posinset"))).toBe(241);
    expect(f.host.querySelector('[data-catalog-placeholder="before"]')).not.toBeNull();
    await act(async () => { await store.loadLegacy(1_000_000_000); }); await flush();
    expect(f.host.querySelector('[data-catalog-legacy="last"]')).not.toBeNull();
    expect(store.getSnapshot().legacy?.resolvedOffset).toBe(20_400);
    await act(async () => { await store.loadLegacy(10_001); }); await flush();
    expect(f.host.textContent).toContain("Este enlace antiguo no se puede abrir en esta posición.");
    const btn = [...f.host.querySelectorAll("button")].find((b) => b.textContent === "Ir al inicio")!;
    await act(async () => { btn.click(); });
    expect(goToStart).toBe(1);
    expect(api.fake.counters.listBeats ?? 0).toBe(0);
  });

  it("A→B: teardown del store A deja el grid sin tarjetas y un store B empieza en su propia query; cero llamadas a INDEX/transporte", async () => {
    const apiA = createCatalogFakeApi({ n: 300, tenant: "A" });
    const a = createCatalogQueryStore({ api: apiA, accountId: "A" });
    await a.resolve(); await a.loadFirst();
    const f = await mount(a);
    expect(f.cards().length).toBeGreaterThan(0);
    await act(async () => { a.teardown(); }); await flush();
    expect(f.cards()).toEqual([]);
    const apiB = createCatalogFakeApi({ n: 50, tenant: "B", seed: 99 });
    const b = createCatalogQueryStore({ api: apiB, accountId: "B" });
    await b.resolve(); await b.loadFirst();
    const fb = await mount(b);
    expect(fb.cards()).toEqual(apiB.fake.sorted("rating").slice(0, fb.cards().length));
    expect(Object.keys(apiA.fake.counters).sort()).toEqual(["context", "listBeats"]);
  });
});
