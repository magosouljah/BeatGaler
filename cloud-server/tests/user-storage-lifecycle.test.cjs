"use strict";

const assert = require("node:assert/strict");
const { createUserStorageLifecycle, isDefinitiveMissingStorageError } = require("../user-storage-lifecycle");

function harness(overrides = {}) {
  const calls = [];
  let nextChat = 9001;
  const dependencies = {
    validateStoredChatId(value) {
      const text = String(value || "");
      if (!/^-100\d+$/.test(text)) throw new Error("Invalid Telegram storage chat id.");
      return Number(text);
    },
    async createPrivateUserStorageGroup({ username, accountId }) {
      calls.push(["create", username, accountId]);
      return { botApiChatId: Number(`-100${nextChat++}`), title: `BeatGaler @${username}` };
    },
    async verifyPrivateUserStorageGroup({ botApiChatId }) {
      calls.push(["verify", String(botApiChatId)]);
      return { ok: true };
    },
    async ensurePrivateUserStorageBotAbsent({ botApiChatId, botUsername }) {
      calls.push(["cleanup", String(botApiChatId), botUsername]);
      return false;
    },
    masterStorageReady: () => true,
    managerBotUsername: "001BeatGaler",
    storageGroupLimit: 500,
    getProvisionedStorageCount: () => 0,
    saveAuthData: () => calls.push(["save"]),
    clearStorageBindingsForUser: user => calls.push(["clear", user.id]),
    rebindStorageBindingsForUser: user => calls.push(["rebind", user.id, user.storageChatId]),
    ensureEmptyIndexForStorage: async account => calls.push(["index", account.storageChatId]),
    now: () => 123456,
    logger: { warn: (...args) => calls.push(["warn", ...args]) },
    ...overrides,
  };
  return { calls, lifecycle: createUserStorageLifecycle(dependencies) };
}

(async () => {
  assert.equal(isDefinitiveMissingStorageError(new Error("CHANNEL_INVALID")), true);
  assert.equal(isDefinitiveMissingStorageError(new Error("ETIMEDOUT")), false);

  {
    const { calls, lifecycle } = harness({
      verifyPrivateUserStorageGroup: async () => { throw new Error("MASTER must not verify on login"); },
      ensurePrivateUserStorageBotAbsent: async () => { throw new Error("MASTER cleanup must not run on login"); },
      masterStorageReady: () => { throw new Error("MASTER health must not gate login"); },
    });
    const user = { id: "existing", username: "existing", storageChatId: "-10012345", storageChatTitle: "Existing" };
    await lifecycle.ensureAssigned(user);
    assert.deepEqual(calls, []);
    assert.equal(user.storageChatId, "-10012345");
  }

  {
    const { calls, lifecycle } = harness();
    const user = { id: "new", username: "new", storageChatId: null };
    await lifecycle.ensureAssigned(user);
    assert.match(user.storageChatId, /^-100\d+$/);
    assert.equal(user.storageCreatedAt, 123456);
    assert.equal(calls.filter(call => call[0] === "create").length, 1);
    assert.equal(calls.filter(call => call[0] === "rebind").length, 1);
    assert.equal(calls.filter(call => call[0] === "verify").length, 0);
    assert.equal(calls.filter(call => call[0] === "cleanup").length, 0);
  }

  {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let creates = 0;
    const { lifecycle } = harness({
      createPrivateUserStorageGroup: async ({ username }) => {
        creates += 1;
        await gate;
        return { botApiChatId: -10077777, title: `BeatGaler @${username}` };
      },
    });
    const user = { id: "concurrent", username: "concurrent", storageChatId: null };
    const one = lifecycle.ensureAssigned(user);
    const two = lifecycle.ensureAssigned(user);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(creates, 1);
    release();
    await Promise.all([one, two]);
    assert.equal(creates, 1);
    assert.equal(user.storageChatId, "-10077777");
  }

  {
    const user = { id: "missing", username: "missing", storageChatId: "-10022222", storageChatTitle: "Old" };
    const { calls, lifecycle } = harness({
      verifyPrivateUserStorageGroup: async () => { throw Object.assign(new Error("CHANNEL_PRIVATE"), { errorMessage: "CHANNEL_PRIVATE" }); },
    });
    const result = await lifecycle.verifyForRecovery(user);
    assert.equal(result.status, "missing");
    assert.equal(result.definitive, true);
    assert.equal(user.storageChatId, "-10022222");
    assert.equal(calls.some(call => call[0] === "create"), false);
    assert.equal(calls.some(call => call[0] === "clear"), false);
  }

  {
    const user = { id: "transient", username: "transient", storageChatId: "-10033333" };
    const { calls, lifecycle } = harness({
      verifyPrivateUserStorageGroup: async () => { throw new Error("ETIMEDOUT"); },
    });
    const result = await lifecycle.verifyForRecovery(user);
    assert.equal(result.status, "unavailable");
    assert.equal(result.definitive, false);
    assert.equal(user.storageChatId, "-10033333");
    assert.equal(calls.some(call => call[0] === "create"), false);
    assert.equal(calls.some(call => call[0] === "clear"), false);
  }

  {
    const user = { id: "maintenance", username: "maintenance", storageChatId: "-10044444" };
    const { calls, lifecycle } = harness();
    const result = await lifecycle.verifyForRecovery(user);
    assert.equal(result.status, "healthy");
    assert.equal(calls.filter(call => call[0] === "verify").length, 1);
    assert.equal(calls.filter(call => call[0] === "cleanup").length, 1);
  }

  {
    let creates = 0;
    const user = { id: "recover", username: "recover", storageChatId: "-10055555", storageChatTitle: "Deleted" };
    const { calls, lifecycle } = harness({
      verifyPrivateUserStorageGroup: async () => { throw new Error("group chat was deleted"); },
      createPrivateUserStorageGroup: async ({ username }) => {
        creates += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
        return { botApiChatId: -10066666, title: `BeatGaler @${username}` };
      },
    });
    const one = lifecycle.recoverMissing(user, { expectedStorageChatId: "-10055555" });
    const two = lifecycle.recoverMissing(user, { expectedStorageChatId: "-10055555" });
    const [first, second] = await Promise.allSettled([one, two]);
    assert.equal(first.status, "fulfilled");
    assert.equal(second.status, "fulfilled");
    assert.equal(creates, 1);
    assert.equal(user.storageChatId, "-10066666");
    assert.equal(calls.filter(call => call[0] === "clear").length, 1);
    assert.equal(calls.filter(call => call[0] === "rebind").length, 1);
  }

  {
    const user = { id: "no-recover-on-transient", username: "no-recover-on-transient", storageChatId: "-10077777" };
    const { calls, lifecycle } = harness({
      verifyPrivateUserStorageGroup: async () => { throw new Error("ECONNRESET"); },
    });
    await assert.rejects(
      lifecycle.recoverMissing(user, { expectedStorageChatId: "-10077777" }),
      /requires a definitive missing-vault verification/,
    );
    assert.equal(user.storageChatId, "-10077777");
    assert.equal(calls.some(call => call[0] === "create"), false);
    assert.equal(calls.some(call => call[0] === "clear"), false);
  }

  console.log("PASS: user storage assignment, recovery classification and single-flight invariants");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
