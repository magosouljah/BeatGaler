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

function productiveTrustBoundaryPlugin() {
  // Cloud-origin policy intentionally lives in AccountGate source so Vite serve
  // and Vite build execute the same resolver. This build-only plugin remains for
  // the unrelated ID3 JavaScript trust boundary.
  const legacyId3Cdn = ["https://cdn.jsdelivr.net/npm/", "jsmediatags@3.9.5/dist/jsmediatags.min.js"].join("");
  const unsafeId3Loader = `    const globalName = (window as any).jsmediatags;\n    if (!globalName) {\n      // inject script\n      await new Promise<void>((resolve, reject) => {\n        const src = '${legacyId3Cdn}';\n        const s = document.createElement('script');\n        s.src = src;\n        s.async = true;\n        s.onload = () => resolve();\n        s.onerror = () => reject(new Error('Failed to load jsmediatags from CDN'));\n        document.head.appendChild(s);\n      });\n    }\n    const jm: any = (window as any).jsmediatags;`;
  const safeId3Loader = `    const jm: any = (window as any).jsmediatags;`;

  return {
    name: "beatgaler-productive-trust-boundary",
    apply: "build" as const,
    enforce: "pre" as const,
    transform(code: string, id: string) {
      const cleanId = id.split("?")[0].replace(/\\/g, "/");
      if (cleanId.endsWith("/src/lib/tauri.ts")) {
        if (!code.includes(unsafeId3Loader)) {
          throw new Error("Task 5.1 ID3 hardening anchor no longer matches; refusing an unsafe build.");
        }
        const transformed = code.replace(unsafeId3Loader, safeId3Loader);
        if (transformed.includes("cdn.jsdelivr.net/npm/jsmediatags")) {
          throw new Error("Task 5.1 ID3 hardening left remote parser code in productive source.");
        }
        return { code: transformed, map: null };
      }
      return null;
    },
    renderChunk(code: string) {
      // Defense in depth: no legacy remote parser URL is allowed in an emitted
      // JavaScript chunk, even as dead text. If an upstream transform ever
      // reintroduces it, replace the URL with a non-network sentinel; the
      // post-build regression additionally asserts the forbidden host is absent.
      if (!code.includes(legacyId3Cdn)) return null;
      return { code: code.split(legacyId3Cdn).join("about:blank#beatgaler-local-id3"), map: null };
    },
  };
}

export default defineConfig(async ({ command, mode }) => ({
  plugins: [productiveTrustBoundaryPlugin(), react()],
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
    proxy: {
      "/beatgaler-api": {
        target: "http://127.0.0.1:4000",
        changeOrigin: true,
        rewrite: requestPath => requestPath.replace(/^\/beatgaler-api/, ""),
      },
    },
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
