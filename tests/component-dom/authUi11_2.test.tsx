import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AuthExperienceGate from "../../src/features/auth/AuthExperienceGate";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const API_KEY = "beatgaler:cloud-api:v1";
const SAME_ORIGIN_API = `${window.location.origin}/beatgaler-api`;

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
    localStorage.setItem(API_KEY, SAME_ORIGIN_API);
    vi.restoreAllMocks();
  });

  it("exposes login, signup OTP and password recovery without the legacy verification flow", async () => {
    const { host, root } = await renderGate();
    expect(host.querySelector("main.bg-auth-shell")).not.toBeNull();
    expect(host.querySelector("#beatgaler-auth-title")?.textContent).toBe("Welcome back");
    expect(host.querySelector<HTMLInputElement>("#auth-login-identifier")?.autocomplete).toBe("email");
    expect(host.querySelector<HTMLInputElement>("#auth-login-password")?.autocomplete).toBe("current-password");
    expect(button(host, "Verify email")).toBeUndefined();
    expect(host.querySelector("#auth-verify-token")).toBeNull();

    await act(async () => button(host, "Forgot password?")?.click());
    expect(host.querySelector("#beatgaler-auth-title")?.textContent).toBe("Reset your password");
    expect(host.querySelector<HTMLInputElement>("#auth-reset-email")?.type).toBe("email");

    await act(async () => button(host, "Back to sign in")?.click());
    await act(async () => button(host, "New to BeatGaler? Create account")?.click());
    expect(host.querySelector("#beatgaler-auth-title")?.textContent).toBe("Create your account");
    expect(host.querySelector<HTMLInputElement>("#auth-register-email")?.autocomplete).toBe("email");
    expect(host.querySelector<HTMLInputElement>("#auth-register-password")?.autocomplete).toBe("new-password");

    await act(async () => root.unmount());
    host.remove();
  });

  it("moves a pending signup to the six digit OTP form", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === `${SAME_ORIGIN_API}/auth/register`) {
        return new Response(JSON.stringify({ signup_pending: true, signup_id: "signup-1", status: "PENDING_VERIFICATION" }), { status: 202 });
      }
      if (String(input) === `${SAME_ORIGIN_API}/auth/signup/resend`) {
        return new Response(JSON.stringify({ signup_pending: true, status: "DELIVERY_PENDING" }), { status: 202 });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { host, root } = await renderGate();
    await act(async () => button(host, "New to BeatGaler? Create account")?.click());
    await act(async () => {
      host.querySelector("form.bg-auth-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(host.querySelector("#beatgaler-auth-title")?.textContent).toBe("Check your email");
    expect(host.querySelector<HTMLInputElement>("#auth-signup-code")?.autocomplete).toBe("one-time-code");
    expect(host.querySelector<HTMLInputElement>("#auth-signup-code")?.pattern).toBe("[0-9]{3}-[0-9]{3}");
    expect(button(host, "Verify and create account")).toBeTruthy();
    expect(button(host, "Verify email")).toBeUndefined();
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === `${SAME_ORIGIN_API}/auth/register`)).toHaveLength(1);

    const code = host.querySelector<HTMLInputElement>("#auth-signup-code")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(code, "123-123");
      code.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(code.value).toBe("123-123");
    await act(async () => { button(host, "Resend code")?.click(); await Promise.resolve(); });
    expect(code.value).toBe("", "a resend must clear the previous OTP before the next one is pasted");

    await act(async () => root.unmount());
    host.remove();
  });

  it("moves a login that requires MFA into an accessible authenticator/recovery flow", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${SAME_ORIGIN_API}/auth/health`) return new Response(JSON.stringify({ account_auth: true }), { status: 200 });
      if (url === `${SAME_ORIGIN_API}/auth/login`) {
        return new Response(JSON.stringify({ error: "Two-step verification required.", code: "MFA_REQUIRED", mfa_required: true }), { status: 401 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { host, root } = await renderGate();
    const identifier = host.querySelector<HTMLInputElement>("#auth-login-identifier")!;
    const password = host.querySelector<HTMLInputElement>("#auth-login-password")!;
    await act(async () => {
      identifier.value = "producer@example.test";
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
      if (url === `${SAME_ORIGIN_API}/auth/oauth/start`) {
        return new Response(JSON.stringify({ flow_id: "flow-1", authorization_url: "https://accounts.example.test/oauth" }), { status: 200 });
      }
      if (url === `${SAME_ORIGIN_API}/auth/health`) return new Response(JSON.stringify({ account_auth: true }), { status: 200 });
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

  it("returns the Web auth gate to sign-in when the current account logs out", async () => {
    localStorage.setItem("beatgaler:web-session-present:v1", "1");
    sessionStorage.setItem("beatgaler:web-csrf:v1", "csrf-before-logout");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${SAME_ORIGIN_API}/auth/session`) {
        return new Response(JSON.stringify({
          user: {
            id: "user-1",
            username: "producer#1234",
            email: "producer@example.test",
            storage_ready: true,
          },
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { host, root } = await renderGate();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="app"]')?.textContent).toBe("Authenticated application");

    localStorage.removeItem("beatgaler:web-session-present:v1");
    sessionStorage.removeItem("beatgaler:web-csrf:v1");
    await act(async () => {
      window.dispatchEvent(new Event("beatgaler:account-logged-out"));
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="app"]')).toBeNull();
    expect(host.querySelector("#beatgaler-auth-title")?.textContent).toBe("Welcome back");
    expect(host.querySelector<HTMLInputElement>("#auth-login-identifier")?.value).toBe("");
    expect(host.querySelector<HTMLInputElement>("#auth-login-password")?.value).toBe("");

    await act(async () => root.unmount());
    host.remove();
  });

  it("keeps a remembered local shell visible when auth restore is transiently offline", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    localStorage.setItem("beatgaler:web-session-present:v1", "1");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network unavailable"); }));

    const { host, root } = await renderGate();
    expect(host.querySelector('[data-testid="app"]')?.textContent).toBe("Authenticated application");
    expect(host.querySelector("#beatgaler-auth-title")).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();

    await act(async () => root.unmount());
    host.remove();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });
});
