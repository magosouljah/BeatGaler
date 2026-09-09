'use strict';

const fs = require('fs');

const compositionPath = 'src/app/useBeatGalerComposition.ts';
let source = fs.readFileSync(compositionPath, 'utf8');

function removeBlock(startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing ${label} start marker`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Missing ${label} end marker`);
  source = source.slice(0, start) + source.slice(end);
}

removeBlock(
  'function runtimeErrorMessage(error: unknown): string {',
  'export function useBeatGalerComposition() {',
  'folder-update error helpers',
);

removeBlock(
  '  const updateExistingBeatFromFolder = useCallback(async (beat: Beat, folderPath: string): Promise<boolean> => {',
  '  const { commitDrawerCloudMutation } = useDrawerCloudPersistence({',
  'unused existing-beat folder update',
);

for (const forbidden of [
  'updateExistingBeatFromFolder',
  'inspectBeatUpdateFolder',
  'mergeFolderIntoExistingBeat',
  'function runtimeErrorMessage',
  'function isRuntimeConflictError',
]) {
  if (source.includes(forbidden)) throw new Error(`Domain residue remained in composition: ${forbidden}`);
}

for (const required of [
  'useBeatAssetUpdates({',
  'useBeatProjects({',
  'useBeatFileDropRouting({',
  'useHtmlLibraryDrop({',
  'useNativeLibraryDrop({',
]) {
  if (!source.includes(required)) throw new Error(`Active file/project routing disappeared: ${required}`);
}

fs.writeFileSync(compositionPath, source);
