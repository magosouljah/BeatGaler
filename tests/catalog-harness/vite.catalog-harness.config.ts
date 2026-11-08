// T02 / V01-B — Build del harness. Reutiliza la config productiva sin cambios y solo añade:
// alias del coordinator al doble, instrumentación inline en index.html, outDir separado y envDir vacío
// (no lee ningún .env del proyecto).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import productive from "../../vite.config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");
const fake = path.join(here, "fakeWebStartupPlaybackCoordinator.ts");
const instrument = fs.readFileSync(path.join(here, "harness-instrument.js"), "utf8");
const emptyEnvDir = path.join(repo, "tmp", "catalog-harness", "empty-env");
fs.mkdirSync(emptyEnvDir, { recursive: true });

export default async (env: any) => {
  const base = typeof productive === "function" ? await (productive as any)(env) : await productive;
  const alias = base.resolve?.alias || {};
  const aliasList = Array.isArray(alias) ? alias : Object.entries(alias).map(([find, replacement]) => ({ find, replacement }));
  return {
    ...base,
    root: repo,
    envDir: emptyEnvDir,
    resolve: { ...base.resolve, alias: [...aliasList, { find: /^.*\/webStartupPlaybackCoordinator$/, replacement: fake }] },
    plugins: [...(base.plugins || []), {
      name: "catalog-harness-instrument",
      transformIndexHtml: () => [{ tag: "script", children: instrument, injectTo: "head-prepend" }],
    }],
    build: { ...base.build, outDir: path.join(repo, "tmp", "catalog-harness", "dist"), emptyOutDir: true },
  };
};
