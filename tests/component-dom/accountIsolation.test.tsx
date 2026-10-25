// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";

const platformMocks = vi.hoisted(() => ({
  syncSession: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
}));

vi.mock("../../src/platform", () => ({
  platform: {
    kind: "web",
    account: { getInstallationId: async () => "installation-test" },
    cloudAuth: { syncSession: platformMocks.syncSession },
    cloudData: { disconnect: platformMocks.disconnect },
  },
}));
vi.mock("../../src/features/playback/webRememberedDirectPreconnect", () => ({ prepareWebDirectForSignIn: vi.fn() }));

import AuthExperienceGate from "../../src/features/auth/AuthExperienceGate";
import { getActiveWebAccountId, setActiveWebAccountId } from "../../src/features/auth/activeWebAccount";
import { loadCachedBeats, saveCachedBeats } from "../../src/features/library/libraryPresentationCache";
import { useLibraryState } from "../../src/features/library/useLibraryState";
import { loginBeatGalerAccount, logoutBeatGalerAccount } from "../../src/components/AccountGate";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const API = `${window.location.origin}/beatgaler-api`;
type User = { id: string; username: string; email: string; storage_ready: boolean };
const user = (id: string): User => ({ id, username: id, email: `${id}@example.test`, storage_ready: true });
const beat = (id: string): Beat => ({ id, name: id, tags: [], other_files: [] } as unknown as Beat);
const response = (id: string) => new Response(JSON.stringify({ user: user(id) }), { status: 200 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function Gallery() {
  const state = useLibraryState();
  return <div data-testid="gallery" data-loading={state.initialLoading}>{state.beats.map(item => item.id).join(",")}</div>;
}

let host: HTMLDivElement;
let root: Root;

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(<AuthExperienceGate><Gallery /></AuthExperienceGate>); });
}

function visibleIds(): string | null {
  return host.querySelector('[data-testid="gallery"]')?.textContent ?? null;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setActiveWebAccountId(null);
  platformMocks.syncSession.mockClear();
  platformMocks.disconnect.mockClear();
  localStorage.setItem("beatgaler:web-session-present:v1", "1");
  localStorage.setItem("beatvault:library:v1", JSON.stringify([beat("A-legacy")]));
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  setActiveWebAccountId(null);
  vi.unstubAllGlobals();
});

describe("confirmed Web account gallery isolation", () => {
  it("never paints A while B session is pending, then reads only B's cached beat", async () => {
    setActiveWebAccountId("usr_A");
    saveCachedBeats([beat("A-beat")]);
    setActiveWebAccountId("usr_B");
    saveCachedBeats([beat("B-beat")]);
    setActiveWebAccountId(null);
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input) === `${API}/auth/session`) return pending.promise;
      throw new Error(`Unexpected request ${String(input)}`);
    }));
    await mount();
    const frames: Array<string | null> = [visibleIds()];
    const observer = new MutationObserver(() => frames.push(visibleIds()));
    observer.observe(host, { childList: true, subtree: true });
    expect(visibleIds()).toBeNull();
    expect(host.querySelector(".bg-auth-card--loading")).not.toBeNull();

    await act(async () => { pending.resolve(response("usr_B")); await pending.promise; });
    frames.push(visibleIds());
    observer.disconnect();
    expect(visibleIds()).toBe("B-beat");
    expect(frames).not.toContain("A-beat");
    expect(localStorage.getItem("beatvault:library:v2:usr_A")).toContain("A-beat");
  });

  it("shows an empty loading gallery for uncached B, then reuses A only after A signs in again", async () => {
    setActiveWebAccountId("usr_A");
    saveCachedBeats([beat("A-beat")]);
    // A damaged B key must not make A's payload valid for B.
    localStorage.setItem("beatvault:library:v2:usr_B", localStorage.getItem("beatvault:library:v2:usr_A")!);
    setActiveWebAccountId(null);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === `${API}/auth/session`) return Promise.resolve(response("usr_A"));
      if (path === `${API}/auth/logout`) return Promise.resolve(new Response("{}", { status: 200 }));
      if (path === `${API}/auth/login`) return Promise.resolve(response("usr_B"));
      throw new Error(`Unexpected request ${path}`);
    }));
    await mount();
    expect(visibleIds()).toBe("A-beat");

    let logout!: Promise<void>;
    act(() => {
      logout = logoutBeatGalerAccount();
      expect(visibleIds()).toBeNull();
    });
    expect(visibleIds()).toBeNull();
    await act(async () => { await logout; });
    await act(async () => { await loginBeatGalerAccount("B@example.test", "password"); });
    expect(visibleIds()).toBe("");
    expect(host.querySelector('[data-testid="gallery"]')?.getAttribute("data-loading")).toBe("true");
    expect(loadCachedBeats()).toBeNull();
    expect(localStorage.getItem("beatvault:library:v2:usr_A")).toContain('"owner_user_id":"usr_A"');

    await act(async () => { window.dispatchEvent(new Event("beatgaler:account-logged-out")); });
    expect(visibleIds()).toBeNull();
    await act(async () => {
      setActiveWebAccountId("usr_A");
      window.dispatchEvent(new CustomEvent("beatgaler:account-updated", { detail: user("usr_A") }));
    });
    expect(visibleIds()).toBe("A-beat");
  });

  it("treats an unowned per-user payload as a miss", () => {
    setActiveWebAccountId("usr_B");
    localStorage.setItem("beatvault:library:v2:usr_B", JSON.stringify([beat("A-beat")]));
    expect(loadCachedBeats()).toBeNull();
  });

  it("never reveals a cache when the remembered session has expired", async () => {
    setActiveWebAccountId("usr_A");
    saveCachedBeats([beat("A-beat")]);
    setActiveWebAccountId(null);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input) === `${API}/auth/session`) return Promise.resolve(new Response(JSON.stringify({ error: "expired", code: "SESSION_EXPIRED" }), { status: 401 }));
      throw new Error(`Unexpected request ${String(input)}`);
    }));
    await mount();
    expect(visibleIds()).toBeNull();
    expect(getActiveWebAccountId()).toBeNull();
    expect(localStorage.getItem("beatvault:library:v2:usr_A")).toContain("A-beat");
  });

  it("ignores a late A restore after a rapid A→B→A switch", async () => {
    for (const id of ["usr_A", "usr_B"]) {
      setActiveWebAccountId(id);
      saveCachedBeats([beat(`${id}-beat`)]);
    }
    setActiveWebAccountId(null);
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input) === `${API}/auth/session`) return pending.promise;
      throw new Error(`Unexpected request ${String(input)}`);
    }));
    await mount();
    const setAccount = async (id: string | null) => act(async () => {
      if (!id) window.dispatchEvent(new Event("beatgaler:account-logged-out"));
      else {
        setActiveWebAccountId(id);
        window.dispatchEvent(new CustomEvent("beatgaler:account-updated", { detail: user(id) }));
      }
    });
    await setAccount("usr_A");
    expect(visibleIds()).toBe("usr_A-beat");
    await setAccount(null);
    expect(visibleIds()).toBeNull();
    await setAccount("usr_B");
    expect(visibleIds()).toBe("usr_B-beat");
    await setAccount(null);
    await setAccount("usr_A");
    expect(visibleIds()).toBe("usr_A-beat");
    await act(async () => { pending.resolve(response("usr_B")); await pending.promise; });
    expect(visibleIds()).toBe("usr_A-beat");
  });
});
