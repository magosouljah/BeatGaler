import fs from "node:fs";

const configPath = "wdio.e2e.conf.mjs";
const runnerPath = "scripts/run-desktop-e2e-isolated.mjs";

function replaceOnce(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`[f4-25.1] ${label} marker missing`);
  return text.replace(from, to);
}

let config = fs.readFileSync(configPath, "utf8");
config = replaceOnce(
  config,
  'driverProvider: "official",',
  'driverProvider: process.env.TAURI_WEBDRIVER_PORT ? "embedded" : "official",\n        embeddedPort: Number(process.env.WDIO_EMBEDDED_PORT || 4445),',
  "driver provider",
);
config = replaceOnce(config, "autoInstallTauriDriver: true,", "autoInstallTauriDriver: false,", "tauri-driver auto-install");
config = replaceOnce(config, "autoDownloadEdgeDriver: true,", "autoDownloadEdgeDriver: false,", "EdgeDriver auto-download");
fs.writeFileSync(configPath, config, "utf8");

let runner = fs.readFileSync(runnerPath, "utf8");

runner = replaceOnce(
  runner,
  '    text = text.slice(0, insertAt) + \'\\ntauri-plugin-wdio = "1"\' + text.slice(insertAt);\n  }',
  '    text = text.slice(0, insertAt) + \'\\ntauri-plugin-wdio = "1"\' + text.slice(insertAt);\n  }\n  if (!/^\\s*tauri-plugin-wdio-webdriver\\s*=/m.test(text)) {\n    const marker = "[dependencies]";\n    const index = text.indexOf(marker);\n    if (index < 0) throw new Error("[e2e] [dependencies] not found in Cargo.toml.");\n    const insertAt = index + marker.length;\n    text = text.slice(0, insertAt) + \'\\ntauri-plugin-wdio-webdriver = "1"\' + text.slice(insertAt);\n  }',
  "embedded Cargo dependency",
);

runner = replaceOnce(
  runner,
  '    text = text.replace(marker, `${marker}\\n        .plugin(tauri_plugin_wdio::init())`);\n  }',
  '    text = text.replace(marker, `${marker}\\n        .plugin(tauri_plugin_wdio::init())`);\n  }\n  if (!text.includes("tauri_plugin_wdio_webdriver::init()")) {\n    const marker = ".plugin(tauri_plugin_wdio::init())";\n    if (!text.includes(marker)) throw new Error("[e2e] tauri-plugin-wdio registration not found in lib.rs.");\n    text = text.replace(marker, `${marker}\\n        .plugin(tauri_plugin_wdio_webdriver::init())`);\n  }',
  "embedded Rust plugin registration",
);

runner = replaceOnce(
  runner,
  '  if (!permissions.includes("wdio:default")) permissions.push("wdio:default");\n  json.permissions = permissions;',
  '  if (!permissions.includes("wdio:default")) permissions.push("wdio:default");\n  if (!permissions.includes("wdio-webdriver:default")) permissions.push("wdio-webdriver:default");\n  json.permissions = permissions;',
  "embedded ACL permission",
);

runner = replaceOnce(
  runner,
  '      env: { ...process.env, BEATGALER_E2E_BINARY: binary },',
  '      env: { ...process.env, BEATGALER_E2E_BINARY: binary, TAURI_WEBDRIVER_PORT: "4445", WDIO_EMBEDDED_PORT: "4445" },',
  "embedded WebDriver runtime signal",
);

fs.writeFileSync(runnerPath, runner, "utf8");
console.log("[f4-25.1] Prepared embedded Tauri WebDriver with runtime-bound provider selection and port signals.");
