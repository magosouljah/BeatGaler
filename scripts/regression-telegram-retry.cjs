const assert = require("node:assert/strict");
const {
  telegramRetryAfterSeconds,
  withTelegramFloodWait,
} = require("../cloud-server/telegram-retry");

async function main() {
  assert.equal(
    telegramRetryAfterSeconds(new Error("Too Many Requests: retry after 29")),
    29,
    "must parse Telegram description retry-after",
  );
  assert.equal(
    telegramRetryAfterSeconds({ response: { body: { parameters: { retry_after: 7 } } } }),
    7,
    "must parse Bot API parameters.retry_after",
  );
  assert.equal(telegramRetryAfterSeconds(new Error("network down")), null);

  let attempts = 0;
  const waits = [];
  const result = await withTelegramFloodWait(
    "regression",
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("Too Many Requests: retry after 2");
      return "ok";
    },
    {
      sleepFn: async ms => waits.push(ms),
      maxRetries: 4,
    },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits.every(ms => ms >= 2000), "must respect Telegram retry_after");

  console.log("PASS Telegram 429 retry_after parser + flood-wait retry");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
