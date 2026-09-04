import { inspectMp3PlayablePrefix } from "../audio/mp3PlayablePrefix";
import {
  WEB_PLAYBACK_FIRST_CHUNK_BYTES,
  type WebTransportPrefetchInput,
  type WebTransportPrefetchResult,
} from "./webTransportWorkerProtocol";

export const WEB_PREFETCH_BATCH_MAX_LANES = 6;
export const WEB_PREFETCH_TARGET_SECONDS = 1;
export const WEB_PREFETCH_MAX_BYTES_PER_BEAT = 1024 * 1024;

export interface WebPrefetchRoundChunk {
  chunk: ArrayBuffer;
  totalBytes: number;
  mimeType: string;
}

export interface WebPrefetchBatchProgress {
  input: WebTransportPrefetchInput;
  bytes: number;
  playableSeconds: number;
  targetMet: boolean;
  totalBytes: number;
  mimeType: string;
  prefix: ArrayBuffer;
}

export interface WebPrefetchBatchOutcome {
  input: WebTransportPrefetchInput;
  result: WebTransportPrefetchResult | null;
  playableSeconds: number;
  targetMet: boolean;
  error: Error | null;
}

export type WebPrefetchChunkReader = (
  input: WebTransportPrefetchInput,
  offsetBytes: number,
) => Promise<WebPrefetchRoundChunk>;

type BatchState = {
  input: WebTransportPrefetchInput;
  chunks: ArrayBuffer[];
  bytes: number;
  totalBytes: number;
  mimeType: string;
  playableSeconds: number;
  targetMet: boolean;
  done: boolean;
  error: Error | null;
};

function concatChunks(chunks: readonly ArrayBuffer[], totalBytes: number): ArrayBuffer {
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    const bytes = new Uint8Array(chunk);
    merged.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return merged.buffer;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Warms every candidate in fair 64 KiB rounds. A candidate never receives a
 * second round until every still-schedulable candidate has received its current
 * round. The caller controls the control-plane lease; this function only bounds
 * data-plane concurrency.
 */
export async function runWebPrefetchBatch(
  inputs: readonly WebTransportPrefetchInput[],
  readChunk: WebPrefetchChunkReader,
  options: {
    maxLanes?: number;
    targetSeconds?: number;
    maxBytesPerBeat?: number;
    shouldContinue?: (input: WebTransportPrefetchInput) => boolean;
    onProgress?: (progress: WebPrefetchBatchProgress) => void;
  } = {},
): Promise<WebPrefetchBatchOutcome[]> {
  const maxLanes = Math.max(1, Math.min(
    WEB_PREFETCH_BATCH_MAX_LANES,
    Math.floor(options.maxLanes || WEB_PREFETCH_BATCH_MAX_LANES),
  ));
  const targetSeconds = Math.max(0.05, options.targetSeconds || WEB_PREFETCH_TARGET_SECONDS);
  const maxBytesPerBeat = Math.max(
    WEB_PLAYBACK_FIRST_CHUNK_BYTES,
    Math.floor(options.maxBytesPerBeat || WEB_PREFETCH_MAX_BYTES_PER_BEAT),
  );
  const states: BatchState[] = inputs.map(input => ({
    input,
    chunks: [],
    bytes: 0,
    totalBytes: 0,
    mimeType: String(input.mimeType || "audio/mpeg"),
    playableSeconds: 0,
    targetMet: false,
    done: false,
    error: null,
  }));

  while (states.some(state => !state.done && !state.error)) {
    for (const state of states) {
      if (!state.done && !state.error && options.shouldContinue && !options.shouldContinue(state.input)) {
        state.done = true;
      }
    }
    const round = states.filter(state => !state.done && !state.error);
    if (round.length <= 0) break;

    // Snapshot the round before any read starts. New progress made by an early
    // lane cannot cause it to receive another chunk until this whole snapshot
    // has had its turn.
    for (let cursor = 0; cursor < round.length; cursor += maxLanes) {
      const lane = round.slice(cursor, cursor + maxLanes);
      await Promise.all(lane.map(async state => {
        try {
          const next = await readChunk(state.input, state.bytes);
          if (!(next.chunk instanceof ArrayBuffer) || next.chunk.byteLength <= 0) {
            throw new Error("Galer Cloud returned an empty playback prefix chunk.");
          }
          if (next.chunk.byteLength > WEB_PLAYBACK_FIRST_CHUNK_BYTES) {
            throw new Error("Galer Cloud returned an oversized playback prefix chunk.");
          }

          state.chunks.push(next.chunk);
          state.bytes += next.chunk.byteLength;
          state.totalBytes = Math.max(state.totalBytes, Number(next.totalBytes) || 0);
          state.mimeType = String(next.mimeType || state.mimeType || "audio/mpeg");
          const prefix = concatChunks(state.chunks, state.bytes);
          const playable = inspectMp3PlayablePrefix(prefix);
          state.playableSeconds = playable.playableSeconds;
          state.targetMet = state.playableSeconds >= targetSeconds;
          const eof = state.totalBytes > 0 && state.bytes >= state.totalBytes;
          const shortChunk = next.chunk.byteLength < WEB_PLAYBACK_FIRST_CHUNK_BYTES;
          const hitFailSafe = state.bytes >= maxBytesPerBeat;
          state.done = state.targetMet || eof || shortChunk || hitFailSafe;

          options.onProgress?.({
            input: state.input,
            bytes: state.bytes,
            playableSeconds: state.playableSeconds,
            targetMet: state.targetMet,
            totalBytes: state.totalBytes || state.bytes,
            mimeType: state.mimeType,
            prefix,
          });
        } catch (error) {
          state.error = normalizeError(error);
        }
      }));
    }
  }

  return states.map(state => ({
    input: state.input,
    result: state.bytes > 0
      ? {
          messageId: state.input.messageId,
          totalBytes: state.totalBytes || state.bytes,
          mimeType: state.mimeType,
          prefix: concatChunks(state.chunks, state.bytes),
        }
      : null,
    playableSeconds: state.playableSeconds,
    targetMet: state.targetMet,
    error: state.error,
  }));
}
