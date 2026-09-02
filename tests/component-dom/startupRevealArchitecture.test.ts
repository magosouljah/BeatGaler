// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/App.tsx", "utf8");
const beatCard = readFileSync("src/components/BeatCard.tsx", "utf8");
const nginx = readFileSync("deploy/web/beatgaler.com.conf", "utf8");

describe("Issue #97 startup reveal architecture", () => {
  it("boots the presentation layer from the last verified lightweight manifest", () => {
    expect(app).toContain("useState<Beat[]>(() => startupCachedBeatsRef.current ?? [])");
    expect(app).toContain("if (!cloudSessionVerified || (settings && !settings.telegram_cloud_connected)) return;");
  });

  it("reserves every filtered beat slot while revealing only artwork-ready cards", () => {
    expect(app).toContain("<SortableContext items={filteredBeats.map((b) => b.id)}");
    expect(app).toContain("visible={revealedBeatIds.has(beat.id)}");
    expect(app).toContain('interactive={cloudSessionVerified || connectionState === "offline" || connectionState === "poor"}');
    expect(beatCard).toContain('visibility: visible ? "visible" : "hidden"');
    expect(beatCard).toContain('pointerEvents: visible && interactive ? "auto" : "none"');
    expect(beatCard).toContain("if (!visible || !interactive || !hasEnteredViewport || !beat.telegram_file_id) return;");
  });

  it("does not gate card reveal on audio cooking", () => {
    expect(app).toContain("title + artwork are enough to show a beat");
    expect(app).not.toContain("After the first six are usable, prepare the rest one at a time");
  });

  it("renders Empty Gallery only after online authority is verified", () => {
    expect(app).toContain('cloudSessionVerified && connectionState === "online" ? (');
  });

  it("serves WebAssembly with the streaming MIME type", () => {
    expect(nginx).toContain("default_type application/wasm;");
  });
});
