import assert from "node:assert/strict";

describe("Task 5.1 M0-E live pure Web temp auth", () => {
  it("binds A/B and uploads synthetic bytes directly from Chrome", async () => {
    await browser.url("/");
    await browser.waitUntil(async () => browser.execute(() => Boolean(window.__M0E_RESULT__ || window.__M0E_ERROR__)), {
      timeout: 150_000,
      interval: 500,
      timeoutMsg: "M0-E browser probe did not finish",
    });
    const snapshot = await browser.execute(() => ({ result: window.__M0E_RESULT__ || null, error: window.__M0E_ERROR__ || null }));
    assert.equal(snapshot.error, null, snapshot.error || "unexpected M0-E browser error");
    const result = snapshot.result;
    assert.ok(result, "browser must publish M0-E result");
    assert.equal(result.platform, "pure-web");
    assert.equal(result.hasTauriRuntime, false);
    assert.equal(result.hasNodeProcess, false);
    assert.equal(result.totalParts, 32);
    assert.equal(result.acceptedBytes, 16 * 1024 * 1024);
    assert.equal(result.sameFileIdAcrossRenewal, true);
    assert.equal(result.proactiveRenewalDuringTransferProven, true);
    assert.equal(result.permanentAuthReachesBrowser, false);
    assert.equal(result.botTokenReachesBrowser, false);
    assert.equal(result.apiHashReachesBrowser, false);
    assert.equal(result.galerCloudFileBytes, 0);
    assert.equal(result.tokenRotationOrRevoke, false);
  });
});
