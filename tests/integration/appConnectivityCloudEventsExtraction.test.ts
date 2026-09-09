import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/App.tsx", "utf8");
const connectivity = readFileSync("src/features/session/useConnectivity.ts", "utf8");
const events = readFileSync("src/features/cloud/useCloudLibraryEvents.ts", "utf8");

function count(source: string, marker: string): number {
  return source.split(marker).length - 1;
}

function expectOrdered(source: string, markers: string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    expect(index, `Missing task 9.4 marker: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("task 9.4 reconnect/cloud events extraction", () => {
  it("moves online/offline and SSE listener ownership out of App", () => {
    expect(app).toContain('import { useConnectivity } from "./features/session/useConnectivity";');
    expect(app).toContain('import { useCloudLibraryEvents } from "./features/cloud/useCloudLibraryEvents";');
    expect(app).toContain("useConnectivity({");
    expect(app).toContain("useCloudLibraryEvents({");
    expect(app).not.toContain('window.addEventListener("offline", onOffline)');
    expect(app).not.toContain('window.addEventListener("online", onOnline)');
    expect(app).not.toContain("new EventSource(url)");
    expect(app).not.toContain("const connectEvents = async () => {");
    expect(count(connectivity, 'window.addEventListener("offline", onOffline)')).toBe(1);
    expect(count(connectivity, 'window.addEventListener("online", onOnline)')).toBe(1);
    expect(count(events, "new EventSource(url)")).toBe(1);
  });

  it("preserves reconnect backoff, verification, offline Trash reconciliation and cleanup", () => {
    expect(connectivity).toContain("const delays = [0, 1000, 2000, 5000, 10000, 30000, 60000]");
    expectOrdered(connectivity, [
      "const status = await pollTelegramCloudStatus()",
      "if (!status.reachable)",
      "if (!status.connected)",
      'setConnectionState("online")',
      "await restoreOnlineLibrary(status.username)",
    ]);
    expectOrdered(connectivity, [
      "const flushedTrashCount = await flushOfflineTrashIntents()",
      "if (flushedTrashCount > 0) clearReconciledTrashRuntimeStates()",
      "const restored = await libraryStateManager.reloadAuthoritative()",
      "setCloudSessionVerified(true)",
    ]);
    expect(connectivity).toContain("networkReconnectRunRef.current += 1");
    expect(connectivity).toContain('setConnectionState("offline")');
    expect(connectivity).toContain("setCloudSessionVerified(false)");
    expect(connectivity).toContain('window.removeEventListener("offline", onOffline)');
    expect(connectivity).toContain('window.removeEventListener("online", onOnline)');
  });

  it("keeps SSE as a verified notification channel with fresh tickets and no commit path", () => {
    expectOrdered(events, [
      "const response = await fetch(`${cloudBase}/events/ticket`",
      "const body = await response.json()",
      "events = new EventSource(url)",
      'events.addEventListener("ready", onReady)',
      'events.addEventListener("library_changed", onLibraryChanged)',
      'events.addEventListener("telegram_connected", onTelegramConnected)',
    ]);
    expect(events).toContain("events?.close();");
    expect(events).toContain("eventReconnectDelayMs = Math.min(eventReconnectDelayMs * 2, 30000)");
    expect(events).toContain("events.onopen = () => { eventReconnectDelayMs = 1000; };");
    expectOrdered(events, [
      "const flushedTrashCount = await flushOfflineTrashIntents()",
      "const merged = await libraryStateManager.reloadAuthoritative()",
      "const nextFingerprint = libraryViewFingerprint(merged)",
      "setBeats(current => preserveLoadedArtwork(merged, current))",
    ]);
    expect(events).toContain("if (cancelled || cloudPullInFlightRef.current) return");
    expect(events).not.toContain("commitSnapshot(");
    expect(events).not.toContain("syncBeatMetadataToTelegram");
    expect(events).not.toContain("uploadBeatToTelegram");
    expect(count(events, 'events?.removeEventListener("ready", onReady)')).toBe(1);
    expect(count(events, 'events?.removeEventListener("library_changed", onLibraryChanged)')).toBe(1);
    expect(count(events, 'events?.removeEventListener("telegram_connected", onTelegramConnected)')).toBe(1);
  });
});
