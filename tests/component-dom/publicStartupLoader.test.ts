// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("public startup overlay", () => {
  it("dismisses when the Landing renders without waiting for an account or library", async () => {
    document.body.innerHTML = '<div id="beatgaler-startup-loader">Loading</div><div id="root"></div>';
    const html = readFileSync("index.html", "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
    new Function(script)();
    expect(document.getElementById("beatgaler-startup-loader")).not.toBeNull();
    document.getElementById("root")!.innerHTML = '<main data-public-page-ready="true">BeatGaler</main>';
    await Promise.resolve();
    expect(document.getElementById("beatgaler-startup-loader")).toBeNull();
  });
});
