import type { WebTransportSession } from "./webTransportSession";

export interface WebTransportUploadInput {
  file: File;
  filename: string;
  beatId: string;
  kind: "MASTER" | "WAV" | "LOOP" | "PROJECT" | "STEMS" | "ARTWORK" | "OTHER";
  threadId: number;
}

export const WEB_DIRECT_MAX_FILE_BYTES = 1900 * 1024 * 1024;
export const WEB_PLAYBACK_FIRST_CHUNK_KB = 64;
export const WEB_PLAYBACK_FIRST_CHUNK_BYTES = WEB_PLAYBACK_FIRST_CHUNK_KB * 1024;
export const DEFAULT_PLAYBACK_DATA_LANES = 7;
export const WEB_PLAYBACK_DATA_LANES = DEFAULT_PLAYBACK_DATA_LANES;
export const STARTUP_PREFIX_BYTES = 64 * 1024;
export const WEB_PLAYBACK_PREFETCH_TARGET_SECONDS = Number.POSITIVE_INFINITY;
export const WEB_PLAYBACK_PREFETCH_MAX_BYTES = STARTUP_PREFIX_BYTES;

export type WebTransportErrorCode =
  | "ROUTE_MISSING"
  | "MEDIA_UNAVAILABLE"
  | "TRANSFER_FAILED"
  | "SESSION_INVALID"
  | "CANCELLED";

export interface WebTransportStoredFile {
  telegram_file_id: string;
  telegram_message_id: number;
  index: number;
  size: number;
  filename: string;
}
export interface WebTransportUploadResult {
  telegram_file_id: string;
  telegram_message_id: number;
  filename: string;
  original_size: number;
  parts: [WebTransportStoredFile];
  transport: "direct-web";
}
export interface WebTransportProgress { uploadedBytes: number; totalBytes: number; }
export interface WebTransportLibraryIndexResult { manifest: unknown; messageId: number | null; }
export interface WebTransportReplaceIndexInput { manifest: unknown; expectedMessageId: number | null; }
export interface WebTransportReplaceIndexResult { messageId: number; previousMessageId: number | null; beatCount: number; }
export interface WebTransportDeleteMessagesInput { messageIds: number[]; }
export interface WebTransportDeleteMessagesResult { deleted: number; }
export interface WebTransportDownloadInput { messageId: number; mimeType?: string | null; purpose?: "artwork" | "other"; }
export interface WebTransportDownloadResult { messageId: number; dataUrl: string; }
export interface WebTransportPrefetchInput { messageId: number; mimeType?: string | null; offsetBytes?: number; }
export interface WebTransportPrefetchResult {
  messageId: number;
  totalBytes: number;
  mimeType: string;
  prefix: ArrayBuffer;
  playableSeconds?: number;
  targetMet?: boolean;
}
export interface WebTransportPrefetchBatchInput {
  inputs: WebTransportPrefetchInput[];
  targetPlayableSeconds?: number;
  maxBytesPerFile?: number;
  maxConcurrency?: number;
}
export interface WebTransportPrefetchChunk {
  messageId: number;
  totalBytes: number;
  mimeType: string;
  offsetBytes: number;
  chunk: ArrayBuffer;
  downloadedBytes: number;
  playableSeconds: number;
  targetMet: boolean;
}
export interface WebTransportPrefetchTerminal {
  messageId: number;
  status: "READY" | "FAILED";
  code?: WebTransportErrorCode;
  error?: string;
  preempted?: boolean;
}
export type WebTransportPrefetchBatchItemResult =
  | { ok: true; result: WebTransportPrefetchResult & { playableSeconds: number; targetMet: boolean } }
  | { ok: false; messageId: number; error: string; code?: WebTransportErrorCode; preempted?: boolean };
export interface WebTransportPrefetchBatchResult { results: WebTransportPrefetchBatchItemResult[]; }
export interface WebTransportStreamInput {
  messageId: number;
  mimeType?: string | null;
  offsetBytes?: number;
  purpose?: "playback" | "export" | "other";
}
export interface WebTransportStreamResult { messageId: number; totalBytes: number; mimeType: string; }

export type WebTransportWorkerCommand =
  | {
      requestId: string;
      op: "initialize";
      startupMessageIds: number[];
      session: Pick<WebTransportSession,
        | "chat_id"
        | "transport_user_id"
        | "temp_auth_key"
        | "temp_session_id"
        | "temp_session_state"
        | "temp_primary_dcs"
      > & {
        expected_bot_id: string;
        temp_api_id: number;
        startup_routes?: Record<string, number>;
        routing_revision?: number;
      };
    }
  | { requestId: string; op: "verify_identity" }
  | { requestId: string; op: "verify" }
  | { requestId: string; op: "get_index" }
  | { requestId: string; op: "cancel_index"; targetRequestId: string }
  | { requestId: string; op: "replace_index"; input: WebTransportReplaceIndexInput }
  | { requestId: string; op: "delete_messages"; input: WebTransportDeleteMessagesInput }
  | { requestId: string; op: "download"; input: WebTransportDownloadInput }
  | { requestId: string; op: "prefetch"; input: WebTransportPrefetchInput }
  | { requestId: string; op: "prefetch_batch"; input: WebTransportPrefetchBatchInput }
  | { requestId: string; op: "prefetch_batch_cancel"; targetRequestId: string; messageId?: number }
  | { requestId: string; op: "playback_focus"; messageId: number }
  | { requestId: string; op: "playback_stable"; messageId: number }
  | { requestId: string; op: "playback_release"; messageId: number }
  | { requestId: string; op: "stream"; input: WebTransportStreamInput }
  | { requestId: string; op: "stream_ack"; targetRequestId: string }
  | { requestId: string; op: "cancel"; targetRequestId: string }
  | { requestId: string; op: "upload"; input: WebTransportUploadInput }
  | { requestId: string; op: "shutdown" };

export type WebTransportWorkerRequest = WebTransportWorkerCommand extends infer Command
  ? Command extends { requestId: string }
    ? Omit<Command, "requestId">
    : never
  : never;

export type WebTransportWorkerResponse =
  | { requestId: string; ok: true; result?: unknown }
  | { requestId: string; ok: false; error: string; code?: WebTransportErrorCode }
  | { requestId: string; event: "progress"; progress: WebTransportProgress }
  | { requestId: string; event: "download-chunk"; chunk: ArrayBuffer; downloadedBytes: number; totalBytes: number }
  | { requestId: string; event: "prefetch-chunk"; progress: WebTransportPrefetchChunk }
  | { requestId: string; event: "prefetch-terminal"; terminal: WebTransportPrefetchTerminal }
  | { requestId: string; event: "index-state"; state: "active" | "paused" };
