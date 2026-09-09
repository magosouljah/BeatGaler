import { useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AppSettings, Beat } from "../../types";
import { getBeatGalerAuthToken, getResolvedCloudApiBase } from "../../components/AccountGate";
import { flushOfflineTrashIntents, getCloudClientId, pollTelegramCloudStatus } from "../../lib/tauri";
import { libraryStateManager } from "../../lib/libraryStateManager";
import { cloudBeatFingerprint, libraryViewFingerprint } from "../library/libraryFingerprints";
import { preserveLoadedArtwork } from "../library/libraryPresentationCache";
import type { ConnectionState } from "../session/useSessionState";

interface UseCloudLibraryEventsOptions {
  setupDone: boolean;
  beatgalerUserId: string | null;
  setConnectionState: Dispatch<SetStateAction<ConnectionState>>;
  setCloudSessionVerified: Dispatch<SetStateAction<boolean>>;
  setSettings: Dispatch<SetStateAction<AppSettings | null>>;
  setBeats: Dispatch<SetStateAction<Beat[]>>;
  cloudMetaSnapshotRef: MutableRefObject<Map<string, string> | null>;
  cloudLibrarySnapshotRef: MutableRefObject<string | null>;
  visibleLibraryFingerprintRef: MutableRefObject<string>;
  startupCookingResolvedRef: MutableRefObject<boolean>;
  startupPipelineStartedRef: MutableRefObject<boolean>;
  startupEnginePrimeReadyRef: MutableRefObject<boolean>;
  progressiveRevealRunRef: MutableRefObject<number>;
  clearReconciledTrashRuntimeStates: () => void;
  clearArtworkHydration: () => void;
  clearPlaybackPreparation: () => void;
  setStartupCookingGate: Dispatch<SetStateAction<boolean>>;
}

export function useCloudLibraryEvents({
  setupDone,
  beatgalerUserId,
  setConnectionState,
  setCloudSessionVerified,
  setSettings,
  setBeats,
  cloudMetaSnapshotRef,
  cloudLibrarySnapshotRef,
  visibleLibraryFingerprintRef,
  startupCookingResolvedRef,
  startupPipelineStartedRef,
  startupEnginePrimeReadyRef,
  progressiveRevealRunRef,
  clearReconciledTrashRuntimeStates,
  clearArtworkHydration,
  clearPlaybackPreparation,
  setStartupCookingGate,
}: UseCloudLibraryEventsOptions): void {
  const cloudPullInFlightRef = useRef(false);

  // BeatGaler synchronization is push-based. There is no timer and no
  // focus-triggered full library scan.
  useEffect(() => {
    const userId = beatgalerUserId;
    if (!setupDone || !userId) return;

    const sourceId = getCloudClientId();
    const cloudBase = getResolvedCloudApiBase();
    let events: EventSource | null = null;
    let eventReconnectTimer: number | null = null;
    let eventReconnectDelayMs = 1000;
    let cancelled = false;

    const applyRemoteLibraryChange = async () => {
      if (cancelled || cloudPullInFlightRef.current) return;
      cloudPullInFlightRef.current = true;
      try {
        const flushedTrashCount = await flushOfflineTrashIntents();
        if (flushedTrashCount > 0) clearReconciledTrashRuntimeStates();
        const merged = await libraryStateManager.reloadAuthoritative();
        if (!cancelled) {
          const nextFingerprint = libraryViewFingerprint(merged);
          if (nextFingerprint !== visibleLibraryFingerprintRef.current) {
            visibleLibraryFingerprintRef.current = nextFingerprint;
            cloudMetaSnapshotRef.current = new Map(
              merged.filter(beat => !!beat.telegram_file_id).map(beat => [beat.id, cloudBeatFingerprint(beat)])
            );
            cloudLibrarySnapshotRef.current = merged
              .filter(beat => !!beat.telegram_file_id)
              .map(cloudBeatFingerprint)
              .join("\u001c");
            setBeats(current => preserveLoadedArtwork(merged, current));
          }
        }
      } catch (error) {
        console.warn("Telegram event sync failed:", error);
      } finally {
        cloudPullInFlightRef.current = false;
      }
    };

    const onLibraryChanged = () => {
      void (async () => {
        try {
          const status = await pollTelegramCloudStatus();
          if (cancelled || !status.connected) return;
          if (!status.reachable) {
            setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
            return;
          }
          setConnectionState("online");
          await applyRemoteLibraryChange();
        } catch {
          if (!cancelled) setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
        }
      })();
    };
    const onReady = () => {
      void (async () => {
        try {
          const status = await pollTelegramCloudStatus();
          if (cancelled) return;
          if (!status.reachable) {
            setCloudSessionVerified(false);
            setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
            return;
          }
          if (!status.connected) {
            setCloudSessionVerified(false);
            setSettings(current => current ? { ...current, telegram_cloud_connected: false, telegram_cloud_username: null } : current);
            return;
          }
          setSettings(current => current ? { ...current, telegram_cloud_connected: true, telegram_cloud_username: status.username } : current);
          setConnectionState("online");
          await applyRemoteLibraryChange();
          if (!cancelled) setCloudSessionVerified(true);
        } catch {
          if (!cancelled) setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
        }
      })();
    };
    const onTelegramConnected = () => {
      void (async () => {
        try {
          const status = await pollTelegramCloudStatus();
          if (cancelled || !status.connected) return;
          if (!status.reachable) {
            setConnectionState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "poor");
            return;
          }
          setConnectionState("online");
          startupCookingResolvedRef.current = false;
          startupPipelineStartedRef.current = false;
          startupEnginePrimeReadyRef.current = false;
          clearArtworkHydration();
          clearPlaybackPreparation();
          progressiveRevealRunRef.current += 1;
          setStartupCookingGate(false);
          setCloudSessionVerified(false);
          setSettings(current => current ? { ...current, telegram_cloud_connected: true, telegram_cloud_username: status.username } : current);
          await applyRemoteLibraryChange();
          if (!cancelled) setCloudSessionVerified(true);
        } catch (error) {
          console.warn("Could not activate Telegram vault:", error);
        }
      })();
    };

    const connectEvents = async () => {
      const token = getBeatGalerAuthToken();
      if (!token) return;
      try {
        const response = await fetch(`${cloudBase}/events/ticket`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ beatgalerUserId: userId }),
        });
        if (!response.ok) throw new Error(`Event authorization failed (${response.status}).`);
        const body = await response.json();
        if (cancelled || !body?.ticket) return;
        const url =
          `${cloudBase}/events?beatgalerUserId=${encodeURIComponent(userId)}` +
          `&sourceId=${encodeURIComponent(sourceId)}` +
          `&ticket=${encodeURIComponent(String(body.ticket))}`;
        events = new EventSource(url);
        events.onopen = () => { eventReconnectDelayMs = 1000; };
        events.addEventListener("ready", onReady);
        events.addEventListener("library_changed", onLibraryChanged);
        events.addEventListener("telegram_connected", onTelegramConnected);
        events.onerror = () => {
          // Event tickets are intentionally single-use. EventSource's built-in
          // reconnect would reuse the consumed ticket and receive 401 forever,
          // so close it and obtain a fresh ticket instead. SSE is only the push
          // notification channel; its failure is not evidence that Telegram or
          // the Cloud data plane is unreachable.
          events?.close();
          events = null;
          if (cancelled || eventReconnectTimer !== null) return;
          const delay = eventReconnectDelayMs;
          eventReconnectDelayMs = Math.min(eventReconnectDelayMs * 2, 30000);
          eventReconnectTimer = window.setTimeout(() => {
            eventReconnectTimer = null;
            void connectEvents();
          }, delay);
        };
      } catch (error) {
        console.warn("BeatGaler event authorization failed:", error);
        if (!cancelled && eventReconnectTimer === null) {
          const delay = eventReconnectDelayMs;
          eventReconnectDelayMs = Math.min(eventReconnectDelayMs * 2, 30000);
          eventReconnectTimer = window.setTimeout(() => {
            eventReconnectTimer = null;
            void connectEvents();
          }, delay);
        }
      }
    };

    void connectEvents();

    return () => {
      cancelled = true;
      if (eventReconnectTimer !== null) window.clearTimeout(eventReconnectTimer);
      events?.removeEventListener("ready", onReady);
      events?.removeEventListener("library_changed", onLibraryChanged);
      events?.removeEventListener("telegram_connected", onTelegramConnected);
      events?.close();
    };
  }, [setupDone, beatgalerUserId]);
}
