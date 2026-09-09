import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const appShell = readFileSync(resolve(process.cwd(), "src/app/AppShell.tsx"), "utf8");
const reload = readFileSync(
  resolve(process.cwd(), "src/features/library/useLibraryReload.ts"),
  "utf8"
);
const queue = readFileSync(
  resolve(process.cwd(), "src/features/cloud/useCloudUploadQueue.ts"),
  "utf8"
);

function expectOrdered(source: string, markers: string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    expect(index, `Missing Reload contract marker: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("task 9.2 library Reload extraction", () => {
  it("moves manual Reload, retries and deferred-event reception out of App", () => {
    expect(app).toContain('import { useLibraryReload } from "./features/library/useLibraryReload";');
    expect(app).toContain("const { libraryRefreshing, reloadLibrary } = useLibraryReload({");
    expect(app).not.toContain("const reloadLibrary = useCallback(async () => {");
    expect(app).not.toContain(
      'window.addEventListener("beatgaler:deferred-library-reload", runDeferredReload)'
    );

    expect(reload).toContain("const reloadLibrary = useCallback(async () => {");
    expect(reload).toContain("for (let attempt = 1; attempt <= 4; attempt += 1)");
    expect(reload).toContain("window.setTimeout(resolve, 450 * attempt)");
    expect(reload).toContain(
      'window.addEventListener(\n      "beatgaler:deferred-library-reload",'
    );
  });

  it("keeps upload deferral before cache clearing and authoritative reload", () => {
    expectOrdered(reload, [
      "if (deferLibraryReloadIfUploading()) return",
      "clearCachedBeats();",
      "const restored = await libraryStateManager.reloadAuthoritative()",
    ]);
    expect(queue).toContain("deferLibraryReloadIfUploading");
    expect(queue).toContain(
      'window.dispatchEvent(new Event("beatgaler:deferred-library-reload"))'
    );
  });

  it("preserves authority-failure gallery semantics instead of treating unknown as empty", () => {
    expect(reload).toContain(
      "Telegram library refresh failed after retries; preserving verified gallery:"
    );
    expectOrdered(reload, [
      "let lastError: unknown = null",
      "const restored = await libraryStateManager.reloadAuthoritative()",
      'setConnectionState("poor")',
      "setCloudSessionVerified(false)",
    ]);
    const failureStart = reload.indexOf(
      "Telegram library refresh failed after retries; preserving verified gallery:"
    );
    const failureEnd = reload.indexOf("const offline = await loadOfflineLibrary()", failureStart);
    const failureBlock = reload.slice(failureStart, failureEnd);
    expect(failureBlock).not.toContain("setBeats(");
  });

  it("keeps the existing refresh feedback and manual button behavior", () => {
    expect(reload).toContain("const [libraryRefreshing, setLibraryRefreshing] = useState(false)");
    expect(reload).toContain("if (elapsed < 320)");
    expect(appShell).toContain("disabled={loading || libraryRefreshing}");
    expect(appShell).toContain('animation: libraryRefreshing ? "beatgaler-refresh-spin .62s linear infinite" : "none"');
    expect(appShell).toContain("clearUploadPreviewCache(); void reloadLibrary();");
    expect(appShell).toContain(
      'title={deferredLibraryReloadRef.current ? "Reload queued until uploads finish" : "Reload Library"}'
    );
  });
});
