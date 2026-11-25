// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/App.tsx", "utf8");
const beatGalerApp = readFileSync("src/app/BeatGalerApp.tsx", "utf8");
const composition = readFileSync("src/app/useBeatGalerComposition.ts", "utf8");
const appShell = readFileSync("src/app/AppShell.tsx", "utf8");
const libraryRevealOwner = readFileSync("src/features/startup/useLibraryReveal.ts", "utf8");
const libraryStateOwner = readFileSync("src/features/library/useLibraryState.ts", "utf8");
const libraryReloadOwner = readFileSync("src/features/library/useLibraryReload.ts", "utf8");
const viteConfig = readFileSync("vite.config.ts", "utf8");
const webSession = readFileSync("src/features/auth/webSession.ts", "utf8");
const nginx = readFileSync("deploy/web/beatgaler.com.conf", "utf8");

describe("Issue #97 startup reveal architecture", () => {
  it("boots the presentation layer from the last verified lightweight manifest", () => {
    expect(composition).toContain("} = useLibraryState();");
    expect(libraryStateOwner).toContain("useState<Beat[]>(() => startupCachedBeatsRef.current ?? [])");
    expect(composition).toContain("useLibraryPresentationCache(");
    expect(libraryStateOwner).toContain("if (!cloudSessionVerified || (settings && !settings.telegram_cloud_connected)) return;");
    expect(libraryStateOwner).toContain("[beats, settings?.telegram_cloud_connected, cloudSessionVerified]");
  });

  it("wires the legacy shell's filtered slots to reveal and interaction eligibility", () => {
    expect(appShell).toContain("<SortableContext items={filteredBeats.map(");
    expect(appShell).toContain("visible={revealedBeatIds.has(beat.id)}");
    expect(appShell).toContain('interactive={cloudSessionVerified || connectionState === "offline" || connectionState === "poor"}');
    expect(appShell).toContain('playbackInteractive={connectionState !== "offline" || Boolean(beat.offline_available)}');
  });

  it("does not gate card reveal on audio cooking", () => {
    expect(libraryRevealOwner).toContain("Authority pass: title + artwork reveal a card. Audio remains a later viewport warmup.");
    expect(composition).not.toContain("After the first six are usable, prepare the rest one at a time");
  });

  it("renders Empty Gallery only after online authority is verified", () => {
    expect(appShell).toContain('cloudSessionVerified && connectionState === "online" ? (');
  });

  it("keeps Web auth to one gate while preserving Desktop AccountGate", () => {
    expect(beatGalerApp).toContain('return platform.kind === "web"');
    expect(beatGalerApp).toContain('? <BeatGalerWorkspace />');
    expect(beatGalerApp).toContain(': <AccountGate><BeatGalerWorkspace /></AccountGate>');
  });

  it("keeps online reveal monotonic across transport refreshes", () => {
    expect(libraryReloadOwner).toContain("for (const beat of visible) next.add(beat.id)");
  });

  it("keeps productive Web auth on the same-origin proxy and clears remembered legacy endpoints", () => {
    expect(webSession).toContain('if (!sameOriginProxy) throw new Error("Could not resolve BeatGaler Cloud API.");');
    expect(webSession).toContain('if (remembered && remembered !== sameOriginProxy) localStorage.removeItem(API_KEY);');
    expect(webSession).toContain('if (platform.kind === "web") return sameOriginProxyApi() || "";');
    expect(viteConfig).not.toContain('code.replace(unsafeCloudResolver');
  });

  it("serves WebAssembly with the streaming MIME type", () => {
    expect(nginx).toContain("types { application/wasm wasm; }");
    expect(nginx).toContain("default_type application/wasm;");
  });
});
