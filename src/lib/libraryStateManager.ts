import type { Beat } from "../types";
import { platform } from "../platform";
import type { PlatformLibrarySyncResult } from "../platform/contracts";

type LibraryOperationKind = "reload" | "commit";

/**
 * Single serialization point for authoritative Telegram library operations.
 *
 * Rules:
 *  - Telegram INDEX is the authority.
 *  - Only one INDEX read/commit transaction may be in flight from this renderer.
 *  - Refresh replaces local state from Telegram; it never merges a stale render snapshot.
 *  - Callers may update React/SQLite only after this manager resolves.
 */
class LibraryStateManager {
  private tail: Promise<void> = Promise.resolve();
  private sequence = 0;
  private lastVerified: Beat[] | null = null;

  private async exclusive<T>(kind: LibraryOperationKind, fn: () => Promise<T>): Promise<T> {
    const seq = ++this.sequence;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous.catch(() => {});
    const started = performance.now();
    try {
      console.info(`[library-tx] BEGIN kind=${kind} seq=${seq}`);
      return await fn();
    } finally {
      console.info(`[library-tx] END kind=${kind} seq=${seq} ms=${Math.round(performance.now() - started)}`);
      release();
    }
  }

  async reloadAuthoritative(): Promise<Beat[]> {
    return this.exclusive("reload", async () => {
      await platform.library.restoreAuthoritative();
      const restored = await platform.library.load();
      this.lastVerified = restored.slice();
      return restored;
    });
  }

  async commitSnapshot(beats: Beat[], reason = "unspecified"): Promise<PlatformLibrarySyncResult> {
    // Freeze the exact transaction candidate. React may mutate while this waits.
    const snapshot = beats.map(beat => ({ ...beat, tags: [...(beat.tags || [])] }));
    return this.exclusive("commit", async () => {
      console.info(`[library-tx] COMMIT reason=${reason} beats=${snapshot.length}`);
      const result = await platform.library.commitSnapshot(snapshot);
      this.lastVerified = snapshot;
      return result;
    });
  }

  verifiedSnapshot(): Beat[] | null {
    return this.lastVerified?.slice() ?? null;
  }
}

export const libraryStateManager = new LibraryStateManager();
