import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AppSettings } from "../../types";

export type ConnectionState = "checking" | "online" | "poor" | "offline";

export interface SessionState {
  settings: AppSettings | null;
  setSettings: Dispatch<SetStateAction<AppSettings | null>>;
  setupDone: boolean;
  setSetupDone: Dispatch<SetStateAction<boolean>>;
  connectionState: ConnectionState;
  setConnectionState: Dispatch<SetStateAction<ConnectionState>>;
  cloudSessionVerified: boolean;
  setCloudSessionVerified: Dispatch<SetStateAction<boolean>>;
}

export function useSessionState(): SessionState {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [setupDone, setSetupDone] = useState(false);
  const [cloudSessionVerified, setCloudSessionVerified] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>(() =>
    typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "checking"
  );

  return {
    settings,
    setSettings,
    setupDone,
    setSetupDone,
    connectionState,
    setConnectionState,
    cloudSessionVerified,
    setCloudSessionVerified,
  };
}
