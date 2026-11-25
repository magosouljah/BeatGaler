// @vitest-environment jsdom
// M10: sustituye la inspección de texto de appStartupBootstrapExtraction («public startup isolated...»).
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({ signedIn: false, props: [] as Array<{ initialPhase: string; onAuthenticated?: () => void }> }));
const calls = vi.hoisted(() => ({ trace: vi.fn(), fetchBoundary: vi.fn(), workspace: vi.fn() }));

vi.mock("../../src/features/auth/AuthExperienceGate", () => ({
  default: (props: { initialPhase: string; onAuthenticated?: () => void; children: ReactNode }) => {
    gate.props.push(props);
    return gate.signedIn ? createElement("div", { "data-gate": "open" }, props.children) : createElement("main", { "data-gate": "closed" });
  },
}));
vi.mock("../../src/app/WebGalleryWorkspace", () => ({
  default: () => { calls.workspace(); return createElement("section", { "data-workspace": "mounted" }); },
}));
vi.mock("../../src/app/galleryLocation", () => ({ galleryLocation: () => "/gallery" }));
vi.mock("../../src/features/perf/startupTrace", () => ({ installStartupTrace: calls.trace }));
vi.mock("../../src/features/auth/webFetchBoundary", () => ({ installWebFetchBoundary: calls.fetchBoundary }));
vi.mock("../../src/app/WebExperience", () => ({ default: () => createElement("main", { "data-web-experience": "yes" }) }));
vi.mock("../../src/app/DesktopExperience", () => ({ default: () => createElement("main", { "data-desktop": "yes" }) }));
vi.mock("../../src/platform", () => ({ platform: { kind: "web" } }));
vi.mock("../../src/platform/react", () => ({ PlatformProvider: (p: { children: ReactNode }) => createElement("div", null, p.children) }));
vi.mock("../../src/features/playback/playTrace", () => ({ playTrace: vi.fn() }));
vi.mock("../../src/styles/design-foundations.css", () => ({}));
vi.mock("../../src/styles/auth-ui.css", () => ({}));
vi.mock("../../src/styles/library-ux.css", () => ({}));

describe("Web entry wiring", () => {
  beforeEach(() => { gate.signedIn = false; gate.props = []; calls.workspace.mockClear(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
  afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); window.history.replaceState(null, "", "/"); });

  it("does not mount the Gallery workspace until the gate confirms the account, and moves a /login visit to the gallery", async () => {
    const { default: Entry } = await import("../../src/app/WebGalleryEntry");
    window.history.replaceState(null, "", "/login");
    const popstate = vi.fn();
    window.addEventListener("popstate", popstate);
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(createElement(Entry, { initialPhase: "register" })));
    expect(gate.props.at(-1)?.initialPhase).toBe("register");
    expect(host.querySelector("[data-gate=closed]")).not.toBeNull();
    expect(host.querySelector("[data-workspace]")).toBeNull();
    expect(calls.workspace).not.toHaveBeenCalled();

    gate.signedIn = true;
    await act(async () => root.render(createElement(Entry, { initialPhase: "register" })));
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector("[data-workspace=mounted]")).not.toBeNull();

    await act(async () => gate.props.at(-1)!.onAuthenticated!());
    expect(window.location.pathname).toBe("/gallery");
    expect(popstate).toHaveBeenCalled();
    window.removeEventListener("popstate", popstate);
    await act(async () => root.unmount());
  });

  it("main installs the startup trace and fetch boundary and mounts WebExperience on the web platform", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    await act(async () => { await import("../../src/main"); });
    expect(calls.trace).toHaveBeenCalledOnce();
    expect(calls.fetchBoundary).toHaveBeenCalledOnce();
    expect(document.querySelector("[data-web-experience=yes]")).not.toBeNull();
    expect(document.querySelector("[data-desktop]")).toBeNull();
  });
});
