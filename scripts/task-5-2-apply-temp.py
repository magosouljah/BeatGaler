from pathlib import Path

app_path = Path("src/App.tsx")
app = app_path.read_text()

import_anchor = 'import { useDrawerCloudPersistence } from "./features/edit/useDrawerCloudPersistence";\n'
import_line = 'import { useBeatAssetUpdates } from "./features/edit/useBeatAssetUpdates";\n'
if import_line not in app:
    if import_anchor not in app:
        raise SystemExit("missing edit import anchor")
    app = app.replace(import_anchor, import_anchor + import_line, 1)

runner_start = app.find('  const runBeatCloudUpdate = useCallback((beat: Beat, filePath: string, work: () => Promise<void>) => {')
runner_end_marker = '  }, [rejectOfflineMutation, transitionRuntime]);\n'
runner_end = app.find(runner_end_marker, runner_start)
if runner_start < 0 or runner_end < 0:
    raise SystemExit("runBeatCloudUpdate block not found")
runner_end += len(runner_end_marker)
new_runner = '''  const {
    runBeatCloudUpdate,
    startMasterAssetUpdate,
    startWavAssetUpdate,
    handleBrowserBeatAssetDrop,
  } = useBeatAssetUpdates({
    rejectOfflineMutation,
    setBeatFileDrop,
    setBeatCloudUpdateBusy,
    beatRuntimeStatesRef,
    transitionRuntime,
    beatsLatestRef,
    cloudLibrarySnapshotRef,
    setBeats,
    setDrawer,
    waitForUploadedBeatPlaybackReady,
  });
'''
app = app[:runner_start] + new_runner + app[runner_end:]

main_start = app.find('    if (role === "main") {', app.find('const handleDroppedBeatFileRole'))
main_end_marker = '    if (role === "projectFolder") {'
main_end = app.find(main_end_marker, main_start)
if main_start < 0 or main_end < 0:
    raise SystemExit("main/wav role block not found")
new_main = '''    if (role === "main") {
      if (ext !== "mp3") return;
      startMasterAssetUpdate(beat, filePath);
      return;
    }

    if (role === "wav") {
      if (ext !== "wav") return;
      startWavAssetUpdate(beat, filePath);
      return;
    }

'''
app = app[:main_start] + new_main + app[main_end:]
old_deps = '  }, [beatFileDrop, hasStoredProject, runBeatCloudUpdate, startProjectAssetUpdate, waitForUploadedBeatPlaybackReady]);'
new_deps = '  }, [beatFileDrop, hasStoredProject, startMasterAssetUpdate, startProjectAssetUpdate, startWavAssetUpdate]);'
if old_deps not in app:
    raise SystemExit("dropped role dependency list not found")
app = app.replace(old_deps, new_deps, 1)

browser_start = app.find('    if (kind === "MASTER" && beat.telegram_file_id) {', app.find('const handleBrowserBeatFileDrop'))
browser_end_marker = '  }, [transitionRuntime]);\n'
browser_end = app.find(browser_end_marker, browser_start)
if browser_start < 0 or browser_end < 0:
    raise SystemExit("browser asset block not found")
browser_end += len(browser_end_marker)
new_browser = '''    if (kind === "MASTER" || kind === "WAV") {
      return handleBrowserBeatAssetDrop(beat, file, kind);
    }

    transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }, beat);
    transitionRuntime(beat.id, { type: "SYNC_UPDATE_STARTED" }, beat);
    try {
      const committed = await platform.editor.commit(beat, beat, { PROJECT: file });
      setBeats(current => {
        const next = current.map(item => item.id === committed.id ? committed : item);
        beatsLatestRef.current = next;
        return next;
      });
      setDrawer(current => current?.beat.id === committed.id ? { ...current, beat: committed } : current);
      transitionRuntime(beat.id, { type: "SYNC_UPDATE_SUCCEEDED" }, committed);
      return false;
    } catch (error) {
      const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
      transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "WEB_FILE_UPDATE_FAILED", message, retryable: true }, beat);
      throw error;
    }
  }, [handleBrowserBeatAssetDrop, transitionRuntime]);
'''
app = app[:browser_start] + new_browser + app[browser_end:]

app_path.write_text(app)
