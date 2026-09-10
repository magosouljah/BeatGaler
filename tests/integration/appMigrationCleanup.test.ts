import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(file);
    return /\.(ts|tsx)$/.test(entry.name) ? [file] : [];
  });
}

describe("task 10.3 migration cleanup", () => {
  it("keeps feature modules independent from the root/app composition layer", () => {
    for (const file of walk("src/features")) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/(?:import|export)\s+[\s\S]*?from\s+["']([^"']+)["']/g)) {
        const specifier = match[1];
        if (!specifier.startsWith(".")) continue;
        const resolved = path.normalize(path.join(path.dirname(file), specifier)).replaceAll("\\", "/");
        expect(resolved, `Feature import must not point into app/root: ${file} -> ${specifier}`).not.toMatch(/\/src\/app(?:\/|$)|\/src\/App$/);
      }
    }
  });

  it("does not pass DOM globals through the application scope", () => {
    const composition = readFileSync("src/app/useBeatGalerComposition.ts", "utf8");
    const shell = readFileSync("src/app/AppShell.tsx", "utf8");
    expect(composition).not.toMatch(/return\s*\{[^}]*\b(?:Event|HTMLElement)\b/s);
    expect(shell).not.toMatch(/const\s*\{[^}]*\b(?:Event|HTMLElement)\b/s);
    expect(shell).toContain('new Event("beatcard:close-menus")');
  });

  it("keeps the playback trace but removes its obsolete temporary migration label", () => {
    const trace = readFileSync("src/features/playback/playTrace.ts", "utf8");
    expect(trace).toContain("export function playTrace(");
    expect(trace).not.toContain("Temporary Issue #97 runtime trace");
  });
});
