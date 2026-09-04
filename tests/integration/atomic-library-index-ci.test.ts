import { execFileSync } from "node:child_process";
import { describe, it } from "vitest";

describe("atomic empty-library bootstrap focused contract", () => {
  it("runs the authoritative cloud-server atomic-library-index suite", () => {
    execFileSync(process.execPath, ["cloud-server/tests/atomic-library-index.test.cjs"], {
      cwd: process.cwd(),
      stdio: "inherit",
    });
  });
});
