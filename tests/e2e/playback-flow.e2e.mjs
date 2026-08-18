import assert from "node:assert/strict";

async function state() {
  return $('[data-e2e-playback-state]').getAttribute("data-e2e-playback-state");
}

async function transportButton(title) {
  const button = await $(`button[title="${title}"]`);
  await button.waitForDisplayed({ timeout: 10000 });
  return button;
}

describe("BeatGaler playback user flow E2E", () => {
  it("transitions idle -> preparing -> playing -> paused -> playing through the real Player", async () => {
    const beatName = await $('//*[normalize-space(text())="E2E Playback Beat"]');
    await beatName.waitForDisplayed({ timeout: 15000 });

    assert.equal(await state(), "idle");

    const play = await transportButton("Play");
    await play.click();

    await browser.waitUntil(
      async () => (await state()) === "preparing",
      {
        timeout: 3000,
        interval: 25,
        timeoutMsg: "Playback never entered preparing state after Play.",
      },
    );

    await browser.waitUntil(
      async () => (await state()) === "playing",
      {
        timeout: 5000,
        interval: 25,
        timeoutMsg: "Playback never reached playing state.",
      },
    );

    const pause = await transportButton("Pause");
    await pause.click();

    await browser.waitUntil(
      async () => (await state()) === "paused",
      {
        timeout: 3000,
        interval: 25,
        timeoutMsg: "Playback never entered paused state.",
      },
    );

    const playAgain = await transportButton("Play");
    await playAgain.click();

    await browser.waitUntil(
      async () => (await state()) === "playing",
      {
        timeout: 3000,
        interval: 25,
        timeoutMsg: "Playback did not resume from paused state.",
      },
    );

    assert.equal(await state(), "playing");
  });
});
