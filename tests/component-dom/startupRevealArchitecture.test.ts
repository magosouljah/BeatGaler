// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/App.tsx", "utf8");
const beatCard = readFileSync("src/components/BeatCard.tsx", "utf8");
const webAdapter = readFileSync("src/platform/webAdapter.ts", "utf8");
const viteConfig = readFileSync("vite.config.ts", "utf8");
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
    expect(app).toContain('playbackInteractive={connectionState === "online" || Boolean(beat.offline_available)}');
    expect(beatCard).toContain('visibility: visible ? "visible" : "hidden"');
    expect(beatCard).toContain('pointerEvents: visible ? "auto" : "none"');
    expect(beatCard).toContain("if (!visible || !playbackInteractive || !hasEnteredViewport || !beat.telegram_file_id) return;");
  });

  it("does not gate card reveal on audio cooking", () => {
    expect(app).toContain("title + artwork are enough to show a beat");
    expect(app).not.toContain("After the first six are usable, prepare the rest one at a time");
  });

  it("renders Empty Gallery only after online authority is verified", () => {
    expect(app).toContain('cloudSessionVerified && connectionState === "online" ? (');
  });

  it("keeps Web auth to one gate while preserving Desktop AccountGate", () => {
    expect(app).toContain('return platform.kind === "web"');
    expect(app).toContain('? <BeatGalerApp />');
    expect(app).toContain(': <AccountGate><BeatGalerApp /></AccountGate>');
  });

  it("keeps online reveal monotonic across transport refreshes", () => {
    expect(app).toContain("for (const beat of visible) next.add(beat.id)");
  });

  it("refreshes cloud-backed playback even when cached metadata contains a stale blob URL", () => {
    const messageLookup = webAdapter.indexOf("const messageId = beat.telegram_message_id");
    const cloudPrepare = webAdapter.indexOf("if (messageId) {");
    const localBlobFallback = webAdapter.indexOf('if (beat.playback_path.startsWith("blob:"))');
    expect(messageLookup).toBeGreaterThan(-1);
    expect(cloudPrepare).toBeGreaterThan(messageLookup);
    expect(localBlobFallback).toBeGreaterThan(cloudPrepare);
    expect(webAdapter).toContain("return sources.prepare(beat.id, messageId, master?.mime_type || \"audio/mpeg\")");
  });

  it("keeps productive Web auth on the same-origin proxy and clears remembered legacy endpoints", () => {
    expect(viteConfig).toContain('if (platform.kind === "web") {\\n    if (remembered && remembered !== sameOriginProxy) localStorage.removeItem(API_KEY);');
    expect(viteConfig).toContain('if (platform.kind === "web") return sameOriginProxyApi() || "";');
    expect(viteConfig).not.toContain('if (trustedRememberedApi(remembered) && await probe(remembered, 1200)) return remembered;\\n  const sameOriginProxy = sameOriginProxyApi();');
  });

  it("serves WebAssembly with the streaming MIME type", () => {
    expect(nginx).toContain("types { application/wasm wasm; }");
    expect(nginx).toContain("default_type application/wasm;");
  });
});
