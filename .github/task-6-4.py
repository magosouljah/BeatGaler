from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INITIAL_SHA = "0ef4255d528e726dd278ba7389575f6d260fe333"


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


HOOK = r'''import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import uploadCompleteWav from "../../assets/status/upload-complete.wav";
import type { AppSettings, Beat } from "../../types";
import { platform } from "../../platform";
import {
  detachLocalSourcesAfterCloudUpload,
  getProjectCloudStatus,
  listCloudFilesForBeat,
  pollTelegramCloudStatus,
  syncBeatMetadataToTelegram,
  uploadBeatToTelegram,
  uploadDroppedFileToTelegram,
  uploadProjectToTelegram,
} from "../../lib/tauri";
import { libraryStateManager } from "../../lib/libraryStateManager";
import { sanitizeUserVisibleText } from "../../lib/userVisibleError";
import { cleanupOrphanedDropStaging } from "../dragdrop/dropStaging";
import { cloudBeatFingerprint } from "../library/libraryFingerprints";
import { clearCloudUploadActive, markCloudUploadActive } from "./interruptedUploadJournal";
import {
  buildCloudSessionUnavailableDetail,
  buildPlaybackPreparationFailureDetail,
  buildUploadFailureDetail,
} from "./uploadErrorDetails";
import { DesktopBeatUploadPipelineError, runDesktopBeatUploadPipeline } from "./desktopBeatUploadPipeline";

type ConnectionState = "checking" | "online" | "poor" | "offline";

type UseCloudUploadQueueInput = {
  settings: AppSettings | null;
  setSettings: Dispatch<SetStateAction<AppSettings | null>>;
  setConnectionState: Dispatch<SetStateAction<ConnectionState>>;
  setBeats: Dispatch<SetStateAction<Beat[]>>;
  beatsLatestRef: MutableRefObject<Beat[]>;
  beatRuntimeStatesRef: MutableRefObject<any>;
  transitionRuntime: (beatId: string, event: any, beat: Beat) => void;
  cloudLibrarySnapshotRef: MutableRefObject<string | null>;
  waitForUploadedBeatPlaybackReady: (beat: Beat) => Promise<boolean>;
  rejectOfflineMutation: (action: string) => boolean;
  isReviewActive: () => boolean;
  hasProtectedStaging: () => boolean;
};

function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useCloudUploadQueue({
  settings,
  setSettings,
  setConnectionState,
  setBeats,
  beatsLatestRef,
  beatRuntimeStatesRef,
  transitionRuntime,
  cloudLibrarySnapshotRef,
  waitForUploadedBeatPlaybackReady,
  rejectOfflineMutation,
  isReviewActive,
  hasProtectedStaging,
}: UseCloudUploadQueueInput) {
  const autoCloudUploadRef = useRef<Set<string>>(new Set());
  const backgroundUploadQueueRef = useRef<Beat[]>([]);
  const backgroundUploadRunningRef = useRef(false);
  const deferredLibraryReloadRef = useRef(false);
  const uploadCompleteTimersRef = useRef<Map<string, number>>(new Map());
  const [backgroundUploadErrors, setBackgroundUploadErrors] = useState<Record<string, string>>({});

  const finishDeferredReloadIfIdle = useCallback(() => {
    if (
      backgroundUploadRunningRef.current ||
      backgroundUploadQueueRef.current.length > 0 ||
      autoCloudUploadRef.current.size > 0
    ) {
      return;
    }
    if (!deferredLibraryReloadRef.current) return;
    deferredLibraryReloadRef.current = false;
    window.dispatchEvent(new Event("beatgaler:deferred-library-reload"));
  }, []);

  const waitForCloudSessionWithBackoff = useCallback(async () => {
    const delays = [0, 1000, 2000, 5000, 10000, 30000, 60000];
    let lastError: unknown = null;

    for (const delay of delays) {
      if (delay > 0) await new Promise(resolve => window.setTimeout(resolve, delay));
      try {
        const status = await pollTelegramCloudStatus();
        if (!status.reachable) {
          lastError = new Error("Galer Cloud is temporarily unreachable.");
          setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
          continue;
        }
        if (!status.connected) return { status, error: null as unknown };
        setConnectionState("online");
        return { status, error: null as unknown };
      } catch (error) {
        lastError = error;
        setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
      }
    }

    return {
      status: {
        connected: Boolean(settings?.telegram_cloud_connected),
        reachable: false,
        username: settings?.telegram_cloud_username ?? null,
      },
      error: lastError,
    };
  }, [settings?.telegram_cloud_connected, settings?.telegram_cloud_username, setConnectionState]);

  const cloudifyImportedBeats = useCallback((newBeats: Beat[]) => {
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
          finishDeferredReloadIfIdle();
        });
      }
      return;
    }

    // Desktop queues work immediately and processes exactly one beat at a time.
    for (const beat of newBeats) {
      const alreadyQueued = backgroundUploadQueueRef.current.some(item => item.id === beat.id);
      if (alreadyQueued || autoCloudUploadRef.current.has(beat.id)) continue;
      markCloudUploadActive(beat);
      backgroundUploadQueueRef.current.push(beat);
      transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPLOAD" }, beat);
      setBackgroundUploadErrors(current => {
        if (!(beat.id in current)) return current;
        const next = { ...current };
        delete next[beat.id];
        return next;
      });
      setBeats(current => current.map(item =>
        item.id === beat.id ? { ...item, cloud_status: "UPLOADING" } : item
      ));
    }

    if (backgroundUploadRunningRef.current) return;
    backgroundUploadRunningRef.current = true;

    window.setTimeout(() => {
      void (async () => {
        try {
          const verified = await waitForCloudSessionWithBackoff();
          const cloudSession = verified.status;
          const sessionCheckError = verified.error;
          if (sessionCheckError) {
            console.warn("Background upload could not verify Telegram session after backoff:", sessionCheckError);
          }

          if (!cloudSession.connected || !cloudSession.reachable) {
            const failed = backgroundUploadQueueRef.current.splice(0);
            const { raw, detail } = buildCloudSessionUnavailableDetail(sessionCheckError);

            setBackgroundUploadErrors(current => {
              const next = { ...current };
              for (const item of failed) next[item.id] = detail;
              return next;
            });
            for (const item of failed) {
              transitionRuntime(item.id, {
                type: "SYNC_FAILED",
                code: "TELEGRAM_SESSION_UNAVAILABLE",
                message: raw,
                retryable: true,
              }, item);
            }
            setBeats(current => current.map(beat =>
              failed.some(item => item.id === beat.id)
                ? { ...beat, cloud_status: "ERROR" }
                : beat
            ));
            return;
          }

          setSettings(current =>
            current
              ? {
                  ...current,
                  telegram_cloud_connected: true,
                  telegram_cloud_username: cloudSession.username,
                }
              : current
          );

          while (backgroundUploadQueueRef.current.length > 0) {
            const original = backgroundUploadQueueRef.current.shift()!;
            if (autoCloudUploadRef.current.has(original.id)) continue;
            autoCloudUploadRef.current.add(original.id);

            transitionRuntime(original.id, { type: "SYNC_UPLOAD_STARTED" }, original);
            try {
              const pipelineResult = await runDesktopBeatUploadPipeline({
                original,
                dependencies: {
                  uploadMaster: uploadBeatToTelegram,
                  listCloudFiles: listCloudFilesForBeat,
                  uploadWav: (beat, path) => uploadDroppedFileToTelegram(beat, path, "WAV"),
                  getProjectStatus: getProjectCloudStatus,
                  uploadProject: uploadProjectToTelegram,
                  detachLocalSources: detachLocalSourcesAfterCloudUpload,
                  syncMetadata: syncBeatMetadataToTelegram,
                  commitSnapshot: (snapshot, reason) => libraryStateManager.commitSnapshot(snapshot, reason),
                  clearUploadMarker: clearCloudUploadActive,
                  waitForPlaybackReady: waitForUploadedBeatPlaybackReady,
                },
                actions: {
                  onMasterUploaded: uploaded => {
                    setBeats(current => current.map(beat =>
                      beat.id === uploaded.id ? { ...uploaded, cloud_status: "UPLOADING" } : beat
                    ));
                  },
                  onDetached: detached => {
                    setBackgroundUploadErrors(current => {
                      if (!(detached.id in current)) return current;
                      const next = { ...current };
                      delete next[detached.id];
                      return next;
                    });
                    setBeats(current => {
                      const next = current.map(beat =>
                        beat.id === detached.id ? { ...detached, cloud_status: "PLAYBACK_PREPARING" } : beat
                      );
                      beatsLatestRef.current = next;
                      return next;
                    });
                  },
                  getLibrarySnapshot: () => beatsLatestRef.current,
                  onIndexCommitted: (detached, indexSnapshot) => {
                    cloudLibrarySnapshotRef.current = indexSnapshot
                      .filter(item => !!item.telegram_file_id)
                      .map(cloudBeatFingerprint)
                      .join("\u001c");
                    transitionRuntime(detached.id, { type: "SYNC_UPLOAD_SUCCEEDED" }, detached);
                  },
                  onPlaybackPreparing: detached => {
                    transitionRuntime(detached.id, { type: "PLAYBACK_PREPARING" }, detached);
                  },
                },
              });

              const detached = pipelineResult.beat;
              const playbackReady = pipelineResult.playbackReady;

              if (!playbackReady) {
                const detail = buildPlaybackPreparationFailureDetail(detached.name);
                setBackgroundUploadErrors(current => ({ ...current, [detached.id]: detail }));
                transitionRuntime(detached.id, {
                  type: "PLAYBACK_FAILED",
                  code: "MASTER_PREPARE_TIMEOUT",
                  message: detail,
                  retryable: true,
                }, detached);
                setBeats(current => {
                  const next = current.map(beat =>
                    beat.id === detached.id ? { ...detached, cloud_status: "ERROR" } : beat
                  );
                  beatsLatestRef.current = next;
                  return next;
                });
              } else {
                transitionRuntime(detached.id, { type: "PLAYBACK_IDLE" }, detached);
                setBeats(current => {
                  const next = current.map(beat =>
                    beat.id === detached.id ? { ...detached, cloud_status: "UPLOAD_COMPLETE" } : beat
                  );
                  beatsLatestRef.current = next;
                  return next;
                });
              }

              // App still owns Review/import staging. The queue only reads whether
              // those owners still protect sources before orphan cleanup can run.
              if (
                backgroundUploadQueueRef.current.length === 0 &&
                !isReviewActive() &&
                !hasProtectedStaging()
              ) {
                await cleanupOrphanedDropStaging(beatsLatestRef.current);
              }

              if (playbackReady) {
                try {
                  const audio = new Audio(uploadCompleteWav);
                  audio.volume = 0.22;
                  void audio.play().catch(() => {});
                } catch {}

                const oldTimer = uploadCompleteTimersRef.current.get(detached.id);
                if (oldTimer) window.clearTimeout(oldTimer);
                const timer = window.setTimeout(() => {
                  setBeats(current => {
                    const next = current.map(beat =>
                      beat.id === detached.id && beat.cloud_status === "UPLOAD_COMPLETE"
                        ? { ...beat, cloud_status: "CLOUD_ONLY" }
                        : beat
                    );
                    beatsLatestRef.current = next;
                    return next;
                  });
                  uploadCompleteTimersRef.current.delete(detached.id);
                }, 1050);
                uploadCompleteTimersRef.current.set(detached.id, timer);
              }
            } catch (error) {
              const pipelineError = error instanceof DesktopBeatUploadPipelineError ? error : null;
              const uploadStage = pipelineError?.stage ?? "Prepare upload";
              const remoteUploadCompleted = pipelineError?.remoteUploadCompleted ?? false;
              const syncCommitted = pipelineError?.syncCommitted ?? false;
              const reportedError = pipelineError?.originalError ?? error;
              console.warn(`Background Telegram upload failed for ${original.name} at ${uploadStage}:`, reportedError);

              const detail = buildUploadFailureDetail({
                beatName: original.name,
                stage: uploadStage,
                platform: navigator.platform || "unknown",
                error: reportedError,
              });

              if (!syncCommitted) {
                transitionRuntime(original.id, {
                  type: "SYNC_FAILED",
                  code: "UPLOAD_FAILED",
                  message: detail,
                  retryable: true,
                }, original);
              } else {
                const runtime = beatRuntimeStatesRef.current[original.id];
                if (runtime?.playback_state === "playback_preparing") {
                  transitionRuntime(original.id, {
                    type: "PLAYBACK_FAILED",
                    code: "PLAYBACK_PREPARATION_FAILED",
                    message: detail,
                    retryable: true,
                  }, original);
                }
              }
              setBackgroundUploadErrors(current => ({ ...current, [original.id]: detail }));
              setBeats(current => current.map(beat =>
                beat.id === original.id
                  ? { ...beat, cloud_status: remoteUploadCompleted ? "CLOUD_ONLY" : "ERROR" }
                  : beat
              ));
            } finally {
              autoCloudUploadRef.current.delete(original.id);
            }

            await new Promise<void>(resolve => window.setTimeout(resolve, 0));
          }
        } finally {
          backgroundUploadRunningRef.current = false;
          finishDeferredReloadIfIdle();
        }
      })();
    }, 0);
  }, [
    beatRuntimeStatesRef,
    beatsLatestRef,
    cloudLibrarySnapshotRef,
    finishDeferredReloadIfIdle,
    hasProtectedStaging,
    isReviewActive,
    setBeats,
    setSettings,
    transitionRuntime,
    waitForCloudSessionWithBackoff,
    waitForUploadedBeatPlaybackReady,
  ]);

  const retryBackgroundUpload = useCallback((beat: Beat) => {
    if (rejectOfflineMutation("Retrying an upload")) return;
    setBackgroundUploadErrors(current => {
      if (!(beat.id in current)) return current;
      const next = { ...current };
      delete next[beat.id];
      return next;
    });
    cloudifyImportedBeats([{ ...beat, cloud_status: "UPLOADING" }]);
  }, [cloudifyImportedBeats, rejectOfflineMutation]);

  const getQueuedBeatsSnapshot = useCallback(
    () => [...backgroundUploadQueueRef.current],
    [],
  );

  const deferLibraryReloadIfUploading = useCallback(() => {
    const uploadInFlight =
      backgroundUploadRunningRef.current ||
      backgroundUploadQueueRef.current.length > 0 ||
      autoCloudUploadRef.current.size > 0;
    if (!uploadInFlight) return false;
    deferredLibraryReloadRef.current = true;
    console.info(`[library-refresh] DEFERRED active_uploads=${autoCloudUploadRef.current.size}`);
    return true;
  }, []);

  return {
    backgroundUploadErrors,
    cloudifyImportedBeats,
    retryBackgroundUpload,
    getQueuedBeatsSnapshot,
    deferLibraryReloadIfUploading,
    deferredLibraryReloadRef,
  };
}
'''

EXTRACTION_TEST = r'''import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const queue = readFileSync(resolve(process.cwd(), "src/features/cloud/useCloudUploadQueue.ts"), "utf8");

function expectOrdered(source: string, markers: string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    expect(index, `Missing queue contract marker: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("task 6.4 cloud upload queue extraction", () => {
  it("moves queue ownership out of App while preserving the small Review/staging read bridge", () => {
    expect(app).toContain("useCloudUploadQueue({");
    expect(app).not.toContain("const backgroundUploadQueueRef = useRef");
    expect(app).not.toContain("const autoCloudUploadRef = useRef");
    expect(app).not.toContain("const backgroundUploadRunningRef = useRef");
    expect(app).toContain("isReviewActive: () => reviewQueueLatestRef.current !== null");
    expect(app).toContain("hasProtectedStaging: () => stagedImportPathsRef.current.size > 0");
    expect(queue).toContain("const backgroundUploadQueueRef = useRef<Beat[]>([])");
    expect(queue).toContain("const autoCloudUploadRef = useRef<Set<string>>(new Set())");
  });

  it("keeps Desktop uploads sequential and routes each item through the 6.3 pipeline", () => {
    expectOrdered(queue, [
      "while (backgroundUploadQueueRef.current.length > 0)",
      "const original = backgroundUploadQueueRef.current.shift()!",
      "await runDesktopBeatUploadPipeline({",
      "await new Promise<void>(resolve => window.setTimeout(resolve, 0))",
    ]);
  });

  it("keeps the existing Web commit path separate from the Desktop worker", () => {
    expectOrdered(queue, [
      "if (platform.capabilities.reviewBeatCloudCommit)",
      "platform.cloudData.commitImportedBeat(beat)",
      "markCloudUploadActive(beat)",
    ]);
  });

  it("runs a deferred Reload only after every queued or active upload has drained", () => {
    expect(queue).toContain("deferLibraryReloadIfUploading");
    expect(queue).toContain("finishDeferredReloadIfIdle");
    expect(queue).toContain('window.dispatchEvent(new Event("beatgaler:deferred-library-reload"))');
    expectOrdered(queue, [
      "backgroundUploadRunningRef.current = false",
      "finishDeferredReloadIfIdle();",
    ]);
    expect(app).toContain("if (deferLibraryReloadIfUploading())");
    expect(app).toContain('window.addEventListener("beatgaler:deferred-library-reload", runDeferredReload)');
  });

  it("preserves staging until the queue is empty and Review/import no longer protects it", () => {
    expect(queue).toContain("backgroundUploadQueueRef.current.length === 0");
    expect(queue).toContain("!isReviewActive()");
    expect(queue).toContain("!hasProtectedStaging()");
    expect(queue).toContain("cleanupOrphanedDropStaging(beatsLatestRef.current)");
  });

  it("keeps failed-upload retry connected to the checkpoint-aware queue", () => {
    expect(queue).toContain('cloudifyImportedBeats([{ ...beat, cloud_status: "UPLOADING" }])');
    expect(app).toContain("onRetryUpload={retryBackgroundUpload}");
  });
});
'''


def apply() -> None:
    app = read("src/App.tsx")
    app = replace_once(app, 'import uploadCompleteWav from "./assets/status/upload-complete.wav";\n', '', "remove completion sound import")
    app = replace_once(
        app,
        'import { clearCloudUploadActive, markCloudUploadActive, readActiveCloudUploads, rollbackInterruptedCloudUploads } from "./features/cloud/interruptedUploadJournal";\nimport { buildCloudSessionUnavailableDetail, buildPlaybackPreparationFailureDetail, buildUploadFailureDetail } from "./features/cloud/uploadErrorDetails";\nimport { DesktopBeatUploadPipelineError, runDesktopBeatUploadPipeline } from "./features/cloud/desktopBeatUploadPipeline";\n',
        'import { readActiveCloudUploads, rollbackInterruptedCloudUploads } from "./features/cloud/interruptedUploadJournal";\nimport { useCloudUploadQueue } from "./features/cloud/useCloudUploadQueue";\n',
        "replace cloud queue imports",
    )
    for token in ["listCloudFilesForBeat, ", "getProjectCloudStatus, ", "detachLocalSourcesAfterCloudUpload, "]:
        app = replace_once(app, token, "", f"remove queue-owned tauri import {token}")

    app = replace_once(app, '  const autoCloudUploadRef = useRef<Set<string>>(new Set());\n  const backgroundUploadQueueRef = useRef<Beat[]>([]);\n', '', "remove upload refs")
    app = replace_once(
        app,
        '  const backgroundUploadRunningRef = useRef(false);\n  // A manual Reload pressed during an import must never overwrite the optimistic\n  // in-flight rows with the older committed Telegram INDEX. Queue the reload and\n  // execute it after the batch commits instead.\n  const deferredLibraryReloadRef = useRef(false);\n  const uploadCompleteTimersRef = useRef<Map<string, number>>(new Map());\n',
        '',
        "remove worker refs",
    )
    app = replace_once(app, '  const [backgroundUploadErrors, setBackgroundUploadErrors] = useState<Record<string, string>>({});\n', '', "remove queue errors")

    start = app.index('  const waitForCloudSessionWithBackoff = useCallback(async () => {')
    end = app.index('  const addBeatsAndReview = useCallback', start)
    if start < 0 or end < 0:
        raise SystemExit("could not locate upload queue block in App.tsx")
    app = app[:start] + app[end:]

    reject = '''  const rejectOfflineMutation = useCallback((action: string): boolean => {
    if (connectionState === "online") return false;
    void appAlert({
      title: connectionState === "offline" ? "Offline" : "Connection unavailable",
      message: `${action} requires an internet connection. Offline mode is read-only except for moving beats to Trash.`,
    });
    return true;
  }, [connectionState]);
'''
    wiring = reject + '''
  const {
    backgroundUploadErrors,
    cloudifyImportedBeats,
    retryBackgroundUpload,
    getQueuedBeatsSnapshot,
    deferLibraryReloadIfUploading,
    deferredLibraryReloadRef,
  } = useCloudUploadQueue({
    settings,
    setSettings,
    setConnectionState,
    setBeats,
    beatsLatestRef,
    beatRuntimeStatesRef,
    transitionRuntime,
    cloudLibrarySnapshotRef,
    waitForUploadedBeatPlaybackReady,
    rejectOfflineMutation,
    isReviewActive: () => reviewQueueLatestRef.current !== null,
    hasProtectedStaging: () => stagedImportPathsRef.current.size > 0,
  });
'''
    app = replace_once(app, reject, wiring, "wire queue hook")
    app = replace_once(app, '            ...backgroundUploadQueueRef.current,\n', '            ...getQueuedBeatsSnapshot(),\n', "skip protected queue")
    app = replace_once(app, '          ...backgroundUploadQueueRef.current,\n', '          ...getQueuedBeatsSnapshot(),\n', "cancel protected queue")

    reload_old = '''      const uploadInFlight = backgroundUploadRunningRef.current || autoCloudUploadRef.current.size > 0;
      if (uploadInFlight) {
        // Critical safety rule: restoreLibraryFromTelegram reconciles SQLite to the
        // committed INDEX. During an import that INDEX is intentionally older, so
        // applying it would make the beats being uploaded disappear. Defer instead.
        deferredLibraryReloadRef.current = true;
        console.info(`[library-refresh] DEFERRED active_uploads=${autoCloudUploadRef.current.size}`);
        return;
      }
'''
    reload_new = '''      // Queue ownership includes active IDs and the pending Reload marker.
      if (deferLibraryReloadIfUploading()) return;
'''
    app = replace_once(app, reload_old, reload_new, "delegate reload deferral")

    write("src/App.tsx", app)
    write("src/features/cloud/useCloudUploadQueue.ts", HOOK)
    write("tests/integration/appCloudUploadQueueExtraction.test.ts", EXTRACTION_TEST)

    characterization = read("tests/integration/appMigrationCharacterization.test.ts")
    characterization = replace_once(
        characterization,
        'const desktopBeatUploadPipeline = readFileSync(resolve(process.cwd(), "src/features/cloud/desktopBeatUploadPipeline.ts"), "utf8");\n',
        'const desktopBeatUploadPipeline = readFileSync(resolve(process.cwd(), "src/features/cloud/desktopBeatUploadPipeline.ts"), "utf8");\nconst cloudUploadQueue = readFileSync(resolve(process.cwd(), "src/features/cloud/useCloudUploadQueue.ts"), "utf8");\n',
        "characterization queue owner",
    )
    old_upload = '''  it("keeps browser commit routing separate and preserves the Desktop per-beat durability boundary", () => {
    const upload = section("const cloudifyImportedBeats = useCallback", "const retryBackgroundUpload = useCallback");

    expectOrdered(upload, [
      "if (platform.capabilities.reviewBeatCloudCommit)",
      "platform.cloudData.commitImportedBeat(beat)",
      "markCloudUploadActive(beat)",
    ]);

    expect(upload).toContain("runDesktopBeatUploadPipeline({");
    expectOrdered(desktopBeatUploadPipeline, [
      "uploaded = await dependencies.uploadMaster(uploaded)",
      "const existingFiles = await dependencies.listCloudFiles(uploaded.id)",
      "await dependencies.uploadWav(uploaded, uploaded.wav_path)",
      "await dependencies.uploadProject(uploaded)",
      "const detached = await dependencies.detachLocalSources(uploaded.id)",
      "await dependencies.syncMetadata(detached)",
      "await dependencies.commitSnapshot(indexSnapshot, `upload-beat:${detached.id}`)",
      "dependencies.clearUploadMarker(original.id)",
      "const playbackReady = await dependencies.waitForPlaybackReady(detached)",
    ]);
    expect(desktopBeatUploadPipeline).toContain("remoteUploadCompleted = true");
    expect(desktopBeatUploadPipeline).toContain("syncCommitted = true");

    expect(upload).toContain("if (!syncCommitted)");
    expect(upload).toContain('cloud_status: remoteUploadCompleted ? "CLOUD_ONLY" : "ERROR"');
    expect(upload).toContain("reviewQueueLatestRef.current === null");
    expect(upload).toContain("stagedImportPathsRef.current.size === 0");
  });
'''
    new_upload = '''  it("keeps browser commit routing separate and preserves the Desktop per-beat durability boundary", () => {
    expectOrdered(cloudUploadQueue, [
      "if (platform.capabilities.reviewBeatCloudCommit)",
      "platform.cloudData.commitImportedBeat(beat)",
      "markCloudUploadActive(beat)",
    ]);

    expect(cloudUploadQueue).toContain("runDesktopBeatUploadPipeline({");
    expectOrdered(desktopBeatUploadPipeline, [
      "uploaded = await dependencies.uploadMaster(uploaded)",
      "const existingFiles = await dependencies.listCloudFiles(uploaded.id)",
      "await dependencies.uploadWav(uploaded, uploaded.wav_path)",
      "await dependencies.uploadProject(uploaded)",
      "const detached = await dependencies.detachLocalSources(uploaded.id)",
      "await dependencies.syncMetadata(detached)",
      "await dependencies.commitSnapshot(indexSnapshot, `upload-beat:${detached.id}`)",
      "dependencies.clearUploadMarker(original.id)",
      "const playbackReady = await dependencies.waitForPlaybackReady(detached)",
    ]);
    expect(desktopBeatUploadPipeline).toContain("remoteUploadCompleted = true");
    expect(desktopBeatUploadPipeline).toContain("syncCommitted = true");

    expect(cloudUploadQueue).toContain("if (!syncCommitted)");
    expect(cloudUploadQueue).toContain('cloud_status: remoteUploadCompleted ? "CLOUD_ONLY" : "ERROR"');
    expect(cloudUploadQueue).toContain("!isReviewActive()");
    expect(cloudUploadQueue).toContain("!hasProtectedStaging()");
    expect(app).toContain("useCloudUploadQueue({");
  });
'''
    characterization = replace_once(characterization, old_upload, new_upload, "move upload characterization")

    old_reload = '''  it("defers manual Reload while uploads are active and consumes the deferred event after the queue drains", () => {
    const reload = section("const reloadLibrary = useCallback", "const applyBulkUpdate = useCallback");
    expectOrdered(reload, [
      "const uploadInFlight = backgroundUploadRunningRef.current || autoCloudUploadRef.current.size > 0",
      "deferredLibraryReloadRef.current = true",
      "const restored = await libraryStateManager.reloadAuthoritative()",
    ]);
    expect(reload).toContain('window.addEventListener("beatgaler:deferred-library-reload", runDeferredReload)');

    const upload = section("const cloudifyImportedBeats = useCallback", "const retryBackgroundUpload = useCallback");
    expectOrdered(upload, [
      "backgroundUploadRunningRef.current = false",
      "if (deferredLibraryReloadRef.current)",
      "deferredLibraryReloadRef.current = false",
      'window.dispatchEvent(new Event("beatgaler:deferred-library-reload"))',
    ]);
  });
'''
    new_reload = '''  it("defers manual Reload while uploads are active and consumes the deferred event after the queue drains", () => {
    const reload = section("const reloadLibrary = useCallback", "const applyBulkUpdate = useCallback");
    expectOrdered(reload, [
      "if (deferLibraryReloadIfUploading()) return",
      "const restored = await libraryStateManager.reloadAuthoritative()",
    ]);
    expect(reload).toContain('window.addEventListener("beatgaler:deferred-library-reload", runDeferredReload)');

    expectOrdered(cloudUploadQueue, [
      "backgroundUploadRunningRef.current = false",
      "finishDeferredReloadIfIdle();",
    ]);
    expect(cloudUploadQueue).toContain('window.dispatchEvent(new Event("beatgaler:deferred-library-reload"))');
  });
'''
    characterization = replace_once(characterization, old_reload, new_reload, "move reload characterization")
    write("tests/integration/appMigrationCharacterization.test.ts", characterization)

    regressions = read("scripts/run-regressions.mjs")
    regressions = replace_once(
        regressions,
        '  const desktopBeatUploadPipeline = readFileSync(path.join(root, "src", "features", "cloud", "desktopBeatUploadPipeline.ts"), "utf8");\n',
        '  const desktopBeatUploadPipeline = readFileSync(path.join(root, "src", "features", "cloud", "desktopBeatUploadPipeline.ts"), "utf8");\n  const cloudUploadQueue = readFileSync(path.join(root, "src", "features", "cloud", "useCloudUploadQueue.ts"), "utf8");\n',
        "regressions queue owner",
    )
    regressions = replace_once(regressions, '  if (!app.includes(\'cloud_status: "PLAYBACK_PREPARING"\')) fail("Background upload must enter PLAYBACK_PREPARING before advertising completion.");\n', '  if (!cloudUploadQueue.includes(\'cloud_status: "PLAYBACK_PREPARING"\')) fail("Background upload must enter PLAYBACK_PREPARING before advertising completion.");\n', "preparing owner")
    regressions = replace_once(regressions, '  if (!app.includes(\'cloud_status: "UPLOAD_COMPLETE"\')) fail("Background upload lost its transient completion state after playback readiness.");\n  if (!app.includes("waitForPlaybackReady: waitForUploadedBeatPlaybackReady")) fail("App no longer wires the real playback readiness gate into the Desktop upload pipeline.");\n', '  if (!cloudUploadQueue.includes(\'cloud_status: "UPLOAD_COMPLETE"\')) fail("Background upload lost its transient completion state after playback readiness.");\n  if (!cloudUploadQueue.includes("waitForPlaybackReady: waitForUploadedBeatPlaybackReady")) fail("Cloud upload queue no longer wires the real playback readiness gate into the Desktop upload pipeline.");\n', "completion owner")
    regressions = replace_once(regressions, 'if (!app.includes(\'cloudifyImportedBeats([{ ...beat, cloud_status: "UPLOADING" }])\'))', 'if (!cloudUploadQueue.includes(\'cloudifyImportedBeats([{ ...beat, cloud_status: "UPLOADING" }])\'))', "retry owner")
    write("scripts/run-regressions.mjs", regressions)


def finalize_docs(initial_sha: str, implementation_sha: str, run_id: str) -> None:
    if initial_sha != INITIAL_SHA:
        raise SystemExit(f"unexpected initial SHA: {initial_sha}")
    roadmap_path = "migration/BeatGaler-roadmap-para-trabajar-con-IAs.md"
    roadmap = read(roadmap_path)
    roadmap = replace_once(roadmap, "### [ ] 6.4 — Separar la cola de uploads", "### [x] 6.4 — Separar la cola de uploads", "roadmap 6.4")
    write(roadmap_path, roadmap)

    registro_path = "migration/Registro-de-avance.md"
    registro = read(registro_path)
    if "### Registro — 6.4" in registro:
        raise SystemExit("Registro 6.4 already exists")
    entry = f'''\n\n### Registro — 6.4\n\n```\nTarea: 6.4 — Separar la cola de uploads\nEstado: Terminada\nFecha: 2026-09-08\n\nBase:\n- Rama: v0.9.0-test-noche\n- SHA inicial: {initial_sha}\n- SHA de implementación validada: {implementation_sha}\n- Última tarea verificada: 6.3 — Separar el proceso de subida de un beat.\n\nCambio realizado:\n- Se extrajo de App.tsx la cola de uploads a src/features/cloud/useCloudUploadQueue.ts.\n- El hook es dueño de cola Desktop, IDs activos, errores por beat, retry, timers de finalización y Reload diferido.\n- Desktop conserva FIFO/secuencialidad y cada beat sigue pasando por runDesktopBeatUploadPipeline de 6.3.\n- Web conserva platform.cloudData.commitImportedBeat como ruta separada.\n- Review/import siguen en App.tsx; la cola solo consulta dos conexiones pequeñas de lectura para proteger staging.\n- Reload delega el diferimiento al hook y el evento existente se dispara solo al quedar realmente ociosa la cola.\n\nAdaptación de pruebas:\n- Nuevo appCloudUploadQueueExtraction.test.ts cubre ownership, orden, Web/Desktop, staging, retry y Reload.\n- appMigrationCharacterization.test.ts y run-regressions.mjs siguen ahora al owner real sin debilitar contratos.\n\nArchivos afectados:\n- src/App.tsx\n- src/features/cloud/useCloudUploadQueue.ts\n- tests/integration/appCloudUploadQueueExtraction.test.ts\n- tests/integration/appMigrationCharacterization.test.ts\n- scripts/run-regressions.mjs\n- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md\n- migration/Registro-de-avance.md\n- migration/BeatGaler-agent-state.md\n- .github/task-6-4.py — temporal, eliminado al cerrar.\n- .github/workflows/task-6-4-apply.yml — temporal, eliminado al cerrar.\n\nComprobaciones ejecutadas:\n- Task 6.4 Apply / run {run_id}.\n- npm ci: PASS.\n- git diff --check: PASS.\n- npm run test:typecheck: PASS.\n- npm run test:unit:ts: PASS.\n- npm run test:component:dom: PASS.\n- npm run test:integration: PASS.\n- npm run test:regressions: PASS.\n- npm run build:web: PASS.\n- npm run build: PASS.\n- SHA de implementación sobre el que se ejecutó esta matriz: {implementation_sha}.\n- Tras eliminar tooling temporal y escribir roadmap/registro se repite la misma matriz antes de cerrar agent-state, porque el workflow versionado cambia después del primer SHA validado.\n\nComprobaciones no ejecutadas:\n- Prueba manual Desktop física: no requerida para esta extracción estructural; integración, regresiones y ambos builds cubren los contratos modificados.\n- E2E completos import/download/recovery: no aplican específicamente a 6.4.\n\nPrueba manual:\n- No requerida.\n\nPendientes / fuera de alcance:\n- 7.1 — Separar el estado y navegación de Review.\n- La futura extracción de Review deberá sustituir isReviewActive/hasProtectedStaging por el nuevo owner sin perder protección de staging.\n\nRiesgos previos relevantes:\n- Se conserva intacta la frontera durable del pipeline 6.3.\n\nHerramientas temporales restantes:\n- Ninguna al cierre.\n\nVeredicto:\n- Terminada.\n\nSiguiente tarea:\n- 7.1 — Separar el estado y navegación de Review. No iniciada.\n```\n'''
    write(registro_path, registro.rstrip() + entry + "\n")


def finalize_state(initial_sha: str, implementation_sha: str, closure_sha: str, run_id: str) -> None:
    state = f'''# BeatGaler — Agent State\n\n## Contexto\n\n- Fecha de ejecución: 2026-09-08\n- Rama de trabajo: `v0.9.0-test-noche`\n- Tarea trabajada: `6.4 — Separar la cola de uploads`\n- Estado: `Terminada`\n- Última tarea terminada: `6.4 — Separar la cola de uploads`\n\n## Base de esta ejecución\n\n- SHA inicial: `{initial_sha}`\n- SHA de implementación validada: `{implementation_sha}`\n- SHA de cierre revalidado tras eliminar tooling temporal: `{closure_sha}`\n- HEAD remoto observado inmediatamente antes de la escritura final de agent-state: `{closure_sha}`\n- Run principal: `{run_id}` — `Task 6.4 Apply` — `SUCCESS`\n\n## Resultado verificado\n\n- `useCloudUploadQueue.ts` es dueño de cola, IDs activos, errores, retry, timers y Reload diferido.\n- Desktop conserva FIFO/secuencialidad y delega cada beat al pipeline 6.3.\n- Web conserva `platform.cloudData.commitImportedBeat`.\n- App conserva wiring y dos lecturas temporales hacia Review/staging.\n- El Reload pendiente se consume solo cuando no quedan uploads activos ni en cola.\n- La matriz completa pasó sobre la implementación y se repitió después de eliminar el workflow/script temporal.\n\n## Pendientes concretos\n\n- `7.1 — Separar el estado y navegación de Review`.\n- Sustituir las conexiones temporales `isReviewActive` / `hasProtectedStaging` cuando Review tenga owner propio.\n\n## Comprobaciones pendientes\n\n- Ninguna necesaria para cerrar 6.4.\n\n## Siguiente tarea\n\n- `7.1 — Separar el estado y navegación de Review`\n- Estado: `Pendiente`\n- No iniciar hasta la próxima ronda.\n'''
    write("migration/BeatGaler-agent-state.md", state)


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: task-6-4.py apply | finalize-docs ... | finalize-state ...")
    action = sys.argv[1]
    if action == "apply":
        apply()
        return
    if action == "finalize-docs" and len(sys.argv) == 5:
        finalize_docs(sys.argv[2], sys.argv[3], sys.argv[4])
        return
    if action == "finalize-state" and len(sys.argv) == 6:
        finalize_state(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
        return
    raise SystemExit("invalid arguments")


if __name__ == "__main__":
    main()
