// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPanel from "../../src/components/SettingsPanel";

const apiBase = window.location.origin + "/beatgaler-api";
const apiKey = "beatgaler:cloud-api:v1";
const markerKey = "beatgaler:web-session-present:v1";
const csrfKey = "beatgaler:web-csrf:v1";
const oldEmail = "before@example.test";
const newEmail = "After@example.test";
const password = "fake-current-password";
const nextPassword = "fake-new-password";
const csrf = "fake-current-csrf";
const rotatedCsrf = "fake-rotated-csrf";
const reauth = "fake-reauth-token";
const props = {
  currentFolder: null, showIncompleteWarnings: true, onIncompleteWarningsChanged() {},
  customCursorEnabled: true, onCustomCursorChanged() {}, telegramConnected: false,
  networkOnline: true, telegramUsername: null, async onDisconnectTelegram() {},
  onClose() {}, onFolderChanged() {},
  trashSource: {
    async listBeats() { return []; },
    async restoreBeat() { throw new Error("Unexpected restore"); },
    async purgeBeats() { throw new Error("Unexpected purge"); },
  },
};
const account = { id: "user", username: "user", storage_ready: true, email: oldEmail, has_password: true };
const reply = (body: object, status = 200) => Response.json(body, { status });

function browserStorage(storage: Storage) {
  return Object.fromEntries(Object.keys(storage).map(key => [key, storage.getItem(key)]));
}

describe("SettingsPanel Web · credenciales de cuenta", () => {
  let root: Root;
  let host: HTMLDivElement;
  let currentAccount: object;
  let requests: Array<{ route: string; body: object; init: RequestInit }>;
  let routes: Record<string, () => Response | Promise<Response>>;
  let unexpected: string[];
  let storageWrites: Array<[string, string]>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem(markerKey, "1");
    sessionStorage.setItem(csrfKey, csrf);
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");
    storageWrites = storageSpy.mock.calls;
    currentAccount = account;
    requests = [];
    unexpected = [];
    routes = {
      "/auth/account": () => reply({ user: currentAccount }),
      "/plans/me": () => reply({ plan: { effective_plan_id: "free", label: "Free" } }),
      "/plans/catalog": () => reply({ plans: [] }),
      "/billing/portal/availability": () => reply({ available: false }),
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      const route = url.startsWith(apiBase) ? url.slice(apiBase.length) : url;
      requests.push({ route, body: JSON.parse(String(init.body ?? "{}")), init });
      const handler = routes[route];
      if (handler) return handler();
      unexpected.push(route);
      throw new Error(`Unexpected fake API request: ${route}`);
    }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    const writes = [...storageWrites];
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
    expect(unexpected).toEqual([]);
    for (const write of writes) {
      expect([[apiKey, apiBase], [csrfKey, rotatedCsrf]]).toContainEqual(write);
    }
  });

  const mount = async () => act(async () => root.render(<SettingsPanel {...props} />));
  const query = (label: string, scope: ParentNode = host) => scope.querySelector<HTMLInputElement>(`input[placeholder="${label}"]`);
  const field = (label: string, scope?: ParentNode) => {
    const input = query(label, scope);
    expect(input, label).not.toBeNull();
    return input!;
  };
  const fill = async (label: string, value: string, scope?: ParentNode) => act(async () => {
    const input = field(label, scope);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = (label: string) => {
    const node = Array.from(host.querySelectorAll("button")).find(item => item.textContent?.trim() === label);
    expect(node, label).toBeDefined();
    return node!;
  };
  const click = async (label: string) => act(async () => button(label).click());
  const calls = (route: string) => requests.filter(request => request.route === route);
  const payloads = (route: string) => calls(route).map(request => request.body);
  const status = (text: string) => expect(host.textContent).toContain(text);
  const expectSessionStorage = (csrfToken = csrf) => {
    expect(browserStorage(localStorage)).toEqual({ [apiKey]: apiBase, [markerKey]: "1" });
    expect(browserStorage(sessionStorage)).toEqual({ [csrfKey]: csrfToken });
  };

  it("valida, espera, muestra el error y completa un cambio de contraseña Web", async () => {
    const pending = Promise.withResolvers<Response>();
    routes["/auth/password/change"] = () => pending.promise;
    await mount();
    for (const label of ["Current password", "New password", "Confirm new password"]) {
      expect(field(label).type).toBe("password");
    }
    await fill("Current password", password);
    await fill("New password", "seven77");
    await click("Change password");
    status("New password must be at least 8 characters.");
    await fill("New password", nextPassword);
    await click("Change password");
    status("New passwords do not match.");
    expect(calls("/auth/password/change")).toHaveLength(0);
    await fill("Confirm new password", nextPassword);

    await click("Change password");
    expect(button("Change password").disabled).toBe(true);
    expect(host.textContent).not.toContain("Password updated.");
    expectSessionStorage();
    await act(async () => pending.resolve(reply({ error: "Current password is incorrect." }, 401)));
    status("Current password is incorrect.");
    expect(button("Change password").disabled).toBe(false);
    expect(field("Current password").value).toBe(password);

    routes["/auth/password/change"] = () => reply({ ok: true, token: "fake-returned-bearer", csrf_token: rotatedCsrf });
    await click("Change password");
    status("Password updated.");
    const body = { currentPassword: password, newPassword: nextPassword, reauthToken: "" };
    expect(payloads("/auth/password/change")).toEqual([body, body]);
    expect(calls("/auth/reauth")).toHaveLength(0);
    expect(calls("/auth/account")).toHaveLength(2);
    const { init } = calls("/auth/password/change")[1];
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    expect(new Headers(init.headers).get("X-BeatGaler-CSRF")).toBe(csrf);
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
    for (const label of ["Current password", "New password", "Confirm new password"]) {
      expect(field(label).value).toBe("");
    }
    expectSessionStorage(rotatedCsrf);
  });

  it("valida el email, reautentica con contraseña y MFA y cierra sesión solo tras confirmarlo", async () => {
    currentAccount = { ...account, mfa_enabled: true };
    const loggedOut = vi.spyOn(window, "dispatchEvent");
    routes["/auth/reauth"] = () => reply({ reauth_token: reauth });
    routes["/auth/email/change/start"] = () => reply({ ok: true });
    routes["/auth/email/change/confirm"] = () => reply({ error: "Invalid confirmation code." }, 400);
    await mount();
    const emailCard = field("New email").parentElement!;
    expect(field("New email").type).toBe("email");
    expect(field("Type new email again").type).toBe("email");
    expect(field("Current password to confirm identity").type).toBe("password");
    expect(field("Authenticator or recovery code", emailCard).autocomplete).toBe("one-time-code");
    await click("Send confirmation to new email");
    status("Enter your new email address.");
    await fill("New email", newEmail);
    await fill("Type new email again", "different@example.test");
    await click("Send confirmation to new email");
    status("Email addresses do not match.");
    expect(calls("/auth/reauth")).toHaveLength(0);
    expect(calls("/auth/email/change/start")).toHaveLength(0);

    await fill("Type new email again", newEmail.toLowerCase());
    await fill("Current password to confirm identity", password);
    await fill("Authenticator or recovery code", " 246810 ", emailCard);
    await click("Send confirmation to new email");
    expect(requests.slice(-2).map(({ route, body }) => [route, body])).toEqual([
      ["/auth/reauth", { password, mfaCode: "246810" }],
      ["/auth/email/change/start", { email: newEmail, reauthToken: reauth }],
    ]);
    status("Your current email remains active until confirmation.");
    status(oldEmail);
    expect(field("Email confirmation code").autocomplete).toBe("one-time-code");
    expect(query("Current password to confirm identity")).toBeNull();
    await click("Confirm new email");
    status("Enter the email confirmation code.");
    expect(calls("/auth/email/change/confirm")).toHaveLength(0);

    await fill("Email confirmation code", " 135790 ");
    await click("Confirm new email");
    status("Invalid confirmation code.");
    expect(field("Email confirmation code").value).toBe("135790");
    expect(loggedOut.mock.calls.some(([event]) => event.type === "beatgaler:account-logged-out")).toBe(false);
    expectSessionStorage();

    routes["/auth/email/change/confirm"] = () => reply({ ok: true });
    await click("Confirm new email");
    expect(payloads("/auth/email/change/confirm")).toEqual([{ code: "135790" }, { code: "135790" }]);
    status("Email updated. Sign in again with the new address.");
    expect(host.textContent).not.toContain(oldEmail);
    expect(query("Email confirmation code")).toBeNull();
    expect(field("New email").value).toBe("");
    expect(field("Type new email again").value).toBe("");
    expect(loggedOut.mock.calls.filter(([event]) => event.type === "beatgaler:account-logged-out")).toHaveLength(1);
    expect(browserStorage(localStorage)).toEqual({ [apiKey]: apiBase });
    expect(browserStorage(sessionStorage)).toEqual({});
  });

  it("distingue el fallo de reautenticación del fallo de entrega y permite reenviar", async () => {
    routes["/auth/reauth"] = () => reply({ error: "Reauthentication failed." }, 401);
    routes["/auth/email/change/start"] = () => reply({ code: "EMAIL_CHANGE_DELIVERY_FAILED" }, 503);
    routes["/auth/email/change/resend"] = () => reply({ error: "Delivery is unavailable." }, 503);
    await mount();
    await fill("New email", newEmail);
    await fill("Type new email again", newEmail);
    await fill("Current password to confirm identity", password);
    await click("Send confirmation to new email");
    status("Reauthentication failed.");
    expect(calls("/auth/email/change/start")).toHaveLength(0);
    expect(query("Email confirmation code")).toBeNull();

    routes["/auth/reauth"] = () => reply({ reauth_token: reauth });
    await click("Send confirmation to new email");
    status("The change is pending, but the message was not delivered.");
    expect(payloads("/auth/email/change/start")).toEqual([{ email: newEmail, reauthToken: reauth }]);
    expect(field("Email confirmation code").value).toBe("");
    await click("Resend code");
    status("Delivery is unavailable.");
    routes["/auth/email/change/resend"] = () => reply({ ok: true });
    await click("Resend code");
    status("A new confirmation message was requested.");
    expect(payloads("/auth/email/change/resend")).toEqual([{}, {}]);
    expectSessionStorage();
  });

  it("usa reautenticación de proveedor para las dos mutaciones de una cuenta sin contraseña", async () => {
    currentAccount = { ...account, has_password: false, providers: { x: { connected: true }, google: { connected: true } } };
    const authorizationUrl = "https://provider.example.test/reauth";
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    routes["/auth/oauth/start"] = () => reply({ authorization_url: authorizationUrl, flow_id: "fake-flow" });
    routes["/auth/oauth/poll"] = () => reply({ reauth_token: reauth });
    routes["/auth/password/change"] = () => reply({ ok: true });
    routes["/auth/email/change/start"] = () => reply({ ok: true });
    await mount();
    expect(query("Current password")).toBeNull();
    expect(query("Current password to confirm identity")).toBeNull();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await fill("New password", nextPassword);
    await fill("Confirm new password", nextPassword);
    await click("Set password");
    expect(calls("/auth/password/change")).toHaveLength(0);
    await act(async () => vi.advanceTimersByTimeAsync(900));
    expect(payloads("/auth/password/change")).toEqual([{ currentPassword: "", newPassword: nextPassword, reauthToken: reauth }]);
    status("Password updated.");

    await fill("New email", newEmail);
    await fill("Type new email again", newEmail);
    await click("Send confirmation to new email");
    expect(calls("/auth/email/change/start")).toHaveLength(0);
    await act(async () => vi.advanceTimersByTimeAsync(900));
    expect(payloads("/auth/email/change/start")).toEqual([{ email: newEmail, reauthToken: reauth }]);
    expect(payloads("/auth/oauth/start")).toEqual([
      { provider: "x", purpose: "reauth" },
      { provider: "google", purpose: "reauth" },
    ]);
    expect(payloads("/auth/oauth/poll")).toEqual([{ flowId: "fake-flow" }, { flowId: "fake-flow" }]);
    expect(open.mock.calls).toEqual(Array(2).fill([authorizationUrl, "_blank", "noopener,noreferrer"]));
    expect(calls("/auth/reauth")).toHaveLength(0);
    status("Your current email remains active until confirmation.");
    expectSessionStorage();
  });
});
