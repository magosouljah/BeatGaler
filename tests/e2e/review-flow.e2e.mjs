import assert from "node:assert/strict";

async function findInputByValue(value) {
  const inputs = await $$('input');
  for (const input of inputs) {
    if (await input.getValue() === value) return input;
  }
  throw new Error(`Review input with value ${value} not found`);
}

async function findButton(label) {
  const buttons = await $$('button');
  for (const button of buttons) {
    if ((await button.getText()).trim() === label) return button;
  }
  throw new Error(`Review button ${label} not found`);
}

describe("F4 Windows Review functional journey", () => {
  it("edits Review metadata and persists the saved values through the real Drawer review surface", async () => {
    const name = await findInputByValue("Review Beat");
    await name.setValue("Review Beat Final");

    const bpm = await findInputByValue("120");
    await bpm.setValue("128");

    const key = await findInputByValue("Cm");
    await key.setValue("F#m");

    const save = await findButton("Save and finish");
    await save.click();

    const saved = await $('[data-e2e-review-saved="true"]');
    await saved.waitForExist({ timeout: 10000 });
    assert.equal(await $('[data-e2e-review-saved-name]').getText(), "Review Beat Final");
    assert.equal(await $('[data-e2e-review-saved-bpm]').getText(), "128");
    assert.equal(await $('[data-e2e-review-saved-key]').getText(), "F#m");
  });
});
