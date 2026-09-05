import type { Beat } from "../../types";
import { WebGalerCloudTransport, type WebStartupWarmCandidate } from "../cloud/webGalerCloudTransport";
import { WEB_TRANSPORT_INVALIDATED_EVENT } from "../cloud/webTransportEvents";
import { WebPlaybackSourceManager, type WebPlaybackTransport } from "./webPlaybackSource";
import { playTrace } from "./playTrace";
import {
  readWebPlaybackRoutingCache,
  updatePlaybackRoutingSort,
  updatePlaybackRoutingStartupFromBeats,
  type WebPlaybackSort,
} from "./webPlaybackRoutingCache";

const PRESENTATION_LIBRARY_CACHE_KEY = "beatvault:library:v1";
const PRESENTATION_SORT_CACHE_KEY = "beatvault:sort:v2";

function localPresentationBeats(): Beat[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PRESENTATION_LIBRARY_CACHE_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((value): value is Beat => Boolean(value && typeof value === "object" && String(value.id || "").trim()))
      : [];
  } catch {
    return [];
  }
}

function localSort(): WebPlaybackSort {
  if (typeof window === "undefined") return "rating";
  try {
    const value = String(window.localStorage.getItem(PRESENTATION_SORT_CACHE_KEY) || "rating");
    return value === "manual" || value === "bpm" || value === "name" ? value : "rating";
  } catch {
    return "rating";
  }
}

function startupCandidates(): WebStartupWarmCandidate[] {
  const sort = localSort();
  let routing = readWebPlaybackRoutingCache();
  if (routing.sortBy !== sort && routing.authoritative && (routing.order?.length || 0) > 0) {
    updatePlaybackRoutingSort(sort);
    routing = readWebPlaybackRoutingCache();
  }
  if (routing.startup.length === 0) {
    const presentation = localPresentationBeats();
    if (presentation.length > 0) routing = updatePlaybackRoutingStartupFromBeats(presentation, sort);
  }
  return routing.startup.map(route => ({
    beatId: route.beatId,
    messageId: route.messageId,
    mimeType: route.mimeType,
    sizeBytes: route.sizeBytes,
  }));
}

/** Single authority for the remembered-session Web startup path. */
export class WebStartupPlaybackCoordinator {
  private readonly candidates = startupCandidates();
  private readonly transport = new WebGalerCloudTransport(this.candidates);
  private readonly sources: WebPlaybackSourceManager;
  private startPromise: Promise<void> | null = null;
  private warmSettled = false;
  private resolveIndexBarrier!: () => void;
  private listeningForInvalidation = false;
  private currentPlaybackMessageId: number | null = null;
  private readonly indexBarrierPromise = new Promise<void>(resolve => {
    this.resolveIndexBarrier = resolve;
  });
  private readonly onTransportInvalidated = () => {
    this.currentPlaybackMessageId = null;
    playTrace("SOURCE_SESSION_INVALIDATED");
    this.sources.releaseAll();
  };

  constructor() {
    this.transport.setIndexBarrier(() => this.waitUntilIndexAllowed());
    const coordinatedTransport: WebPlaybackTransport = {
      prefetchFile: input => this.transport.prefetchFile(input),
      prefetchFiles: (inputs, onChunk, onTerminal) => this.transport.prefetchFiles(inputs, onChunk, onTerminal),
      focusPlayback: messageId => this.beginPlayback(messageId),
      markPlaybackStable: messageId => this.markPlaybackStable(messageId),
      releasePlaybackFocus: messageId => this.endPlayback(messageId),
      streamFile: (input, onChunk) => this.transport.streamFile(input, onChunk),
    };
    this.sources = new WebPlaybackSourceManager(coordinatedTransport);
    if (typeof window !== "undefined") {
      window.addEventListener(WEB_TRANSPORT_INVALIDATED_EVENT, this.onTransportInvalidated);
      this.listeningForInvalidation = true;
    }
    playTrace("STARTUP_LOCAL_ROUTING_READY", { count: this.candidates.length });
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    playTrace("DIRECT_START_DISPATCHED", { startup_candidate_count: this.candidates.length });

    let attempt!: Promise<void>;
    attempt = (async () => {
      await this.transport.connectPlaybackDataPlane();
      if (this.candidates.length === 0) {
        this.finishStartupWarm(0, 0);
        return;
      }

      playTrace("WARM_BATCH_BEGIN", { count: this.candidates.length });
      const results = await Promise.allSettled(this.candidates.map(candidate =>
        this.sources.prefetch(candidate.beatId, candidate.messageId, candidate.mimeType, "visible")
      ));
      const failures = results.filter(result => result.status === "rejected").length;
      this.finishStartupWarm(this.candidates.length, failures);
    })().catch(error => {
      if (this.startPromise === attempt) this.startPromise = null;
      playTrace("DIRECT_START_RETRYABLE_FAILURE", {
        error_name: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    });

    this.startPromise = attempt;
    return attempt;
  }

  private finishStartupWarm(count: number, failures: number): void {
    if (this.warmSettled) return;
    this.warmSettled = true;
    playTrace("ADAPTER_STARTUP_WARM_SETTLED", { count, failures });
    this.resolveIndexBarrier();
  }

  async waitUntilIndexAllowed(): Promise<void> {
    if (!this.warmSettled) playTrace("INDEX_WAIT_STARTUP", { count: this.candidates.length });
    await this.start();
    await this.indexBarrierPromise;
  }

  private async restoreCurrentFocusAfter(staleMessageId: number): Promise<void> {
    const current = this.currentPlaybackMessageId;
    if (current === null || current === staleMessageId) return;
    playTrace("PLAY_FOCUS_RESTORE_AFTER_STALE_RELEASE", {
      stale_message_id: staleMessageId,
      current_message_id: current,
    });
    await this.transport.focusPlayback(current);
  }

  async beginPlayback(messageId: number): Promise<void> {
    this.currentPlaybackMessageId = messageId;
    playTrace("PLAY_FOCUS_BEGIN", { message_id: messageId });
    const startup = this.start();
    void startup.catch(error => playTrace("PLAY_DIRECT_START_DEFERRED", {
      message_id: messageId,
      error_name: error instanceof Error ? error.name : "unknown",
    }));
    try {
      await this.transport.focusPlayback(messageId);
    } catch (error) {
      if (this.currentPlaybackMessageId === messageId) this.currentPlaybackMessageId = null;
      throw error;
    }
  }

  async markPlaybackStable(messageId: number): Promise<void> {
    if (this.currentPlaybackMessageId !== messageId) return;
    await this.transport.markPlaybackStable(messageId);
    await this.restoreCurrentFocusAfter(messageId);
  }

  async endPlayback(messageId: number): Promise<void> {
    if (this.currentPlaybackMessageId !== messageId) return;
    this.currentPlaybackMessageId = null;
    await this.transport.releasePlaybackFocus(messageId);
    await this.restoreCurrentFocusAfter(messageId);
  }

  getTransport(): WebGalerCloudTransport {
    return this.transport;
  }

  getPlaybackSources(): WebPlaybackSourceManager {
    return this.sources;
  }

  dispose(): void {
    this.currentPlaybackMessageId = null;
    if (this.listeningForInvalidation && typeof window !== "undefined") {
      window.removeEventListener(WEB_TRANSPORT_INVALIDATED_EVENT, this.onTransportInvalidated);
      this.listeningForInvalidation = false;
    }
    this.sources.releaseAll();
  }
}

let singleton: WebStartupPlaybackCoordinator | null = null;

export function getWebStartupPlaybackCoordinator(): WebStartupPlaybackCoordinator {
  if (!singleton) singleton = new WebStartupPlaybackCoordinator();
  return singleton;
}

export async function disconnectWebStartupPlaybackCoordinator(): Promise<void> {
  const current = singleton;
  singleton = null;
  if (!current) return;
  current.dispose();
  await current.getTransport().disconnect();
}
