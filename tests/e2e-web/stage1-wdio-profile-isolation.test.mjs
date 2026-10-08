import assert from "node:assert/strict";
import { test } from "node:test";

async function loadConfigFor(accountCount) {
  const previous = process.env.STAGE1_RUN_ACCOUNTS;
  process.env.STAGE1_RUN_ACCOUNTS = String(accountCount);

  try {
    const url = new URL(
      `../../wdio.stage1-real.conf.mjs?profile-isolation=${Date.now()}-${Math.random()}`,
      import.meta.url,
    );
    return (await import(url.href)).config;
  } finally {
    if (previous === undefined) delete process.env.STAGE1_RUN_ACCOUNTS;
    else process.env.STAGE1_RUN_ACCOUNTS = previous;
  }
}

test("Stage 1 gives every multiremote Chrome alias its own user-data-dir", async () => {
  const config = await loadConfigFor(4);
  const entries = Object.entries(config.capabilities);

  assert.equal(entries.length, 4);

  const profileArgs = entries.map(([alias, value]) => {
    const args = value.capabilities?.["goog:chromeOptions"]?.args || [];
    const matches = args.filter(arg => String(arg).startsWith("--user-data-dir="));

    assert.equal(
      matches.length,
      1,
      `${alias} must define exactly one Chrome user-data-dir.`,
    );
    assert.ok(
      matches[0].includes(alias),
      `${alias} Chrome profile must include its own alias.`,
    );

    return matches[0];
  });

  assert.equal(
    new Set(profileArgs).size,
    entries.length,
    "Every Stage 1 browser alias must use a distinct Chrome profile.",
  );
});
