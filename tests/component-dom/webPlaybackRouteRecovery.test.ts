import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const adapter = readFileSync("src/platform/webAdapter.ts", "utf8");

describe("Web playback stale-route recovery", () => {
  it("registers foreground warm before prepare so a cold stale route fails before URL publication", () => {
    expect(adapter).toContain('const warm = sources.prefetch(beat.id, targetMessageId, mimeType, "visible")');
    expect(adapter).toContain("return sources.prepare(beat.id, targetMessageId, mimeType, intent.id)");
  });

  it("reconciles one suspect route and retries only a changed Telegram message id", () => {
    expect(adapter).toContain('playTrace("PLAY_ROUTE_SUSPECT"');
    expect(adapter).toContain('const page = await windowConsumer.refresh()');
    expect(adapter).toContain("if (repairedMessageId && repairedMessageId !== messageId)");
    expect(adapter).toContain('playTrace("ADAPTER_PREPARE_ROUTE_RETRY_READY"');
    expect(adapter).not.toContain("return webAdapter.media.preparePlayback(beat)");
  });

  it("checks the monotonic Play intent again after reconcile before retrying X", () => {
    const reconcile = adapter.indexOf("await recoverPlaybackRoute(beat.id, messageId)");
    const currentIntentCheck = adapter.indexOf("if (!isCurrentWebPlaybackIntent(intent))", reconcile);
    const retry = adapter.indexOf("await prepareOnce(repairedMessageId)", currentIntentCheck);
    expect(reconcile).toBeGreaterThan(-1);
    expect(currentIntentCheck).toBeGreaterThan(reconcile);
    expect(retry).toBeGreaterThan(currentIntentCheck);
  });
});
