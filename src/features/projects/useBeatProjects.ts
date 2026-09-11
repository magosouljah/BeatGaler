import { useCallback, useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Beat } from "../../types";
import { appAlert, appConfirm } from "../../lib/dialog";
import { libraryStateManager } from "../../lib/libraryStateManager";
import { sanitizeUserVisibleText } from "../../lib/userVisibleError";
import { platform } from "../../platform";
import { getProjectCloudStatus, inspectProjectDropSource, listOpenableCloudProjectBeatIds, openBeatProject, updateProjectArchiveFromSource, uploadDroppedFileToTelegram, uploadProjectToTelegram } from "../../lib/tauri";
import { cleanupStagedDropPaths } from "../dragdrop/dropStaging";
import { extensionFromPath, fileNameFromPath } from "../dragdrop/pathHelpers";
import type { BeatRuntimeRegistry } from "../state/useBeatRuntimeRegistry";
import { isProjectDawExtension } from "./projectFileTypes";

type ConnectionState = "checking" | "online" | "poor" | "offline";
type DrawerState = { beat: Beat; mode: "detail" | "edit" } | null;
export type AutoProjectDropResult = "not-project" | "handled" | "started";

type Options = {
  beats: Beat[];
  connectionState: ConnectionState;
  rejectOfflineMutation: (label: string) => boolean;
  transitionRuntime: BeatRuntimeRegistry["transitionRuntime"];
  beatsLatestRef: MutableRefObject<Beat[]>;
  setBeats: Dispatch<SetStateAction<Beat[]>>;
  setDrawer: Dispatch<SetStateAction<DrawerState>>;
  runBeatCloudUpdate: (beat: Beat, filePath: string, work: () => Promise<void>) => void;
  setBeatCloudUpdateBusy: (beatId: string, active: boolean, success?: boolean) => void;
};

function runtimeErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRuntimeConflictError(error: unknown): boolean {
  const message = runtimeErrorMessage(error).toLowerCase();
  return message.includes("409") || message.includes("conflict") || message.includes("revision mismatch") || message.includes("version mismatch");
}

export function useBeatProjects({ beats, connectionState, rejectOfflineMutation, transitionRuntime, beatsLatestRef, setBeats, setDrawer, runBeatCloudUpdate, setBeatCloudUpdateBusy }: Options) {
  const [openableCloudProjectIds, setOpenableCloudProjectIds] = useState<Set<string>>(new Set());
  const [projectUpdateNotice, setProjectUpdateNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!projectUpdateNotice) return;
    const timer = window.setTimeout(() => setProjectUpdateNotice(null), 9000);
    return () => window.clearTimeout(timer);
  }, [projectUpdateNotice]);

  const refreshOpenableCloudProjects = useCallback(async () => {
    try { setOpenableCloudProjectIds(new Set(await listOpenableCloudProjectBeatIds())); }
    catch (error) { console.warn("Could not refresh Open Project indicators", error); }
  }, []);
  useEffect(() => { void refreshOpenableCloudProjects(); }, [beats, refreshOpenableCloudProjects]);
  useEffect(() => {
    const refresh = () => { void refreshOpenableCloudProjects(); };
    window.addEventListener("beatgaler:project-cloud-changed", refresh);
    window.addEventListener("beatgaler:project-cloud-updated", refresh);
    return () => { window.removeEventListener("beatgaler:project-cloud-changed", refresh); window.removeEventListener("beatgaler:project-cloud-updated", refresh); };
  }, [refreshOpenableCloudProjects]);

  const hasStoredProject = useCallback(async (beat: Beat) => {
    const status = await getProjectCloudStatus(beat);
    return status.valid || status.part_count > 0 || status.local_exists || status.state !== "LOCAL";
  }, []);

  const startProjectAssetUpdate = useCallback((beat: Beat, filePath: string, kind: "projectFile" | "projectFolder") => {
    runBeatCloudUpdate(beat, filePath, async () => {
      const inspection = kind === "projectFolder" ? await inspectProjectDropSource(filePath).catch(() => null) : null;
      if (inspection && !inspection.valid) throw new Error(inspection.reason || "This project folder could not be inspected.");
      if (inspection?.has_backups) setProjectUpdateNotice(`Backup folders were found in “${fileNameFromPath(filePath)}”. BeatGaler will skip them and continue with the project update.`);
      await updateProjectArchiveFromSource(beat, filePath, kind);
      await uploadProjectToTelegram(beat);
      window.dispatchEvent(new CustomEvent("beatgaler:project-cloud-updated", { detail: { beatId: beat.id } }));
      await libraryStateManager.commitSnapshot(beatsLatestRef.current, "project-sync");
      if (inspection?.has_backups) setProjectUpdateNotice(`Backup folders were skipped from “${fileNameFromPath(filePath)}” and were not added to PROJECT.zip.`);
    });
  }, [beatsLatestRef, runBeatCloudUpdate]);

  const startProjectZipReplacement = useCallback((beat: Beat, filePath: string) => {
    runBeatCloudUpdate(beat, filePath, async () => {
      await uploadDroppedFileToTelegram(beat, filePath, "PROJECT");
      window.dispatchEvent(new CustomEvent("beatgaler:project-cloud-updated", { detail: { beatId: beat.id } }));
      await libraryStateManager.commitSnapshot(beatsLatestRef.current, "project-sync");
    });
  }, [beatsLatestRef, runBeatCloudUpdate]);

  const handleAutoProjectDrop = useCallback(async (beat: Beat, filePath: string): Promise<AutoProjectDropResult> => {
    const ext = extensionFromPath(filePath);
    if (!(ext === "zip" || isProjectDawExtension(ext))) return "not-project";
    let inspection;
    try { inspection = await inspectProjectDropSource(filePath); }
    catch (error) { setBeatCloudUpdateBusy(beat.id, false, false); await cleanupStagedDropPaths([filePath]).catch(() => {}); await appAlert({ title: "Project check failed", message: String(error), danger: true }); return "handled"; }
    if (inspection.kind !== "zip" && inspection.kind !== "project_file") return "not-project";
    if (!inspection.valid) {
      setBeatCloudUpdateBusy(beat.id, false, false);
      await cleanupStagedDropPaths([filePath]).catch(() => {});
      await appAlert({ title: inspection.kind === "zip" ? "Invalid PROJECT" : "Project check failed", message: inspection.reason || "The project could not be validated.", danger: true });
      return "handled";
    }
    const existing = await hasStoredProject(beat).catch(() => false);
    if (existing) {
      setBeatCloudUpdateBusy(beat.id, false, false);
      const replace = await appConfirm({
        title: inspection.kind === "zip" ? "Replace PROJECT ZIP?" : "Replace project file?",
        message: inspection.kind === "zip" ? `"${beat.name}" already has a PROJECT ZIP. Replace it with ${fileNameFromPath(filePath)}?` : `"${beat.name}" already has a project file. Replace it with ${fileNameFromPath(filePath)}?`,
        confirmLabel: "Replace", cancelLabel: "Cancel", danger: true,
      });
      if (!replace) { await cleanupStagedDropPaths([filePath]).catch(() => {}); return "handled"; }
    }
    if (inspection.has_backups) setProjectUpdateNotice(`Backup folders were found in “${fileNameFromPath(filePath)}”. BeatGaler will skip them and continue with the PROJECT ZIP.`);
    if (inspection.kind === "zip") startProjectZipReplacement(beat, filePath); else startProjectAssetUpdate(beat, filePath, "projectFile");
    return "started";
  }, [hasStoredProject, setBeatCloudUpdateBusy, startProjectAssetUpdate, startProjectZipReplacement]);

  const handleBrowserProjectDrop = useCallback(async (beat: Beat, file: File): Promise<boolean> => {
    transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }, beat);
    transitionRuntime(beat.id, { type: "SYNC_UPDATE_STARTED" }, beat);
    try {
      const committed = await platform.editor.commit(beat, beat, { PROJECT: file });
      setBeats(current => { const next = current.map(item => item.id === committed.id ? committed : item); beatsLatestRef.current = next; return next; });
      setDrawer(current => current?.beat.id === committed.id ? { ...current, beat: committed } : current);
      transitionRuntime(beat.id, { type: "SYNC_UPDATE_SUCCEEDED" }, committed);
      return false;
    } catch (error) {
      const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
      transitionRuntime(beat.id, { type: "SYNC_FAILED", code: "WEB_FILE_UPDATE_FAILED", message, retryable: true }, beat);
      throw error;
    }
  }, [beatsLatestRef, setBeats, setDrawer, transitionRuntime]);

  const syncCurrentProject = useCallback(async (beat: Beat, mode: "upload" | "update") => {
    if (rejectOfflineMutation(mode === "upload" ? "Uploading a project" : "Updating a project")) return;
    transitionRuntime(beat.id, { type: "SYNC_QUEUE_UPDATE" }, beat);
    transitionRuntime(beat.id, { type: "SYNC_UPDATE_STARTED" }, beat);
    try {
      await uploadProjectToTelegram(beat);
      await libraryStateManager.commitSnapshot(beatsLatestRef.current, "project-sync");
      transitionRuntime(beat.id, { type: "SYNC_UPDATE_SUCCEEDED" }, beat);
      window.dispatchEvent(new CustomEvent("beatgaler:project-cloud-updated", { detail: { beatId: beat.id } }));
      await appAlert({ title: mode === "upload" ? "Project synced to Galer Cloud" : "Project updated", message: mode === "upload" ? `${beat.name}.zip is stored in Galer Cloud as one PROJECT file.` : "The current PROJECT.zip has been synced to Galer Cloud." });
    } catch (error) {
      const message = sanitizeUserVisibleText(runtimeErrorMessage(error), "Cloud operation failed.");
      if (isRuntimeConflictError(error)) transitionRuntime(beat.id, { type: "SYNC_CONFLICT", message }, beat);
      else transitionRuntime(beat.id, { type: "SYNC_FAILED", code: mode === "upload" ? "PROJECT_UPLOAD_FAILED" : "PROJECT_UPDATE_FAILED", message, retryable: true }, beat);
      await appAlert({ title: mode === "upload" ? "Project upload failed" : "Project update failed", message, danger: true });
    }
  }, [beatsLatestRef, rejectOfflineMutation, transitionRuntime]);

  const dismissProjectUpdateNotice = useCallback(() => setProjectUpdateNotice(null), []);
  const handleUploadProjectTelegram = useCallback((beat: Beat) => syncCurrentProject(beat, "upload"), [syncCurrentProject]);
  const handleUpdateProject = useCallback((beat: Beat) => syncCurrentProject(beat, "update"), [syncCurrentProject]);
  const handleOpenProject = useCallback(async (beat: Beat) => {
    if (connectionState !== "online" && !beat.offline_available) { await appAlert({ title: "Project unavailable offline", message: "This project was not downloaded with Available Offline. Reconnect to open it." }); return; }
    try { await openBeatProject(beat); await appAlert({ title: "Project opened", message: "Save normally in FL Studio. When you want those changes stored in Galer Cloud, return to BeatGaler and choose “Update Project”." }); }
    catch (error) { await appAlert({ title: "Project unavailable", message: runtimeErrorMessage(error), danger: true }); }
  }, [connectionState]);

  return { openableCloudProjectIds, projectUpdateNotice, dismissProjectUpdateNotice, hasStoredProject, startProjectAssetUpdate, handleAutoProjectDrop, handleBrowserProjectDrop, handleUploadProjectTelegram, handleOpenProject, handleUpdateProject };
}
