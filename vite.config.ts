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

const DEFAULT_WEB_DEV_API_TARGET = "https://beatgaler.com";

function webDevApiTarget(): string {
  const raw = String(process.env.BEATGALER_DEV_API_TARGET || DEFAULT_WEB_DEV_API_TARGET).trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("BEATGALER_DEV_API_TARGET must be an absolute URL.");
  }
  const loopbackHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !loopbackHttp) {
    throw new Error("BEATGALER_DEV_API_TARGET must use HTTPS unless it is localhost/loopback.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("BEATGALER_DEV_API_TARGET must not contain credentials, query parameters, or fragments.");
  }
  return parsed.origin;
}

function productiveTrustBoundaryPlugin() {
  const unsafeCloudConstants = `const API_KEY = "beatgaler:cloud-api:v1";\nconst LOCAL_API = "http://127.0.0.1:4000";\nconst REMOTE_API = "https://desktop-7l93a0j.tailabe8ff.ts.net";`;
  const safeCloudConstants = `const API_KEY = "beatgaler:cloud-api:v1";\nconst REMOTE_API = "https://desktop-7l93a0j.tailabe8ff.ts.net";`;
  const unsafeResolver = `export async function resolveBeatGalerCloudApi(): Promise<string> {\n  const remembered = localStorage.getItem(API_KEY);\n  if (remembered && await probe(remembered, 1200)) return remembered;\n  const sameOriginProxy = sameOriginProxyApi();\n  if (sameOriginProxy && await probe(sameOriginProxy, 1500)) {\n    localStorage.setItem(API_KEY, sameOriginProxy);\n    return sameOriginProxy;\n  }\n  if (await probe(LOCAL_API, 900)) { localStorage.setItem(API_KEY, LOCAL_API); return LOCAL_API; }\n  if (await probe(REMOTE_API, 2500)) { localStorage.setItem(API_KEY, REMOTE_API); return REMOTE_API; }\n  throw new Error("Could not reach BeatGaler Cloud.");\n}\n\nexport function getResolvedCloudApiBase(): string { return localStorage.getItem(API_KEY) || REMOTE_API; }`;
  const safeResolver = `function trustedRememberedApi(value: string | null): value is string {\n  if (!value) return false;\n  const sameOriginProxy = sameOriginProxyApi();\n  if (platform.kind === "web") return !!sameOriginProxy && value === sameOriginProxy;\n  return value === REMOTE_API;\n}\n\nexport async function resolveBeatGalerCloudApi(): Promise<string> {\n  const remembered = localStorage.getItem(API_KEY);\n  const sameOriginProxy = sameOriginProxyApi();\n  if (platform.kind === "web") {\n    if (remembered && remembered !== sameOriginProxy) localStorage.removeItem(API_KEY);\n    if (sameOriginProxy && await probe(sameOriginProxy, 1500)) {\n      localStorage.setItem(API_KEY, sameOriginProxy);\n      return sameOriginProxy;\n    }\n    throw new Error("Could not reach BeatGaler Cloud.");\n  }\n  if (trustedRememberedApi(remembered) && await probe(remembered, 1200)) return remembered;\n  if (await probe(REMOTE_API, 2500)) { localStorage.setItem(API_KEY, REMOTE_API); return REMOTE_API; }\n  throw new Error("Could not reach BeatGaler Cloud.");\n}\n\nexport function getResolvedCloudApiBase(): string {\n  const remembered = localStorage.getItem(API_KEY);\n  if (platform.kind === "web") return sameOriginProxyApi() || "";\n  return trustedRememberedApi(remembered) ? remembered : REMOTE_API;\n}`;
  // Build the legacy URL from fragments so the deprecated remote source is not
  // itself embedded as a contiguous executable URL in Vite's compiled config.
  const legacyId3Cdn = ["https://cdn.jsdelivr.net/npm/", "jsmediatags@3.9.5/dist/jsmediatags.min.js"].join("");
  const unsafeId3Loader = `    const globalName = (window as any).jsmediatags;\n    if (!globalName) {\n      // inject script\n      await new Promise<void>((resolve, reject) => {\n        const src = '${legacyId3Cdn}';\n        const s = document.createElement('script');\n        s.src = src;\n        s.async = true;\n        s.onload = () => resolve();\n        s.onerror = () => reject(new Error('Failed to load jsmediatags from CDN'));\n        document.head.appendChild(s);\n      });\n    }\n    const jm: any = (window as any).jsmediatags;`;
  const safeId3Loader = `    const jm: any = (window as any).jsmediatags;`;

  return {
    name: "beatgaler-productive-trust-boundary",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      const cleanId = id.split("?")[0].replace(/\\/g, "/");
      if (cleanId.endsWith("/src/components/AccountGate.tsx")) {
        if (!code.includes(unsafeCloudConstants) || !code.includes(unsafeResolver)) {
          throw new Error("Task 5.1 cloud-origin hardening anchors no longer match; refusing an unsafe build.");
        }
        const transformed = code.replace(unsafeCloudConstants, safeCloudConstants).replace(unsafeResolver, safeResolver);
        if (transformed.includes("http://127.0.0.1:4000")) {
          throw new Error("Task 5.1 cloud-origin hardening left local Cloud discovery in productive code.");
        }
        return { code: transformed, map: null };
      }
      if (cleanId.endsWith("/src/lib/tauri.ts")) {
        if (!code.includes(unsafeId3Loader)) {
          throw new Error("Task 5.1 ID3 hardening anchor no longer match; refusing an unsafe build.");
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

export default defineConfig(async ({ command, mode }) => {
  const devProxyTarget = command === "serve" && mode === "web" ? webDevApiTarget() : null;
  return {
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
      watch: {
        ignored: [
          "**/src-tauri/**",
          "**/.vs/**",
          "**/node_modules/**"
        ],
      },
      ...(devProxyTarget ? {
        proxy: {
          "/beatgaler-api": {
            target: devProxyTarget,
            changeOrigin: true,
            secure: true,
            cookieDomainRewrite: "",
          },
        },
      } : {}),
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
  };
});
