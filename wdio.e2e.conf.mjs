import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appBinary = process.env.BEATGALER_E2E_BINARY
  ? path.resolve(process.env.BEATGALER_E2E_BINARY)
  : path.resolve(here, "src-tauri", "target", "release", "beat_galer.exe");

export const config = {
  runner: "local",
  specs: ["./tests/e2e/**/*.e2e.mjs"],
  maxInstances: 1,
  logLevel: "warn",
  bail: 1,
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 1,

  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 60000,
  },

  services: [
    [
      "@wdio/tauri-service",
      {
        driverProvider: "official",
        appBinaryPath: appBinary,
        autoInstallTauriDriver: true,
        autoDownloadEdgeDriver: true,
        captureBackendLogs: false,
        captureFrontendLogs: false,
        startTimeout: 60000,
        commandTimeout: 30000,
      },
    ],
  ],

  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: appBinary,
      },
    },
  ],
};
