from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    if old not in text:
        raise RuntimeError(f"expected block missing in {path}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "tests/integration/issue97RuntimeWebFollowup.test.ts",
    '''  it("routes browser drops through browser File owners, not Desktop path staging", () => {
    const app = source("src/App.tsx");
    const uploadQueue = source("src/features/cloud/useCloudUploadQueue.ts");
    const controller = source("src/features/dragdrop/htmlDropController.ts");
    expect(app).toContain("onBrowserLibraryFileDrop: platform.capabilities.browserFileImport ? importDroppedBrowserFiles : undefined");
    expect(app).toContain("onBrowserBeatFileDrop: platform.capabilities.browserFileImport ? handleBrowserBeatFileDrop : undefined");
    expect(uploadQueue).toContain("platform.cloudData.commitImportedBeat(beat)");
    expect(controller).toContain("options.onBrowserBeatFileDrop");
  });
''',
    '''  it("routes browser drops through browser File owners, not Desktop path staging", () => {
    const app = source("src/App.tsx");
    const uploadQueue = source("src/features/cloud/useCloudUploadQueue.ts");
    const htmlDropOwner = source("src/features/dragdrop/useHtmlLibraryDrop.ts");
    const controller = source("src/features/dragdrop/htmlDropController.ts");
    expect(app).toContain("browserFileImport: platform.capabilities.browserFileImport");
    expect(app).toContain("importDroppedBrowserFiles,");
    expect(htmlDropOwner).toContain("onBrowserLibraryFileDrop: browserFileImport ? importDroppedBrowserFiles : undefined");
    expect(htmlDropOwner).toContain("onBrowserBeatFileDrop: browserFileImport ? handleBrowserBeatFileDrop : undefined");
    expect(uploadQueue).toContain("platform.cloudData.commitImportedBeat(beat)");
    expect(controller).toContain("options.onBrowserBeatFileDrop");
  });
''',
)

replace_once(
    "tests/integration/appBrowserImportExtraction.test.ts",
    '''const browserImport = readFileSync(resolve(process.cwd(), "src/features/import/useBrowserImport.ts"), "utf8");
const review = readFileSync(resolve(process.cwd(), "src/features/import/useImportReview.ts"), "utf8");
''',
    '''const browserImport = readFileSync(resolve(process.cwd(), "src/features/import/useBrowserImport.ts"), "utf8");
const htmlDropOwner = readFileSync(resolve(process.cwd(), "src/features/dragdrop/useHtmlLibraryDrop.ts"), "utf8");
const review = readFileSync(resolve(process.cwd(), "src/features/import/useImportReview.ts"), "utf8");
''',
)

replace_once(
    "tests/integration/appBrowserImportExtraction.test.ts",
    '''    expect(app).not.toContain("const importDroppedBrowserFiles = useCallback");
    expect(app).toContain("onBrowserLibraryFileDrop: platform.capabilities.browserFileImport ? importDroppedBrowserFiles : undefined");
''',
    '''    expect(app).not.toContain("const importDroppedBrowserFiles = useCallback");
    expect(app).toContain("browserFileImport: platform.capabilities.browserFileImport");
    expect(app).toContain("importDroppedBrowserFiles,");
    expect(htmlDropOwner).toContain("onBrowserLibraryFileDrop: browserFileImport ? importDroppedBrowserFiles : undefined");
''',
)
