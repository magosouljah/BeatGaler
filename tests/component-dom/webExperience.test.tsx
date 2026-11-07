// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebExperience from "../../src/app/WebExperience";

const renders = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("../../src/features/design/LANDING/LandingPage", () => ({ default: () => <main data-landing>Public landing</main> }));
vi.mock("../../src/app/WebGalleryEntry", () => ({ default: (props: {initialPhase:string}) => { renders.auth(props); return <main data-auth={props.initialPhase}>Auth gate</main>; } }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
async function open(url: string) {
  window.history.replaceState(null, "", url);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<WebExperience />); await new Promise(resolve => setTimeout(resolve, 0)); });
}
afterEach(async () => { if (root) await act(async () => root.unmount()); host?.remove(); renders.auth.mockClear(); });
describe("public and authenticated entry routes", () => {
  it("renders the public root without mounting authentication", async () => {
    await open("/"); expect(host.querySelector("[data-landing]")).not.toBeNull(); expect(renders.auth).not.toHaveBeenCalled();
  });
  it("opens /gallery directly through the session gate and retains pagination", async () => {
    await open("/gallery?bgPage=160"); expect(host.querySelector("[data-auth]")?.getAttribute("data-auth")).toBe("login");
    expect(window.location.search).toBe("?bgPage=160"); expect(host.querySelector("[data-landing]")).toBeNull();
  });
  it("opens registration directly from the Landing CTA destination", async () => {
    await open("/signup"); expect(host.querySelector("[data-auth]")?.getAttribute("data-auth")).toBe("register");
  });
  it("preserves old root library bookmarks", async () => {
    await open("/?bgPage=80"); expect(window.location.pathname).toBe("/gallery"); expect(window.location.search).toBe("?bgPage=80");
  });
  it("handles browser back navigation to the public Landing", async () => {
    await open("/gallery");
    await act(async () => { window.history.replaceState(null, "", "/"); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(host.querySelector("[data-landing]")).not.toBeNull();
  });
  it("shows a usable missing-page result", async () => {
    await open("/missing"); expect(host.querySelector('[data-public-page-ready="true"]')).not.toBeNull(); expect(host.querySelector('a[href="/"]')).not.toBeNull();
  });
});
