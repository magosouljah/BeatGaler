import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AppSettings, Beat } from "../../types";

interface SessionActionsOptions {
  setSettings: Dispatch<SetStateAction<AppSettings | null>>;
  setCloudSessionVerified: Dispatch<SetStateAction<boolean>>;
  logoutAccount: () => Promise<unknown>;
  releaseFile: () => void;
  progressiveRevealRunRef: { current: number };
  clearPlaybackPreparation: () => void;
  clearArtworkHydration: () => void;
  setRevealedBeatIds: Dispatch<SetStateAction<Set<string>>>;
  setBeats: Dispatch<SetStateAction<Beat[]>>;
  clearSelection: () => void;
}

export interface SessionActions {
  handleIncompleteWarningsChanged: (enabled: boolean) => void;
  handleCustomCursorChanged: (enabled: boolean) => void;
  handleFolderChanged: (folder: string) => void;
  handleDisconnectTelegramAccount: () => Promise<void>;
}

export function useSessionActions({
  setSettings,
  setCloudSessionVerified,
  logoutAccount,
  releaseFile,
  progressiveRevealRunRef,
  clearPlaybackPreparation,
  clearArtworkHydration,
  setRevealedBeatIds,
  setBeats,
  clearSelection,
}: SessionActionsOptions): SessionActions {
  const handleIncompleteWarningsChanged = useCallback((enabled: boolean) => {
    setSettings(current => current
      ? { ...current, incomplete_warnings_enabled: enabled }
      : { beats_folder: null, incomplete_warnings_enabled: enabled, custom_cursor_enabled: true });
  }, [setSettings]);

  const handleCustomCursorChanged = useCallback((enabled: boolean) => {
    setSettings(current => current
      ? { ...current, custom_cursor_enabled: enabled }
      : { beats_folder: null, incomplete_warnings_enabled: true, custom_cursor_enabled: enabled });
  }, [setSettings]);

  const handleFolderChanged = useCallback((folder: string) => {
    setSettings(current => current
      ? { ...current, beats_folder: folder }
      : { beats_folder: folder, incomplete_warnings_enabled: true, custom_cursor_enabled: true });
  }, [setSettings]);

  const handleDisconnectTelegramAccount = useCallback(async () => {
    await logoutAccount().catch(() => {});
    releaseFile();
    progressiveRevealRunRef.current += 1;
    clearPlaybackPreparation();
    clearArtworkHydration();
    setRevealedBeatIds(new Set());
    setCloudSessionVerified(false);
    setBeats([]);
    clearSelection();
    setSettings(current => current ? {
      ...current,
      telegram_cloud_connected: false,
      telegram_cloud_username: null,
    } : current);
  }, [
    logoutAccount,
    releaseFile,
    progressiveRevealRunRef,
    clearPlaybackPreparation,
    clearArtworkHydration,
    setRevealedBeatIds,
    setCloudSessionVerified,
    setBeats,
    clearSelection,
    setSettings,
  ]);

  return {
    handleIncompleteWarningsChanged,
    handleCustomCursorChanged,
    handleFolderChanged,
    handleDisconnectTelegramAccount,
  };
}
