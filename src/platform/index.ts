import type { PlatformAdapter } from "./contracts";
import { desktopAdapter } from "./desktopAdapter";
import { webAdapter } from "./webAdapter";

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && Boolean((window as any).__TAURI_INTERNALS__);
}

export const platform: PlatformAdapter = isDesktopRuntime()
  ? desktopAdapter
  : webAdapter;

export type { PlatformAdapter } from "./contracts";
export type { PlatformCapabilities, PlatformKind } from "./capabilities";
