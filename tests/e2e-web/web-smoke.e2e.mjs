import assert from "node:assert/strict";

describe("BeatGaler Web build smoke", () => {
  it("boots the compiled Web app in a real browser without Tauri", async () => {
    await browser.url("/");

    await browser.waitUntil(
      async () => browser.execute(() => {
        const root = document.querySelector("#root");
        return Boolean(root && root.childElementCount > 0);
      }),
      {
        timeout: 15_000,
        interval: 200,
        timeoutMsg: "BeatGaler Web did not mount React into #root.",
      },
    );

    const snapshot = await browser.execute(() => ({
      title: document.title,
      rootChildren: document.querySelector("#root")?.childElementCount ?? 0,
      hasTauriRuntime: Boolean(window.__TAURI_INTERNALS__),
    }));

    assert.equal(snapshot.title, "Beat Galer");
    assert.ok(snapshot.rootChildren > 0, "BeatGaler Web must render at least one React child");
    assert.equal(snapshot.hasTauriRuntime, false, "BeatGaler Web smoke must run without a Tauri runtime");
  });
});
