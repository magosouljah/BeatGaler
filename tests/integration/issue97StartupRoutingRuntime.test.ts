import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const routing = require(resolve(process.cwd(), "cloud-server/startup-routing-index.js")) as {
  normalizeStartupBeatIds(values: unknown): string[];
  normalizeRoutingChanges(values: unknown): Record<string, number | null>;
  routingSnapshotFromManifest(manifest: unknown): Record<string, number>;
};

describe("Issue #97 startup routing runtime", () => {
  it("deduplicates and caps startup routing lookups at 14 beat ids", () => {
    const input = ["A", "A", ...Array.from({ length: 20 }, (_, index) => `beat-${index}`)];
    const result = routing.normalizeStartupBeatIds(input);

    expect(result).toHaveLength(14);
    expect(result[0]).toBe("A");
    expect(new Set(result).size).toBe(result.length);
  });

  it("extracts only MASTER message ids from the authoritative Telegram manifest", () => {
    const snapshot = routing.routingSnapshotFromManifest({
      schema: "beatgaler.telegram.library",
      version: 2,
      beats: [
        {
          id: "beat-A",
          master: {
            telegram_message_id: 1825,
            manifest: {
              parts: [{ telegram_message_id: 1825, telegram_file_id: "direct:1825" }],
            },
          },
          artwork: { telegram_message_id: 9001 },
        },
        {
          id: "beat-B",
          master: { telegram_file_id: "direct:2762" },
        },
      ],
    });

    expect(snapshot).toEqual({ "beat-A": 1825, "beat-B": 2762 });
  });

  it("accepts routing deltas with explicit null deletion and rejects invalid message ids", () => {
    expect(routing.normalizeRoutingChanges({
      "beat-A": 3000,
      "beat-B": null,
      "beat-C": 0,
      "": 123,
    })).toEqual({ "beat-A": 3000, "beat-B": null });
  });
});
