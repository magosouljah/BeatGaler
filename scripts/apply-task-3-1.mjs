import { readFileSync, writeFileSync } from "node:fs";

const appPath = "src/App.tsx";
let app = readFileSync(appPath, "utf8");

function replaceOnce(label, before, after) {
  const first = app.indexOf(before);
  if (first < 0) throw new Error(`Task 3.1 patch failed: missing ${label}`);
  if (app.indexOf(before, first + before.length) >= 0) throw new Error(`Task 3.1 patch failed: duplicate ${label}`);
  app = app.slice(0, first) + after + app.slice(first + before.length);
}

const setBeatsCallsBefore = (app.match(/\bsetBeats\s*\(/g) ?? []).length;
const latestAssignmentsBefore = (app.match(/beatsLatestRef\.current\s*=/g) ?? []).length;

replaceOnce(
  "library presentation-cache import",
  'import { clearCachedBeats, clearUploadPreviewCache, loadCachedBeats, loadCachedSort, preserveLoadedArtwork, saveCachedBeats, saveCachedSort } from "./features/library/libraryPresentationCache";',
  'import { clearCachedBeats, clearUploadPreviewCache, loadCachedSort, preserveLoadedArtwork, saveCachedSort } from "./features/library/libraryPresentationCache";\nimport { useLibraryPresentationCache, useLibraryState } from "./features/library/useLibraryState";',
);

replaceOnce(
  "local library ownership block",
`  // Browser/localStorage library data is an instant-paint presentation cache.\n  // It may render before cloud authority resolves, but remains read-only until\n  // verification and is never allowed to overwrite the authoritative library.\n  const startupCachedBeatsRef = useRef<Beat[] | null>(null);\n  if (startupCachedBeatsRef.current === null) {\n    const cached = loadCachedBeats() ?? [];\n    const interruptedIds = new Set(readActiveCloudUploads().map(item => item.beatId));\n    startupCachedBeatsRef.current = interruptedIds.size > 0\n      ? cached.filter(beat => !interruptedIds.has(beat.id))\n      : cached;\n  }\n  const [beats, setBeats] = useState<Beat[]>(() => startupCachedBeatsRef.current ?? []);`,
`  const {\n    beats,\n    setBeats,\n    beatsLatestRef,\n    startupCachedBeatsRef,\n    initialLoading,\n  } = useLibraryState();`,
);

replaceOnce(
  "cache timer ref",
  '  const cacheSaveTimerRef = useRef<number | null>(null);\n',
  "",
);

replaceOnce(
  "local latest-library ref",
`  // Always holds the newest library snapshot for immediate cloud-index writes.\n  const beatsLatestRef = useRef<Beat[]>([]);\n`,
  "",
);

replaceOnce(
  "loading cache read",
  '  const [loading, setLoading] = useState(() => loadCachedBeats() === null);',
  '  const [loading, setLoading] = useState(() => initialLoading);',
);

replaceOnce(
  "presentation cache effect",
`  // localStorage is synchronous and blocks the UI thread. Debounce it and store\n  // a lightweight version without full artwork instead of serializing megabytes\n  // of base64 on every small metadata change.\n  useEffect(() => {\n    if (cacheSaveTimerRef.current) window.clearTimeout(cacheSaveTimerRef.current);\n\n    // Hiding the cloud library while disconnected is a view decision, not a\n    // destructive cache mutation. Preserve the last verified instant-paint cache.\n    if (!cloudSessionVerified || (settings && !settings.telegram_cloud_connected)) return;\n\n    cacheSaveTimerRef.current = window.setTimeout(() => {\n      cacheSaveTimerRef.current = null;\n      saveCachedBeats(beats);\n    }, 1500);\n\n    return () => {\n      if (cacheSaveTimerRef.current) {\n        window.clearTimeout(cacheSaveTimerRef.current);\n        cacheSaveTimerRef.current = null;\n      }\n    };\n  }, [beats, settings?.telegram_cloud_connected, cloudSessionVerified]);`,
`  useLibraryPresentationCache(\n    beats,\n    cloudSessionVerified,\n    settings?.telegram_cloud_connected,\n  );`,
);

const setBeatsCallsAfter = (app.match(/\bsetBeats\s*\(/g) ?? []).length;
const latestAssignmentsAfter = (app.match(/beatsLatestRef\.current\s*=/g) ?? []).length;
if (setBeatsCallsAfter !== setBeatsCallsBefore) {
  throw new Error(`Task 3.1 patch changed setBeats call count: ${setBeatsCallsBefore} -> ${setBeatsCallsAfter}`);
}
if (latestAssignmentsAfter !== latestAssignmentsBefore) {
  // Task 3.1 must not move or normalize any existing latest-ref publication.
  // Those synchronous assignments and the render effect intentionally happen at
  // different moments and are characterization behavior for this extraction.
  throw new Error(`Task 3.1 patch changed beatsLatestRef assignment count: ${latestAssignmentsBefore} -> ${latestAssignmentsAfter}`);
}

writeFileSync(appPath, app);

writeFileSync("tests/integration/libraryStateExtraction.test.ts", `import { readFileSync } from "node:fs";\nimport { resolve } from "node:path";\nimport { describe, expect, it } from "vitest";\n\nconst app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");\nconst owner = readFileSync(resolve(process.cwd(), "src/features/library/useLibraryState.ts"), "utf8");\n\ndescribe("task 3.1 library-state extraction", () => {\n  it("moves the single library owner and presentation cache out of App", () => {\n    expect(app).toContain("} = useLibraryState();");\n    expect(app).not.toContain("const [beats, setBeats] = useState<Beat[]>");\n    expect(app).not.toContain("const startupCachedBeatsRef = useRef<Beat[] | null>");\n    expect(app).not.toContain("const beatsLatestRef = useRef<Beat[]>");\n    expect(owner).toContain("const [beats, setBeats] = useState<Beat[]>");\n    expect(owner).toContain("const startupCachedBeatsRef = useRef<Beat[] | null>(null)");\n    expect(owner).toContain("const beatsLatestRef = useRef<Beat[]>([])");\n    expect(app).toContain("useLibraryPresentationCache(");\n    expect(owner).toContain("saveCachedBeats(beats)");\n  });\n\n  it("preserves the old latest-snapshot timing instead of making every setter synchronous", () => {\n    expect(app).toContain("visibleLibraryFingerprintRef.current = libraryViewFingerprint(beats);\\n    beatsLatestRef.current = beats;");\n    expect(owner).not.toContain("beatsLatestRef.current = beats");\n    expect((app.match(/beatsLatestRef\\.current = next/g) ?? []).length).toBeGreaterThan(5);\n  });\n\n  it("keeps presentation cache gated by verified cloud authority", () => {\n    expect(owner).toContain("if (!cloudSessionVerified || telegramCloudConnected === false) return;");\n    expect(owner).toContain("}, 1500);");\n    expect(owner).toContain("readActiveCloudUploads()");\n  });\n});\n`);

console.log(`Task 3.1 patch applied. setBeats calls preserved: ${setBeatsCallsAfter}; latest assignments preserved: ${latestAssignmentsAfter}.`);
