import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
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
