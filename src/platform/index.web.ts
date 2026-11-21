import type { PlatformAdapter } from "./contracts";
import { webAdapter } from "./webAdapter";

export function isDesktopRuntime(): boolean {
  return false;
}

export const platform: PlatformAdapter = webAdapter;

export type { PlatformAdapter } from "./contracts";
export type { PlatformCapabilities, PlatformKind } from "./capabilities";
