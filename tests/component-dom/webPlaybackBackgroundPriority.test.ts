import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const audio = readFileSync("src/hooks/useAudio.ts", "utf8");

describe("Audio transport events", () => {
  it("keeps the main UI bundle pointed at the tiny event module rather than WorkerClient", () => {
    expect(audio).toContain('from "../features/cloud/webTransportEvents"');
    expect(audio).not.toContain('from "../features/cloud/webTransportWorkerClient"');
  });
});
