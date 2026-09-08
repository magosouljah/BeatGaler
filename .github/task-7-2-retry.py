from pathlib import Path

OLD_WORKFLOW = Path('.github/workflows/temp-task-7.2-apply.yml')
old_workflow = OLD_WORKFLOW.read_text(encoding='utf-8')


def extract_heredoc(path: str) -> str:
    marker = f"cat > {path} <<'EOF'\n"
    start = old_workflow.index(marker) + len(marker)
    end = old_workflow.index('\n          EOF', start)
    block = old_workflow[start:end]
    lines = block.splitlines()
    return '\n'.join(line[10:] if line.startswith('          ') else line for line in lines) + '\n'


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)


discovery_source = extract_heredoc('src/features/import/useImportDiscovery.ts')
discovery_source = replace_once(
    discovery_source,
    '  const cancelPendingReviewWork = useCallback(() => {\n',
    '  const completeImmediateReviewPreparation = useCallback(() => {\n    setReviewPreparationDone(true);\n    setReviewBootstrap(null);\n  }, []);\n\n  const cancelPendingReviewWork = useCallback(() => {\n',
    'immediate review handoff',
)
discovery_source = replace_once(
    discovery_source,
    '    cancelPendingReviewWork,\n  };\n',
    '    cancelPendingReviewWork,\n    completeImmediateReviewPreparation,\n  };\n',
    'discovery return handoff',
)
Path('src/features/import/useImportDiscovery.ts').write_text(discovery_source, encoding='utf-8')
Path('tests/component-dom/importDiscovery.test.tsx').write_text(
    extract_heredoc('tests/component-dom/importDiscovery.test.tsx'), encoding='utf-8'
)
integration_test = extract_heredoc('tests/integration/appImportDiscoveryExtraction.test.ts')
integration_test = integration_test.replace(
    'section(discovery, "const importDroppedPaths = useCallback", "\\n    return {\\n")',
    'section(discovery, "const importDroppedPaths = useCallback", "\\n  return {\\n")',
)
Path('tests/integration/appImportDiscoveryExtraction.test.ts').write_text(integration_test, encoding='utf-8')

app_path = Path('src/App.tsx')
app = app_path.read_text(encoding='utf-8')
app = replace_once(
    app,
    'saveBeatMeta, startImportReviewStream, getImportReviewBatchSummary, prepareNextImportReviewBeat, discardImportReviewBatch',
    'saveBeatMeta, discardImportReviewBatch',
    'tauri discovery imports',
)
app = replace_once(
    app,
    'import { reviewSourceKey, useImportSession } from "./features/import/useImportSession";\n',
    'import { useImportSession } from "./features/import/useImportSession";\n',
    'session import',
)
app = replace_once(
    app,
    'import { useImportReview } from "./features/import/useImportReview";\n',
    'import { useImportReview } from "./features/import/useImportReview";\nimport { useImportDiscovery } from "./features/import/useImportDiscovery";\n',
    'discovery import',
)
app = replace_once(
    app,
    '  const [reviewBootstrap, setReviewBootstrap] = useState<{ total: number | null } | null>(null);\n',
    '',
    'bootstrap state',
)
app = replace_once(
    app,
    '  const [reviewPreparationDone, setReviewPreparationDone] = useState(true);\n',
    '',
    'preparation state',
)

refs_start = app.index('  // Background uploads can finish while the user is still reviewing other beats')
refs_end_marker = '  const importReviewRequestRunRef = useRef(0);\n'
refs_end = app.index(refs_end_marker, refs_start) + len(refs_end_marker)
app = app[:refs_start] + app[refs_end:]

marker = '''  }, [connectionState]);

  const {
    backgroundUploadErrors,
'''
inserted = '''  }, [connectionState]);

  const {
    reviewBootstrap,
    reviewPreparationDone,
    reviewPreparationPromiseRef,
    importDroppedPaths,
    cancelPendingReviewWork,
    completeImmediateReviewPreparation,
  } = useImportDiscovery({
    dropImporting,
    setDropImporting,
    rejectOfflineMutation,
    setDropActive,
    setShowAdd,
    setDeferredImportBatch,
    setAudioConflictBatch,
    setDropImportBatch,
    setReviewQueue,
    skippedReviewSourceKeysRef,
    stagedImportPathsRef,
    skeletonEnabled: REVIEW_SKELETON_ENABLED,
  });

  const {
    backgroundUploadErrors,
'''
app = replace_once(app, marker, inserted, 'hook composition')

cancel_start = app.index('  const cancelPendingReviewWork = useCallback(() => {')
cancel_end = app.index('const {\n  skipCurrentReviewBeat,', cancel_start)
if cancel_end < 0:
    raise SystemExit('could not locate end of local cancelPendingReviewWork')
app = app[:cancel_start] + app[cancel_end:]

discovery_start = app.index('  const importDroppedPaths = useCallback(async (paths: string[]) => {')
discovery_end_marker = '\n\n  useEffect(() => {\n    if (!deferredImportBatch || !reviewPreparationDone || bulkSaveAllBusy) return;'
discovery_end = app.index(discovery_end_marker, discovery_start)
app = app[:discovery_start] + app[discovery_end:]
app = replace_once(
    app,
    '      setReviewPreparationDone(true);\n      setReviewBootstrap(null);\n      setDeferredImportBatch(null);\n',
    '      completeImmediateReviewPreparation();\n      setDeferredImportBatch(null);\n',
    'browser immediate review handoff',
)
app_path.write_text(app, encoding='utf-8')

characterization_path = Path('tests/integration/appMigrationCharacterization.test.ts')
characterization = characterization_path.read_text(encoding='utf-8')
characterization = replace_once(
    characterization,
    'const add = section("const addBeatsAndReview = useCallback", "const cancelPendingReviewWork = useCallback");',
    'const add = section("const addBeatsAndReview = useCallback", "const handleReviewedSaveAll = useCallback");',
    'review characterization boundary',
)
characterization_path.write_text(characterization, encoding='utf-8')

regressions_path = Path('scripts/run-regressions.mjs')
regressions = regressions_path.read_text(encoding='utf-8')
regressions = replace_once(
    regressions,
    '  const cloudUploadQueue = readFileSync(path.join(root, "src", "features", "cloud", "useCloudUploadQueue.ts"), "utf8");\n',
    '  const cloudUploadQueue = readFileSync(path.join(root, "src", "features", "cloud", "useCloudUploadQueue.ts"), "utf8");\n  const importDiscovery = readFileSync(path.join(root, "src", "features", "import", "useImportDiscovery.ts"), "utf8");\n',
    'regression owner read',
)
old_guard = '''  const skeletonIndex = app.indexOf("setReviewBootstrap({ total: null })");
  const streamStartIndex = app.indexOf("await startImportReviewStream(normalized)", skeletonIndex);
  if (skeletonIndex < 0 || streamStartIndex < 0 || skeletonIndex > streamStartIndex) fail("Review skeleton no longer appears before streaming discovery starts.");
  if (app.includes("await previewImportBatch(normalized)")) fail("Review regressed to full-batch discovery before Beat 1.");
  if (!app.includes("await prepareNextImportReviewBeat(stream.batch_id)")) fail("Review no longer advances the streaming discovery one beat at a time.");
  if (!app.includes("while (!step.discovery_complete") || !app.includes("FIRST_REVIEW_READY") || !app.includes("DISCOVERY_FINISHED")) fail("Streaming Review worker/perf instrumentation was removed.");
  if (!app.includes("reviewPreparationPromiseRef.current")) fail("Save All no longer shares the sequential Review preparation worker.");
'''
new_guard = '''  const skeletonIndex = importDiscovery.indexOf("setReviewBootstrap({ total: null })");
  const streamStartIndex = importDiscovery.indexOf("await services.startStream(normalized)", skeletonIndex);
  if (skeletonIndex < 0 || streamStartIndex < 0 || skeletonIndex > streamStartIndex) fail("Review skeleton no longer appears before streaming discovery starts.");
  if ([app, importDiscovery].some(source => source.includes("await previewImportBatch(normalized)"))) fail("Review regressed to full-batch discovery before Beat 1.");
  if (!importDiscovery.includes("startStream: startImportReviewStream") || !importDiscovery.includes("prepareNext: prepareNextImportReviewBeat") || !importDiscovery.includes("await services.prepareNext(stream.batch_id)")) fail("Review no longer advances the streaming discovery one beat at a time.");
  if (!importDiscovery.includes("while (!step.discovery_complete") || !importDiscovery.includes("FIRST_REVIEW_READY") || !importDiscovery.includes("DISCOVERY_FINISHED")) fail("Streaming Review worker/perf instrumentation was removed.");
  if (!importDiscovery.includes("const reviewPreparationPromiseRef = useRef<Promise<Beat[]> | null>(null)") || !app.includes("reviewPreparationPromiseRef.current")) fail("Save All no longer shares the sequential Review preparation worker.");
'''
regressions = replace_once(regressions, old_guard, new_guard, 'bulk Review regression guard')
regressions_path.write_text(regressions, encoding='utf-8')

for path in [
    '.github/workflows/temp-task-7.2-apply.yml',
    '.github/workflows/temp-task-7.2-retry.yml',
    '.github/workflows/temp-task-7.2-retry2.yml',
    '.github/task-7-2-retry.py',
]:
    candidate = Path(path)
    if candidate.exists():
        candidate.unlink()
