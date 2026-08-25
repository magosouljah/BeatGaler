import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function packageRoot(specifier, expectedName) {
  let current = path.dirname(fileURLToPath(import.meta.resolve(specifier)));
  for (let depth = 0; depth < 12; depth += 1) {
    const manifestPath = path.join(current, "package.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.name === expectedName) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate ${expectedName}.`);
}

function internal(root, relativeWithoutExtension) {
  for (const ext of [".js", ".mjs", ".cjs"]) {
    const candidate = path.join(root, `${relativeWithoutExtension}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Missing mtcute internal module ${relativeWithoutExtension}.`);
}

const coreRoot = packageRoot("@mtcute/core", "@mtcute/core");

export default defineConfig({
  root: "tests/probes/temp-auth-web",
  base: "./",
  build: {
    outDir: path.resolve("dist-temp-auth"),
    emptyOutDir: true,
    rollupOptions: { input: path.resolve("tests/probes/temp-auth-web/index.html") },
  },
  optimizeDeps: { exclude: ["@mtcute/wasm"] },
  resolve: {
    alias: {
      "@m0e/session-connection": internal(coreRoot, "network/session-connection"),
      "@m0e/authorization": internal(coreRoot, "network/authorization"),
      "@m0e/server-salt": internal(coreRoot, "network/server-salt"),
      "@m0e/tl-reader": internal(coreRoot, "tl/binary/reader"),
      "@m0e/tl-writer": internal(coreRoot, "tl/binary/writer"),
      "@m0e/mtproto-crypto": internal(coreRoot, "utils/crypto/mtproto"),
      "@m0e/long-utils": internal(coreRoot, "utils/long-utils"),
    },
  },
});
