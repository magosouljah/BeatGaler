import assert from "node:assert/strict";

async function bodyText() {
  const body = await $("body");
  await body.waitForDisplayed({ timeout: 15000 });
  return (await body.getText()).trim();
}

describe("BeatGaler Desktop smoke E2E", () => {
  it("launches the real release executable with the correct product title", async () => {
    await browser.waitUntil(
      async () => {
        const title = await browser.getTitle();
        return title.trim().length > 0;
      },
      {
        timeout: 15000,
        interval: 200,
        timeoutMsg: "BeatGaler opened but never exposed a window title.",
      },
    );

    assert.equal(await browser.getTitle(), "Beat Galer");
  });

  it("renders a non-empty application surface instead of a blank/crashed WebView", async () => {
    const text = await bodyText();

    assert.ok(
      text.length > 0,
      "BeatGaler body is blank after startup.",
    );

    const root = await $("#root");
    assert.equal(await root.isExisting(), true, "React root #root is missing.");
    assert.equal(await root.isDisplayed(), true, "React root #root is not displayed.");
  });

  it("renders at least one user-interactive control", async () => {
    await bodyText();

    await browser.waitUntil(
      async () => {
        const controls = await $$("button, input, [role='button'], a");
        for (const control of controls) {
          if (await control.isDisplayed()) return true;
        }
        return false;
      },
      {
        timeout: 15000,
        interval: 250,
        timeoutMsg: "No visible interactive control appeared in BeatGaler.",
      },
    );
  });

  it("does not expose the hidden cloud transport implementation in visible UI", async () => {
    const text = await bodyText();

    assert.doesNotMatch(
      text,
      /\btelegram\b/i,
      "Internal cloud transport implementation leaked into user-visible UI.",
    );
  });

  it("does not show generic fatal frontend crash signatures on startup", async () => {
    const text = await bodyText();

    assert.doesNotMatch(text, /\buncaught\b/i);
    assert.doesNotMatch(text, /\binternal server error\b/i);
    assert.doesNotMatch(text, /\bfailed to fetch dynamically imported module\b/i);
  });
});
