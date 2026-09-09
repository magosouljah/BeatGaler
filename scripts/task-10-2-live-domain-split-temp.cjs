'use strict';

const fs = require('fs');
const path = require('path');

const compositionPath = 'src/app/useBeatGalerComposition.ts';
let composition = fs.readFileSync(compositionPath, 'utf8');

function replaceBlock(text, start, end, replacement = '') {
  const startIndex = text.indexOf(start);
  if (startIndex < 0) throw new Error(`Missing start marker: ${start}`);
  const endIndex = text.indexOf(end, startIndex);
  if (endIndex < 0) throw new Error(`Missing end marker after: ${start}`);
  return text.slice(0, startIndex) + replacement + text.slice(endIndex);
}

const importAnchor = 'import { useImportEntry } from "../features/import/useImportEntry";\n';
if (!composition.includes(importAnchor)) throw new Error('Composition import anchor changed');
composition = composition.replace(importAnchor, `${importAnchor}import { useBeatEditing } from "../features/edit/useBeatEditing";\nimport { useBeatFileDropRouting } from "../features/dragdrop/useBeatFileDropRouting";\nimport { isBeatCloudUpdateBusy, setBeatCloudUpdateBusy } from "../features/cloud/beatCloudUpdateBusy";\n`);

composition = replaceBlock(
  composition,
  'const beatCloudUpdateBusyIds = new Set<string>();',
  'function formatCloudBytes(bytes: number)',
);
composition = composition.replace(
  '    isBeatCloudUpdateBusy: beatId => beatCloudUpdateBusyIds.has(beatId),',
  '    isBeatCloudUpdateBusy,',
);

composition = replaceBlock(
  composition,
  '  const handleEditBulk = useCallback(() => {',
  '  const { deleteBeat, handleRemoveBulk, handleBeatRestored } = useTrashActions({',
);

composition = replaceBlock(
  composition,
  '  const updateBeat = useCallback((updated: Beat) => {',
  '  const {\n    runBeatCloudUpdate,',
  `  const { handleEditBulk, updateBeat, handleDropArtwork, applyBulkUpdate } = useBeatEditing({\n    beats,\n    selectedIds,\n    clearSelection,\n    drawer,\n    setDrawer,\n    rejectOfflineMutation,\n    connectionState,\n    beatRuntimeStatesRef,\n    transitionRuntime,\n    setBeats,\n    beatsLatestRef,\n    cloudLibraryTimerRef,\n    cloudLibrarySnapshotRef,\n    cloudMetaSnapshotRef,\n  });\n\n`,
);

composition = replaceBlock(
  composition,
  '  const handleDroppedBeatFileRole = useCallback(async (role: DroppedBeatFileRole) => {',
  '  useHtmlLibraryDrop({',
  `  const { handleDroppedBeatFileRole } = useBeatFileDropRouting({\n    beatFileDrop,\n    setBeatFileDrop,\n    hasStoredProject,\n    startMasterAssetUpdate,\n    startWavAssetUpdate,\n    startProjectAssetUpdate,\n  });\n\n`,
);

composition = replaceBlock(
  composition,
  '  const applyBulkUpdate = useCallback((updates: Partial<Beat>, options?: { tagsMode?: "add" | "replace" | "remove" }) => {',
  '  const tagColors = useTagColors();',
);

fs.writeFileSync(compositionPath, composition);

fs.writeFileSync('src/features/cloud/beatCloudUpdateBusy.ts', `const busyBeatIds = new Set<string>();\n\nexport function isBeatCloudUpdateBusy(beatId: string): boolean {\n  return busyBeatIds.has(beatId);\n}\n\nexport function setBeatCloudUpdateBusy(beatId: string, active: boolean, success = false): void {\n  if (active) busyBeatIds.add(beatId);\n  else busyBeatIds.delete(beatId);\n  window.dispatchEvent(new CustomEvent("beatgaler:beat-cloud-busy", {\n    detail: { beatId, active, success },\n  }));\n}\n`);

fs.writeFileSync('src/features/edit/useBeatEditing.ts', `import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";\nimport type { Beat } from "../../types";\nimport { libraryStateManager } from "../../lib/libraryStateManager";\nimport { sanitizeUserVisibleText } from "../../lib/userVisibleError";\nimport { platform } from "../../platform";\nimport { saveBeatMeta, syncBeatMetadataToTelegram } from "../../lib/tauri";\nimport { cloudBeatFingerprint } from "../library/libraryFingerprints";\nimport { createBeatRuntimeState, type BeatRuntimeState } from "../state/beatRuntimeState";\nimport type { BeatRuntimeRegistry } from "../state/useBeatRuntimeRegistry";\nimport type { ConnectionState } from "../session/useSessionState";\n\ntype DrawerState = { beat: Beat; mode: "detail" | "edit" } | null;\n\ntype UseBeatEditingOptions = {\n  beats: Beat[];\n  selectedIds: Set<string>;\n  clearSelection: () => void;\n  drawer: DrawerState;\n  setDrawer: Dispatch<SetStateAction<DrawerState>>;\n  rejectOfflineMutation: (action: string) => boolean;\n  connectionState: ConnectionState;\n  beatRuntimeStatesRef: MutableRefObject<Record<string, BeatRuntimeState>>;\n  transitionRuntime: BeatRuntimeRegistry["transitionRuntime"];\n  setBeats: Dispatch<SetStateAction<Beat[]>>;\n  beatsLatestRef: MutableRefObject<Beat[]>;\n  cloudLibraryTimerRef: MutableRefObject<number | null>;\n  cloudLibrarySnapshotRef: MutableRefObject<string | null>;\n  cloudMetaSnapshotRef: MutableRefObject<Map<string, string> | null>;\n};\n\nfunction runtimeErrorMessage(error: unknown): string {\n  return error instanceof Error ? error.message : String(error);\n}\n\nexport function useBeatEditing({\n  beats,\n  selectedIds,\n  clearSelection,\n  drawer,\n  setDrawer,\n  rejectOfflineMutation,\n  connectionState,\n  beatRuntimeStatesRef,\n  transitionRuntime,\n  setBeats,\n  beatsLatestRef,\n  cloudLibraryTimerRef,\n  cloudLibrarySnapshotRef,\n  cloudMetaSnapshotRef,\n}: UseBeatEditingOptions) {\n  const handleEditBulk = useCallback(() => {\n    if (rejectOfflineMutation("Editing metadata")) return;\n    const firstSelected = beats.find(beat => selectedIds.has(beat.id));\n    if (firstSelected) setDrawer({ beat: firstSelected, mode: "edit" });\n  }, [beats, selectedIds, rejectOfflineMutation, setDrawer]);\n\n  const updateBeat = useCallback((updated: Beat) => {\n    if (updated.telegram_file_id && connectionState === "online") {\n      const runtime = beatRuntimeStatesRef.current[updated.id] ?? createBeatRuntimeState(updated);\n      if (runtime.sync_state === "synced") transitionRuntime(updated.id, { type: "SYNC_QUEUE_UPDATE" }, updated);\n    }\n    setBeats(current => current.map(beat => beat.id === updated.id ? updated : beat));\n    if (drawer?.beat.id === updated.id) setDrawer(current => current ? { ...current, beat: updated } : null);\n  }, [beatRuntimeStatesRef, connectionState, drawer, setBeats, setDrawer, transitionRuntime]);\n\n  const handleDropArtwork = useCallback(async (beat: Beat, imageBase64: string) => {\n    if (rejectOfflineMutation("Changing artwork")) return;\n\n    const updated = { ...beat, image_base64: imageBase64, image_preview_base64: null };\n\n    if (platform.capabilities.browserCloudEditing) {\n      updateBeat(updated);\n      transitionRuntime(updated.id, { type: "SYNC_UPDATE_STARTED" }, updated);\n      try {\n        const committed = await platform.editor.commit(beat, updated, {});\n        setBeats(current => {\n          const next = current.map(item => item.id === committed.id ? committed : item);\n          beatsLatestRef.current = next;\n          return next;\n        });\n        setDrawer(current => current?.beat.id === committed.id ? { ...current, beat: committed } : current);\n        transitionRuntime(updated.id, { type: "SYNC_UPDATE_SUCCEEDED" }, committed);\n      } catch (error) {\n        const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");\n        transitionRuntime(updated.id, { type: "SYNC_FAILED", code: "ARTWORK_SYNC_FAILED", message, retryable: true }, updated);\n        throw error;\n      }\n      return;\n    }\n\n    await saveBeatMeta({\n      mp3_path: beat.mp3_path,\n      wav_path: beat.wav_path,\n      bpm: beat.bpm,\n      key: beat.key,\n      tags: beat.tags,\n      rating: beat.rating,\n      image_base64: imageBase64,\n      update_filename: false,\n    });\n\n    updateBeat(updated);\n\n    if (updated.telegram_file_id && connectionState === "online") {\n      const runtime = beatRuntimeStatesRef.current[updated.id] ?? createBeatRuntimeState(updated);\n      if (runtime.sync_state === "synced") transitionRuntime(updated.id, { type: "SYNC_QUEUE_UPDATE" }, updated);\n      transitionRuntime(updated.id, { type: "SYNC_UPDATE_STARTED" }, updated);\n      try {\n        await syncBeatMetadataToTelegram(updated);\n        const indexSnapshot = beatsLatestRef.current.map(item => item.id === updated.id ? updated : item);\n        await libraryStateManager.commitSnapshot(indexSnapshot, "upload-batch");\n        if (cloudLibraryTimerRef.current) {\n          window.clearTimeout(cloudLibraryTimerRef.current);\n          cloudLibraryTimerRef.current = null;\n        }\n        cloudLibrarySnapshotRef.current = indexSnapshot\n          .filter(item => !!item.telegram_file_id)\n          .map(cloudBeatFingerprint)\n          .join("\\u001c");\n        cloudMetaSnapshotRef.current?.set(updated.id, cloudBeatFingerprint(updated));\n        transitionRuntime(updated.id, { type: "SYNC_UPDATE_SUCCEEDED" }, updated);\n      } catch (error) {\n        const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");\n        transitionRuntime(updated.id, { type: "SYNC_FAILED", code: "ARTWORK_SYNC_FAILED", message, retryable: true }, updated);\n        throw error;\n      }\n    }\n  }, [beatRuntimeStatesRef, beatsLatestRef, cloudLibrarySnapshotRef, cloudLibraryTimerRef, cloudMetaSnapshotRef, connectionState, rejectOfflineMutation, setBeats, setDrawer, transitionRuntime, updateBeat]);\n\n  const applyBulkUpdate = useCallback((updates: Partial<Beat>, options?: { tagsMode?: "add" | "replace" | "remove" }) => {\n    setBeats(current => current.map(beat => {\n      if (!selectedIds.has(beat.id)) return beat;\n      if (!updates.tags) return { ...beat, ...updates };\n\n      const normalizedInput = Array.from(new Set(\n        updates.tags.map(tag => tag.trim().toLowerCase()).filter(Boolean),\n      ));\n      if (options?.tagsMode === "replace") return { ...beat, ...updates, tags: normalizedInput };\n      if (options?.tagsMode === "remove") {\n        const removeSet = new Set(normalizedInput);\n        return { ...beat, ...updates, tags: beat.tags.filter(tag => !removeSet.has(tag.trim().toLowerCase())) };\n      }\n      const mergedTags = Array.from(new Set(\n        [...beat.tags, ...normalizedInput].map(tag => tag.trim().toLowerCase()).filter(Boolean),\n      ));\n      return { ...beat, ...updates, tags: mergedTags };\n    }));\n    clearSelection();\n  }, [clearSelection, selectedIds, setBeats]);\n\n  return { handleEditBulk, updateBeat, handleDropArtwork, applyBulkUpdate };\n}\n`);

fs.writeFileSync('src/features/dragdrop/useBeatFileDropRouting.ts', `import { useCallback, type Dispatch, type SetStateAction } from "react";\nimport type { Beat } from "../../types";\nimport { appAlert } from "../../lib/dialog";\nimport { cleanupStagedDropPaths } from "./dropStaging";\nimport { extensionFromPath } from "./pathHelpers";\nimport type { DroppedBeatFileRole } from "./components/BeatFileDropModal";\n\ntype BeatFileDropState = { beat: Beat; filePath: string; kind: "file" | "directory" } | null;\n\ntype Options = {\n  beatFileDrop: BeatFileDropState;\n  setBeatFileDrop: Dispatch<SetStateAction<BeatFileDropState>>;\n  hasStoredProject: (beat: Beat) => Promise<boolean>;\n  startMasterAssetUpdate: (beat: Beat, filePath: string) => void;\n  startWavAssetUpdate: (beat: Beat, filePath: string) => void;\n  startProjectAssetUpdate: (beat: Beat, filePath: string, kind: "projectFile" | "projectFolder") => void;\n};\n\nexport function useBeatFileDropRouting({\n  beatFileDrop,\n  setBeatFileDrop,\n  hasStoredProject,\n  startMasterAssetUpdate,\n  startWavAssetUpdate,\n  startProjectAssetUpdate,\n}: Options) {\n  const handleDroppedBeatFileRole = useCallback(async (role: DroppedBeatFileRole) => {\n    if (!beatFileDrop) return;\n    const { beat, filePath } = beatFileDrop;\n    const ext = extensionFromPath(filePath);\n\n    if (role === "loop" || role === "stems") return;\n    if (role === "main") {\n      if (ext === "mp3") startMasterAssetUpdate(beat, filePath);\n      return;\n    }\n    if (role === "wav") {\n      if (ext === "wav") startWavAssetUpdate(beat, filePath);\n      return;\n    }\n    if (role === "projectFolder") {\n      const existing = await hasStoredProject(beat).catch(() => false);\n      if (!existing) {\n        await cleanupStagedDropPaths([filePath]).catch(() => {});\n        setBeatFileDrop(null);\n        await appAlert({\n          title: "Project file required",\n          message: "Add a .flp, .als, .logicx, .ptx/.ptf file or a valid PROJECT ZIP first. Then folders can be added to that PROJECT.zip using their original folder name.",\n        });\n        return;\n      }\n      startProjectAssetUpdate(beat, filePath, "projectFolder");\n    }\n  }, [beatFileDrop, hasStoredProject, setBeatFileDrop, startMasterAssetUpdate, startProjectAssetUpdate, startWavAssetUpdate]);\n\n  return { handleDroppedBeatFileRole };\n}\n`);

const regressionPath = 'scripts/run-regressions.mjs';
let regressions = fs.readFileSync(regressionPath, 'utf8');
const regressionAnchor = '    readFileSync(path.join(root, "src", "features", "import", "useImportEntry.ts"), "utf8"),\n';
if (!regressions.includes(regressionAnchor)) throw new Error('Regression root-owner anchor changed');
regressions = regressions.replace(regressionAnchor, `${regressionAnchor}    readFileSync(path.join(root, "src", "features", "edit", "useBeatEditing.ts"), "utf8"),\n    readFileSync(path.join(root, "src", "features", "dragdrop", "useBeatFileDropRouting.ts"), "utf8"),\n    readFileSync(path.join(root, "src", "features", "cloud", "beatCloudUpdateBusy.ts"), "utf8"),\n`);
fs.writeFileSync(regressionPath, regressions);

const testsRoot = 'tests/integration';
const compositionRead = 'readFileSync(resolve(process.cwd(), "src/app/useBeatGalerComposition.ts"), "utf8")';
const combinedRead = `[\n  readFileSync(resolve(process.cwd(), "src/app/useBeatGalerComposition.ts"), "utf8"),\n  readFileSync(resolve(process.cwd(), "src/features/edit/useBeatEditing.ts"), "utf8"),\n  readFileSync(resolve(process.cwd(), "src/features/dragdrop/useBeatFileDropRouting.ts"), "utf8"),\n  readFileSync(resolve(process.cwd(), "src/features/cloud/beatCloudUpdateBusy.ts"), "utf8"),\n].join("\\n")`;
for (const fileName of fs.readdirSync(testsRoot)) {
  if (!/\.test\.(ts|tsx)$/.test(fileName)) continue;
  const filePath = path.join(testsRoot, fileName);
  let source = fs.readFileSync(filePath, 'utf8');
  if (!source.includes(compositionRead)) continue;
  source = source.replaceAll(compositionRead, combinedRead);
  fs.writeFileSync(filePath, source);
}

for (const tempPath of [
  '.github/workflows/task-10-2-live-domain-split-temp.yml',
  'scripts/task-10-2-live-domain-split-temp.cjs',
]) {
  if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}

console.log('Extracted live editing, drop routing, and busy-state ownership from root composition');
