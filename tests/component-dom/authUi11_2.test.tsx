import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AuthExperienceGate from "../../src/features/auth/AuthExperienceGate";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const API_KEY = "beatgaler:cloud-api:v1";
const TRUSTED_REMOTE_API = "https://desktop-7l93a0j.tailabe8ff.ts.net";

async function renderGate() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<AuthExperienceGate><div data-testid="app">Authenticated application</div></AuthExperienceGate>);
    await Promise.resolve();
  });
  return { host, root };
}

function button(host: HTMLElement, label: string) {
  return Array.from(host.querySelectorAll("button")).find(node => node.textContent?.trim() === label);
}

describe("F2 11.2 complete Auth UI", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem(API_KEY, TRUSTED_REMOTE_API);
    vi.restoreAllMocks();
  });

  it("exposes reachable login, register, verify and password recovery flows with native labels/autocomplete", async () => {
    const { host, root } = await renderGate();
    expect(host.querySelector("main.bg-auth-shell")).not.toBeNull();
    expect(host.querySelector("#beatgaler-auth-title")?.textContent).toBe("Welcome back");
    expect(host.querySelector<HTMLInputElement>("#auth-login-identifier")?.autocomplete).toBe("username");
    expect(host.querySelector<HTMLInputElement>("#auth-login-password")?.autocomplete).toBe("current-password");

    await act(async () => button(host, "Forgot password?")?.click());
    expect(host.querySelector("#beatgaler-auth-title")?.textContent).toBe("Reset your password");
    expect(host.querySelector<HTMLInputElement>("#auth-reset-email")?.type).toBe("email");

    await act(async () => button(host, "Back to sign in")?.click());
    await act(async () => button(host, "Verify email")?.click());
    expect(host.querySelector("#beatgaler-auth-title")?.textContent).toBe("Verify your email");
    expect(host.querySelector<HTMLInputElement>("#auth-verify-token")?.autocomplete).toBe("one-time-code");

    await act(async () => button(host, "Back to sign in")?.click());
    await act(async () => button(host, "New to BeatGaler? Create account")?.click());
    expect(host.querySelector("#beatgaler-auth-title")?.textContent).toBe("Create your account");
    expect(host.querySelector<HTMLInputElement>("#auth-register-email")?.autocomplete).toBe("email");
    expect(host.querySelector<HTMLInputElement>("#auth-register-password")?.autocomplete).toBe("new-password");

    await act(async () => root.unmount());
    host.remove();
  });

  it("moves a login that requires MFA into an accessible authenticator/recovery flow", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${TRUSTED_REMOTE_API}/auth/health`) return new Response(JSON.stringify({ account_auth: true }), { status: 200 });
      if (url === `${TRUSTED_REMOTE_API}/auth/login`) {
        return new Response(JSON.stringify({ error: "Two-step verification required.", code: "MFA_REQUIRED", mfa_required: true }), { status: 401 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { host, root } = await renderGate();
    const identifier = host.querySelector<HTMLInputElement>("#auth-login-identifier")!;
    const password = host.querySelector<HTMLInputElement>("#auth-login-password")!;
    await act(async () => {
      identifier.value = "producer#1234";
      identifier.dispatchEvent(new Event("input", { bubbles: true }));
      password.value = "password-123";
      password.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(host, "Sign in")?.click());

    expect(host.querySelector("#beatgaler-auth-title")?.textContent).toBe("Two-step verification");
    expect(host.querySelector<HTMLInputElement>("#auth-login-mfa")?.inputMode).toBe("numeric");
    await act(async () => button(host, "Use a recovery code")?.click());
    expect(host.querySelector('label[for="auth-login-mfa"]')?.textContent).toBe("Recovery code");
    expect(host.querySelector<HTMLInputElement>("#auth-login-mfa")?.inputMode).toBe("text");

    await act(async () => root.unmount());
    host.remove();
  });

  it("offers popup blocked recovery, redirect/new-tab fallback, cancel and retry semantics for OAuth", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${TRUSTED_REMOTE_API}/auth/oauth/start`) {
        return new Response(JSON.stringify({ flow_id: "flow-1", authorization_url: "https://accounts.example.test/oauth" }), { status: 200 });
      }
      if (url === `${TRUSTED_REMOTE_API}/auth/health`) return new Response(JSON.stringify({ account_auth: true }), { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "open").mockReturnValue(null);

    const { host, root } = await renderGate();
    await act(async () => button(host, "Continue with Google")?.click());

    expect(host.textContent).toContain("Popup blocked.");
    expect(button(host, "Retry popup")).toBeTruthy();
    const newTab = Array.from(host.querySelectorAll("a")).find(node => node.textContent === "Open new tab");
    expect(newTab?.getAttribute("href")).toBe("https://accounts.example.test/oauth");
    expect(newTab?.getAttribute("target")).toBe("_blank");
    expect(button(host, "Continue in this tab")).toBeTruthy();

    await act(async () => root.unmount());
    host.remove();
  });

  it("keeps an offline state recoverable with explicit retry and an assertive error region", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    localStorage.setItem("beatgaler:web-session-present:v1", "1");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network unavailable"); }));

    const { host, root } = await renderGate();
    expect(host.querySelector("#beatgaler-auth-title")?.textContent).toBe("BeatGaler Cloud is unavailable");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("offline");
    expect(button(host, "Retry connection")).toBeTruthy();
    expect(button(host, "Use another account")).toBeTruthy();

    await act(async () => root.unmount());
    host.remove();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });
});
