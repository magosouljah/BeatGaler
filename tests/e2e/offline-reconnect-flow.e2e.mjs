import assert from "node:assert/strict";

async function rootAttr(name) {
  return $('[data-e2e-connection-state]').getAttribute(name);
}

async function rightClickBeat() {
  const beatName = await $('//*[normalize-space(text())="E2E Offline Beat"]');
  await beatName.waitForDisplayed({ timeout: 15000 });
  await beatName.click({ button: "right" });
}

async function menuItem(text) {
  const item = await $(`//*[normalize-space(text())="${text}"]`);
  await item.waitForDisplayed({ timeout: 5000 });
  return item;
}

describe("BeatGaler offline / reconnect user flow E2E", () => {
  it("keeps Available Offline visible, blocks edits, queues Trash, then reconciles on reconnect", async () => {
    assert.equal(await rootAttr("data-e2e-connection-state"), "online");

    const offlineBadge = await $('[aria-label="Available offline"]');
    await offlineBadge.waitForDisplayed({ timeout: 10000 });

    await rightClickBeat();
    const onlineOfflineAction = await menuItem("Remove offline download");
    assert.equal(await onlineOfflineAction.isDisplayed(), true);

    await browser.keys("Escape");

    await browser.execute(() => {
      window.dispatchEvent(new Event("offline"));
    });

    await browser.waitUntil(
      async () => (await rootAttr("data-e2e-connection-state")) === "offline",
      { timeout: 3000, interval: 25, timeoutMsg: "App never entered offline state." },
    );

    const banner = await $('[data-e2e-offline-banner="true"]');
    await banner.waitForDisplayed({ timeout: 3000 });
    assert.match(await banner.getText(), /You're offline\./);

    // The durable Offline badge remains visible when the network is gone.
    assert.equal(await offlineBadge.isDisplayed(), true);

    await rightClickBeat();
    const edit = await menuItem("Edit metadata");
    await edit.click();

    const blocked = await $('[data-e2e-blocked-action="true"]');
    await blocked.waitForDisplayed({ timeout: 3000 });
    assert.match(await blocked.getText(), /Offline mode is read-only except for moving beats to Trash/);

    await rightClickBeat();
    const remove = await menuItem("Remove from library");
    await remove.click();

    const removed = await $('[data-e2e-beat-removed="true"]');
    await removed.waitForDisplayed({ timeout: 3000 });
    assert.equal(await rootAttr("data-e2e-trash-intents"), "1");

    await browser.execute(() => {
      window.dispatchEvent(new Event("online"));
    });

    await browser.waitUntil(
      async () =>
        (await rootAttr("data-e2e-connection-state")) === "online" &&
        (await rootAttr("data-e2e-flush-count")) === "1" &&
        (await rootAttr("data-e2e-reload-count")) === "1",
      {
        timeout: 5000,
        interval: 25,
        timeoutMsg: "Reconnect did not complete flush + reload + online.",
      },
    );

    assert.equal(await rootAttr("data-e2e-reconnect-order"), "poll>flush>reload");
  });
});
