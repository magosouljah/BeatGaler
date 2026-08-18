import { expect } from "@wdio/globals";

describe("BeatGaler Phase 11 stress + recovery E2E", () => {
  beforeEach(async () => {
    await browser.execute(() => document.getElementById("beatgaler-startup-loader")?.remove());
    const harness = await $("[data-e2e-recovery-harness='true']");
    await harness.waitForDisplayed({ timeout: 15000, timeoutMsg: "Recovery E2E harness did not become ready" });
  });

  it("recovers one interrupted operation across restart and retries without duplication", async () => {
    await $("[data-e2e-reset]").click();
    await $("[data-e2e-start-upload]").click();
    await expect($("[data-e2e-recovery-harness='true']")).toHaveAttribute("data-e2e-operation", "op-fixed-1:UPLOAD:0");
    await expect($("[data-e2e-temp-present]")).toHaveAttribute("data-e2e-temp-present", "true");

    await browser.refresh();
    const harness = await $("[data-e2e-recovery-harness='true']");
    await harness.waitForDisplayed({ timeout: 15000 });
    await expect(harness).toHaveAttribute("data-e2e-state", "recovered");
    await expect(harness).toHaveAttribute("data-e2e-operation", "op-fixed-1:UPLOAD:0");

    await $("[data-e2e-retry]").click();
    await expect(harness).toHaveAttribute("data-e2e-operation", "op-fixed-1:UPLOAD:1");
    await $("[data-e2e-complete]").click();
    await expect($("[data-e2e-completed]")).toHaveAttribute("data-e2e-completed", "op-fixed-1");
    await expect(harness).toHaveAttribute("data-e2e-operation", "none");
  });

  it("keeps canonical INDEX intact after torn candidate, rejects corrupt payload, and cleans stale temp", async () => {
    await $("[data-e2e-reset]").click();
    await $("[data-e2e-start-download]").click();
    await $("[data-e2e-torn-index]").click();
    await expect($("[data-e2e-canonical-index]")).toHaveAttribute("data-e2e-canonical-index", "index-v1");

    await browser.refresh();
    const harness = await $("[data-e2e-recovery-harness='true']");
    await harness.waitForDisplayed({ timeout: 15000 });
    await expect($("[data-e2e-canonical-index]")).toHaveAttribute("data-e2e-canonical-index", "index-v1");
    await $("[data-e2e-recover-index]").click();
    await $("[data-e2e-corrupt-file]").click();
    await expect($("[data-e2e-corrupt-accepted]")).toHaveAttribute("data-e2e-corrupt-accepted", "false");
    await expect(harness).toHaveAttribute("data-e2e-state", "error");

    await expect($("[data-e2e-temp-present]")).toHaveAttribute("data-e2e-temp-present", "true");
    await $("[data-e2e-clean-temp]").click();
    await expect($("[data-e2e-temp-present]")).toHaveAttribute("data-e2e-temp-present", "false");
  });
});
