// @vitest-environment jsdom
// T25 — Comportamiento de la Gallery Web tras retirar INDEX: la composición decide qué se monta y la Web nunca vuelve al árbol LEGACY
// (App + pipeline INDEX) ni dispara el precalentamiento reservado al login. Sustituye a aserciones de texto fuente
// obsoletas de tests/integration (appStartupBootstrapExtraction, issue97PlaybackOptimization, issue97RuntimeWebFollowup).
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryCompositionState } from "../../src/features/library/catalog/LibraryCompositionGate";

const mocks = vi.hoisted(() => ({
  composition: { state: { status: "resolving" } as unknown, services: null as unknown },
  accountId: "acc-1" as string | null,
  workspaceProps: [] as Array<Record<string, unknown>>,
  prewarm: vi.fn(),
  useLibraryComposition: vi.fn(),
}));

vi.mock("../../src/features/auth/activeWebAccount", () => ({ getActiveWebAccountId: () => mocks.accountId }));
vi.mock("../../src/features/library/catalog/catalogLibraryProvider", () => ({
  useLibraryComposition: (options: unknown) => { mocks.useLibraryComposition(options); return mocks.composition; },
}));
vi.mock("../../src/features/library/catalog/CatalogGalleryWorkspace", () => ({
  CatalogGalleryWorkspace: (props: Record<string, unknown>) => {
    mocks.workspaceProps.push(props);
    return React.createElement("section", { "data-test-catalog-workspace": true });
  },
}));
vi.mock("../../src/features/library/catalog/catalogDirectPort", () => ({
  prewarmDirectRuntime: mocks.prewarm,
}));

import WebGalleryWorkspace from "../../src/app/WebGalleryWorkspace";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ready = (epoch = "7") => ({
  status: "resolved",
  key: `catalog:${epoch}`,
  composition: { mode: "catalog", resolution: { status: "ready", context: { authority_era: "era-1", authority_epoch: epoch, revision: "42" } } },
}) as unknown as LibraryCompositionState;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<WebGalleryWorkspace />); });
}

beforeEach(() => {
  mocks.composition = { state: { status: "resolving" }, services: null };
  mocks.accountId = "acc-1";
  mocks.workspaceProps.length = 0;
  mocks.prewarm.mockReset();
  mocks.useLibraryComposition.mockReset();
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove();
  root = null; host = null;
});

describe("WebGalleryWorkspace tras T25 (catálogo PostgreSQL como única autoridad)", () => {
  it("resuelve la composición para la cuenta activa y muestra un estado de verificación mientras tanto", async () => {
    await render();
    expect(mocks.useLibraryComposition).toHaveBeenCalledWith({ accountId: "acc-1" });
    expect(host!.querySelector('[data-library-composition="resolving"]')).not.toBeNull();
    expect(host!.querySelector("[data-test-catalog-workspace]")).toBeNull();
  });

  it("una composición LEGACY (flag forzado) muestra el estado retirado, fail-closed, sin montar la biblioteca INDEX", async () => {
    mocks.composition = { state: { status: "resolved", key: "legacy", composition: { mode: "legacy", reason: "flag-off" } }, services: null };
    await render();
    const retired = host!.querySelector('[data-catalog-mode="legacy-retired"]');
    expect(retired).not.toBeNull();
    expect(retired!.getAttribute("role")).toBe("status");
    expect(host!.querySelector("[data-test-catalog-workspace]")).toBeNull();
  });

  it("con autoridad POSTGRES y servicios listos monta el workspace del catálogo con la era/época/revisión del contexto", async () => {
    mocks.composition = { state: ready("7"), services: { tag: "services" } };
    await render();
    expect(host!.querySelector("[data-test-catalog-workspace]")).not.toBeNull();
    expect(mocks.workspaceProps).toHaveLength(1);
    expect(mocks.workspaceProps[0]).toMatchObject({ accountId: "acc-1", services: { tag: "services" }, context: { authority_era: "era-1", authority_epoch: "7", revision: "42" } });
  });

  it("con autoridad POSTGRES pero sin servicios o sin cuenta activa espera visiblemente sin montar el catálogo", async () => {
    mocks.composition = { state: ready(), services: null };
    await render();
    expect(host!.querySelector('[data-catalog-mode="postgres"][aria-busy="true"]')).not.toBeNull();
    expect(host!.querySelector("[data-test-catalog-workspace]")).toBeNull();
    await act(async () => { root!.unmount(); });
    host!.remove();
    mocks.composition = { state: ready(), services: { tag: "services" } };
    mocks.accountId = null;
    await render();
    expect(host!.querySelector("[data-test-catalog-workspace]")).toBeNull();
  });

  it("nunca dispara el precalentamiento Direct reservado al login", async () => {
    for (const state of [{ status: "resolving" }, ready()]) {
      mocks.composition = { state, services: { tag: "services" } };
      await render();
      await act(async () => { root!.unmount(); });
      host!.remove();
    }
    root = null; host = null;
    expect(mocks.prewarm).not.toHaveBeenCalled();
  });
});
