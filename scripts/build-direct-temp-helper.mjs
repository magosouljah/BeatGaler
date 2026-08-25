import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFromRoot = createRequire(import.meta.url);

function findPackageRoot(entryPath, expectedName) {
  let current = path.dirname(entryPath);
  for (let depth = 0; depth < 12; depth += 1) {
    const manifestPath = path.join(current, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === expectedName) return { root: current, manifest };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate ${expectedName} package root.`);
}

function findFirstWasm(directory) {
  const queue = [directory];
  while (queue.length) {
    const current = queue.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.name.endsWith(".wasm")) return full;
    }
  }
  throw new Error("Could not locate @mtcute/wasm binary.");
}

const webEntry = requireFromRoot.resolve("@mtcute/web");
const webPkg = findPackageRoot(webEntry, "@mtcute/web");
if (webPkg.manifest.version !== "0.31.0") throw new Error(`Direct temp helper requires @mtcute/web 0.31.0, got ${webPkg.manifest.version}.`);
const requireFromWeb = createRequire(pathToFileURL(path.join(webPkg.root, "package.json")));
const coreEntry = requireFromWeb.resolve("@mtcute/core");
const corePkg = findPackageRoot(coreEntry, "@mtcute/core");
if (corePkg.manifest.version !== "0.31.0") throw new Error(`Direct temp helper requires @mtcute/core 0.31.0, got ${corePkg.manifest.version}.`);
const wasmEntry = requireFromWeb.resolve("@mtcute/wasm");
const wasmPkg = findPackageRoot(wasmEntry, "@mtcute/wasm");

const aliases = new Map([
  ["__beatgaler_mtcute_authorization__", path.join(corePkg.root, "network", "authorization.js")],
  ["__beatgaler_mtcute_utils__", path.join(corePkg.root, "utils.js")],
  ["__beatgaler_mtcute_wasm__", findFirstWasm(wasmPkg.root)],
]);
for (const [name, target] of aliases) {
  if (!existsSync(target)) throw new Error(`Missing ${name} target: ${target}`);
}

// Keep this bundle self-contained: packaged Desktop has no node_modules beside the helper.
await build({
  entryPoints: [path.join(root, "src-tauri", "direct-transport", "transport-helper.source.mjs")],
  outfile: path.join(root, "src-tauri", "direct-transport", "transport-helper.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: false,
  legalComments: "none",
  loader: { ".wasm": "binary" },
  plugins: [{
    name: "beatgaler-mtcute-temp-auth-aliases",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^__beatgaler_mtcute_(?:authorization|utils|wasm)__$/ }, args => ({ path: aliases.get(args.path) }));
    },
  }],
});

console.log("Built self-contained Desktop temporary-auth Direct helper.");
