import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(path.join(root, "src", "App.tsx"), "utf8");
const rust = readFileSync(path.join(root, "src-tauri", "src", "commands.rs"), "utf8");
const helper = readFileSync(path.join(root, "src-tauri", "direct-transport", "transport-helper.cjs"), "utf8");

const fail = message => { throw new Error(`MASTER replacement cleanup regression: ${message}`); };

const masterUiStart = app.indexOf('if (role === "main")');
const masterUiEnd = app.indexOf('if (role === "wav")', masterUiStart);
const masterUi = app.slice(masterUiStart, masterUiEnd);
if (masterUiStart < 0 || masterUiEnd < 0) fail("MASTER replacement UI transaction could not be located");
if (!masterUi.includes('uploadDroppedFileToTelegram(beat, filePath, "MASTER")')) fail("MASTER replacement no longer uploads the replacement first");
if (!masterUi.includes('libraryStateManager.commitSnapshot(refreshed, "dropped-master")')) fail("MASTER replacement no longer commits the authoritative INDEX");
if (masterUi.indexOf('uploadDroppedFileToTelegram(beat, filePath, "MASTER")') > masterUi.indexOf('libraryStateManager.commitSnapshot(refreshed, "dropped-master")')) fail("INDEX can commit before replacement upload succeeds");

const rustStart = rust.indexOf('pub fn upload_dropped_file_to_telegram(');
const rustEnd = rust.indexOf('let existing_slot:', rustStart);
const rustMaster = rust.slice(rustStart, rustEnd);
if (!rustMaster.includes('if cloud_type == "MASTER"')) fail("Rust MASTER-specific replacement path disappeared");
if (!rustMaster.includes('db_save(&conn, &updated)')) fail("new MASTER IDs are not persisted locally before INDEX commit");
if (!rustMaster.includes('updated.telegram_message_id = telegram_message_id')) fail("new MASTER message id is not persisted");

const replaceStart = helper.indexOf('async function replaceIndex(');
const replaceEnd = helper.indexOf('async function deleteMessages(', replaceStart);
const replace = helper.slice(replaceStart, replaceEnd);
if (replaceStart < 0 || replaceEnd < 0) fail("Direct INDEX replacement transaction could not be located");
const sendIndex = replace.indexOf('sendDocumentLocal(session');
const pinIndex = replace.indexOf("pinChatMessage");
const cleanupLoop = replace.indexOf('for (const id of previousRefs)');
const deleteMedia = replace.indexOf("deleteMessage", cleanupLoop);
if (sendIndex < 0 || pinIndex < 0 || cleanupLoop < 0 || deleteMedia < 0) fail("INDEX commit/obsolete-media cleanup stages are incomplete");
if (!(sendIndex < pinIndex && pinIndex < cleanupLoop && cleanupLoop < deleteMedia)) fail("obsolete MASTER can be deleted before the replacement INDEX is pinned");
if (!replace.includes('if (nextRefs.has(id)) continue')) fail("cleanup no longer preserves media still referenced by the new INDEX");
if (!replace.includes('isSafeNonDestructiveLibraryTransition')) fail("cleanup lost the identity-preservation safety gate");
if (!replace.includes('OBSOLETE_MEDIA_DELETE_FAILED')) fail("failed obsolete-media deletion is no longer diagnosable");
if (!replace.includes('MEDIA_CLEANUP_SKIPPED_DESTRUCTIVE_DIFF')) fail("skipped cleanup is no longer diagnosable");
if (!replace.includes('INDEX_REPLACE_OK')) fail("successful cleanup count is no longer diagnosable");

console.log("PASS MASTER replacement cleanup transaction: upload -> persist new IDs -> pin new INDEX -> delete only obsolete media, with failure/skip diagnostics retained");
