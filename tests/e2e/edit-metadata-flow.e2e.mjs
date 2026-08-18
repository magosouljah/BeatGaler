import assert from "node:assert/strict";

async function byText(text) {
  return $(`//*[normalize-space(text())="${text}"]`);
}

describe("BeatGaler edit metadata user flow E2E", () => {
  it("edits BPM through the real BeatCard + Drawer and reflects the saved result in the card", async () => {
    // Safety: intercept the real Rust command before the UI interaction.
    // This makes the flow deterministic and prevents mutation of real user data.
    const saveMock = await browser.tauri.mock("save_beat_meta");
    await saveMock.mockReturnValue({
      new_mp3_path: "E:\\BeatGaler-E2E\\E2E Purple Beat\\E2E Purple Beat.mp3",
      new_wav_path: null,
    });

    // Real BeatCard is rendered by the isolated harness.
    const beatName = await byText("E2E Purple Beat");
    await beatName.waitForDisplayed({ timeout: 15000 });

    const artwork = await $('[data-beat-artwork-id="e2e-purple-beat"]');
    await artwork.waitForDisplayed({ timeout: 10000 });

    // Open BeatCard's real context menu.
    await browser.execute((el) => {
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 2,
        buttons: 2,
        clientX: Math.round(rect.left + Math.min(20, rect.width / 2)),
        clientY: Math.round(rect.top + Math.min(20, rect.height / 2)),
      }));
    }, artwork);

    const edit = await byText("Edit metadata");
    await edit.waitForDisplayed({ timeout: 10000 });
    await edit.click();

    // Real Drawer is now open.
    const bpm = await $('input[value="140"]');
    await bpm.waitForDisplayed({ timeout: 10000 });

    // Update React-controlled BPM without triggering Enter/save shortcuts.
    await browser.execute((el) => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(el, "150");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, bpm);

    await browser.waitUntil(
      async () => (await bpm.getValue()) === "150",
      {
        timeout: 5000,
        timeoutMsg: "BPM input did not become 150.",
      },
    );

    const save = await $('//button[normalize-space(.)="Save changes"]');
    await save.waitForDisplayed({ timeout: 10000 });

    assert.equal(
      await save.getAttribute("disabled"),
      null,
      'Expected "Save changes" to be enabled.',
    );

    await save.click();

    // The strongest user-visible proof of the save flow:
    // Drawer must close because handleSave completed, onSaved fired, and the
    // harness updated BeatCard with the returned/committed Beat.
    await browser.waitUntil(
      async () => !(await $('//button[normalize-space(.)="Save changes"]').isExisting()),
      {
        timeout: 10000,
        interval: 100,
        timeoutMsg: "Drawer did not close after Save changes.",
      },
    );

    // BeatCard must now reflect the edited BPM.
    await browser.waitUntil(
      async () => {
        const bodyText = await $("body").getText();
        return bodyText.includes("150 · cm");
      },
      {
        timeout: 10000,
        interval: 100,
        timeoutMsg: 'BeatCard did not reflect the saved BPM as "150 · cm".',
      },
    );

    const bodyText = await $("body").getText();
    assert.match(bodyText, /E2E Purple Beat/);
    assert.match(bodyText, /150\s*·\s*cm/);
  });
});
