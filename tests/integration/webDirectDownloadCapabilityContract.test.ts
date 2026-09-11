import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  OPERATION_SCOPE_RULES,
  normalizeScope,
} = require("../../cloud-server/direct-capability-boundary.js") as {
  OPERATION_SCOPE_RULES: Map<string, Set<string>>;
  normalizeScope(kind: string, scope: { objectType: string; objectIds: string[] }): unknown;
};

const transport = readFileSync(
  resolve(process.cwd(), "src/features/cloud/webGalerCloudTransport.ts"),
  "utf8",
);

describe("Web Direct download capability contract", () => {
  it("keeps export as stream purpose while requesting an allowlisted download/message capability", () => {
    const exportGuard = transport.match(/if \(purpose === "export"\) \{([\s\S]*?)\n    \}/)?.[1] || "";
    const requestedCapability = exportGuard.match(/beginOperation\(\s*"([^"]+)"/)?.[1] || "";

    expect(transport).toContain('if (purpose === "export")');
    expect(exportGuard).toContain("beginOperation");
    expect(requestedCapability).toBe("download");
    expect(OPERATION_SCOPE_RULES.has(requestedCapability)).toBe(true);
    expect(OPERATION_SCOPE_RULES.get(requestedCapability)?.has("message")).toBe(true);
    expect(() => normalizeScope(requestedCapability, {
      objectType: "message",
      objectIds: ["31"],
    })).not.toThrow();
    expect(OPERATION_SCOPE_RULES.has("export")).toBe(false);
  });
});
