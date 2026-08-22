import type { WebTransportSession } from "./webTransportSession";

export interface WebTransportUploadInput {
  file: File;
  filename: string;
  beatId: string;
  kind: "MASTER" | "WAV" | "LOOP" | "PROJECT" | "STEMS" | "ARTWORK" | "OTHER";
  threadId: number;
}

export const WEB_DIRECT_MAX_FILE_BYTES = 1900 * 1024 * 1024;

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
  /** Galer T-Library compatibility: Web always writes exactly one stored file. */
  parts: [WebTransportStoredFile];
  transport: "direct-web";
}

export interface WebTransportProgress {
  uploadedBytes: number;
  totalBytes: number;
}

export interface WebTransportLibraryIndexResult {
  manifest: unknown;
  messageId: number | null;
}

export interface WebTransportReplaceIndexInput {
  manifest: unknown;
  expectedMessageId: number | null;
}

export interface WebTransportReplaceIndexResult {
  messageId: number;
  previousMessageId: number | null;
  beatCount: number;
}

export interface WebTransportDeleteMessagesInput {
  messageIds: number[];
}

export interface WebTransportDeleteMessagesResult {
  deleted: number;
}

export interface WebTransportDownloadInput {
  messageId: number;
  mimeType?: string | null;
}

export interface WebTransportDownloadResult {
  messageId: number;
  dataUrl: string;
}

export interface WebTransportStreamInput {
  messageId: number;
  mimeType?: string | null;
}

export interface WebTransportStreamResult {
  messageId: number;
  totalBytes: number;
  mimeType: string;
}

export type WebTransportWorkerCommand =
  | { requestId: string; op: "initialize"; session: Pick<WebTransportSession, "bot_token" | "chat_id" | "telegram_api_id" | "telegram_api_hash"> }
  | { requestId: string; op: "verify" }
  | { requestId: string; op: "get_index" }
  | { requestId: string; op: "replace_index"; input: WebTransportReplaceIndexInput }
  | { requestId: string; op: "delete_messages"; input: WebTransportDeleteMessagesInput }
  | { requestId: string; op: "download"; input: WebTransportDownloadInput }
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
  | { requestId: string; ok: false; error: string }
  | { requestId: string; event: "progress"; progress: WebTransportProgress }
  | {
      requestId: string;
      event: "download-chunk";
      chunk: ArrayBuffer;
      downloadedBytes: number;
      totalBytes: number;
    };
