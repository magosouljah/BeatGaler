import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

function findPackageRoot(entryPath, expectedName) {
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
  throw new Error(`Could not locate ${expectedName} package root for M0-E2.`);
}

const requireFromProbe = createRequire(import.meta.url);
const webEntry = requireFromProbe.resolve("@mtcute/web");
const webRoot = findPackageRoot(webEntry, "@mtcute/web");
const requireFromWeb = createRequire(pathToFileURL(path.join(webRoot, "package.json")));
const coreEntry = requireFromWeb.resolve("@mtcute/core");
const coreRoot = findPackageRoot(coreEntry, "@mtcute/core");

function requiredPublishedFile(...parts) {
  const full = path.join(coreRoot, ...parts);
  if (!existsSync(full)) throw new Error(`Missing published @mtcute/core file required by M0-E2: ${parts.join("/")}`);
  return full;
}

export default defineConfig({
  root,
  optimizeDeps: {
    exclude: ["@mtcute/wasm"],
  },
  resolve: {
    alias: {
      __m0_authorization__: requiredPublishedFile("network", "authorization.js"),
      __m0_core_utils__: requiredPublishedFile("utils.js"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4174,
    strictPort: true,
    proxy: {
      "/m0-e2-binder": {
        target: "http://127.0.0.1:4180",
        changeOrigin: false,
        rewrite: pathname => pathname.replace(/^\/m0-e2-binder/, ""),
      },
    },
  },
});
