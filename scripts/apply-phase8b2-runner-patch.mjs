import fs from "node:fs";

const file = "scripts/run-desktop-e2e-isolated.mjs";
let text = fs.readFileSync(file, "utf8");

if (!text.includes("BEATGALER_E2E_FLOW")) {
  // 1) When patching frontend, import the flow harness and replace <App/> render in the temporary source.
  text = text.replace(
    'const importLine = \'import "@wdio/tauri-plugin";\';',
    'const importLine = \'import "@wdio/tauri-plugin";\\nimport E2EFlowHarness from "../tests/e2e-harness/E2EFlowHarness";\';'
  );

  text = text.replace(
    'if (!text.includes(importLine)) {\\n    text = `${importLine}\\\\n${text}`;\\n  }',
    'if (!text.includes(\'import "@wdio/tauri-plugin";\')) {\\n    text = `${importLine}\\\\n${text}`;\\n  }\\n  if (process.env.BEATGALER_E2E_FLOW === "1") {\\n    text = text.replace(/<App\\\\s*\\\\/>/g, "<E2EFlowHarness />");\\n  }'
  );

  // 2) Pass the flag into the temporary frontend build.
  text = text.replace(
    'run("npm", ["run", "build"], { VITE_E2E: "1" });',
    'run("npm", ["run", "build"], { VITE_E2E: "1", BEATGALER_E2E_FLOW: process.env.BEATGALER_E2E_FLOW ?? "" });'
  );

  fs.writeFileSync(file, text, "utf8");
  console.log("[phase8b2] Patched isolated runner for optional E2E flow harness.");
} else {
  console.log("[phase8b2] Isolated runner already supports E2E flow harness.");
}
