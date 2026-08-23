import React, { createContext, useContext } from "react";
import { platform } from "./index";
import type { PlatformAdapter } from "./contracts";

const PlatformContext = createContext<PlatformAdapter>(platform);

export function PlatformProvider({ children }: { children: React.ReactNode }) {
  return <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): PlatformAdapter {
  return useContext(PlatformContext);
}
