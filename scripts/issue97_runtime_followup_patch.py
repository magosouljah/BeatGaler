from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, got {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


# Existing-beat Web edits must upload into the authoritative beat topic.
replace_once(
    "src/features/edit/webBeatEdit.ts",
    'input: { file: File; filename: string; beatId: string; beatName: string; kind: EditUploadKind },',
    'input: { file: File; filename: string; beatId: string; beatName: string; threadId?: number | null; kind: EditUploadKind },',
)
replace_once(
    "src/features/edit/webBeatEdit.ts",
    '  const artworkChanged = (updated.image_base64 || null) !== (original.image_base64 || null);',
    '''  const existing = manifest.beats[existingIndex];
  const topicCandidate = Number(existing.telegram_topic_id || 0);
  const existingThreadId = Number.isInteger(topicCandidate) && topicCandidate > 0 ? topicCandidate : null;

  const artworkChanged = (updated.image_base64 || null) !== (original.image_base64 || null);''',
)
replace_once(
    "src/features/edit/webBeatEdit.ts",
    '''      beatId: original.id,
      beatName: updated.name,
      kind: item.kind,''',
    '''      beatId: original.id,
      beatName: updated.name,
      threadId: existingThreadId,
      kind: item.kind,''',
)
replace_once(
    "src/features/edit/webBeatEdit.ts",
    '  const existing = manifest.beats[existingIndex];\n  const next: JsonRecord = {',
    '  const next: JsonRecord = {',
)

replace_once(
    "src/features/cloud/webGalerCloudTransport.ts",
    '''        upload: async (input, progress) => {
          topic ||= ensureWebTransportTopic(input.beatId, input.beatName);
          const threadId = await topic;
          return this.uploadOnce({ ...input, threadId }, progress);
        },
        replaceLibraryIndex: input => this.worker.replaceLibraryIndex(input),
      }, onProgress);
      await commitWebTransportIndexPointer({''',
    '''        upload: async (input, progress) => {
          const hintedThreadId = Number(input.threadId || 0);
          let threadId = Number.isInteger(hintedThreadId) && hintedThreadId > 0 ? hintedThreadId : 0;
          if (!threadId) {
            topic ||= ensureWebTransportTopic(input.beatId, input.beatName);
            threadId = await topic;
          }
          return this.uploadOnce({ ...input, threadId }, progress);
        },
        replaceLibraryIndex: input => this.worker.replaceLibraryIndex(input),
      }, onProgress);
      await commitWebTransportIndexPointer({''',
)

# Browser import owns File objects end-to-end; release only after durable success.
replace_once(
    "src/platform/webAdapter.ts",
    '''        return await transport.commitImportedBeat(beat, {
          master,
          wav: slots.WAV,
          project: slots.PROJECT,
        }, webClientId, onProgress);''',
    '''        const committed = await transport.commitImportedBeat(beat, {
          master,
          wav: slots.WAV,
          project: slots.PROJECT,
        }, webClientId, onProgress);
        webImportPort.releaseBeat(beat.id);
        return committed;''',
)

# Let the HTML controller hand real browser Files to Web instead of staging Desktop paths.
replace_once(
    "src/features/dragdrop/htmlDropController.ts",
    '''  onBeatFileDrop: (beatId: string, roots: HtmlDroppedRoot[]) => boolean | void | Promise<boolean | void>;
  onBeatFileStagingChange?: (beatId: string, active: boolean) => void;''',
    '''  onBeatFileDrop: (beatId: string, roots: HtmlDroppedRoot[]) => boolean | void | Promise<boolean | void>;
  onBrowserBeatFileDrop?: (beatId: string, files: File[]) => boolean | void | Promise<boolean | void>;
  onBeatFileStagingChange?: (beatId: string, active: boolean) => void;''',
)
replace_once(
    "src/features/dragdrop/htmlDropController.ts",
    '''    const beatId = card?.dataset.beatCardId ?? lastBeatUpdateId;
    if (!beatId && options.onBrowserLibraryFileDrop) {''',
    '''    const beatId = card?.dataset.beatCardId ?? lastBeatUpdateId;
    if (beatId && options.onBrowserBeatFileDrop) {
      const files = Array.from(dt.files || []);
      clearAll();
      void (async () => {
        try {
          if (files.length === 0) {
            await options.onEmptyFileDrop?.();
            return;
          }
          options.onBeatFileStagingChange?.(beatId, true);
          const keepBusy = await options.onBrowserBeatFileDrop?.(beatId, files);
          if (!keepBusy) options.onBeatFileStagingChange?.(beatId, false);
        } catch (error) {
          options.onBeatFileStagingChange?.(beatId, false);
          await options.onError?.(error);
        }
      })();
      return;
    }
    if (!beatId && options.onBrowserLibraryFileDrop) {''',
)

# Web imports commit through platform.cloudData, never the Desktop/Tauri background uploader.
replace_once(
    "src/App.tsx",
    '''  const cloudifyImportedBeats = useCallback((newBeats: Beat[]) => {
    if (newBeats.length === 0) return;

    // Do not trust the React settings snapshot here.''',
    '''  const cloudifyImportedBeats = useCallback((newBeats: Beat[]) => {
    if (newBeats.length === 0) return;

    if (platform.capabilities.reviewBeatCloudCommit) {
      for (const beat of newBeats) {
        if (autoCloudUploadRef.current.has(beat.id)) continue;
        autoCloudUploadRef.current.add(beat.id);
        transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPLOAD" }, beat);
        transitionRuntime(beat.id, { type: "SYNC_UPLOAD_STARTED" }, beat);
        setBackgroundUploadErrors(current => {
          if (!(beat.id in current)) return current;
          const next = { ...current };
          delete next[beat.id];
          return next;
        });
        setBeats(current => {
          const next = current.map(item => item.id === beat.id ? { ...item, cloud_status: "UPLOADING" } : item);
          beatsLatestRef.current = next;
          return next;
        });

        void platform.cloudData.commitImportedBeat(beat).then(committed => {
          transitionRuntime(committed.id, { type: "SYNC_UPLOAD_SUCCEEDED" }, committed);
          setBackgroundUploadErrors(current => {
            if (!(committed.id in current)) return current;
            const next = { ...current };
            delete next[committed.id];
            return next;
          });
          setBeats(current => {
            const next = current.map(item => item.id === committed.id ? committed : item);
            beatsLatestRef.current = next;
            return next;
          });
        }).catch(error => {
          const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
          transitionRuntime(beat.id, {
            type: "SYNC_FAILED",
            code: "WEB_IMPORT_FAILED",
            message,
            retryable: true,
          }, beat);
          setBackgroundUploadErrors(current => ({ ...current, [beat.id]: message }));
          setBeats(current => {
            const next = current.map(item => item.id === beat.id ? { ...item, cloud_status: "ERROR" } : item);
            beatsLatestRef.current = next;
            return next;
          });
        }).finally(() => {
          autoCloudUploadRef.current.delete(beat.id);
        });
      }
      return;
    }

    // Do not trust the React settings snapshot here.''',
)

marker = '''\n\n  // Browser/Pinterest controller. Windows desktop keeps the existing single native\n'''
insert = '''\n\n  const importDroppedBrowserFiles = useCallback(async (files: File[]) => {
    if (rejectOfflineMutation("Importing beats")) return;
    if (dropImporting) return;

    const supported = files.filter(file =>
      /\\.(mp3|wav)$/i.test(file.name) ||
      file.type === "audio/mpeg" ||
      file.type === "audio/wav" ||
      file.type === "audio/x-wav"
    );
    if (supported.length === 0) {
      await appAlert({ title: "Nothing to import", message: "Drop an MP3 or WAV file to add a beat." });
      return;
    }
    if (supported.length > 1) {
      await appAlert({ title: "Drop one beat at a time", message: "BeatGaler Web imports one beat per drag action." });
      return;
    }

    setDropImporting(true);
    setDropActive(false);
    try {
      const candidate = platform.importer.fromFile(supported[0]);
      const hydrated = await candidate.hydrated.catch(() => candidate.beat);
      const beat = { ...hydrated, tags: cleanTags(hydrated.tags || []).tags };
      setShowAdd(false);
      setReviewPreparationDone(true);
      setReviewBootstrap(null);
      setDeferredImportBatch(null);
      setAudioConflictBatch(null);
      setDropImportBatch(null);
      setReviewQueue({ beats: [beat], index: 0, total: 1, batchId: null, preparing: false });
    } catch (error) {
      await appAlert({ title: "Import failed", message: String(error), danger: true });
    } finally {
      setDropImporting(false);
    }
  }, [dropImporting, rejectOfflineMutation]);

  const handleBrowserBeatFileDrop = useCallback(async (beatId: string, files: File[]): Promise<boolean> => {
    const beat = beatsLatestRef.current.find(item => item.id === beatId);
    if (!beat) throw new Error(`Dropped file target beat was not found: ${beatId}`);
    if (files.length !== 1) {
      await appAlert({ title: "Drop one file at a time", message: "Drop one MP3, WAV, or PROJECT ZIP on a beat." });
      return false;
    }

    const file = files[0];
    const name = file.name.toLowerCase();
    const kind = name.endsWith(".mp3") ? "MASTER" : name.endsWith(".wav") ? "WAV" : name.endsWith(".zip") ? "PROJECT" : null;
    if (!kind) {
      await appAlert({ title: "Unsupported file", message: "BeatGaler Web accepts MP3, WAV, or PROJECT ZIP files on an existing beat." });
      return false;
    }

    if (kind === "MASTER" && beat.telegram_file_id) {
      const replace = await appConfirm({
        title: "Replace MASTER?",
        message: `Replace the current MASTER for "${beat.name}" with ${file.name}?`,
        confirmLabel: "Replace",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!replace) return false;
    }

    transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }, beat);
    transitionRuntime(beat.id, { type: "SYNC_UPDATE_STARTED" }, beat);
    try {
      const committed = await platform.editor.commit(beat, beat, { [kind]: file });
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
  }, [transitionRuntime]);

  // Browser/Pinterest controller. Windows desktop keeps the existing single native
'''
replace_once("src/App.tsx", marker, insert)

replace_once(
    "src/App.tsx",
    '''      onLibraryFileDrop: async roots => {
        await importDroppedPaths(roots.map(root => root.path));
      },''',
    '''      onBrowserBeatFileDrop: platform.capabilities.browserFileImport ? handleBrowserBeatFileDrop : undefined,
      onBrowserLibraryFileDrop: platform.capabilities.browserFileImport ? importDroppedBrowserFiles : undefined,
      onLibraryFileDrop: async roots => {
        await importDroppedPaths(roots.map(root => root.path));
      },''',
)
replace_once(
    "src/App.tsx",
    '  }, [handleAutoProjectDrop, handleDropArtwork, importDroppedPaths]);',
    '  }, [handleAutoProjectDrop, handleBrowserBeatFileDrop, handleDropArtwork, importDroppedBrowserFiles, importDroppedPaths]);',
)

# Browser cancel/skip releases object URLs/files; success releases in webAdapter.
replace_once(
    "src/App.tsx",
    '''      const currentBeat = q.beats[q.index];
      const sourceKey = currentBeat ? reviewSourceKey(currentBeat) : "";
      if (sourceKey) skippedReviewSourceKeysRef.current.add(sourceKey);''',
    '''      const currentBeat = q.beats[q.index];
      const sourceKey = currentBeat ? reviewSourceKey(currentBeat) : "";
      if (sourceKey) skippedReviewSourceKeysRef.current.add(sourceKey);
      if (platform.capabilities.reviewBeatCloudCommit && currentBeat) platform.importer.releaseBeat(currentBeat.id);''',
)
replace_once(
    "src/App.tsx",
    '''    setReviewQueue(q => {
      if (!q) return null;
      if (q.batchId) void discardImportReviewBatch(q.batchId);''',
    '''    setReviewQueue(q => {
      if (!q) return null;
      if (platform.capabilities.reviewBeatCloudCommit) {
        for (const beat of q.beats.slice(q.index)) platform.importer.releaseBeat(beat.id);
      }
      if (q.batchId) void discardImportReviewBatch(q.batchId);''',
)

# Web Save All still owns Desktop metadata paths; hide it until browser batch transaction exists.
replace_once(
    "src/App.tsx",
    '          onSaveAll={handleReviewedSaveAll}',
    '          onSaveAll={platform.capabilities.reviewBeatCloudCommit ? undefined : handleReviewedSaveAll}',
)

# Never queue native Download Cooking from Web cards; keep at most one background artwork op ahead of foreground Play.
replace_once(
    "src/App.tsx",
    '''  const handleWarm = useCallback((beat: Beat) => {
    void ensureWarmPlaybackUrl(beat);
  }, [ensureWarmPlaybackUrl]);''',
    '''  const handleWarm = useCallback((beat: Beat) => {
    if (!platform.capabilities.playbackCache) return;
    void ensureWarmPlaybackUrl(beat);
  }, [ensureWarmPlaybackUrl]);''',
)
replace_once(
    "src/App.tsx",
    '    const workerCount = Math.min(isTauriAvailable ? 6 : 3, queue.length);',
    '    const workerCount = Math.min(isTauriAvailable ? 6 : 1, queue.length);',
)

# Focused regression: authoritative topic reuse + browser-file routing contracts.
test = Path("tests/integration/issue97RuntimeWebFollowup.test.ts")
test.write_text(r'''import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Beat } from "../../src/types";
import { commitWebBeatEdit } from "../../src/features/edit/webBeatEdit";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Issue #97 production runtime follow-up", () => {
  it("reuses the authoritative existing topic for an existing-beat upload", async () => {
    const original = {
      id: "beat-1",
      name: "Same Beat",
      bpm: "120",
      key: "Cm",
      tags: [],
      rating: 0,
      color: "#111111",
      color2: "#222222",
      telegram_file_id: "direct:101",
      telegram_message_id: 101,
      image_base64: null,
    } as unknown as Beat;
    const updated = { ...original, bpm: "121" };
    const uploadedInputs: Array<Record<string, unknown>> = [];
    const runtime = {
      getLibraryIndex: vi.fn(async () => ({
        messageId: 500,
        manifest: {
          schema: "beatgaler.telegram.library",
          version: 2,
          beats: [{
            id: "beat-1",
            name: "Same Beat",
            bpm: "120",
            key: "Cm",
            tags: [],
            rating: 0,
            color: "#111111",
            color2: "#222222",
            telegram_topic_id: 4242,
            master: { telegram_message_id: 101, filename: "old.mp3", mime: "audio/mpeg", size: 10 },
          }],
          trash: [],
        },
      })),
      upload: vi.fn(async (input: Record<string, unknown>) => {
        uploadedInputs.push(input);
        return {
          telegram_file_id: "file-new",
          telegram_message_id: 202,
          filename: "new.mp3",
          original_size: 3,
          parts: [],
          transport: "direct-web" as const,
        };
      }),
      replaceLibraryIndex: vi.fn(async () => ({ messageId: 501, beatCount: 1, updated: true })),
    };

    await commitWebBeatEdit(original, updated, { MASTER: new File(["abc"], "new.mp3", { type: "audio/mpeg" }) }, runtime);
    expect(uploadedInputs).toHaveLength(1);
    expect(uploadedInputs[0].threadId).toBe(4242);
  });

  it("routes browser drops through browser File owners, not Desktop path staging", () => {
    const app = source("src/App.tsx");
    const controller = source("src/features/dragdrop/htmlDropController.ts");
    expect(app).toContain("onBrowserLibraryFileDrop: platform.capabilities.browserFileImport ? importDroppedBrowserFiles : undefined");
    expect(app).toContain("onBrowserBeatFileDrop: platform.capabilities.browserFileImport ? handleBrowserBeatFileDrop : undefined");
    expect(app).toContain("platform.cloudData.commitImportedBeat(beat)");
    expect(controller).toContain("options.onBrowserBeatFileDrop");
  });

  it("does not let Web card warming queue native cooking ahead of Play", () => {
    const app = source("src/App.tsx");
    expect(app).toContain("if (!platform.capabilities.playbackCache) return;");
    expect(app).toContain("Math.min(isTauriAvailable ? 6 : 1, queue.length)");
  });

  it("existing Web edit transport prefers the manifest thread hint", () => {
    const edit = source("src/features/cloud/webGalerCloudTransport.ts");
    expect(edit).toContain("const hintedThreadId = Number(input.threadId || 0)");
    expect(edit).toContain("if (!threadId)");
  });
});
''')
