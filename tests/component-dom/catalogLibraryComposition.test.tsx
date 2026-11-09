// @vitest-environment jsdom
// T16 / V08 — Composición por autoridad: flag apagado → árbol LEGACY intacto y 0 peticiones de catálogo; flag encendido → /context antes de
// montar: POSTGRES monta el workspace del catálogo (sin pager, sin INDEX, servicios por cuenta); bloqueado/desconocido → estado visible,
// nunca LEGACY; cambio de cuenta → teardown de los servicios anteriores y remontaje con clave nueva. Workspace POSTGRES: tarjetas
// virtualizadas desde el store acotado, selección por toggle y aviso condicional.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LibraryCompositionGate, type LibraryCompositionState } from "../../src/features/library/catalog/LibraryCompositionGate";
import { createCatalogServices, useLibraryComposition } from "../../src/features/library/catalog/catalogLibraryProvider";
import { CatalogGalleryWorkspace } from "../../src/features/library/catalog/CatalogGalleryWorkspace";
import type { LibraryComposition } from "../../src/features/library/catalog/catalogComposition";
import { createCatalogFakeApi } from "../helpers/catalogFakeApi";
import { createCatalogFakeCommands, fakeBeats } from "../helpers/catalogFakeCommands";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let roots: Root[] = [];
afterEach(() => { for (const r of roots) act(() => r.unmount()); roots = []; document.body.innerHTML = ""; });
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
function mount(node: React.ReactNode) { const el = document.createElement("div"); document.body.appendChild(el); const root = createRoot(el); roots.push(root); act(() => root.render(node)); return el; }
const ctx = { authority: "POSTGRES" as const, user_id: "u1", vault_id: "v1", chat_id: "-1", authority_era: "e1", authority_epoch: "7", revision: "3", generation_id: "g", generation_origin: "NATIVE", migration_state: "IDLE", counts: { active: 1, trash: 0, purging: 0, pending: 0 }, restore_hold: true, cleanup_enabled: false };
const resolved = (composition: LibraryComposition, key = "k"): LibraryCompositionState => ({ status: "resolved", composition, key });

describe("LibraryCompositionGate", () => {
  it("legacy monta exactamente los children; catalog monta el workspace y no los children; bloqueado/desconocido muestra copy y nunca LEGACY; resolving no monta nada", () => {
    const el1 = mount(<LibraryCompositionGate state={resolved({ mode: "legacy", reason: "flag-off" })} legacy={<div data-legacy-tree="true">pager+app</div>} catalog={() => <div data-catalog-tree="true" />} />);
    expect(el1.querySelector("[data-legacy-tree]")).not.toBeNull(); expect(el1.querySelector("[data-catalog-tree]")).toBeNull(); expect(el1.querySelector("[data-library-composition]")?.getAttribute("data-library-composition")).toBe("legacy");
    const el2 = mount(<LibraryCompositionGate state={resolved({ mode: "catalog", resolution: { status: "ready", context: ctx, provisioned: false } })} legacy={<div data-legacy-tree="true" />} catalog={() => <div data-catalog-tree="true" />} />);
    expect(el2.querySelector("[data-catalog-tree]")).not.toBeNull(); expect(el2.querySelector("[data-legacy-tree]")).toBeNull(); expect(el2.querySelector("[data-library-composition]")?.getAttribute("data-catalog-epoch")).toBe("7");
    for (const [status, copy] of [["reset_required", "reinicio nativo"], ["quarantined", "cuarentena"], ["unauthenticated", "Sign in again"], ["offline", "Reconnect"], ["unavailable", "no está disponible"]] as const) {
      const el = mount(<LibraryCompositionGate state={resolved({ mode: "blocked", resolution: { status, error: new Error("x") } as never })} legacy={<div data-legacy-tree="true" />} catalog={() => <div data-catalog-tree="true" />} />);
      expect(el.querySelector("[data-legacy-tree]")).toBeNull(); expect(el.querySelector("[data-catalog-tree]")).toBeNull();
      expect(el.querySelector("[data-library-composition]")?.getAttribute("data-blocked-status")).toBe(status); expect(el.textContent).toContain(copy);
    }
    const el3 = mount(<LibraryCompositionGate state={{ status: "resolving" }} legacy={<div data-legacy-tree="true" />} catalog={() => <div data-catalog-tree="true" />} />);
    expect(el3.querySelector("[data-legacy-tree]")).toBeNull(); expect(el3.querySelector("[data-library-composition='resolving']")).not.toBeNull();
  });
});

function Probe({ accountId, enabled, api, onState }: { accountId: string | null; enabled: boolean; api: ReturnType<typeof createCatalogFakeApi>; onState: (s: ReturnType<typeof useLibraryComposition>) => void }) {
  const r = useLibraryComposition({ accountId, enabled, api: api as never });
  onState(r);
  return <LibraryCompositionGate state={r.state} legacy={<div data-legacy-tree="true" />} catalog={() => <div data-catalog-tree="true" />} />;
}

describe("useLibraryComposition", () => {
  it("flag apagado: LEGACY sin ninguna petición; flag encendido: /context una vez → POSTGRES con servicios; 404 → provision una vez; RESET/503/offline → bloqueado (nunca LEGACY)", async () => {
    const api = createCatalogFakeApi({ n: 10 }); let last: ReturnType<typeof useLibraryComposition> | null = null;
    mount(<Probe accountId="u1" enabled={false} api={api} onState={(s) => { last = s; }} />); await flush();
    expect(last!.state).toMatchObject({ status: "resolved", composition: { mode: "legacy" } }); expect(api.fake.counters.context ?? 0).toBe(0); expect(last!.services).toBeNull();
    const api2 = createCatalogFakeApi({ n: 10 }); let last2: ReturnType<typeof useLibraryComposition> | null = null;
    const el = mount(<Probe accountId="u1" enabled api={api2} onState={(s) => { last2 = s; }} />); await flush();
    expect(last2!.state.status).toBe("resolved"); expect((last2!.state as { composition: LibraryComposition }).composition.mode).toBe("catalog");
    expect(api2.fake.counters.context).toBe(1); expect(last2!.services).not.toBeNull(); expect(el.querySelector("[data-catalog-tree]")).not.toBeNull(); expect(el.querySelector("[data-legacy-tree]")).toBeNull();
    const api3 = createCatalogFakeApi({ n: 3, provisioned: false }); let last3: ReturnType<typeof useLibraryComposition> | null = null;
    mount(<Probe accountId="u1" enabled api={api3} onState={(s) => { last3 = s; }} />); await flush();
    expect((last3!.state as { composition: LibraryComposition }).composition.mode).toBe("catalog"); expect(api3.fake.counters.provision).toBe(1);
    for (const failure of [{ kind: "status" as const, status: 409, code: "LIBRARY_RESET_REQUIRED" }, { kind: "status" as const, status: 503, code: "CATALOG_UNAVAILABLE" }, { kind: "offline" as const }]) {
      const apiX = createCatalogFakeApi({ n: 3 }); apiX.fake.setFailure(failure); let lastX: ReturnType<typeof useLibraryComposition> | null = null;
      const elX = mount(<Probe accountId="u1" enabled api={apiX} onState={(s) => { lastX = s; }} />); await flush();
      expect((lastX!.state as { composition: LibraryComposition }).composition.mode).toBe("blocked"); expect(lastX!.services).toBeNull();
      expect(elX.querySelector("[data-legacy-tree]")).toBeNull(); expect(elX.querySelector("[data-library-composition='blocked']")).not.toBeNull();
    }
  });

  it("cambio de cuenta: los servicios anteriores se liberan (teardown) y la clave de composición cambia; sin cuenta no se crean servicios", async () => {
    const api = createCatalogFakeApi({ n: 5 }); let last: ReturnType<typeof useLibraryComposition> | null = null;
    const el = document.createElement("div"); document.body.appendChild(el); const root = createRoot(el); roots.push(root);
    act(() => root.render(<Probe accountId="acc-A" enabled api={api} onState={(s) => { last = s; }} />)); await flush();
    const first = last!.services!; const keyA = (last!.state as { key: string }).key; expect(keyA).toMatch(/^catalog:acc-A:/);
    await act(async () => { await first.store.loadFirst(); }); await flush();
    expect(first.store.getSnapshot().blocks.length).toBeGreaterThan(0);
    act(() => root.render(<Probe accountId="acc-B" enabled api={api} onState={(s) => { last = s; }} />)); await flush();
    // teardown de los servicios de acc-A: el store queda vacío (los servicios son inmutables; se observa el efecto, no un espía)
    expect(first.store.getSnapshot().blocks.length).toBe(0); expect(last!.services).not.toBe(first); expect((last!.state as { key: string }).key).toMatch(/^catalog:acc-B:/);
    act(() => root.render(<Probe accountId={null} enabled api={api} onState={(s) => { last = s; }} />)); await flush();
    expect(last!.services).toBeNull(); expect((last!.state as { key: string }).key).toMatch(/^blocked:anon/);
  });
});

describe("CatalogGalleryWorkspace", () => {
  it("monta tarjetas virtualizadas desde el store (sin pager ni INDEX), toggle de selección por clic y aviso condicional al cambiar filtros; espías legacy = 0", async () => {
    const api = createCatalogFakeApi({ n: 30 });
    const server = createCatalogFakeCommands({ beats: fakeBeats(30) });
    const services = createCatalogServices({ api: api as never, accountId: "u1", context: { authority_era: "e1", authority_epoch: "1" }, fetchImpl: server.fetchImpl, baseUrl: () => "https://cloud.invalid/api", token: () => "tok", csrf: () => "c" });
    const el = mount(<div style={{ height: 800 }}><CatalogGalleryWorkspace services={services} accountId="u1" context={{ authority_era: "e1", authority_epoch: "1", revision: "1" }} viewportHeightFallback={800} /></div>);
    await flush(10);
    const cards = el.querySelectorAll("[data-card]"); expect(cards.length).toBeGreaterThan(0); expect(cards.length).toBeLessThanOrEqual(30);
    expect(el.querySelector("[data-catalog-mode='postgres']")).not.toBeNull(); expect(el.querySelector("[data-library-scroll]")).not.toBeNull();
    expect(document.querySelector(".bg-web-pagination, [data-web-pagination]")).toBeNull();
    expect(api.fake.counters.listBeats).toBeGreaterThan(0);
    await act(async () => { (cards[0] as HTMLElement).click(); await new Promise((r) => setTimeout(r, 0)); }); await flush(6);
    const status = el.querySelector(".bg-catalog-status")!;
    expect(status.getAttribute("data-selection-count")).toBe("1"); expect(status.getAttribute("data-selection-status")).toBe("active");
    await act(async () => { await services.interaction.onFiltersChanged({ filters: { state: "ACTIVE", q: "Beat 1", includeTags: [], excludeTags: [], includeMode: "any" }, sort: "rating", revision: server.revision() }); }); await flush(2);
    expect(el.querySelector(".bg-catalog-notice")?.textContent).toBe("Selección borrada al cambiar los filtros");
    expect(server.legacy).toEqual({ getLibraryIndex: 0, replaceLibraryIndex: 0 });
    await services.teardown();
  });
});
