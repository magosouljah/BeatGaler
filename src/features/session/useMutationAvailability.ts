import { useCallback } from "react";
import { appAlert } from "../../lib/dialog";
import type { ConnectionState } from "./useSessionState";

export function useMutationAvailability(connectionState: ConnectionState) {
  const rejectOfflineMutation = useCallback((action: string): boolean => {
    if (connectionState === "online") return false;
    void appAlert({
      title: connectionState === "offline" ? "Offline" : "Connection unavailable",
      message: `${action} requires an internet connection. Offline mode is read-only except for moving beats to Trash.`,
    });
    return true;
  }, [connectionState]);

  return { rejectOfflineMutation };
}
