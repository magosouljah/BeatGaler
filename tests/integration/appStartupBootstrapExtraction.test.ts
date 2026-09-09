import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/app/useBeatGalerComposition.ts", "utf8").replaceAll("../", "./");
const startup = readFileSync("src/features/startup/useStartupBootstrap.ts", "utf8");
const connectivity = readFileSync("src/features/session/useConnectivity.ts", "utf8");
const cloudEvents = readFileSync("src/features/cloud/useCloudLibraryEvents.ts", "utf8");
const main = readFileSync("src/main.tsx", "utf8");

function expectOrdered(source: string, markers: string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    expect(index, `Missing startup marker: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("task 9.3 startup bootstrap extraction", () => {
  it("keeps bootstrap, reconnect and SSE as distinct owners after task 9.4", () => {
    expect(app).toContain('import { useStartupBootstrap } from "./features/startup/useStartupBootstrap";');
    expect(app).toContain("useStartupBootstrap({");
    expect(app).toContain("useConnectivity({");
    expect(app).toContain("useCloudLibraryEvents({");
    expect(app).not.toContain("const showOfflineLibrary = async");
    expect(app).not.toContain("const reconnect = async () => {");
    expect(app).not.toContain("const connectEvents = async () => {");
    expect(startup).toContain("const showOfflineLibrary = async");
    expect(startup).toContain("Telegram vault startup check failed:");
    expect(connectivity).toContain("const reconnect = async () => {");
    expect(cloudEvents).toContain("const connectEvents = async () => {");
  });

  it("preserves startup ordering and authority distinctions", () => {
    expectOrdered(startup, [
      "const local = await getSettings()",
      "status = await pollTelegramCloudStatus()",
      "readActiveCloudUploads().length > 0",
      "rollbackInterruptedCloudUploads({",
      "const flushedTrashCount = await flushOfflineTrashIntents()",
      "restored = await libraryStateManager.reloadAuthoritative()",
      "const repaired = await repairStaleCloudLibraryRefs()",
      "setBeats(current => preserveLoadedArtwork(",
      "setCloudSessionVerified(true)",
    ]);
    expect(startup).toContain("Authority is temporarily unknown, not empty.");
    expect(startup).toContain("if (!status.connected) {");
    expect(startup).toContain("setBeats([]);");
    expect(startup).toContain('setConnectionState("poor")');
  });

  it("keeps main.tsx initializers and root composition in place", () => {
    expect(main).toContain("installStartupTrace();");
    expect(main).toContain("installWebCsrfFetchCoordinator();");
    expect(main).toContain("preconnectRememberedWebDirect();");
    expect(main).toContain("<AuthExperienceGate>");
    expect(main).toContain("<LibraryUxBridge />");
    expect(main).toContain("<WebLibraryPagination />");
    expect(main).toContain("<App />");
  });
});
