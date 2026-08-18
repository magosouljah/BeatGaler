import React, { useEffect, useMemo, useState } from "react";
import BeatCard from "../../src/components/BeatCard";
import type { Beat } from "../../src/types";

type ConnectionState = "online" | "offline" | "poor";

const offlineBeat = {
  id: "e2e-offline-beat",
  name: "E2E Offline Beat",
  folder_path: "E:\\BeatGaler-E2E\\Offline",
  mp3_path: "E:\\BeatGaler-E2E\\Offline\\E2E Offline Beat.mp3",
  wav_path: null,
  playback_path: "E:\\BeatGaler-E2E\\Offline\\E2E Offline Beat.mp3",
  bpm: "144",
  key: "gm",
  needs_resolution: false,
  tags: ["e2e", "offline"],
  rating: 5,
  image_base64: null,
  has_wav: false,
  has_stems: false,
  has_samples: true,
  samples_path: "E:\\BeatGaler-E2E\\Offline\\Samples",
  has_flp: false,
  has_als: false,
  stems_path: null,
  flp_path: null,
  als_path: null,
  other_files: [],
  color: "#4f2d7f",
  color2: "#24143c",
  has_loop: false,
  loop_path: null,
  telegram_file_id: "e2e-cloud-master",
  offline_available: true,
  cloud_status: "SYNCED",
} as Beat;

export default function E2EOfflineReconnectHarness() {
  const [connectionState, setConnectionState] = useState<ConnectionState>("online");
  const [beatVisible, setBeatVisible] = useState(true);
  const [blockedAction, setBlockedAction] = useState("");
  const [trashIntentCount, setTrashIntentCount] = useState(0);
  const [flushCount, setFlushCount] = useState(0);
  const [reloadCount, setReloadCount] = useState(0);
  const [reconnectOrder, setReconnectOrder] = useState<string[]>([]);

  const tagFrequency = useMemo(
    () => new Map(offlineBeat.tags.map(tag => [tag, 1])),
    [],
  );

  useEffect(() => {
    const loader = document.getElementById("beatgaler-startup-loader");
    if (loader) loader.remove();
    document.documentElement.removeAttribute("data-startup-loading");
    document.body.removeAttribute("data-startup-loading");

    const onOffline = () => {
      setConnectionState("offline");
    };

    const onOnline = () => {
      void (async () => {
        const order: string[] = [];
        order.push("poll");
        setReconnectOrder([...order]);

        // Controlled backend says reachable + connected.
        order.push("flush");
        setFlushCount(value => value + 1);
        setReconnectOrder([...order]);

        await Promise.resolve();

        order.push("reload");
        setReloadCount(value => value + 1);
        setReconnectOrder([...order]);

        setConnectionState("online");
      })();
    };

    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);

    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  const rejectOfflineMutation = (action: string): boolean => {
    if (connectionState === "online") return false;
    setBlockedAction(
      `${action} requires an internet connection. Offline mode is read-only except for moving beats to Trash.`,
    );
    return true;
  };

  const deleteBeat = () => {
    if (connectionState !== "online") {
      setTrashIntentCount(value => value + 1);
    }
    setBeatVisible(false);
  };

  const props: any = {
    beat: offlineBeat,
    tagFrequency,
    showIncompleteWarnings: false,
    openableProject: false,
    playing: false,
    selected: false,
    selectedCount: 0,
    selectMode: false,
    dragEnabled: true,
    networkOnline: connectionState === "online",
    offlineBusy: false,
    onToggleOffline: () => {},
    onRetryUpload: () => {},
    onPlay: () => {},
    onWarm: () => {},
    onDetail: () => {},
    onEdit: () => {
      if (!rejectOfflineMutation("Editing metadata")) {
        setBlockedAction("");
      }
    },
    onDelete: deleteBeat,
    onAddToQueue: () => {},
    onUpload: () => {
      rejectOfflineMutation("Uploading to YouTube");
    },
    onUploadTelegram: () => {
      rejectOfflineMutation("Uploading a beat");
    },
    onDownloadTelegram: () => {},
    onUploadProjectTelegram: () => {},
    onOpenProject: () => {},
    onUpdateProject: () => {},
    onCloudFiles: () => {},
    onBulkEdit: () => {},
    onBulkUpload: () => {},
    onBulkDelete: () => {},
    onToggleSelect: () => {},
    animDelay: 0,
  };

  return (
    <div
      data-e2e-connection-state={connectionState}
      data-e2e-trash-intents={trashIntentCount}
      data-e2e-flush-count={flushCount}
      data-e2e-reload-count={reloadCount}
      data-e2e-reconnect-order={reconnectOrder.join(">")}
      style={{ minHeight: "100vh", background: "#0c0c0c", padding: 32 }}
    >
      {connectionState === "offline" && (
        <div data-e2e-offline-banner="true">
          You're offline. This session can keep using already prepared audio; after restart only beats with the green Offline check are shown.
        </div>
      )}

      {blockedAction && (
        <div data-e2e-blocked-action="true">{blockedAction}</div>
      )}

      {beatVisible && (
        <div style={{ width: 240, marginTop: 48 }}>
          <BeatCard {...props} />
        </div>
      )}

      {!beatVisible && (
        <div data-e2e-beat-removed="true">Beat moved to Trash locally</div>
      )}
    </div>
  );
}
