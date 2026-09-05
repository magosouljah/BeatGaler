import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const coordinator = readFileSync("src/features/playback/webStartupPlaybackCoordinator.ts", "utf8");

describe("Web startup coordinator final wiring", () => {
  it("forwards per-candidate terminal notifications instead of waiting for batch completion", () => {
    expect(coordinator).toContain(
      "prefetchFiles: (inputs, onChunk, onTerminal) => this.transport.prefetchFiles(inputs, onChunk, onTerminal)",
    );
  });

  it("repairs persisted startup14 when the presentation sort changed before the next OPEN", () => {
    expect(coordinator).toContain("if (routing.sortBy !== sort && routing.authoritative");
    expect(coordinator).toContain("updatePlaybackRoutingSort(sort)");
  });
});
