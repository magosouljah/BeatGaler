import type { Beat } from "../types";
import { platform } from "../platform";
import type { PlatformLibrarySyncResult } from "../platform/contracts";

type LibraryOperationKind = "reload" | "commit";

function libraryDiagnostic(event: string, detail: string): void {
  if (platform.kind !== "desktop") return;
  void import("./tauri")
    .then(({ diagnosticLog }) => diagnosticLog("library-tx", event, detail))
    .catch(() => {});
}

/**
 * Single serialization point for authoritative library operations.
 *
 * Rules:
 *  - Galer T-Library INDEX is the authority.
 *  - Only one INDEX read/commit transaction may be in flight from this renderer.
 *  - Refresh replaces local state from the authority; it never merges a stale render snapshot.
 *  - Callers may update React/local cache only after this manager resolves.
 *  - Once this renderer has a verified snapshot, a transient authority failure never
 *    turns that verified surface into an empty library. The verified snapshot stays
 *    reproducible/read-only until a later authoritative reload succeeds.
 */
class LibraryStateManager {
  private tail: Promise<void> = Promise.resolve();
  private sequence = 0;
  private lastVerified: Beat[] | null = null;
  private reloadInFlight: Promise<Beat[]> | null = null;

  private async exclusive<T>(kind: LibraryOperationKind, fn: () => Promise<T>): Promise<T> {
    const seq = ++this.sequence;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous.catch(() => {});
    const started = performance.now();
    try {
      console.info(`[library-tx] BEGIN kind=${kind} seq=${seq}`);
      libraryDiagnostic("BEGIN", `kind=${kind} seq=${seq}`);
      const result = await fn();
      libraryDiagnostic("OK", `kind=${kind} seq=${seq} elapsed_ms=${Math.round(performance.now() - started)}`);
      return result;
    } catch (error) {
      libraryDiagnostic("FAILED", `kind=${kind} seq=${seq} elapsed_ms=${Math.round(performance.now() - started)} error=${String(error)}`);
      throw error;
    } finally {
      console.info(`[library-tx] END kind=${kind} seq=${seq} ms=${Math.round(performance.now() - started)}`);
      release();
    }
  }

  reloadAuthoritative(): Promise<Beat[]> {
    if (this.reloadInFlight) return this.reloadInFlight;

    const pending = this.exclusive("reload", async () => {
      try {
        await platform.library.restoreAuthoritative();
        const restored = await platform.library.load();
        this.lastVerified = restored.slice();
        return restored;
      } catch (error) {
        if (this.lastVerified !== null) {
          console.warn("[library-tx] transient authority failure; preserving last verified library surface", error);
          libraryDiagnostic("PRESERVE_VERIFIED", `beats=${this.lastVerified.length} error=${String(error)}`);
          return this.lastVerified.slice();
        }
        throw error;
      }
    });
    this.reloadInFlight = pending;
    void pending.finally(() => {
      if (this.reloadInFlight === pending) this.reloadInFlight = null;
    }).catch(() => {});
    return pending;
  }

  async commitSnapshot(beats: Beat[], reason = "unspecified"): Promise<PlatformLibrarySyncResult> {
    const snapshot = beats.map(beat => ({ ...beat, tags: [...(beat.tags || [])] }));
    return this.exclusive("commit", async () => {
      console.info(`[library-tx] COMMIT reason=${reason} beats=${snapshot.length}`);
      libraryDiagnostic(
        "COMMIT_CANDIDATE",
        `reason=${reason} beats=${snapshot.length} cloud_beats=${snapshot.filter(beat => Boolean(beat.telegram_file_id)).length}`,
      );
      const result = await platform.library.commitSnapshot(snapshot);
      libraryDiagnostic(
        "COMMIT_CONFIRMED",
        `reason=${reason} message_id=${result.telegram_message_id} beat_count=${result.beat_count} updated=${result.updated}`,
      );
      this.lastVerified = snapshot;
      return result;
    });
  }

  verifiedSnapshot(): Beat[] | null {
    return this.lastVerified?.slice() ?? null;
  }
}

export const libraryStateManager = new LibraryStateManager();
