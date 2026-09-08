import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const projects = readFileSync(resolve(process.cwd(), "src/features/projects/useBeatProjects.ts"), "utf8");
describe("Beat project extraction", () => {
  it("moves project ownership outside App", () => { expect(app).toContain("useBeatProjects({"); expect(app).not.toContain("const handleOpenProject = useCallback"); expect(app).not.toContain("const startProjectAssetUpdate = useCallback"); expect(projects).toContain("const handleOpenProject = useCallback"); expect(projects).toContain("const startProjectAssetUpdate = useCallback"); });
  it("preserves replacement and Backup rules", () => { expect(projects).toContain("Replace PROJECT ZIP?"); expect(projects).toContain("Replace project file?"); expect(projects).toContain("inspectProjectDropSource(filePath)"); expect(projects).toContain("Backup folders were skipped from"); });
  it("preserves desktop web and indicators", () => { expect(projects).toContain("openBeatProject(beat)"); expect(projects).toContain("uploadProjectToTelegram(beat)"); expect(projects).toContain("platform.editor.commit(beat, beat, { PROJECT: file })"); expect(projects).toContain("listOpenableCloudProjectBeatIds()"); });
});
