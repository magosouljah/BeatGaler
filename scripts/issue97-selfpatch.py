from pathlib import Path

path = Path("src/App.tsx")
text = path.read_text(encoding="utf-8")

observer_old = '  useEffect(() => {\n    if (connectionState !== "online" || !cloudSessionVerified) return;\n    const next = new Map<string, string>();'
observer_new = '  useEffect(() => {\n    // Web edits are explicit durable transactions through platform.editor.\n    // Never let the legacy Desktop metadata observer invoke Tauri from Web.\n    if (platform.kind === "web") return;\n    if (connectionState !== "online" || !cloudSessionVerified) return;\n    const next = new Map<string, string>();'
if text.count(observer_old) != 1:
    raise SystemExit(f"expected exactly one metadata observer marker, found {text.count(observer_old)}")
text = text.replace(observer_old, observer_new, 1)

start_marker = '  const handleDropArtwork = useCallback(async (beat: Beat, imageBase64: string) => {'
end_marker = '\n\n\n  const runBeatCloudUpdate = useCallback'
start = text.find(start_marker)
end = text.find(end_marker, start)
if start < 0 or end < 0:
    raise SystemExit("handleDropArtwork markers not found")

replacement = '''  const handleDropArtwork = useCallback(async (beat: Beat, imageBase64: string) => {
    if (rejectOfflineMutation("Changing artwork")) return;

    const updated = { ...beat, image_base64: imageBase64, image_preview_base64: null };

    if (platform.kind === "web") {
      // Publish the browser-decoded artwork immediately, then commit it through
      // the Web editor/Direct transport. No Tauri metadata path participates.
      updateBeat(updated);
      transitionRuntime(updated.id, { type: "SYNC_UPDATE_STARTED" }, updated);
      try {
        const committed = await platform.editor.commit(beat, updated, {});
        setBeats(current => {
          const next = current.map(item => item.id === committed.id ? committed : item);
          beatsLatestRef.current = next;
          return next;
        });
        setDrawer(current => current?.beat.id === committed.id ? { ...current, beat: committed } : current);
        transitionRuntime(updated.id, { type: "SYNC_UPDATE_SUCCEEDED" }, committed);
      } catch (error) {
        const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
        transitionRuntime(updated.id, { type: "SYNC_FAILED", code: "ARTWORK_SYNC_FAILED", message, retryable: true }, updated);
        throw error;
      }
      return;
    }

    // Desktop keeps its existing native metadata/artwork transaction.
    await saveBeatMeta({
      mp3_path: beat.mp3_path,
      wav_path: beat.wav_path,
      bpm: beat.bpm,
      key: beat.key,
      tags: beat.tags,
      rating: beat.rating,
      image_base64: imageBase64,
      update_filename: false,
    });

    updateBeat(updated);

    if (updated.telegram_file_id && connectionState === "online") {
      const runtime = beatRuntimeStatesRef.current[updated.id] ?? createBeatRuntimeState(updated);
      if (runtime.sync_state === "synced") transitionRuntime(updated.id, { type: "SYNC_QUEUE_UPDATE" }, updated);
      transitionRuntime(updated.id, { type: "SYNC_UPDATE_STARTED" }, updated);
      try {
        await syncBeatMetadataToTelegram(updated);
        const indexSnapshot = beatsLatestRef.current.map(item => item.id === updated.id ? updated : item);
        await libraryStateManager.commitSnapshot(indexSnapshot, "upload-batch");
        if (cloudLibraryTimerRef.current) {
          window.clearTimeout(cloudLibraryTimerRef.current);
          cloudLibraryTimerRef.current = null;
        }
        cloudLibrarySnapshotRef.current = indexSnapshot
          .filter(item => !!item.telegram_file_id)
          .map(cloudBeatFingerprint)
          .join("\\u001c");
        cloudMetaSnapshotRef.current?.set(updated.id, cloudBeatFingerprint(updated));
        transitionRuntime(updated.id, { type: "SYNC_UPDATE_SUCCEEDED" }, updated);
      } catch (error) {
        const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
        transitionRuntime(updated.id, { type: "SYNC_FAILED", code: "ARTWORK_SYNC_FAILED", message, retryable: true }, updated);
        throw error;
      }
    }
  }, [updateBeat, rejectOfflineMutation, connectionState, transitionRuntime]);'''

text = text[:start] + replacement + text[end:]
path.write_text(text, encoding="utf-8")
