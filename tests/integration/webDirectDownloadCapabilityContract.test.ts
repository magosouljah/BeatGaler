import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  OPERATION_SCOPE_RULES,
  normalizeScope,
} = require("../../cloud-server/direct-capability-boundary.js") as {
  OPERATION_SCOPE_RULES: Map<string, Set<string>>;
  normalizeScope(kind: string, scope: { objectType: string; objectIds: string[] }): unknown;
};

describe("Cloud Direct download capability contract", () => {
  it("allows download for messages and excludes export from capabilities", () => {
    const requestedCapability = "download";

    expect(OPERATION_SCOPE_RULES.has(requestedCapability)).toBe(true);
    expect(OPERATION_SCOPE_RULES.get(requestedCapability)?.has("message")).toBe(true);
    expect(() => normalizeScope(requestedCapability, {
      objectType: "message",
      objectIds: ["31"],
    })).not.toThrow();
    expect(OPERATION_SCOPE_RULES.has("export")).toBe(false);
  });
});
