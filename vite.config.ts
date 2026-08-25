import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = path.dirname(fileURLToPath(import.meta.url));

function findPackageRoot(entryPath: string, expectedName: string): string {
  let current = path.dirname(entryPath);
  for (let depth = 0; depth < 12; depth += 1) {
    const manifestPath = path.join(current, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === expectedName) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate ${expectedName} package root.`);
}

const requireFromRoot = createRequire(import.meta.url);
const webEntry = requireFromRoot.resolve("@mtcute/web");
const webRoot = findPackageRoot(webEntry, "@mtcute/web");
const requireFromWeb = createRequire(pathToFileURL(path.join(webRoot, "package.json")));
const coreEntry = requireFromWeb.resolve("@mtcute/core");
const coreRoot = findPackageRoot(coreEntry, "@mtcute/core");

function requiredCoreFile(...parts: string[]): string {
  const full = path.join(coreRoot, ...parts);
  if (!existsSync(full)) throw new Error(`Missing published @mtcute/core file: ${parts.join("/")}`);
  return full;
}

export default defineConfig(async ({ command, mode }) => ({
  plugins: [react()],
  base: command === "serve" ? "/" : "./",
  clearScreen: false,
  resolve: {
    alias: {
      __beatgaler_mtcute_authorization__: requiredCoreFile("network", "authorization.js"),
      __beatgaler_mtcute_utils__: requiredCoreFile("utils.js"),
    },
  },
  optimizeDeps: {
    exclude: ["@mtcute/wasm"],
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/.vs/**",
        "**/node_modules/**"
      ],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Web transport dependencies use native BigInt. The browser build therefore
    // targets ES2020, while Desktop keeps its existing platform-specific targets.
    target: mode === "web"
      ? "es2020"
      : process.env.TAURI_ENV_PLATFORM == "windows"
        ? "chrome105"
        : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
