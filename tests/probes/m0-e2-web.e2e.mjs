import assert from "node:assert/strict";

describe("Task 5.1 M0-E2 pure Web temporary auth", () => {
  it("binds and runs a bot RPC from a real browser Web Worker without permanent credentials", async () => {
    await browser.url("/m0-e2.html");

    await browser.waitUntil(
      async () => browser.execute(() => {
        const result = globalThis.__M0_E2_RESULT__;
        return result?.status === "pass" || result?.status === "fail";
      }),
      {
        timeout: 90_000,
        interval: 250,
        timeoutMsg: "M0-E2 browser Worker did not produce a final result.",
      },
    );

    const result = await browser.execute(() => globalThis.__M0_E2_RESULT__);
    console.log(`M0_E2_BROWSER_RESULT=${JSON.stringify(result)}`);

    assert.equal(result?.status, "pass", result?.error || "M0-E2 browser proof failed.");
    assert.equal(result.web_browser_proven, true);
    assert.equal(result.web_worker_proven, true);
    assert.equal(result.bot_identity_proven, true);
    assert.equal(result.network_bind_proven, true);
    assert.equal(result.direct_mtproto_operation_proven, true);
    assert.equal(result.permanent_auth_reaches_browser, false);
    assert.equal(result.bot_token_reaches_browser, false);
    assert.equal(result.api_hash_reaches_browser, false);
    assert.equal(result.galer_file_bytes, false);
    assert.equal(result.vault_used, false);
    assert.equal(result.production_runtime_changed, false);
    assert.equal(result.token_rotation_or_revoke, false);
  });
});
