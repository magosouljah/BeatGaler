import { expect } from "@wdio/globals";

describe("BeatGaler Phase 9 critical import E2E", () => {
  beforeEach(async () => {
    // Import E2E uses a dedicated harness build. The production startup loader is
    // removed from the E2E-only HTML by the isolated runner, so harness readiness
    // itself is the authoritative gate for interaction.
    await browser.execute(() => {
      document.getElementById("beatgaler-startup-loader")?.remove();
    });

    const harness = await $("[data-e2e-import-harness='true']");
    await harness.waitForDisplayed({
      timeout: 15000,
      timeoutMsg: "Import E2E harness did not become ready",
    });
  });

  it("imports MP3, WAV-only with generated MASTER, full folders, and multiple folders through Review", async () => {
    await $("[data-e2e-drop-mp3]").click();
    await expect($("[data-e2e-review-name]")).toHaveText("E2E MP3");
    await $("[data-e2e-review-save]").click();
    const mp3 = await $("[data-e2e-beat='E2E MP3']");
    await expect(mp3).toBeDisplayed();
    await expect(mp3).toHaveAttribute("data-e2e-master", "E2E MP3.mp3");
    await expect(mp3).toHaveAttribute("data-e2e-wav", "");

    await $("[data-e2e-drop-wav]").click();
    await $("[data-e2e-review-save]").click();
    const wav = await $("[data-e2e-beat='E2E WAV']");
    await expect(wav).toHaveAttribute("data-e2e-wav", "E2E WAV.wav");
    await expect(wav).toHaveAttribute("data-e2e-master", "E2E WAV.generated.mp3");
    await expect($("[data-e2e-generated-master='true']")).toBeDisplayed();

    await $("[data-e2e-drop-folder]").click();
    await $("[data-e2e-review-save]").click();
    const full = await $("[data-e2e-beat='E2E Full Folder']");
    await expect(full).toHaveAttribute("data-e2e-master", "beat.mp3");
    await expect(full).toHaveAttribute("data-e2e-wav", "beat.wav");
    await expect(full).toHaveAttribute("data-e2e-project", "beat.flp");
    await expect(full).toHaveAttribute("data-e2e-folders", "Samples");

    await $("[data-e2e-drop-multiple]").click();
    await expect($("[data-e2e-review-progress]")).toHaveText("1 / 2");
    await $("[data-e2e-review-save]").click();
    await expect($("[data-e2e-review-name]")).toHaveText("E2E Multi B");
    await expect($("[data-e2e-review-progress]")).toHaveText("2 / 2");
    await $("[data-e2e-review-save]").click();
    await expect($("[data-e2e-beat='E2E Multi A']")).toBeDisplayed();
    await expect($("[data-e2e-beat='E2E Multi B']")).toBeDisplayed();
  });

  it("updates existing beat slots without duplication and keeps Backup/Pinterest isolated", async () => {
    await $("[data-e2e-add-wav]").click();
    await expect($("[data-e2e-existing='true'] [data-e2e-existing-wav]" )).toHaveAttribute("data-e2e-existing-wav", "later.wav");

    await $("[data-e2e-replace-wav]").click();
    await expect($("[data-e2e-existing='true'] [data-e2e-existing-wav]" )).toHaveAttribute("data-e2e-existing-wav", "replacement.wav");

    await $("[data-e2e-add-project]").click();
    await expect($("[data-e2e-existing='true'] [data-e2e-existing-project]" )).toHaveAttribute("data-e2e-existing-project", "later.flp");

    await $("[data-e2e-replace-project]").click();
    await expect($("[data-e2e-existing='true'] [data-e2e-existing-project]" )).toHaveAttribute("data-e2e-existing-project", "replacement.flp");

    await $("[data-e2e-add-samples]").click();
    await $("[data-e2e-add-samples]").click();
    await expect($("[data-e2e-existing='true'] [data-e2e-existing-folders]" )).toHaveAttribute("data-e2e-existing-folders", "Samples");

    await $("[data-e2e-drop-backup]").click();
    await expect($("[data-e2e-backup-skipped='true']")).toBeDisplayed();

    const before = await $("[data-e2e-import-harness='true']").getAttribute("data-e2e-library-count");
    await $("[data-e2e-pinterest]").click();
    await expect($("[data-e2e-pinterest-artwork='true']")).toBeDisplayed();
    await expect($("[data-e2e-import-harness='true']")).toHaveAttribute("data-e2e-library-count", before);
  });
});
