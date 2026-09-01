import fs from "node:fs";

function fail(message) {
  console.error(`FAIL regression-web-startup-bridge: ${message}`);
  process.exit(1);
}

function expect(source, needle, message) {
  if (!source.includes(needle)) fail(message);
}

const tauri = fs.readFileSync("src/lib/tauri.ts", "utf8");
const app = fs.readFileSync("src/App.tsx", "utf8");
const library = fs.readFileSync("src/lib/libraryStateManager.ts", "utf8");
const boundary = fs.readFileSync("cloud-server/productive-temp-auth-boundary.js", "utf8");

expect(tauri, 'import { getWebClientId } from "../platform/webClientId";', "legacy bridge no longer uses the stable Web installation id");
expect(tauri, "beatgaler_user_id: getWebClientId()", "Web settings fallback no longer exposes the stable installation id");
expect(tauri, "telegram_cloud_connected: true", "Web settings fallback regressed to disconnected");
expect(tauri, 'return { connected: true, reachable, username: null };', "browser Cloud status fallback no longer reports connectivity from navigator");
expect(tauri, 'export async function flushOfflineTrashIntents(): Promise<number> {\n  await initTauri();\n  if (!invoke) return 0;', "browser startup can throw through the Desktop offline-trash bridge");

expect(app, 'useEffect(() => {\n    if (!isTauriAvailable) return;\n\n    let unlisten: (() => void) | undefined;\n    let disposed = false;\n\n    void listen<BackgroundDownloadEvent>("beatgaler-download-event"', "Web still reaches the native background-download listener");

expect(library, 'import { platform } from "../platform";', "authoritative library manager no longer uses the platform adapter");
expect(library, "await platform.library.restoreAuthoritative();", "authoritative restore no longer delegates to the platform library");
expect(library, "const restored = await platform.library.load();", "authoritative load no longer delegates to the platform library");

expect(boundary, "if (session.ok !== true) return safe;", "failed control-plane responses can still be mistaken for productive sessions");

console.log("PASS regression-web-startup-bridge");
