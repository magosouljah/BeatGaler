import type { Beat } from "../../types";
import { WebGalerCloudTransport, type WebStartupWarmCandidate } from "../cloud/webGalerCloudTransport";
import { WebPlaybackSourceManager, type WebPlaybackTransport } from "./webPlaybackSource";
import { playTrace } from "./playTrace";
import {
  readWebPlaybackRoutingCache,
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
  const presentation = localPresentationBeats();
  if (presentation.length > 0) updatePlaybackRoutingStartupFromBeats(presentation, localSort());
  return readWebPlaybackRoutingCache().startup.map(route => ({
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
  private readonly indexBarrierPromise = new Promise<void>(resolve => {
    this.resolveIndexBarrier = resolve;
  });

  constructor() {
    this.transport.setIndexBarrier(() => this.waitUntilIndexAllowed());
    const coordinatedTransport: WebPlaybackTransport = {
      prefetchFile: input => this.transport.prefetchFile(input),
      prefetchFiles: (inputs, onChunk) => this.transport.prefetchFiles(inputs, onChunk),
      focusPlayback: messageId => this.beginPlayback(messageId),
      markPlaybackStable: messageId => this.markPlaybackStable(messageId),
      releasePlaybackFocus: messageId => this.endPlayback(messageId),
      streamFile: (input, onChunk) => this.transport.streamFile(input, onChunk),
    };
    this.sources = new WebPlaybackSourceManager(coordinatedTransport);
    playTrace("STARTUP_LOCAL_ROUTING_READY", { count: this.candidates.length });
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    playTrace("DIRECT_START_DISPATCHED", { startup_candidate_count: this.candidates.length });
    this.startPromise = (async () => {
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
      // A failed Direct startup must not deadlock the authoritative INDEX path.
      this.finishStartupWarm(this.candidates.length, this.candidates.length);
      throw error;
    });
    return this.startPromise;
  }

  private finishStartupWarm(count: number, failures: number): void {
    if (this.warmSettled) return;
    this.warmSettled = true;
    playTrace("ADAPTER_STARTUP_WARM_SETTLED", { count, failures });
    this.resolveIndexBarrier();
  }

  async waitUntilIndexAllowed(): Promise<void> {
    if (!this.warmSettled) playTrace("INDEX_WAIT_STARTUP", { count: this.candidates.length });
    void this.start();
    await this.indexBarrierPromise;
  }

  async beginPlayback(messageId: number): Promise<void> {
    playTrace("PLAY_FOCUS_BEGIN", { message_id: messageId });
    void this.start();
    await this.transport.focusPlayback(messageId);
  }

  markPlaybackStable(messageId: number): Promise<void> {
    return this.transport.markPlaybackStable(messageId);
  }

  endPlayback(messageId: number): Promise<void> {
    return this.transport.releasePlaybackFocus(messageId);
  }

  getTransport(): WebGalerCloudTransport {
    return this.transport;
  }

  getPlaybackSources(): WebPlaybackSourceManager {
    return this.sources;
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
  current.getPlaybackSources().releaseAll();
  await current.getTransport().disconnect();
}