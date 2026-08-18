import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relative => readFileSync(path.join(root, relative), "utf8");
const fail = message => { throw new Error(`Phase 9C/9D regression: ${message}`); };

const app = read("src/App.tsx");
const controller = read("src/features/dragdrop/htmlDropController.ts");
const browserArtwork = read("src/features/dragdrop/browserArtwork.ts");
const nativeExternalImage = read("src/features/dragdrop/nativeExternalImage.ts");
const tauriClient = read("src/lib/tauri.ts");
const rust = read("src-tauri/src/commands.rs");
const wry = read("scripts/wry-patches/wry-0.54.2-drag_drop.rs");

// 9C — existing beat slot updates.
if (!app.includes('title: "MASTER MP3"') || !app.includes('role: "main"')) fail("existing-beat MASTER destination disappeared.");
if (!app.includes('title: "WAV HQ"') || !app.includes('role: "wav"')) fail("existing-beat WAV HQ destination disappeared.");
if (!app.includes('uploadDroppedFileToTelegram(beat, filePath, "MASTER")')) fail("MASTER replacement no longer writes the MASTER slot.");
if (!app.includes('uploadDroppedFileToTelegram(beat, filePath, "WAV")')) fail("WAV add/replace no longer writes the WAV slot.");
if (!app.includes('waitForUploadedBeatPlaybackReady(updated)')) fail("MASTER replacement no longer waits for playback readiness.");
if (!app.includes('inspectProjectDropSource(filePath)')) fail("PROJECT auto-inspection disappeared.");
if (!app.includes('updateProjectArchiveFromSource(beat, filePath, "projectFile")') && !app.includes('startProjectAssetUpdate(beat, filePath, "projectFile")')) fail("PROJECT file update route disappeared.");
if (!app.includes('startProjectAssetUpdate(beat, filePath, "projectFolder")')) fail("PROJECT folder/Samples update route disappeared.");
if (!app.includes('Add folder to Project')) fail("folder-to-PROJECT destination disappeared.");
if (!app.includes('Project file required')) fail("folder updates no longer require an existing PROJECT.");
if (!app.includes('Replace PROJECT ZIP?') || !app.includes('Replace project file?')) fail("PROJECT replacement confirmation disappeared.");
if (!app.includes('if (isBackupFolderPath(filePath))')) fail("direct Backup/Backups drop is no longer rejected.");
if (!app.includes('Backup folders were skipped from')) fail("nested Backup/Backups filtering no longer reaches the user.");
if (!app.includes('libraryStateManager.commitSnapshot(refreshed, "dropped-master")')) fail("MASTER replacement lost its authoritative library commit.");
if (!app.includes('libraryStateManager.commitSnapshot(beatsLatestRef.current, "project-sync")')) fail("WAV/PROJECT updates lost an authoritative commit.");
if (!tauriClient.includes('update_project_archive_from_source')) fail("Tauri client lost PROJECT archive mutation.");
if (!rust.includes('pub fn update_project_archive_from_source') && !rust.includes('pub async fn update_project_archive_from_source')) fail("Rust lost PROJECT archive mutation.");
if (!rust.includes('Test-ForbiddenPart')) fail("PROJECT mutation lost Backup/Backups filtering.");

// 9D — Pinterest / external artwork isolation.
if (!browserArtwork.includes('application/x-pinterest-closeup-image')) fail("Pinterest custom MIME support disappeared.");
if (!browserArtwork.includes('i.pinimg.com')) fail("Pinterest CDN recognition disappeared.");
if (!nativeExternalImage.includes('__BEATGALER_EXTERNAL_IMAGE_V1__')) fail("native external-image sentinel disappeared.");
if (!app.includes('nativeExternalImageSignalFromPaths(incomingPaths)')) fail("native external-image marker is no longer intercepted before filesystem import.");
if (!app.includes('native-external-image-drop')) fail("external artwork event route disappeared.");
if (!app.includes('URLs never enter Import Beat and are accepted only by an artwork target')) fail("artwork-only URL invariant disappeared.");
if (!controller.includes('captureArtworkSourcesFromDataTransfer(dt)')) fail("browser fallback lost artwork source capture.");
if (!wry.includes('i.pinimg.com') || !wry.includes('application/x-pinterest-closeup-image')) fail("WRY Option-2 Pinterest extraction disappeared.");
if (!wry.includes('CF_HDROP') || !wry.includes('inspect_external_drop')) fail("WRY no longer separates local filesystem and browser payloads.");

console.log("PASS Phase 9C existing-beat slot updates: MASTER/WAV/PROJECT/folder routes, replacement safety, commits, readiness, and Backup filtering are protected");
console.log("PASS Phase 9D Pinterest/external artwork: browser/native sources stay artwork-only and isolated from local beat import");
