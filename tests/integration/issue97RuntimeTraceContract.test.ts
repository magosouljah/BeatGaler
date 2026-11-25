import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Issue #97 runtime trace contract", () => {
  it("keeps the definitive startup/playback timeline observable", () => {
    const webSession = source("src/features/auth/webSession.ts");
    const worker = source("src/features/cloud/webTransport.worker.ts");

    expect(webSession).toContain("DIRECT_SIGN_IN_PRECONNECT_BEGIN");
    expect(worker).toContain("DIRECT_MTPROTO_READY");
    expect(worker).toContain("DIRECT_BACKGROUND_GET_ME_OK");
    expect(worker).toContain("DIRECT_BACKGROUND_GET_CHAT_OK");
    expect(worker).toContain("WARM_BATCH_BEGIN");
    expect(worker).toContain("WARM_PREFIX_READY");
    expect(worker).toContain("PLAY_WARM_PREEMPT_ALL");
    expect(worker).toContain("WARM_RESUME");
  });

  it("contains no startup Cloud-route override path", () => {
    const adapter = source("src/platform/webAdapter.ts");

    expect(adapter).not.toContain("cloudRoute");
    expect(adapter).not.toContain("startup_routes");
  });
});
