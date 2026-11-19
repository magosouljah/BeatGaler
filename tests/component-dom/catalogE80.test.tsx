// E80 — Pulido final de Gallery: progreso real de subida (bytes de Direct B, total ponderado por bytes, monótono), almacenamiento local en
// Settings (uso y limpieza por cuenta de metadatos/prefijos/portadas, sin red), carátula de un beat cuya portada aún carga (sin fondo
// procedural ni iniciales) y fallo de portada → fondo de «sin portada».
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { Artwork } from "../../src/components/ui";
import { createCatalogCommandsApi } from "../../src/features/library/catalog/catalogCommandsApi";
import { createCatalogMutations, createLocalOperationRefStore, beatFromCatalogDetail } from "../../src/features/library/catalog/catalogMutations";
import { createCatalogTransfer } from "../../src/features/library/catalog/catalogTransfer";
import { aggregateUploadPercent, uploadPercent } from "../../src/features/library/catalog/catalogUploadProgress";
import { createCatalogLocalCaches } from "../../src/features/library/catalog/catalogLocalCaches";
import { createFirstBlockCache, memoryFirstBlockBackend } from "../../src/features/library/catalog/catalogFirstBlockCache";
import { createPrefixCache } from "../../src/features/library/catalog/catalogPrefixCache";
import { createArtworkCache, memoryArtworkBackend } from "../../src/features/library/catalog/catalogArtworkCache";
import type { CatalogPage } from "../../src/features/library/catalog/catalogApi";
import { createCatalogFakeCommands } from "../helpers/catalogFakeCommands";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function render(node: React.ReactElement) { const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container); act(() => { root.render(node); }); return { container }; }
function harness() {
  const server = createCatalogFakeCommands();
  const common = { fetchImpl: server.fetchImpl, baseUrl: () => "https://cloud.invalid/api", token: () => "tok", csrf: () => "c", headers: () => ({ era: "era-fake", epoch: "1" }) };
  const commands = createCatalogCommandsApi(common);
  const transfer = createCatalogTransfer({ ...common, direct: server.directPort, sleep: async () => {}, pollIntervalMs: 1, idempotencyKey: () => `k-${Math.random().toString(36).slice(2)}` });
  const m = new Map<string, string>();
  const mutations = createCatalogMutations({ commands, transfer, accountId: () => "acc-1", refStore: createLocalOperationRefStore({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } }), idempotencyKey: () => `idem-${Math.random().toString(36).slice(2)}`, prepareFiles: async (files) => files });
  return { server, mutations };
}
const file = (n: number, type = "audio/mpeg") => new File([new Uint8Array(n)], `f${n}.bin`, { type });
const meta = { bpm: "", key: "", tags: [], rating: 0, color: "#111", color2: "#222", image_base64: null };

describe("E80 progreso real de subida", () => {
  it("avanza DENTRO de cada archivo con los bytes que informa Direct B (MP3 + PROJECT), monótono, sin saltar de 0 a 100", async () => {
    const h = harness(); const seen: Array<[string, number, number]> = [];
    const r = await h.mutations.importBeat({ beat: { name: "Grande", ...meta }, files: { master: file(4000), project: file(1000, "application/zip") }, onProgress: (p) => seen.push([p.stage, p.uploadedBytes, p.totalBytes]) });
    expect(r.status).toBe("committed");
    const bytes = seen.map((s) => s[1]);
    for (let i = 1; i < bytes.length; i++) expect(bytes[i]).toBeGreaterThanOrEqual(bytes[i - 1]);
    expect(seen).toContainEqual(["master", 1000, 5000]); expect(seen).toContainEqual(["master", 3000, 5000]); // tramos intermedios del MASTER
    expect(seen).toContainEqual(["project", 4250, 5000]); // PROJECT avanza sobre lo ya enviado del MASTER
    expect(new Set(bytes.map((b) => uploadPercent(b, 5000))).size).toBeGreaterThan(4); // no solo 0 y 100
    expect(seen.at(-1)).toEqual(["library", 5000, 5000]);
  });

  it("un reintento de la misma parte no hace retroceder el aviso", async () => {
    const h = harness(); const port = h.server.directPort as unknown as { send: (i: { blob: Blob }, o?: { onProgress?: (u: number, t: number) => void }) => Promise<unknown> };
    const real = port.send.bind(port); let calls = 0;
    port.send = async (i, o) => { if (++calls === 1) { o?.onProgress?.(i.blob.size * 0.8, i.blob.size); const { DirectSendError } = await import("../../src/features/library/catalog/catalogDirectCore"); throw new DirectSendError({ kind: "REJECTED", code: "FLOOD_WAIT_1", retryAfterMs: 1 }); } return real(i, o); };
    const seen: number[] = [];
    const r = await h.mutations.importBeat({ beat: { name: "Retry", ...meta }, files: { master: file(1000) }, onProgress: (p) => seen.push(p.uploadedBytes) });
    expect(r.status).toBe("committed"); expect(calls).toBe(2);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen).toContain(800); expect(seen.filter((b) => b === 250)).toEqual([]); // los tramos del 2.º intento (250, 500) no se muestran por debajo de 800
  });

  it("varias subidas: total = bytes enviados / bytes totales (una grande pesa lo que pesa)", () => {
    expect(aggregateUploadPercent([{ uploadedBytes: 50 * 2 ** 20, totalBytes: 100 * 2 ** 20 }, { uploadedBytes: 2 ** 20, totalBytes: 2 ** 20 }])).toBe(50);
    expect(aggregateUploadPercent([{ uploadedBytes: 0, totalBytes: 0 }])).toBe(0);
    expect(uploadPercent(999, 1000)).toBe(99); expect(uploadPercent(2000, 1000)).toBe(100);
  });
});

describe("E80 almacenamiento local (Settings)", () => {
  const page = (ids: string[]): CatalogPage => ({ items: ids.map((id) => ({ id, version: "1", name: id, tags: [], rating: 0 })), startOrdinal: 0, nextCursor: null, previousCursor: null, resumeCursor: "r", revision: "1", totalMatched: ids.length, totalLibrary: ids.length } as unknown as CatalogPage);
  const sha = (c: string) => c.repeat(64);
  it("uso por cuenta y limpieza solo de la cuenta activa; nada de red; las otras cuentas quedan intactas", async () => {
    const first = createFirstBlockCache({ backend: memoryFirstBlockBackend() });
    const prefix = createPrefixCache({ backend: "memory" });
    const art = createArtworkCache({ backend: memoryArtworkBackend() });
    const idA = { accountId: "A", vaultId: "v", era: "e", epoch: "1", generationId: "g" };
    await first.write(idA, "q", page(["b1", "b2"])); await first.write({ ...idA, accountId: "B" }, "q", page(["x"]));
    await prefix.put({ account: "A", fileSha256: sha("a"), fileSize: 10, bytes: new Uint8Array(10), source: "upload" });
    await prefix.put({ account: "B", fileSha256: sha("b"), fileSize: 10, bytes: new Uint8Array(10), source: "upload" });
    await art.put({ key: "A|1|f|r", account: "A", beatId: "b1", blob: new Blob([new Uint8Array(30)]) });
    await art.put({ key: "B|1|f|r", account: "B", beatId: "x", blob: new Blob([new Uint8Array(40)]) });
    const local = createCatalogLocalCaches({ accountId: "A", firstBlockCache: first, prefixCache: prefix, artworkCache: art });
    const u = Object.fromEntries((await local.usage()).map((x) => [x.kind, x]));
    expect(u.metadata.entries).toBe(1); expect(u.metadata.bytes).toBeGreaterThan(0); expect(u.metadata.limitBytes).toBeNull();
    expect([u.prefixes.bytes, u.prefixes.limitBytes]).toEqual([10, 256 * 2 ** 20]);
    expect([u.artwork.bytes, u.artwork.limitBytes]).toEqual([30, 256 * 2 ** 20]);
    const afterArt = Object.fromEntries((await local.clear("artwork")).map((x) => [x.kind, x.bytes]));
    expect(afterArt.artwork).toBe(0); expect(afterArt.prefixes).toBe(10);
    const all = await local.clear("all");
    expect(all.every((x) => x.bytes === 0)).toBe(true);
    expect((await prefix.usage("B")).bytes).toBe(10); expect((await art.usage("B")).bytes).toBe(40); expect((await first.usage("B")).entries).toBe(1);
  });
});

describe("E80 carátula", () => {
  it("portada pendiente: fondo de portada (sin fondo procedural ni iniciales); sin portada: fondo procedural; fallo de portada → «sin portada»", () => {
    const dto = { id: "b1", version: "1", name: "Dark Trap", tags: [], rating: 0, artwork: { fileId: "f1", revision: "r1" } } as never;
    const pending = beatFromCatalogDetail(dto, null);
    expect(pending.artwork_pending).toBe(true);
    const a = render(<Artwork beat={pending} gallery />);
    expect(a.container.querySelector("[data-artwork-pending='true']")).not.toBeNull();
    expect(a.container.querySelector("canvas")).toBeNull(); expect(a.container.textContent).toBe("");
    const failed = beatFromCatalogDetail(dto, null, true);
    expect(failed.artwork_pending).toBe(false);
    const loaded = beatFromCatalogDetail(dto, "blob:x");
    const c = render(<Artwork beat={loaded} gallery />);
    expect(c.container.querySelector("img")?.getAttribute("src")).toBe("blob:x");
    const none = beatFromCatalogDetail({ ...(dto as object), artwork: null } as never, null);
    expect(none.artwork_pending).toBe(false);
    // jsdom no tiene contexto 2D: el lienzo procedural cae al degradado + iniciales, como antes sin generador
    const n = render(<Artwork beat={none} gallery={false} />);
    expect(n.container.textContent).toBe("DT");
  });
});
