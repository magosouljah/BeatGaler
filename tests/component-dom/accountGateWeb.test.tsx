import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AccountGate, {
  getBeatGalerAuthToken,
  getBeatGalerInstallationId,
  loginBeatGalerAccount,
  restoreBeatGalerSession,
} from "../../src/components/AccountGate";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const API_KEY = "beatgaler:cloud-api:v1";
const TOKEN_KEY = "beatgaler:account-session:v1";
const WEB_SESSION_MARKER_KEY = "beatgaler:web-session-present:v1";
const CSRF_KEY = "beatgaler:web-csrf:v1";
const TRUSTED_REMOTE_API = "https://desktop-7l93a0j.tailabe8ff.ts.net";

async function renderSignedOutGate() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<AccountGate><div>Authenticated application</div></AccountGate>);
    await Promise.resolve();
  });
  return { host, root };
}

describe("AccountGate Web adapter", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem(API_KEY, TRUSTED_REMOTE_API);
    vi.restoreAllMocks();
  });

  it("uses a stable browser installation id without invoking Tauri", async () => {
    const first = await getBeatGalerInstallationId();
    const second = await getBeatGalerInstallationId();
    expect(first).toBe(second);
    expect(first).toMatch(/^beatgaler-web-/);
  });

  it("renders the real signed-out browser shell on shared foundation classes", async () => {
    const { host, root } = await renderSignedOutGate();
    expect(host.textContent).toContain("Sign in to your BeatGaler account");
    expect(host.querySelector(".bg-account-gate")).not.toBeNull();
    expect(host.querySelector("form.bg-account-card")).not.toBeNull();
    expect(host.querySelector("button.bg-button--primary")).not.toBeNull();
    expect(host.querySelectorAll("button.bg-button--secondary")).toHaveLength(2);
    await act(async () => root.unmount());
    host.remove();
  });

  it("uses labelled login fields and browser autocomplete semantics", async () => {
    const { host, root } = await renderSignedOutGate();
    const identifier = host.querySelector<HTMLInputElement>("#beatgaler-login-identifier");
    const password = host.querySelector<HTMLInputElement>("#beatgaler-login-password");
    expect(identifier?.getAttribute("autocomplete")).toBe("username");
    expect(password?.getAttribute("autocomplete")).toBe("current-password");
    expect(host.querySelector('label[for="beatgaler-login-identifier"]')?.textContent).toBe("USERNAME OR EMAIL");
    expect(host.querySelector('label[for="beatgaler-login-password"]')?.textContent).toBe("PASSWORD");
    await act(async () => root.unmount());
    host.remove();
  });

  it("uses email/new-password autofill semantics in registration mode", async () => {
    const { host, root } = await renderSignedOutGate();
    const switchButton = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes("Create account"));
    expect(switchButton).toBeTruthy();
    await act(async () => switchButton?.click());

    expect(host.querySelector<HTMLInputElement>("#beatgaler-register-username")?.getAttribute("autocomplete")).toBe("username");
    expect(host.querySelector<HTMLInputElement>("#beatgaler-register-email")?.getAttribute("autocomplete")).toBe("email");
    expect(host.querySelector<HTMLInputElement>("#beatgaler-register-password")?.getAttribute("autocomplete")).toBe("new-password");
    expect(host.querySelector<HTMLInputElement>("#beatgaler-register-password-confirm")?.getAttribute("autocomplete")).toBe("new-password");
    expect(host.querySelector('label[for="beatgaler-register-email"]')?.textContent).toBe("EMAIL");

    await act(async () => root.unmount());
    host.remove();
  });

  it("uses credentialed cookie transport and never persists the Web bearer", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${TRUSTED_REMOTE_API}/auth/health`) {
        return new Response(JSON.stringify({ account_auth: true }), { status: 200 });
      }
      if (url === `${TRUSTED_REMOTE_API}/auth/login`) {
        const body = JSON.parse(String(init?.body || "{}"));
        const headers = new Headers(init?.headers);
        expect(body.beatgalerUserId).toMatch(/^beatgaler-web-/);
        expect(init?.credentials).toBe("include");
        expect(headers.get("X-BeatGaler-Client")).toBe("web");
        expect(headers.get("Authorization")).toBeNull();
        return new Response(JSON.stringify({
          ok: true,
          csrf_token: "csrf-web-test",
          session_transport: "cookie",
          user: { id: "web-user", username: "web#0001", storage_ready: true },
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const account = await loginBeatGalerAccount("web#0001", "password");
    expect(account.id).toBe("web-user");
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(WEB_SESSION_MARKER_KEY)).toBe("1");
    expect(sessionStorage.getItem(CSRF_KEY)).toBe("csrf-web-test");
    expect(getBeatGalerAuthToken()).toBe("browser-cookie-session");
  });

  it("clears a saved session only for an explicit 401/expiry", async () => {
    localStorage.setItem(TOKEN_KEY, "legacy-web-token");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${TRUSTED_REMOTE_API}/auth/health`) {
        return new Response(JSON.stringify({ account_auth: true }), { status: 200 });
      }
      if (url === `${TRUSTED_REMOTE_API}/auth/session`) {
        return new Response(JSON.stringify({ error: "Session expired. Sign in again.", code: "SESSION_EXPIRED" }), { status: 401 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(restoreBeatGalerSession()).resolves.toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(WEB_SESSION_MARKER_KEY)).toBeNull();
  });

  it("keeps the saved session on offline/network failure instead of treating it as expiry", async () => {
    localStorage.setItem(TOKEN_KEY, "legacy-web-token");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network unavailable"); }));

    await expect(restoreBeatGalerSession()).rejects.toMatchObject({ code: "CLOUD_UNREACHABLE", kind: "network" });
    expect(localStorage.getItem(TOKEN_KEY)).toBe("legacy-web-token");
  });
});
