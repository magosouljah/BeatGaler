import { expect, it, vi } from "vitest";

vi.mock("../../src/features/cloud/webTransportWorkerClient", () => {
  throw new Error("Loading useAudio must not load the transport Worker client");
});

it("loads useAudio without loading the transport Worker client", async () => {
  const { useAudio } = await import("../../src/hooks/useAudio");
  expect(useAudio).toBeTypeOf("function");
});
