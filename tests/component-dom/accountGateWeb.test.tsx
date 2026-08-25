import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AccountGate, { getBeatGalerInstallationId, loginBeatGalerAccount } from "../../src/components/AccountGate";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const API_KEY = "beatgaler:cloud-api:v1";
const TOKEN_KEY = "beatgaler:account-session:v1";
const TRUSTED_REMOTE_API = "https://desktop-7l93a0j.tailabe8ff.ts.net";

describe("AccountGate Web adapter", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(API_KEY, TRUSTED_REMOTE_API);
    vi.restoreAllMocks();
  });

  it("uses a stable browser installation id without invoking Tauri", async () => {
    const first = await getBeatGalerInstallationId();
    const second = await getBeatGalerInstallationId();
    expect(first).toBe(second);
    expect(first).toMatch(/^beatgaler-web-/);
  });

  it("renders the real signed-out browser shell", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<AccountGate><div>Authenticated application</div></AccountGate>);
      await Promise.resolve();
    });
    expect(host.textContent).toContain("Sign in to your BeatGaler account");
    await act(async () => root.unmount());
    host.remove();
  });

  it("logs in through the Web adapter and persists the account token", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${TRUSTED_REMOTE_API}/auth/health`) {
        return new Response(JSON.stringify({ account_auth: true }), { status: 200 });
      }
      if (url === `${TRUSTED_REMOTE_API}/auth/login`) {
        const body = JSON.parse(String(init?.body || "{}"));
        expect(body.beatgalerUserId).toMatch(/^beatgaler-web-/);
        return new Response(JSON.stringify({
          ok: true,
          token: "web-test-token",
          user: { id: "web-user", username: "web#0001", storage_ready: true },
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const account = await loginBeatGalerAccount("web#0001", "password");
    expect(account.id).toBe("web-user");
    expect(localStorage.getItem(TOKEN_KEY)).toBe("web-test-token");
    expect(localStorage.getItem(API_KEY)).toBe(TRUSTED_REMOTE_API);
  });
});
