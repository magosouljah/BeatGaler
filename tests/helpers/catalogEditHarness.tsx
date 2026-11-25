// M3.1 — Ayudante de caracterización de las secuencias de edición del catálogo Web (S1–S5).
// Monta el hook REAL `useCatalogGalleryScope` sobre servicios reales (`createCatalogServices`) cuyo único «exterior» son los dobles
// ya existentes: `catalogFakeApi` (lecturas) y `catalogFakeCommands` (fetch + Puerto Direct falso). Solo observa desde fuera:
// peticiones al Cloud falso, llamadas al Puerto Direct falso, avisos, evento de tarjeta ocupada y refrescos (listBeats).
// Requiere `vi.useFakeTimers()` activo en la prueba (el commit sondea cada 1,5 s y agota a los 10 min).
import React, { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import { createCatalogServices } from "../../src/features/library/catalog/catalogLibraryProvider";
import { useCatalogGalleryScope } from "../../src/features/library/catalog/useCatalogGalleryScope";
import { createCatalogFakeApi } from "./catalogFakeApi";
import { createCatalogFakeCommands, fakeBeats } from "./catalogFakeCommands";

export type Scope = ReturnType<typeof useCatalogGalleryScope>;
export interface EditReq { method: string; path: string; headers: Record<string, string>; body: any }
export type BusyEvent = { beatId: string; active: boolean; success: boolean };

function Probe({ options, onScope }: { options: Parameters<typeof useCatalogGalleryScope>[0]; onScope: (s: Scope) => void }) {
  const scope = useCatalogGalleryScope(options);
  useLayoutEffect(() => { onScope(scope); }, [onScope, scope]);
  return null;
}

export interface EditHarnessOptions { n?: number; transferVerifyAfterPolls?: number; /** Deja la tonalidad heredada «Cm» (el Drawer la normaliza a «cm»). Por defecto «cm»: sin normalización espuria. */ legacyKey?: boolean }

export async function mountEditHarness(options: EditHarnessOptions = {}) {
  const beats = fakeBeats(options.n ?? 4).map((b) => (options.legacyKey ? b : { ...b, key: "cm" }));
  const server = createCatalogFakeCommands({ beats, transferVerifyAfterPolls: options.transferVerifyAfterPolls });
  const api = createCatalogFakeApi({ n: beats.length, generate: (i) => ({ ...beats[i], state: "ACTIVE", manualRank: beats[i].rank }) });
  const context = { authority_era: "era-fake", authority_epoch: "1", revision: server.revision() };
  for (let rev = 1; rev < Number(context.revision); rev++) api.fake.bumpRevision();
  const reqs: EditReq[] = [];
  let before: ((r: EditReq) => void) | null = null;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? null;
    const req: EditReq = { method: init?.method ?? "GET", path: url.pathname.replace(/^.*?\/catalog\/v1/, "/catalog/v1"), headers: { ...((init?.headers as Record<string, string>) ?? {}) }, body };
    reqs.push(req);
    before?.(req);
    return server.fetchImpl(input, init);
  }) as typeof fetch;
  const accountId = "fake-user";
  const services = createCatalogServices({ api, accountId, context, fetchImpl, baseUrl: () => "https://cloud.invalid/api", token: () => "fake", csrf: () => "fake", direct: server.directPort, prefixCache: null, artworkCache: null });
  const host = document.createElement("div"); document.body.appendChild(host);
  const root: Root = createRoot(host);
  let scope!: Scope;
  const busy: BusyEvent[] = [];
  const onBusy = (e: Event) => { busy.push((e as CustomEvent<BusyEvent>).detail); };
  window.addEventListener("beatgaler:beat-cloud-busy", onBusy);
  const originalHref = window.location.href; const originalHistory = window.history.state;
  window.history.replaceState(null, "", "/gallery");
  await act(async () => { root.render(<Probe options={{ services, accountId, context }} onScope={(s) => { scope = s; }} />); });
  const dto = (id: string) => scope.snapshot.blocks.flatMap((b) => b.items).find((i) => i.id === id)!;
  /** Avanza el reloj falso hasta que la promesa se resuelve (commit/sondeo). */
  async function drive<T>(p: Promise<T>, stepMs = 1500, maxSteps = 500): Promise<T> {
    let done = false; let value!: T; let error: unknown; let failed = false;
    void p.then((v) => { done = true; value = v; }, (e) => { done = true; failed = true; error = e; });
    for (let i = 0; i < maxSteps && !done; i++) await act(async () => { await vi.advanceTimersByTimeAsync(stepMs); });
    if (!done) throw new Error("drive: la promesa no se resolvió");
    if (failed) throw error; return value;
  }
  const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(50); }); };
  return {
    server, api, services, reqs, busy, scope: () => scope, dto, drive, flush,
    /** Vuelve a renderizar el hook con las mismas opciones (sin cambio de estado): mide la estabilidad referencial de los grupos. */
    rerender: () => act(async () => { root.render(<Probe options={{ services, accountId, context: { ...context } }} onScope={(s) => { scope = s; }} />); }),
    /** Atrapa/ejecuta algo justo ANTES de que la petición llegue al Cloud falso (p. ej. una edición ajena). */
    onRequest(fn: ((r: EditReq) => void) | null) { before = fn; },
    mark: () => reqs.length,
    since: (m: number) => reqs.slice(m),
    /** Peticiones de escritura del catálogo (sin lecturas ni sondeos GET). */
    writes: (m = 0) => reqs.slice(m).filter((r) => r.method !== "GET"),
    refreshes: () => api.fake.counters.listBeats ?? 0,
    async teardown() {
      window.removeEventListener("beatgaler:beat-cloud-busy", onBusy);
      act(() => root.unmount()); await services.teardown(); host.remove();
      window.history.replaceState(originalHistory, "", originalHref);
    },
  };
}
export type EditHarness = Awaited<ReturnType<typeof mountEditHarness>>;
export const mp3 = (name = "new.mp3") => new File([new Uint8Array(2048).fill(7)], name, { type: "audio/mpeg" });
export const wav = (name = "hq.wav") => new File([new Uint8Array(2048).fill(9)], name, { type: "audio/wav" });
export const png = (name = "cover.png") => new File([new Uint8Array(512).fill(3)], name, { type: "image/png" });
