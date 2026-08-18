import assert from "node:assert/strict";

describe("BeatGaler Trash controlled desktop E2E", () => {
  it("restores a beat, blocks Empty Trash offline, and empties Trash online", async () => {
    await browser.execute(() => {
      document.getElementById("beatgaler-startup-loader")?.remove();
      document.documentElement.removeAttribute("data-startup-loading");
      document.body.removeAttribute("data-startup-loading");
    });

    const harness = await $('[data-e2e-trash-harness="true"]');
    await harness.waitForDisplayed({ timeout: 10000 });

    // 1. Restore.
    const restoreBeat = await $('[data-e2e-trash-item="restore-beat"]');
    await restoreBeat.waitForDisplayed({ timeout: 5000 });

    const restoreButton = await $('[data-e2e-restore="restore-beat"]');
    await restoreButton.click();

    await browser.waitUntil(
      async () => !(await restoreBeat.isExisting()),
      {
        timeout: 3000,
        interval: 25,
        timeoutMsg: "Restored beat did not leave Trash.",
      },
    );

    const restoredInLibrary = await $('[data-e2e-library-item="restore-beat"]');
    await restoredInLibrary.waitForDisplayed({ timeout: 3000 });

    assert.equal(await restoredInLibrary.getText(), "E2E Restore Beat");
    assert.equal(await harness.getAttribute("data-e2e-trash-count"), "0");
    assert.equal(await harness.getAttribute("data-e2e-library-count"), "1");

    // 2. Seed a new Trash beat for Empty Trash.
    const seed = await $('[data-e2e-seed-purge="true"]');
    await seed.click();

    const purgeBeat = await $('[data-e2e-trash-item="purge-beat"]');
    await purgeBeat.waitForDisplayed({ timeout: 3000 });

    // 3. Offline blocks permanent emptying.
    const toggleNetwork = await $('[data-e2e-toggle-network="true"]');
    await toggleNetwork.click();

    assert.equal(await harness.getAttribute("data-e2e-online"), "false");

    const emptyTrash = await $('[data-e2e-empty-trash="true"]');
    assert.notEqual(await emptyTrash.getAttribute("disabled"), null);
    assert.equal(
      await emptyTrash.getAttribute("title"),
      "Internet connection required",
    );

    // 4. Online permits Empty Trash.
    await toggleNetwork.click();

    assert.equal(await harness.getAttribute("data-e2e-online"), "true");
    assert.equal(await emptyTrash.getAttribute("disabled"), null);

    await emptyTrash.click();

    await browser.waitUntil(
      async () => (await $('[data-e2e-trash-empty="true"]')).isDisplayed(),
      {
        timeout: 3000,
        interval: 25,
        timeoutMsg: "Trash did not become empty after Empty beat trash.",
      },
    );

    assert.equal(await harness.getAttribute("data-e2e-trash-count"), "0");
    assert.equal(await harness.getAttribute("data-e2e-library-count"), "1");
  });
});
