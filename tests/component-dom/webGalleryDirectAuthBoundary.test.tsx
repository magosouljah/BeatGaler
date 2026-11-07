// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  restore: vi.fn(),
  resumeSignup: vi.fn(),
  preconnect: vi.fn(),
}));

vi.mock("../../src/platform", () => ({
  platform: {
    kind: "web",
    account: { getInstallationId: async () => "test-web-installation" },
    cloudAuth: { syncSession: vi.fn(async () => {}) },
  },
}));

vi.mock("../../src/components/AccountGate", () => ({
  restoreBeatGalerSession: mocks.restore,
  resumeBeatGalerSignup: mocks.resumeSignup,
  getBeatGalerInstallationId: vi.fn(async () => "test-web-installation"),
  loginBeatGalerAccount: vi.fn(),
  registerBeatGalerAccount: vi.fn(),
  verifyBeatGalerSignup: vi.fn(),
  resendBeatGalerSignup: vi.fn(),
  resolveBeatGalerCloudApi: vi.fn(async () => "/beatgaler-api"),
}));

vi.mock("../../src/features/playback/webRememberedDirectPreconnect", () => ({
  preconnectRememberedWebDirect: mocks.preconnect,
}));

vi.mock("../../src/App", () => ({
  default: () => React.createElement("main", { "data-test-gallery-app": true }, "Authenticated Gallery"),
}));
vi.mock("../../src/features/library/LibraryUxBridge", () => ({
  default: () => null,
}));
vi.mock("../../src/features/library/WebLibraryPagination", () => ({
  default: () => null,
}));
vi.mock("../../src/features/design/LANDING/LandingPage", () => ({
  default: () => React.createElement("main", { "data-test-public-landing": true }, "Public Landing"),
}));

import WebExperience from "../../src/app/WebExperience";
import { setActiveWebAccountId } from "../../src/features/auth/activeWebAccount";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type TestAccount = { id: string; username: string; email: string; storage_ready: boolean };
const account = (id: string): TestAccount => ({
  id, username: id, email: `${id}@example.test`, storage_ready: true,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mountAt(pathname: string) {
  window.history.replaceState(null, "", pathname);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<WebExperience />);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

async function flushLazy() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  setActiveWebAccountId(null);
  mocks.resumeSignup.mockResolvedValue({ signup_pending: true, status: "PENDING", signup_id: "" });
  mocks.restore.mockResolvedValue(null);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
  setActiveWebAccountId(null);
});

describe("Web Direct authenticated Gallery mount boundary", () => {
  it("does not preconnect or mount Gallery from the public Landing", async () => {
    await mountAt("/");
    await flushLazy();
    expect(host?.querySelector("[data-test-public-landing]")).not.toBeNull();
    expect(host?.querySelector("[data-test-gallery-app]")).toBeNull();
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.preconnect).not.toHaveBeenCalled();
  });

  it("keeps Gallery and Direct unmounted when session restore is pending or signed out", async () => {
    const pending = deferred<TestAccount | null>();
    mocks.restore.mockReturnValueOnce(pending.promise);
    await mountAt("/gallery");
    await flushLazy();
    expect(host?.querySelector("[data-test-gallery-app]")).toBeNull();
    expect(mocks.preconnect).not.toHaveBeenCalled();

    await act(async () => { pending.resolve(null); await pending.promise; });
    await flushLazy();
    expect(host?.querySelector("[data-test-gallery-app]")).toBeNull();
    expect(mocks.preconnect).not.toHaveBeenCalled();
  });

  it("preconnects after account confirmation, and unmounts Gallery on logout", async () => {
    const pending = deferred<TestAccount | null>();
    mocks.restore.mockReturnValueOnce(pending.promise);
    await mountAt("/gallery");
    await flushLazy();
    expect(mocks.preconnect).not.toHaveBeenCalled();

    await act(async () => { pending.resolve(account("user-a")); await pending.promise; });
    await flushLazy();
    expect(host?.querySelector("[data-test-gallery-app]")).not.toBeNull();
    expect(mocks.preconnect).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("beatgaler:account-logged-out"));
    });
    await flushLazy();
    expect(host?.querySelector("[data-test-gallery-app]")).toBeNull();
    expect(mocks.preconnect).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new CustomEvent("beatgaler:account-updated", { detail: account("user-b") }));
    });
    await flushLazy();
    expect(host?.querySelector("[data-test-gallery-app]")).not.toBeNull();
    expect(mocks.preconnect).toHaveBeenCalledTimes(2);
  });
});
