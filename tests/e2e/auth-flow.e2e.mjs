import assert from "node:assert/strict";

const account = { id: "e2e-account", username: "windows-auth#1234", email: "windows-auth@example.invalid", storage_ready: true };

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
      const nativeFetch = window.fetch.bind(window);
      const nativeResponse = Response;
      window.fetch = async (input, init = {}) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        let pathname = "";
        try { pathname = new URL(url, window.location.origin).pathname; } catch {}
        // @wdio/tauri-service transports its own IPC through fetch. Never stub that
        // service channel: the auth harness owns only the two HTTP auth endpoints.
        if (pathname.startsWith("/plugin%3Awdio%7C")) return nativeFetch(input, init);
        if (url.endsWith("/auth/health")) {
          return new nativeResponse(JSON.stringify({ account_auth: true }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.endsWith("/auth/login")) {
          const body = JSON.parse(String(init.body || "{}"));
          if (body.identifier !== "windows-auth" || body.password !== "correct horse battery staple") {
            return new nativeResponse(JSON.stringify({ error: "invalid test credentials" }), { status: 401, headers: { "Content-Type": "application/json" } });
          }
          return new nativeResponse(JSON.stringify({ ok: true, token: "e2e-session-token", user: fakeAccount }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return nativeFetch(input, init);
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
    await browser.waitUntil(
      async () => (await browser.execute(() => localStorage.getItem("beatgaler:account-session:v1"))) === "e2e-session-token",
      { timeout: 15000, interval: 200, timeoutMsg: "Desktop login did not persist the returned session token." },
    );
    assert.equal(await browser.execute(() => localStorage.getItem("beatgaler:account-session:v1")), "e2e-session-token", "Desktop auth token persistence assertion failed.");
    assert.equal(await $(".bg-account-gate").isExisting(), false, "AccountGate remained visible after successful login.");
  });
});
