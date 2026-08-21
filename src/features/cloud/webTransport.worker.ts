import { InputMedia, MemoryStorage, TelegramClient } from "@mtcute/web";
import {
  WEB_DIRECT_MAX_FILE_BYTES,
  type WebTransportUploadResult,
  type WebTransportWorkerCommand,
  type WebTransportWorkerResponse,
} from "./webTransportWorkerProtocol";

type WorkerScope = {
  onmessage: ((event: MessageEvent<WebTransportWorkerCommand>) => void) | null;
  postMessage(message: WebTransportWorkerResponse): void;
};

const scope = globalThis as unknown as WorkerScope;
let client: TelegramClient | null = null;
let chatId = "";
let vaultVerified = false;

async function closeClient(): Promise<void> {
  const current = client;
  client = null;
  vaultVerified = false;
  chatId = "";
  if (current) await current.destroy().catch(() => {});
}

async function initialize(command: Extract<WebTransportWorkerCommand, { op: "initialize" }>): Promise<void> {
  await closeClient();
  const { bot_token, chat_id, telegram_api_id, telegram_api_hash } = command.session;
  if (!bot_token || !chat_id || !telegram_api_id || !telegram_api_hash) {
    throw new Error("Galer Cloud returned incomplete Web transport credentials.");
  }

  const next = new TelegramClient({
    apiId: telegram_api_id,
    apiHash: telegram_api_hash,
    storage: new MemoryStorage(),
    disableUpdates: true,
  });
  try {
    await next.start({ botToken: bot_token });
    await next.getMe();
  } catch (error) {
    await next.destroy().catch(() => {});
    throw error;
  }
  client = next;
  chatId = chat_id;
}

async function verifyReady(): Promise<void> {
  if (!client || !chatId) throw new Error("Galer Cloud Web transport is not initialized.");
  await client.getChat(chatId);
  vaultVerified = true;
}

function validateFile(file: File): void {
  if (!(file instanceof File) || file.size <= 0) throw new Error("Upload source is missing or empty.");
  if (file.size > WEB_DIRECT_MAX_FILE_BYTES) {
    throw new Error("This file exceeds the 1.9 GB Galer Cloud Web limit.");
  }
}

async function upload(
  requestId: string,
  input: Extract<WebTransportWorkerCommand, { op: "upload" }>["input"],
): Promise<WebTransportUploadResult> {
  if (!client || !vaultVerified) throw new Error("Galer Cloud Web transport is not ready.");
  validateFile(input.file);

  // The browser File is read progressively in MTProto protocol chunks. Galer
  // Cloud still receives exactly one document in exactly one message.
  const message = await client.sendMedia(chatId, InputMedia.document(input.file, {
    fileName: input.filename,
    fileMime: input.file.type || "application/octet-stream",
    fileSize: input.file.size,
    caption: `BEATGALER_MEDIA_V1 kind=${input.kind} beat=${input.beatId}`,
  }), {
    silent: true,
    replyTo: input.threadId,
    threadId: input.threadId,
    progressCallback: uploadedBytes => {
      scope.postMessage({
        requestId,
        event: "progress",
        progress: {
          uploadedBytes: Math.min(input.file.size, Math.round(uploadedBytes)),
          totalBytes: input.file.size,
        },
      });
    },
  });
  const messageId = Number(message?.id || 0);
  if (!Number.isInteger(messageId) || messageId <= 0) {
    throw new Error("Galer Cloud returned incomplete uploaded file information.");
  }
  const stored = {
    telegram_file_id: `direct:${messageId}`,
    telegram_message_id: messageId,
    index: 0,
    size: input.file.size,
    filename: input.filename,
  };
  return {
    telegram_file_id: stored.telegram_file_id,
    telegram_message_id: messageId,
    filename: input.filename,
    original_size: input.file.size,
    parts: [stored],
    transport: "direct-web",
  };
}

async function handle(command: WebTransportWorkerCommand): Promise<unknown> {
  switch (command.op) {
    case "initialize":
      await initialize(command);
      return { ready: true };
    case "verify":
      await verifyReady();
      return { verified: true };
    case "upload":
      return upload(command.requestId, command.input);
    case "shutdown":
      await closeClient();
      return { closed: true };
  }
}

scope.onmessage = event => {
  const command = event.data;
  void handle(command).then(
    result => scope.postMessage({ requestId: command.requestId, ok: true, result }),
    error => scope.postMessage({ requestId: command.requestId, ok: false, error: String(error?.message || error) }),
  );
};
