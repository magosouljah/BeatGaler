'use strict';

const fs = require('fs');

const compositionPath = 'src/app/useBeatGalerComposition.ts';
let composition = fs.readFileSync(compositionPath, 'utf8');

function replaceBlock(text, start, end, replacement) {
  const startIndex = text.indexOf(start);
  if (startIndex < 0) throw new Error(`Missing start marker: ${start}`);
  const endIndex = text.indexOf(end, startIndex);
  if (endIndex < 0) throw new Error(`Missing end marker after: ${start}`);
  return text.slice(0, startIndex) + replacement + text.slice(endIndex);
}

const importAnchor = 'import { usePublishingActions } from "../features/publishing/usePublishingActions";\n';
if (!composition.includes(importAnchor)) throw new Error('Composition import anchor changed');
composition = composition.replace(importAnchor, `${importAnchor}import { useMutationAvailability } from "../features/session/useMutationAvailability";\nimport { useCloudLibraryRecovery } from "../features/startup/useCloudLibraryRecovery";\nimport { useCloudBeatTransfer } from "../features/cloud/useCloudBeatTransfer";\nimport { useImportEntry } from "../features/import/useImportEntry";\n`);

composition = replaceBlock(
  composition,
  '  const rejectOfflineMutation = useCallback((action: string): boolean => {',
  '  const { showUpload, setShowUpload, handleUpload, handleUploadBulk } = usePublishingActions({',
  '  const { rejectOfflineMutation } = useMutationAvailability(connectionState);\n\n',
);

composition = replaceBlock(
  composition,
  '  // One-time recovery for a cloud-only library after Telegram login/startup.',
  '  const handleUploadTelegram = useCallback(async (beat: Beat) => {',
  '  useCloudLibraryRecovery({ beatsLength: beats.length, setBeats, setSettings });\n\n',
);

composition = replaceBlock(
  composition,
  '  const handleUploadTelegram = useCallback(async (beat: Beat) => {',
  '  const handleEditBulk = useCallback(() => {',
  '  const { handleUploadTelegram, handleDownloadTelegram } = useCloudBeatTransfer({\n    rejectOfflineMutation,\n    transitionRuntime,\n    setBeats,\n  });\n\n',
);

composition = replaceBlock(
  composition,
  '  const addBeatsAndReview = useCallback((newBeats: Beat[]) => {',
  'const {\n  skipCurrentReviewBeat,',
  '  const { addBeatsAndReview } = useImportEntry({\n    connectionState,\n    setShowAdd,\n    startReview,\n    beatsLatestRef,\n  });\n\n',
);

fs.writeFileSync(compositionPath, composition);

fs.writeFileSync('src/features/session/useMutationAvailability.ts', `import { useCallback } from "react";\nimport { appAlert } from "../../lib/dialog";\nimport type { ConnectionState } from "./useSessionState";\n\nexport function useMutationAvailability(connectionState: ConnectionState) {\n  const rejectOfflineMutation = useCallback((action: string): boolean => {\n    if (connectionState === "online") return false;\n    void appAlert({\n      title: connectionState === "offline" ? "Offline" : "Connection unavailable",\n      message: \`${'${action}'} requires an internet connection. Offline mode is read-only except for moving beats to Trash.\`,\n    });\n    return true;\n  }, [connectionState]);\n\n  return { rejectOfflineMutation };\n}\n`);

fs.writeFileSync('src/features/startup/useCloudLibraryRecovery.ts', `import { useCallback, useEffect, useRef } from "react";\nimport type { Dispatch, SetStateAction } from "react";\nimport type { AppSettings, Beat } from "../../types";\nimport { libraryStateManager } from "../../lib/libraryStateManager";\n\ntype UseCloudLibraryRecoveryOptions = {\n  beatsLength: number;\n  setBeats: Dispatch<SetStateAction<Beat[]>>;\n  setSettings: Dispatch<SetStateAction<AppSettings | null>>;\n};\n\nexport function useCloudLibraryRecovery({ beatsLength, setBeats, setSettings }: UseCloudLibraryRecoveryOptions) {\n  // One-time recovery for a cloud-only library after account login/startup.\n  // No timer, no permanent synchronization.\n  const cloudRecoveryAttemptedRef = useRef(false);\n\n  const recoverCloudLibraryOnceIfEmpty = useCallback(async () => {\n    if (cloudRecoveryAttemptedRef.current) return;\n    if (beatsLength !== 0) return;\n\n    cloudRecoveryAttemptedRef.current = true;\n    try {\n      const restored = await libraryStateManager.reloadAuthoritative();\n      if (restored.length > 0) {\n        setBeats(current => current.length === 0 ? restored : current);\n      }\n    } catch (error) {\n      console.warn("Cloud library one-time recovery skipped:", error);\n    }\n  }, [beatsLength, setBeats]);\n\n  // IMPORTANT: an empty library is a valid, authoritative state (for example\n  // immediately after Remove All). Never infer recovery merely from\n  // beatsLength === 0; doing so races the pending trash/index commit and can\n  // resurrect the just-removed cards with their artwork unloaded. Recovery is\n  // only allowed from the explicit account connection/startup event below.\n  useEffect(() => {\n    const onCloudConnected = (event: Event) => {\n      const detail = (event as CustomEvent<{ connected?: boolean; username?: string | null }>).detail;\n      if (!detail?.connected) return;\n\n      setSettings(current => current ? {\n        ...current,\n        telegram_cloud_connected: true,\n        telegram_cloud_username: detail.username ?? current.telegram_cloud_username ?? null,\n      } : current);\n\n      void recoverCloudLibraryOnceIfEmpty();\n    };\n\n    window.addEventListener("beatgaler:telegram-connected", onCloudConnected);\n    return () => window.removeEventListener("beatgaler:telegram-connected", onCloudConnected);\n  }, [recoverCloudLibraryOnceIfEmpty, setSettings]);\n}\n`);

fs.writeFileSync('src/features/cloud/useCloudBeatTransfer.ts', `import { useCallback } from "react";\nimport type { Dispatch, SetStateAction } from "react";\nimport type { Beat } from "../../types";\nimport { appAlert } from "../../lib/dialog";\nimport { sanitizeUserVisibleText } from "../../lib/userVisibleError";\nimport { syncBeatMetadataToTelegram, uploadBeatToTelegram } from "../../lib/tauri";\nimport type { BeatRuntimeRegistry } from "../state/useBeatRuntimeRegistry";\n\ntype UseCloudBeatTransferOptions = {\n  rejectOfflineMutation: (action: string) => boolean;\n  transitionRuntime: BeatRuntimeRegistry["transitionRuntime"];\n  setBeats: Dispatch<SetStateAction<Beat[]>>;\n};\n\nfunction runtimeErrorMessage(error: unknown): string {\n  return error instanceof Error ? error.message : String(error);\n}\n\nfunction isRuntimeConflictError(error: unknown): boolean {\n  const message = runtimeErrorMessage(error).toLowerCase();\n  return message.includes("409") || message.includes("conflict") || message.includes("revision mismatch") || message.includes("version mismatch");\n}\n\nexport function useCloudBeatTransfer({ rejectOfflineMutation, transitionRuntime, setBeats }: UseCloudBeatTransferOptions) {\n  const handleUploadTelegram = useCallback(async (beat: Beat) => {\n    if (rejectOfflineMutation("Uploading a beat")) return;\n    const existingCloudBeat = Boolean(beat.telegram_file_id);\n    transitionRuntime(beat.id, { type: existingCloudBeat ? "SYNC_QUEUE_UPDATE" : "SYNC_QUEUE_UPLOAD" }, beat);\n    transitionRuntime(beat.id, { type: existingCloudBeat ? "SYNC_UPDATE_STARTED" : "SYNC_UPLOAD_STARTED" }, beat);\n    try {\n      const updated = await uploadBeatToTelegram(beat);\n      await syncBeatMetadataToTelegram(updated);\n      transitionRuntime(updated.id, { type: existingCloudBeat ? "SYNC_UPDATE_SUCCEEDED" : "SYNC_UPLOAD_SUCCEEDED" }, updated);\n      setBeats(bs => bs.map(b => b.id === updated.id ? updated : b));\n    } catch (error) {\n      const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");\n      if (existingCloudBeat && isRuntimeConflictError(error)) {\n        transitionRuntime(beat.id, { type: "SYNC_CONFLICT", message }, beat);\n      } else {\n        transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "TELEGRAM_UPLOAD_FAILED", message, retryable: true }, beat);\n      }\n      await appAlert({ title: "Cloud upload failed", message, danger: true });\n    }\n  }, [rejectOfflineMutation, setBeats, transitionRuntime]);\n\n  const handleDownloadTelegram = useCallback(async (_beat: Beat) => {\n    await appAlert({\n      title: "Cloud-only library",\n      message: "Files are fetched into temporary storage automatically when needed.",\n    });\n  }, []);\n\n  return { handleUploadTelegram, handleDownloadTelegram };\n}\n`);

fs.writeFileSync('src/features/import/useImportEntry.ts', `import { useCallback } from "react";\nimport type { Dispatch, MutableRefObject, SetStateAction } from "react";\nimport type { Beat } from "../../types";\nimport { appAlert } from "../../lib/dialog";\nimport { cleanTags } from "../../lib/metadataValidation";\nimport { cleanupOrphanedDropStaging } from "../dragdrop/dropStaging";\nimport type { ConnectionState } from "../session/useSessionState";\nimport type { ImportSession } from "./useImportSession";\n\ntype UseImportEntryOptions = {\n  connectionState: ConnectionState;\n  setShowAdd: Dispatch<SetStateAction<boolean>>;\n  startReview: ImportSession["startReview"];\n  beatsLatestRef: MutableRefObject<Beat[]>;\n};\n\nexport function useImportEntry({ connectionState, setShowAdd, startReview, beatsLatestRef }: UseImportEntryOptions) {\n  const addBeatsAndReview = useCallback((newBeats: Beat[]) => {\n    if (newBeats.length === 0) return;\n    if (connectionState !== "online") {\n      void appAlert({\n        title: "Internet connection required",\n        message: "BeatGaler does not import new beats while offline. Reconnect and import them again.",\n      });\n      void cleanupOrphanedDropStaging(beatsLatestRef.current);\n      return;\n    }\n    const sanitized = newBeats.map(beat => ({ ...beat, tags: cleanTags(beat.tags || []).tags }));\n\n    // Review candidates are NOT library beats yet. Cancel leaves nothing behind,\n    // duplicate-name checks see committed library items only, and upload begins\n    // only after Review -> Save.\n    setShowAdd(false);\n    startReview(sanitized);\n  }, [beatsLatestRef, connectionState, setShowAdd, startReview]);\n\n  return { addBeatsAndReview };\n}\n`);

const regressionsPath = 'scripts/run-regressions.mjs';
let regressions = fs.readFileSync(regressionsPath, 'utf8');
const oldRootSource = '  const app = `${appEntry}\\n${composition}`;';
const newRootSource = `  const rootDomainOwners = [\n    readFileSync(path.join(root, "src", "features", "session", "useMutationAvailability.ts"), "utf8"),\n    readFileSync(path.join(root, "src", "features", "startup", "useCloudLibraryRecovery.ts"), "utf8"),\n    readFileSync(path.join(root, "src", "features", "cloud", "useCloudBeatTransfer.ts"), "utf8"),\n    readFileSync(path.join(root, "src", "features", "import", "useImportEntry.ts"), "utf8"),\n  ].join("\\n").replaceAll("../", "./");\n  const app = \`${'${appEntry}'}\\n${'${composition}'}\\n${'${rootDomainOwners}'}\`;`;
if (!regressions.includes(oldRootSource)) throw new Error('Regression root source no longer matches expected 10.2 shape');
regressions = regressions.replace(oldRootSource, newRootSource);
fs.writeFileSync(regressionsPath, regressions);

for (const tempPath of [
  '.github/workflows/task-10-2-domain-boundaries-temp.yml',
  'scripts/task-10-2-domain-boundaries-temp.cjs',
]) {
  if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}

console.log('Split session/startup/cloud/import domain logic out of root composition');
