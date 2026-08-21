import type { WebTransportSession } from "./webTransportSession";

export interface WebTransportUploadInput {
  file: File;
  filename: string;
  beatId: string;
  kind: "MASTER" | "WAV" | "LOOP" | "PROJECT" | "STEMS" | "OTHER";
  threadId: number;
}

export interface WebTransportUploadedPart {
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
  parts: WebTransportUploadedPart[];
  transport: "direct-web";
}

export interface WebTransportProgress {
  uploadedBytes: number;
  totalBytes: number;
  partIndex: number;
  partCount: number;
}

export type WebTransportWorkerCommand =
  | { requestId: string; op: "initialize"; session: Pick<WebTransportSession, "bot_token" | "chat_id"> }
  | { requestId: string; op: "verify" }
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
  | { requestId: string; event: "progress"; progress: WebTransportProgress };
