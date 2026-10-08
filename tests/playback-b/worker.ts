// Test-only observation wrapper. The imported worker and mtcute keep their
// production scheduling, cache, retry and network behavior.
import { TelegramClient } from "@mtcute/web";

const originalInfo = console.info.bind(console);
const earlyMessages: unknown[] = [];
let ready = false;
self.addEventListener("message", event => { if (!ready) earlyMessages.push(event.data); });
console.info = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("[play-trace] ")) {
    try {
      const event = JSON.parse(args[0].slice(13));
      self.postMessage({ harnessTrace: event });
    } catch { /* An observation must not interrupt playback. */ }
  }
  originalInfo(...args);
};

const originalGetMessages = TelegramClient.prototype.getMessages;
TelegramClient.prototype.getMessages = async function (...args) {
  const messages = await originalGetMessages.apply(this, args);
  for (const message of messages) {
    if (message?.id !== 96) continue;
    self.postMessage({ harnessTrace: {
      stage: "TARGET_IDENTITY", message_id: message.id,
      filename_matches: message.media?.fileName === "Stage1 Playback v2 03.mp3",
      total_bytes: message.media?.fileSize ?? null,
    } });
  }
  return messages;
};

await import("../../src/features/cloud/webTransport.worker.ts");
ready = true;
for (const data of earlyMessages) self.onmessage?.({ data } as MessageEvent);
