from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


extraction = read("tests/integration/appCloudUploadQueueExtraction.test.ts")
extraction = replace_once(
    extraction,
    '''    expectOrdered(queue, [
      "backgroundUploadRunningRef.current = false",
      "finishDeferredReloadIfIdle();",
    ]);
''',
    '''    const desktopFinally = queue.indexOf("backgroundUploadRunningRef.current = false");
    expect(desktopFinally).toBeGreaterThan(-1);
    expect(queue.indexOf("finishDeferredReloadIfIdle();", desktopFinally)).toBeGreaterThan(desktopFinally);
''',
    "queue deferred Reload assertion",
)
write("tests/integration/appCloudUploadQueueExtraction.test.ts", extraction)

characterization = read("tests/integration/appMigrationCharacterization.test.ts")
characterization = replace_once(
    characterization,
    '''    expectOrdered(cloudUploadQueue, [
      "backgroundUploadRunningRef.current = false",
      "finishDeferredReloadIfIdle();",
    ]);
''',
    '''    const desktopFinally = cloudUploadQueue.indexOf("backgroundUploadRunningRef.current = false");
    expect(desktopFinally).toBeGreaterThan(-1);
    expect(cloudUploadQueue.indexOf("finishDeferredReloadIfIdle();", desktopFinally)).toBeGreaterThan(desktopFinally);
''',
    "characterization deferred Reload assertion",
)
write("tests/integration/appMigrationCharacterization.test.ts", characterization)

issue97 = read("tests/integration/issue97RuntimeWebFollowup.test.ts")
issue97 = replace_once(
    issue97,
    '''    const app = source("src/App.tsx");
    const controller = source("src/features/dragdrop/htmlDropController.ts");
''',
    '''    const app = source("src/App.tsx");
    const uploadQueue = source("src/features/cloud/useCloudUploadQueue.ts");
    const controller = source("src/features/dragdrop/htmlDropController.ts");
''',
    "issue97 reads upload queue",
)
issue97 = replace_once(
    issue97,
    '    expect(app).toContain("platform.cloudData.commitImportedBeat(beat)");\n',
    '    expect(uploadQueue).toContain("platform.cloudData.commitImportedBeat(beat)");\n',
    "issue97 web commit owner",
)
write("tests/integration/issue97RuntimeWebFollowup.test.ts", issue97)

regressions = read("scripts/run-regressions.mjs")
old_guard = '''  if (!app.includes('transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }') || !app.includes('type: "SYNC_UPLOAD_STARTED"') || !app.includes('type: "PLAYBACK_PREPARING"') || !beatDownloadsForRuntime.includes('type: "DOWNLOAD_STARTED"')) fail("App flows are no longer wired to the definitive runtime state machine.");
'''
new_guard = '''  if (!app.includes('transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }') || !cloudUploadQueue.includes('type: "SYNC_UPLOAD_STARTED"') || !cloudUploadQueue.includes('type: "PLAYBACK_PREPARING"') || !beatDownloadsForRuntime.includes('type: "DOWNLOAD_STARTED"')) fail("App flows are no longer wired to the definitive runtime state machine.");
'''
regressions = replace_once(regressions, old_guard, new_guard, "runtime flow owner regression")
regressions = replace_once(
    regressions,
    '''  if (!app.includes('assets/status/upload-complete.wav') || !app.includes('assets/status/download-complete.wav')) fail("User-supplied upload/download completion sounds are not wired into App.tsx.");
''',
    '''  if (!cloudUploadQueue.includes('assets/status/upload-complete.wav') || !app.includes('assets/status/download-complete.wav')) fail("User-supplied upload/download completion sounds are not wired into their runtime owners.");
''',
    "completion sound owner regression",
)
write("scripts/run-regressions.mjs", regressions)

main_tool = read(".github/task-6-4.py")
main_tool = replace_once(
    main_tool,
    '- .github/task-6-4.py — temporal, eliminado al cerrar.\\n- .github/workflows/task-6-4-apply.yml — temporal, eliminado al cerrar.\\n',
    '- .github/task-6-4.py — temporal, eliminado al cerrar.\\n- .github/task-6-4-fix.py — temporal, creado para adaptar pruebas estáticas acopladas al owner anterior y eliminado al cerrar.\\n- .github/workflows/task-6-4-apply.yml — temporal, eliminado al cerrar.\\n',
    "record corrective tool in Registro template",
)
write(".github/task-6-4.py", main_tool)
