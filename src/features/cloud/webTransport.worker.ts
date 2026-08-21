import { planWebUploadParts } from "./webTransportParts";
import type {
  WebTransportUploadResult,
  WebTransportWorkerCommand,
  WebTransportWorkerResponse,
} from "./webTransportWorkerProtocol";

type WorkerScope = {
  onmessage: ((event: MessageEvent<WebTransportWorkerCommand>) => void) | null;
  postMessage(message: WebTransportWorkerResponse): void;
};

const scope = globalThis as unknown as WorkerScope;
let botToken = "";
let chatId = "";

function apiUrl(method: string): string {
  if (!botToken) throw new Error("Galer Cloud Web transport is not initialized.");
  return `https://api.telegram.org/bot${botToken}/${method}`;
}

function retryDelay(error: any, attempt: number): number | null {
  const retryAfter = Number(error?.parameters?.retry_after || 0);
  if (retryAfter > 0) return Math.min(60_000, retryAfter * 1000);
  const status = Number(error?.error_code || error?.status || 0);
  if (status >= 400 && status < 500) return null;
  return attempt < 3 ? 300 * (2 ** (attempt - 1)) : null;
}

async function callApi<T>(method: string, form: FormData): Promise<T> {
  let lastError: any = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(apiUrl(method), { method: "POST", body: form });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true) {
        const error = Object.assign(new Error(payload?.description || `Galer Cloud HTTP ${response.status}`), payload, { status: response.status });
        const delay = retryDelay(payload, attempt);
        if (delay === null) throw error;
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      return payload.result as T;
    } catch (error) {
      lastError = error;
      const delay = retryDelay(error, attempt);
      if (delay === null) break;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError || new Error("Galer Cloud request failed.");
}

function textForm(fields: Record<string, string | number | boolean>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  return form;
}

function mediaFromMessage(message: any): { fileId: string; messageId: number } {
  const media = message?.document || message?.audio || message?.video || message?.animation;
  const fileId = String(media?.file_id || "");
  const messageId = Number(message?.message_id || 0);
  if (!fileId || !Number.isInteger(messageId) || messageId <= 0) {
    throw new Error("Galer Cloud returned incomplete uploaded file information.");
  }
  return { fileId, messageId };
}

async function deleteUploadedMessages(messageIds: number[]): Promise<void> {
  if (!messageIds.length) return;
  const form = textForm({ chat_id: chatId });
  form.append("message_ids", JSON.stringify(messageIds));
  await callApi("deleteMessages", form);
}

async function upload(requestId: string, input: Extract<WebTransportWorkerCommand, { op: "upload" }>['input']): Promise<WebTransportUploadResult> {
  const plans = planWebUploadParts(input.file.size, input.filename);
  const parts: WebTransportUploadResult["parts"] = [];
  try {
    for (const plan of plans) {
      const form = textForm({
        chat_id: chatId,
        message_thread_id: input.threadId,
        caption: `BEATGALER_MEDIA_V1 kind=${input.kind} beat=${input.beatId} part=${plan.index + 1}/${plans.length}`,
        disable_notification: true,
      });
      const blob = input.file.slice(plan.offset, plan.offset + plan.size, "application/octet-stream");
      form.append("document", blob, plan.filename);
      const media = mediaFromMessage(await callApi<any>("sendDocument", form));
      parts.push({
        telegram_file_id: `direct:${media.messageId}`,
        telegram_message_id: media.messageId,
        index: plan.index,
        size: plan.size,
        filename: plan.filename,
      });
      scope.postMessage({
        requestId,
        event: "progress",
        progress: {
          uploadedBytes: plan.offset + plan.size,
          totalBytes: input.file.size,
          partIndex: plan.index,
          partCount: plans.length,
        },
      });
    }
  } catch (error) {
    await deleteUploadedMessages(parts.map(part => part.telegram_message_id)).catch(() => {});
    throw error;
  }
  return {
    telegram_file_id: parts[0].telegram_file_id,
    telegram_message_id: parts[0].telegram_message_id,
    filename: input.filename,
    original_size: input.file.size,
    parts,
    transport: "direct-web",
  };
}

async function handle(command: WebTransportWorkerCommand): Promise<unknown> {
  switch (command.op) {
    case "initialize": {
      botToken = command.session.bot_token;
      chatId = command.session.chat_id;
      await callApi("getMe", new FormData());
      return { ready: true };
    }
    case "verify":
      await callApi("getChat", textForm({ chat_id: chatId }));
      return { verified: true };
    case "upload":
      return upload(command.requestId, command.input);
    case "shutdown":
      botToken = "";
      chatId = "";
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
