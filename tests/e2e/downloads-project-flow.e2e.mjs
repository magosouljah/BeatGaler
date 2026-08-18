import { expect } from "@wdio/globals";

describe("BeatGaler Phase 10 downloads + PROJECT lifecycle E2E", () => {
  beforeEach(async () => {
    await browser.execute(() => document.getElementById("beatgaler-startup-loader")?.remove());
    const harness = await $("[data-e2e-downloads-harness='true']");
    await harness.waitForDisplayed({ timeout: 15000, timeoutMsg: "Downloads E2E harness did not become ready" });
  });

  it("runs MP3/WAV/Everything background download states without cross-marking actions", async () => {
    await $("[data-e2e-download-mp3]").click();
    await expect($("[data-e2e-progress='true']")).toBeDisplayed();
    await $("[data-e2e-complete-action]").click();
    await expect($("[data-e2e-downloads-harness='true']")).toHaveAttribute("data-e2e-downloaded", "MP3");

    await $("[data-e2e-download-wav]").click();
    await $("[data-e2e-complete-action]").click();
    await expect($("[data-e2e-downloads-harness='true']")).toHaveAttribute("data-e2e-downloaded", "MP3,WAV");

    await $("[data-e2e-download-all]").click();
    await $("[data-e2e-complete-action]").click();
    await expect($("[data-e2e-downloads-harness='true']")).toHaveAttribute("data-e2e-downloaded", "MP3,WAV,ALL");
    await expect($("[data-e2e-everything-folders]")).toHaveAttribute("data-e2e-everything-folders", "E2E Beat");

    await $("[data-e2e-download-all]").click();
    await $("[data-e2e-complete-action]").click();
    await expect($("[data-e2e-everything-folders]")).toHaveAttribute("data-e2e-everything-folders", "E2E Beat|E2E Beat (1)");
  });

  it("retries failed PROJECT download, caches it, rejects corrupt open, then opens valid cached project", async () => {
    await $("[data-e2e-download-project]").click();
    await $("[data-e2e-fail-action]").click();
    await expect($("[data-e2e-error='true']")).toBeDisplayed();

    await $("[data-e2e-retry-action]").click();
    await expect($("[data-e2e-progress='true']")).toBeDisplayed();
    await $("[data-e2e-complete-action]").click();
    await expect($("[data-e2e-project-cached]")).toHaveAttribute("data-e2e-project-cached", "true");

    await $("[data-e2e-toggle-corrupt]").click();
    await $("[data-e2e-open-project]").click();
    await expect($("[data-e2e-project-opened]")).toHaveAttribute("data-e2e-project-opened", "false");

    await $("[data-e2e-toggle-corrupt]").click();
    await $("[data-e2e-open-project]").click();
    await expect($("[data-e2e-project-opened]")).toHaveAttribute("data-e2e-project-opened", "true");
  });
});
