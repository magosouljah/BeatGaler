import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const p = (...parts) => path.join(root, ...parts);

const files = {
  cargo: p("src-tauri", "Cargo.toml"),
  cargoLock: p("src-tauri", "Cargo.lock"),
  lib: p("src-tauri", "src", "lib.rs"),
  tauriConf: p("src-tauri", "tauri.conf.json"),
  capability: p("src-tauri", "capabilities", "default.json"),
  frontend: p("src", "main.tsx"),
  html: p("index.html"),
};

for (const [name, file] of Object.entries(files)) {
  if (name === "cargoLock") continue;
  if (!fs.existsSync(file)) throw new Error(`[e2e] Required file missing (${name}): ${file}`);
}

const touched = [
  files.cargo,
  files.lib,
  files.tauriConf,
  files.capability,
  files.frontend,
  files.html,
];
if (fs.existsSync(files.cargoLock)) touched.push(files.cargoLock);

const backups = new Map(touched.map(file => [file, fs.readFileSync(file, "utf8")]));

function write(file, text) {
  fs.writeFileSync(file, text, "utf8");
}

function run(command, args, extraEnv = {}) {
  console.log(`\n[e2e] > ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`[e2e] Command failed (${result.status}): ${command} ${args.join(" ")}`);
  }
}

function patchCargo() {
  let text = fs.readFileSync(files.cargo, "utf8");
  if (!/^\s*tauri-plugin-wdio\s*=/m.test(text)) {
    const marker = "[dependencies]";
    const index = text.indexOf(marker);
    if (index < 0) throw new Error("[e2e] [dependencies] not found in Cargo.toml.");
    const insertAt = index + marker.length;
    text = text.slice(0, insertAt) + '\ntauri-plugin-wdio = "1"' + text.slice(insertAt);
  }
  write(files.cargo, text);
}

function patchRust() {
  let text = fs.readFileSync(files.lib, "utf8");
  if (!text.includes("tauri_plugin_wdio::init()")) {
    const marker = "tauri::Builder::default()";
    if (!text.includes(marker)) throw new Error("[e2e] tauri::Builder::default() not found in lib.rs.");
    text = text.replace(marker, `${marker}\n        .plugin(tauri_plugin_wdio::init())`);
  }
  write(files.lib, text);
}

function patchCapability() {
  const json = JSON.parse(fs.readFileSync(files.capability, "utf8"));
  const permissions = Array.isArray(json.permissions) ? json.permissions : [];
  if (!permissions.includes("wdio:default")) permissions.push("wdio:default");
  json.permissions = permissions;
  write(files.capability, JSON.stringify(json, null, 2) + "\n");
}

function patchTauriConf() {
  const json = JSON.parse(fs.readFileSync(files.tauriConf, "utf8"));
  json.app ??= {};
  json.app.withGlobalTauri = true;
  write(files.tauriConf, JSON.stringify(json, null, 2) + "\n");
}

function cleanPermanentE2EImports(text) {
  return text
    .replace(/^\s*import\s+["']@wdio\/tauri-plugin["'];?\s*\r?\n/gm, "")
    .replace(/^\s*import\s+E2EFlowHarness\s+from\s+["'][^"']*E2EFlowHarness["'];?\s*\r?\n/gm, "")
    .replace(/^\s*import\s+E2EPlaybackHarness\s+from\s+["'][^"']*E2EPlaybackHarness["'];?\s*\r?\n/gm, "")
    .replace(/^\s*import\s+E2EOfflineReconnectHarness\s+from\s+["'][^"']*E2EOfflineReconnectHarness["'];?\s*\r?\n/gm, "")
    .replace(/^\s*import\s+E2ETrashHarness\s+from\s+["'][^"']*E2ETrashHarness["'];?\s*\r?\n/gm, "")
    .replace(/^\s*import\s+E2EImportHarness\s+from\s+["'][^"']*E2EImportHarness["'];?\s*\r?\n/gm, "")
    .replace(/^\s*import\s+E2EDownloadsHarness\s+from\s+["'][^"']*E2EDownloadsHarness["'];?\s*\r?\n/gm, "")
    .replace(/^\s*import\s+E2ERecoveryHarness\s+from\s+["'][^"']*E2ERecoveryHarness["'];?\s*\r?\n/gm, "");
}

function patchFrontend() {
  let text = fs.readFileSync(files.frontend, "utf8");

  // Normalize any accidental E2E imports left by an older runner.
  text = cleanPermanentE2EImports(text);

  const editFlowEnabled = process.env.BEATGALER_E2E_FLOW === "1";
  const playbackFlowEnabled = process.env.BEATGALER_E2E_PLAYBACK === "1";
  const offlineFlowEnabled = process.env.BEATGALER_E2E_OFFLINE === "1";
  const trashFlowEnabled = process.env.BEATGALER_E2E_TRASH === "1";
  const importFlowEnabled = process.env.BEATGALER_E2E_IMPORT === "1";
  const downloadsFlowEnabled = process.env.BEATGALER_E2E_DOWNLOADS === "1";
  const recoveryFlowEnabled = process.env.BEATGALER_E2E_RECOVERY === "1";

  const enabledFlowCount = [editFlowEnabled, playbackFlowEnabled, offlineFlowEnabled, trashFlowEnabled, importFlowEnabled, downloadsFlowEnabled, recoveryFlowEnabled]
    .filter(Boolean).length;

  if (enabledFlowCount > 1) {
    throw new Error("[e2e] Enable only one flow harness at a time.");
  }

  const imports = ['import "@wdio/tauri-plugin";'];

  if (editFlowEnabled) {
    imports.push('import E2EFlowHarness from "../tests/e2e-harness/E2EFlowHarness";');
  }
  if (playbackFlowEnabled) {
    imports.push('import E2EPlaybackHarness from "../tests/e2e-harness/E2EPlaybackHarness";');
  }
  if (offlineFlowEnabled) {
    imports.push('import E2EOfflineReconnectHarness from "../tests/e2e-harness/E2EOfflineReconnectHarness";');
  }
  if (trashFlowEnabled) {
    imports.push('import E2ETrashHarness from "../tests/e2e-harness/E2ETrashHarness";');
  }
  if (importFlowEnabled) {
    imports.push('import E2EImportHarness from "../tests/e2e-harness/E2EImportHarness";');
  }
  if (downloadsFlowEnabled) {
    imports.push('import E2EDownloadsHarness from "../tests/e2e-harness/E2EDownloadsHarness";');
  }
  if (recoveryFlowEnabled) {
    imports.push('import E2ERecoveryHarness from "../tests/e2e-harness/E2ERecoveryHarness";');
  }

  text = `${imports.join("\n")}\n${text}`;

  if (editFlowEnabled) {
    const before = text;
    text = text.replace(/<App\s*\/>/g, "<E2EFlowHarness />");
    if (text === before || !text.includes("<E2EFlowHarness />")) {
      throw new Error("[e2e] BEATGALER_E2E_FLOW=1 but <App /> was not replaced in src/main.tsx.");
    }
    console.log("[e2e] EDIT FLOW HARNESS MOUNTED: <App /> -> <E2EFlowHarness />");
  } else if (playbackFlowEnabled) {
    const before = text;
    text = text.replace(/<App\s*\/>/g, "<E2EPlaybackHarness />");
    if (text === before || !text.includes("<E2EPlaybackHarness />")) {
      throw new Error("[e2e] BEATGALER_E2E_PLAYBACK=1 but <App /> was not replaced in src/main.tsx.");
    }
    console.log("[e2e] PLAYBACK HARNESS MOUNTED: <App /> -> <E2EPlaybackHarness />");
  } else if (offlineFlowEnabled) {
    const before = text;
    text = text.replace(/<App\s*\/>/g, "<E2EOfflineReconnectHarness />");
    if (text === before || !text.includes("<E2EOfflineReconnectHarness />")) {
      throw new Error("[e2e] BEATGALER_E2E_OFFLINE=1 but <App /> was not replaced in src/main.tsx.");
    }
    console.log("[e2e] OFFLINE HARNESS MOUNTED: <App /> -> <E2EOfflineReconnectHarness />");
  } else if (trashFlowEnabled) {
    const before = text;
    text = text.replace(/<App\s*\/>/g, "<E2ETrashHarness />");
    if (text === before || !text.includes("<E2ETrashHarness />")) {
      throw new Error("[e2e] BEATGALER_E2E_TRASH=1 but <App /> was not replaced in src/main.tsx.");
    }
    console.log("[e2e] TRASH HARNESS MOUNTED: <App /> -> <E2ETrashHarness />");
  } else if (importFlowEnabled) {
    const before = text;
    text = text.replace(/<App\s*\/>/g, "<E2EImportHarness />");
    if (text === before || !text.includes("<E2EImportHarness />")) {
      throw new Error("[e2e] BEATGALER_E2E_IMPORT=1 but <App /> was not replaced in src/main.tsx.");
    }
    console.log("[e2e] IMPORT HARNESS MOUNTED: <App /> -> <E2EImportHarness />");
  } else if (downloadsFlowEnabled) {
    const before = text;
    text = text.replace(/<App\s*\/>/g, "<E2EDownloadsHarness />");
    if (text === before || !text.includes("<E2EDownloadsHarness />")) {
      throw new Error("[e2e] BEATGALER_E2E_DOWNLOADS=1 but <App /> was not replaced in src/main.tsx.");
    }
    console.log("[e2e] DOWNLOADS HARNESS MOUNTED: <App /> -> <E2EDownloadsHarness />");
  } else if (recoveryFlowEnabled) {
    const before = text;
    text = text.replace(/<App\s*\/>/g, "<E2ERecoveryHarness />");
    if (text === before || !text.includes("<E2ERecoveryHarness />")) {
      throw new Error("[e2e] BEATGALER_E2E_RECOVERY=1 but <App /> was not replaced in src/main.tsx.");
    }
    console.log("[e2e] RECOVERY HARNESS MOUNTED: <App /> -> <E2ERecoveryHarness />");
  } else {
    console.log("[e2e] Normal E2E app mounted (no flow harness).");
  }

  write(files.frontend, text);
}

function patchFlowIndexHtml() {
  if (process.env.BEATGALER_E2E_IMPORT !== "1" && process.env.BEATGALER_E2E_DOWNLOADS !== "1" && process.env.BEATGALER_E2E_RECOVERY !== "1") return;

  let text = fs.readFileSync(files.html, "utf8");
  const before = text;

  // Import E2E mounts a dedicated deterministic harness. The production startup
  // overlay lives outside #root and is irrelevant to this harness, so remove the
  // element from the E2E-only HTML before Vite builds dist/. This is stronger
  // than trying to remove it later from React: it cannot intercept WDIO clicks
  // because it never exists in the E2E document.
  text = text.replace(
    /\s*<div\s+id=["']beatgaler-startup-loader["'][^>]*>[^<]*<\/div>\s*/i,
    "\n",
  );

  if (text === before || text.includes('id="beatgaler-startup-loader"')) {
    throw new Error("[e2e] Flow mode could not remove #beatgaler-startup-loader from index.html.");
  }

  write(files.html, text);
  console.log("[e2e] Flow startup loader removed from E2E-only index.html.");
}

function restoreSources() {
  for (const [file, content] of backups) write(file, content);
}

function sanitizeProductionFrontend() {
  let text = fs.readFileSync(files.frontend, "utf8");
  const cleaned = cleanPermanentE2EImports(text);
  if (cleaned !== text) {
    write(files.frontend, cleaned);
    console.log("[e2e] Removed stale E2E-only imports from production src/main.tsx.");
  }
}

let testExit = 1;

try {
  // Clean stale imports BEFORE taking the effective production state into E2E.
  // backups were already captured, so we also update the backup to the sanitized form.
  sanitizeProductionFrontend();
  backups.set(files.frontend, fs.readFileSync(files.frontend, "utf8"));

  console.log("[e2e] Preparing an isolated WDIO-enabled BeatGaler build.");
  patchCargo();
  patchRust();
  patchCapability();
  patchTauriConf();
  patchFrontend();
  patchFlowIndexHtml();

  run("npm", ["run", "build"], { VITE_E2E: "1" });

  const e2eTarget = p("src-tauri", "target", "e2e");
  run(
    "cargo",
    ["build", "--manifest-path", "src-tauri/Cargo.toml", "--release"],
    { CARGO_TARGET_DIR: e2eTarget },
  );

  const exeName = process.platform === "win32" ? "beat_galer.exe" : "beat_galer";
  const binary = path.join(e2eTarget, "release", exeName);
  if (!fs.existsSync(binary)) throw new Error(`[e2e] E2E binary was not created: ${binary}`);

  restoreSources();

  console.log("\n[e2e] Source files restored. Production source does NOT retain WDIO permissions.");
  console.log(`[e2e] Running desktop tests against: ${binary}`);

  const editFlowEnabled = process.env.BEATGALER_E2E_FLOW === "1";
  const playbackFlowEnabled = process.env.BEATGALER_E2E_PLAYBACK === "1";
  const offlineFlowEnabled = process.env.BEATGALER_E2E_OFFLINE === "1";
  const trashFlowEnabled = process.env.BEATGALER_E2E_TRASH === "1";
  const importFlowEnabled = process.env.BEATGALER_E2E_IMPORT === "1";
  const downloadsFlowEnabled = process.env.BEATGALER_E2E_DOWNLOADS === "1";
  const recoveryFlowEnabled = process.env.BEATGALER_E2E_RECOVERY === "1";

  const wdioArgs = editFlowEnabled
    ? ["wdio", "run", "wdio.e2e.conf.mjs", "--spec", "tests/e2e/edit-metadata-flow.e2e.mjs"]
    : playbackFlowEnabled
      ? ["wdio", "run", "wdio.e2e.conf.mjs", "--spec", "tests/e2e/playback-flow.e2e.mjs"]
      : offlineFlowEnabled
        ? ["wdio", "run", "wdio.e2e.conf.mjs", "--spec", "tests/e2e/offline-reconnect-flow.e2e.mjs"]
        : trashFlowEnabled
          ? ["wdio", "run", "wdio.e2e.conf.mjs", "--spec", "tests/e2e/trash-flow.e2e.mjs"]
          : importFlowEnabled
            ? ["wdio", "run", "wdio.e2e.conf.mjs", "--spec", "tests/e2e/import-flow.e2e.mjs"]
            : downloadsFlowEnabled
              ? ["wdio", "run", "wdio.e2e.conf.mjs", "--spec", "tests/e2e/downloads-project-flow.e2e.mjs"]
              : recoveryFlowEnabled
                ? ["wdio", "run", "wdio.e2e.conf.mjs", "--spec", "tests/e2e/recovery-stress-flow.e2e.mjs"]
                : ["wdio", "run", "wdio.e2e.conf.mjs"];

  console.log(
    editFlowEnabled
      ? "[e2e] EDIT FLOW MODE: running only tests/e2e/edit-metadata-flow.e2e.mjs"
      : playbackFlowEnabled
        ? "[e2e] PLAYBACK FLOW MODE: running only tests/e2e/playback-flow.e2e.mjs"
        : offlineFlowEnabled
          ? "[e2e] OFFLINE FLOW MODE: running only tests/e2e/offline-reconnect-flow.e2e.mjs"
          : trashFlowEnabled
            ? "[e2e] TRASH FLOW MODE: running only tests/e2e/trash-flow.e2e.mjs"
            : importFlowEnabled
              ? "[e2e] IMPORT FLOW MODE: running only tests/e2e/import-flow.e2e.mjs"
              : downloadsFlowEnabled
                ? "[e2e] DOWNLOADS FLOW MODE: running only tests/e2e/downloads-project-flow.e2e.mjs"
                : recoveryFlowEnabled
                  ? "[e2e] RECOVERY FLOW MODE: running only tests/e2e/recovery-stress-flow.e2e.mjs"
                  : "[e2e] NORMAL MODE: running the full desktop E2E suite"
  );

  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    wdioArgs,
    {
      cwd: root,
      env: { ...process.env, BEATGALER_E2E_BINARY: binary },
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  testExit = result.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  testExit = 1;
} finally {
  restoreSources();
  sanitizeProductionFrontend();

  try {
    console.log("\n[e2e] Restoring normal production frontend dist/.");
    run("npm", ["run", "build"]);
  } catch (error) {
    console.error("[e2e] WARNING: normal dist/ rebuild failed after E2E cleanup.");
    console.error(error instanceof Error ? error.message : error);
    testExit = 1;
  }
}

process.exit(testExit);
