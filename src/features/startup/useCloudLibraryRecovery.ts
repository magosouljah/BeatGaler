import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AppSettings, Beat } from "../../types";
import { libraryStateManager } from "../../lib/libraryStateManager";

type UseCloudLibraryRecoveryOptions = {
  beatsLength: number;
  setBeats: Dispatch<SetStateAction<Beat[]>>;
  setSettings: Dispatch<SetStateAction<AppSettings | null>>;
};

export function useCloudLibraryRecovery({ beatsLength, setBeats, setSettings }: UseCloudLibraryRecoveryOptions) {
  // One-time recovery for a cloud-only library after account login/startup.
  // No timer, no permanent synchronization.
  const cloudRecoveryAttemptedRef = useRef(false);

  const recoverCloudLibraryOnceIfEmpty = useCallback(async () => {
    if (cloudRecoveryAttemptedRef.current) return;
    if (beatsLength !== 0) return;

    cloudRecoveryAttemptedRef.current = true;
    try {
      const restored = await libraryStateManager.reloadAuthoritative();
      if (restored.length > 0) {
        setBeats(current => current.length === 0 ? restored : current);
      }
    } catch (error) {
      console.warn("Cloud library one-time recovery skipped:", error);
    }
  }, [beatsLength, setBeats]);

  // IMPORTANT: an empty library is a valid, authoritative state (for example
  // immediately after Remove All). Never infer recovery merely from
  // beatsLength === 0; doing so races the pending trash/index commit and can
  // resurrect the just-removed cards with their artwork unloaded. Recovery is
  // only allowed from the explicit account connection/startup event below.
  useEffect(() => {
    const onCloudConnected = (event: Event) => {
      const detail = (event as CustomEvent<{ connected?: boolean; username?: string | null }>).detail;
      if (!detail?.connected) return;

      setSettings(current => current ? {
        ...current,
        telegram_cloud_connected: true,
        telegram_cloud_username: detail.username ?? current.telegram_cloud_username ?? null,
      } : current);

      void recoverCloudLibraryOnceIfEmpty();
    };

    window.addEventListener("beatgaler:telegram-connected", onCloudConnected);
    return () => window.removeEventListener("beatgaler:telegram-connected", onCloudConnected);
  }, [recoverCloudLibraryOnceIfEmpty, setSettings]);
}
