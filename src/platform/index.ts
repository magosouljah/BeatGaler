import type { PlatformAdapter } from "./contracts";
import { desktopAdapter } from "./desktopAdapter";
import { webAdapter } from "./webAdapter";

type RuntimeWindow = Pick<Window, "location"> & {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
};

export function isDesktopRuntime(runtimeWindow?: RuntimeWindow): boolean {
  const target: RuntimeWindow | undefined = runtimeWindow ??
    (typeof window !== "undefined" ? (window as RuntimeWindow) : undefined);
  if (!target) return false;
  if (Boolean(target.__TAURI_INTERNALS__) || Boolean(target.__TAURI__)) return true;

  // Packaged Tauri can expose its production origin before the injected globals
  // are observable by frontend module initialization (notably under WebDriver).
  // Treat only Tauri-owned production origins as Desktop; ordinary localhost/dev
  // remains Web so browser auth keeps its cookie/session-marker contract.
  const { protocol, hostname } = target.location;
  return protocol === "tauri:" || hostname === "tauri.localhost";
}

export const platform: PlatformAdapter = isDesktopRuntime()
  ? desktopAdapter
  : webAdapter;

export type { PlatformAdapter } from "./contracts";
export type { PlatformCapabilities, PlatformKind } from "./capabilities";
