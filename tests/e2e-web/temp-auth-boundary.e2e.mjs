import assert from "node:assert/strict";

describe("Task 5.1 M0-E pure Web boundary", () => {
  it("runs in a real browser with no Tauri/helper and exposes no permanent Telegram credentials", async () => {
    await browser.url("/");

    const snapshot = await browser.execute(() => ({
      hasTauriRuntime: Boolean(window.__TAURI_INTERNALS__),
      hasWebCrypto: Boolean(globalThis.crypto?.subtle),
      hasWebSocket: typeof globalThis.WebSocket === "function",
      hasNodeProcess: typeof globalThis.process !== "undefined",
      html: document.documentElement.innerHTML,
      storage: Object.fromEntries(
        Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
          .filter(Boolean)
          .map(key => [key, localStorage.getItem(key)]),
      ),
    }));

    assert.equal(snapshot.hasTauriRuntime, false, "M0-E Web evidence must not run inside Tauri");
    assert.equal(snapshot.hasNodeProcess, false, "M0-E Web evidence must execute in the browser, not Node");
    assert.equal(snapshot.hasWebCrypto, true, "M0-E Web requires browser WebCrypto");
    assert.equal(snapshot.hasWebSocket, true, "M0-E Web requires browser WebSocket transport");

    const serialized = JSON.stringify({ html: snapshot.html, storage: snapshot.storage });
    for (const forbidden of ["BEATGALER_M0_D_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_API_HASH", "bot_token", "telegram_api_hash"]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} must not appear in rendered/storage browser state`);
    }

    // This guard intentionally does NOT claim temp-auth success. The secret-backed
    // browser bind/transfer proof is a separate required M0-E evidence step.
  });
});
