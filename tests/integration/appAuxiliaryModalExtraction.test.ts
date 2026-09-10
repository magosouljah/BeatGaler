import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = [
  readFileSync(resolve(process.cwd(), "src/app/useBeatGalerComposition.ts"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/app/AppShell.tsx"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/features/edit/useBeatEditing.ts"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/features/dragdrop/useBeatFileDropRouting.ts"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/features/cloud/beatCloudUpdateBusy.ts"), "utf8"),
].join("\n").replaceAll("../", "./");
const cloudModal = readFileSync(resolve(process.cwd(), "src/features/downloads/components/CloudFilesModal.tsx"), "utf8");
const dropModal = readFileSync(resolve(process.cwd(), "src/features/dragdrop/components/BeatFileDropModal.tsx"), "utf8");

describe("App auxiliary modal extraction", () => {
  it("moves both auxiliary modal definitions to their feature owners", () => {
    expect(app).toContain('from "./features/downloads/components/CloudFilesModal"');
    expect(app).toContain('from "./features/dragdrop/components/BeatFileDropModal"');
    expect(app).not.toContain("function CloudFilesModal({");
    expect(app).not.toContain("function BeatFileDropModal({");
    expect(cloudModal).toContain("ReactDOM.createPortal");
    expect(dropModal).toContain("ReactDOM.createPortal");
  });
});
