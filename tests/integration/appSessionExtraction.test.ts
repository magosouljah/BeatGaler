import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const app = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
const state = fs.readFileSync(path.join(root, "src/features/session/useSessionState.ts"), "utf8");
const actions = fs.readFileSync(path.join(root, "src/features/session/useSessionActions.ts"), "utf8");
const cursor = fs.readFileSync(path.join(root, "src/features/session/useCustomCursor.ts"), "utf8");

describe("task 9.1 session/settings extraction", () => {
  it("moves session state ownership out of App without collapsing connectivity into verification", () => {
    expect(app).toContain("} = useSessionState();");
    expect(app).not.toContain("useState<AppSettings | null>");
    expect(app).not.toContain('type ConnectionState = "checking"');
    expect(state).toContain("const [connectionState, setConnectionState]");
    expect(state).toContain("const [cloudSessionVerified, setCloudSessionVerified] = useState(false)");
    expect(state).toContain("const [setupDone, setSetupDone] = useState(false)");
    expect(state).not.toContain("cloudSessionVerified = connectionState");
  });

  it("moves preferences, cursor and disconnect cleanup to session owners", () => {
    expect(app).toContain("useCustomCursor(settings?.custom_cursor_enabled ?? true);");
    expect(app).toContain("} = useSessionActions({");
    expect(app).toContain("onIncompleteWarningsChanged={handleIncompleteWarningsChanged}");
    expect(app).toContain("onCustomCursorChanged={handleCustomCursorChanged}");
    expect(app).toContain("onFolderChanged={handleFolderChanged}");
    expect(app).toContain("onDisconnectTelegram={handleDisconnectTelegramAccount}");
    expect(cursor).toContain('CUSTOM_CURSOR_STYLE_ID = "beatgaler-custom-cursor-style"');
    expect(cursor).toContain("beatgaler-custom-cursor.cur");
    expect(actions).toContain("await logoutAccount().catch(() => {});");
    expect(actions).toContain("releaseFile();");
    expect(actions).toContain("progressiveRevealRunRef.current += 1;");
    expect(actions).toContain("clearPlaybackPreparation();");
    expect(actions).toContain("clearArtworkHydration();");
    expect(actions).toContain("setRevealedBeatIds(new Set());");
    expect(actions).toContain("setCloudSessionVerified(false);");
    expect(actions).toContain("setBeats([]);");
    expect(actions).toContain("clearSelection();");
  });

  it("does not pull forward startup, reconnect or SSE from their later roadmap tasks", () => {
    expect(app).toContain("pollTelegramCloudStatus");
    expect(app).toContain('window.addEventListener("offline", onOffline)');
    expect(app).toContain("new EventSource(url)");
    expect(app).toContain("libraryStateManager.reloadAuthoritative()");
    expect(state).not.toContain("pollTelegramCloudStatus");
    expect(actions).not.toContain("EventSource");
  });
});
