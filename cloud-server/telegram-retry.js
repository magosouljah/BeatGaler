"use strict";

function telegramRetryAfterSeconds(error) {
  const direct = [
    error?.retry_after,
    error?.parameters?.retry_after,
    error?.response?.body?.parameters?.retry_after,
    error?.response?.body?.retry_after,
  ];
  for (const value of direct) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.ceil(n);
  }

  const message = String(
    error?.response?.body?.description || error?.message || error || ""
  );
  const match = message.match(/retry\s+after\s+(\d+)/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withTelegramFloodWait(label, operation, options = {}) {
  const maxRetries = Number.isFinite(options.maxRetries) ? Math.max(0, options.maxRetries) : 4;
  const sleepFn = typeof options.sleepFn === "function" ? options.sleepFn : sleep;
  const onWait = typeof options.onWait === "function" ? options.onWait : () => {};

  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      const retryAfter = telegramRetryAfterSeconds(error);
      if (!retryAfter || attempt >= maxRetries) throw error;
      attempt += 1;
      // Telegram's retry_after is authoritative. A small safety margin avoids
      // waking on the exact boundary and immediately receiving another 429.
      const waitMs = retryAfter * 1000 + 350;
      onWait({ label, retryAfter, waitMs, attempt, error });
      await sleepFn(waitMs);
    }
  }
}

module.exports = {
  telegramRetryAfterSeconds,
  withTelegramFloodWait,
};
