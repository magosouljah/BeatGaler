import assert from "node:assert/strict";

const account = {
  id: "e2e-account",
  username: "windows-auth#1234",
  email: "windows-auth@example.invalid",
  storage_ready: true,
};

describe("BeatGaler Windows auth functional journey", () => {
  it("signs in through the real Desktop AccountGate and persists the desktop session", async () => {
    await browser.execute(() => {
      localStorage.removeItem("beatgaler:account-session:v1");
      localStorage.removeItem("beatgaler:cloud-api:v1");
    });
    await browser.refresh();

    const settings = await browser.tauri.mock("get_settings");
    await settings.mockReturnValue({ beatgaler_user_id: "e2e-installation-id" });
    const syncSession = await browser.tauri.mock("set_cloud_auth_token");
    await syncSession.mockReturnValue(null);

    await browser.execute((fakeAccount) => {
      window.__beatgalerAuthTrace = [];
      const trace = (event) => window.__beatgalerAuthTrace.push(event);

      const nativeSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === "beatgaler:account-session:v1") trace({ boundary: "session-write-attempt", present: Boolean(value) });
        const result = nativeSetItem.call(this, key, value);
        if (key === "beatgaler:account-session:v1") trace({ boundary: "session-write-complete", present: Boolean(this.getItem(key)) });
        return result;
      };

      const internals = window.__TAURI_INTERNALS__;
      if (internals && typeof internals.invoke === "function") {
        const nativeInvoke = internals.invoke.bind(internals);
        internals.invoke = async (command, args, options) => {
          const commandName = String(command || "");
          if (commandName.includes("set_cloud_auth_token")) trace({ boundary: "set-cloud-auth-token-invoke" });
          try {
            const result = await nativeInvoke(command, args, options);
            if (commandName.includes("set_cloud_auth_token")) trace({ boundary: "set-cloud-auth-token-success" });
            return result;
          } catch (error) {
            if (commandName.includes("set_cloud_auth_token")) trace({ boundary: "set-cloud-auth-token-failure", errorType: error?.constructor?.name || typeof error });
            throw error;
          }
        };
      } else {
        trace({ boundary: "tauri-invoke-unavailable" });
      }

      const nativeResponse = Response;
      window.fetch = async (input, init = {}) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/auth/health")) {
          trace({ boundary: "auth-health" });
          return new nativeResponse(JSON.stringify({ account_auth: true }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.endsWith("/auth/login")) {
          const body = JSON.parse(String(init.body || "{}"));
          trace({ boundary: "auth-login-request", expectedIdentifier: body.identifier === "windows-auth" });
          if (body.identifier !== "windows-auth" || body.password !== "correct horse battery staple") {
            trace({ boundary: "auth-login-response", status: 401 });
            return new nativeResponse(JSON.stringify({ error: "invalid test credentials" }), { status: 401, headers: { "Content-Type": "application/json" } });
          }
          trace({ boundary: "auth-login-response", status: 200, tokenPresent: true });
          return new nativeResponse(JSON.stringify({ ok: true, token: "e2e-session-token", user: fakeAccount }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        trace({ boundary: "unexpected-request" });
        return new nativeResponse(JSON.stringify({ error: "unexpected E2E request" }), { status: 500, headers: { "Content-Type": "application/json" } });
      };
    }, account);

    const identifier = await $("#beatgaler-login-identifier");
    const password = await $("#beatgaler-login-password");
    const submit = await $("button.bg-account-submit");

    await identifier.waitForDisplayed({ timeout: 15000 });
    assert.equal(await submit.getText(), "Sign in", "Desktop auth gate did not expose the real sign-in action.");

    await identifier.setValue("windows-auth");
    await password.setValue("correct horse battery staple");
    await submit.click();

    try {
      await browser.waitUntil(
        async () => (await browser.execute(() => localStorage.getItem("beatgaler:account-session:v1"))) === "e2e-session-token",
        { timeout: 15000, interval: 200, timeoutMsg: "Desktop login did not persist the returned session token." },
      );
    } catch (error) {
      const trace = await browser.execute(() => ({
        events: window.__beatgalerAuthTrace || [],
        tokenPresent: Boolean(localStorage.getItem("beatgaler:account-session:v1")),
        gatePresent: Boolean(document.querySelector(".bg-account-gate")),
      }));
      console.error("[auth-e2e] causal-boundary trace", JSON.stringify(trace));
      throw error;
    }

    const successTrace = await browser.execute(() => ({
      events: window.__beatgalerAuthTrace || [],
      tokenPresent: Boolean(localStorage.getItem("beatgaler:account-session:v1")),
      gatePresent: Boolean(document.querySelector(".bg-account-gate")),
    }));
    console.log("[auth-e2e] causal-boundary trace", JSON.stringify(successTrace));

    assert.equal(
      await browser.execute(() => localStorage.getItem("beatgaler:account-session:v1")),
      "e2e-session-token",
      "Desktop auth token persistence assertion failed.",
    );
    assert.equal(await $(".bg-account-gate").isExisting(), false, "AccountGate remained visible after successful login.");
  });
});
