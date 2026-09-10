import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = [
  readFileSync(resolve(process.cwd(), "src/app/useBeatGalerComposition.ts"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/features/edit/useBeatEditing.ts"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/features/dragdrop/useBeatFileDropRouting.ts"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/features/cloud/beatCloudUpdateBusy.ts"), "utf8"),
].join("\n").replaceAll("../", "./");
const owner = readFileSync(resolve(process.cwd(), "src/features/library/useLibraryState.ts"), "utf8");
const importReview = readFileSync(resolve(process.cwd(), "src/features/import/useImportReview.ts"), "utf8");
const importSaveAll = readFileSync(resolve(process.cwd(), "src/features/import/useImportSaveAll.ts"), "utf8");

describe("task 3.1 library-state extraction", () => {
  it("moves the single library owner and presentation cache out of App", () => {
    expect(app).toContain("} = useLibraryState();");
    expect(app).not.toContain("const [beats, setBeats] = useState<Beat[]>");
    expect(app).not.toContain("const startupCachedBeatsRef = useRef<Beat[] | null>");
    expect(app).not.toContain("const beatsLatestRef = useRef<Beat[]>");
    expect(owner).toContain("const [beats, setBeats] = useState<Beat[]>");
    expect(owner).toContain("const startupCachedBeatsRef = useRef<Beat[] | null>(null)");
    expect(owner).toContain("const beatsLatestRef = useRef<Beat[]>([])");
    expect(app).toContain("useLibraryPresentationCache(");
    expect(owner).toContain("saveCachedBeats(beats)");
  });

  it("preserves the old latest-snapshot timing instead of making every setter synchronous", () => {
    expect(app).toContain("visibleLibraryFingerprintRef.current = libraryViewFingerprint(beats);\n    beatsLatestRef.current = beats;");
    expect(owner).not.toContain("beatsLatestRef.current = beats");
    const extractedOwners = `${app}\n${importReview}\n${importSaveAll}`;
    expect((extractedOwners.match(/beatsLatestRef\.current = next/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(importReview).toContain("beatsLatestRef.current = next;");
  });

  it("keeps the presentation-cache guard and dependencies byte-for-byte equivalent", () => {
    expect(app).toContain("useLibraryPresentationCache(\n    beats,\n    cloudSessionVerified,\n    settings,\n  );");
    expect(owner).toContain("if (!cloudSessionVerified || (settings && !settings.telegram_cloud_connected)) return;");
    expect(owner).toContain("[beats, settings?.telegram_cloud_connected, cloudSessionVerified]");
    expect(owner).toContain("}, 1500);");
    expect(owner).toContain("readActiveCloudUploads()");
  });
});
