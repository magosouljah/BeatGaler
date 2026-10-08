"use strict";

const DEFINITIVE_MISSING_STORAGE_RE = /could not be found|group chat was deleted|supergroup chat was deleted|CHANNEL_INVALID|CHANNEL_PRIVATE|peer id invalid/i;

function storageErrorMessage(error) {
  return String(error?.errorMessage || error?.message || error || "");
}

function isDefinitiveMissingStorageError(error) {
  return DEFINITIVE_MISSING_STORAGE_RE.test(storageErrorMessage(error));
}

function createUserStorageLifecycle({
  validateStoredChatId,
  createPrivateUserStorageGroup,
  verifyPrivateUserStorageGroup,
  ensurePrivateUserStorageBotAbsent,
  masterStorageReady,
  managerBotUsername = "",
  storageGroupLimit,
  getProvisionedStorageCount,
  saveAuthData,
  clearStorageBindingsForUser,
  rebindStorageBindingsForUser,
  ensureEmptyIndexForStorage,
  now = () => Date.now(),
  logger = console,
} = {}) {
  const provisioningFlights = new Map();

  const requiredFunctions = {
    validateStoredChatId,
    createPrivateUserStorageGroup,
    verifyPrivateUserStorageGroup,
    ensurePrivateUserStorageBotAbsent,
    masterStorageReady,
    getProvisionedStorageCount,
    saveAuthData,
    clearStorageBindingsForUser,
    rebindStorageBindingsForUser,
    ensureEmptyIndexForStorage,
  };
  for (const [name, value] of Object.entries(requiredFunctions)) {
    if (typeof value !== "function") throw new TypeError(`${name} must be a function.`);
  }
  if (!Number.isSafeInteger(storageGroupLimit) || storageGroupLimit <= 0) {
    throw new TypeError("storageGroupLimit must be a positive safe integer.");
  }

  function userKey(user) {
    const id = String(user?.id || "").trim();
    if (!id) throw new Error("BeatGaler user id is required for storage provisioning.");
    return id;
  }

  function assignedAccount(user) {
    const storageChatId = validateStoredChatId(user?.storageChatId);
    return {
      telegramUserId: storageChatId,
      storageChatId,
      storageChatTitle: user?.storageChatTitle,
    };
  }

  async function withProvisioningFlight(user, operation) {
    const key = userKey(user);
    const existing = provisioningFlights.get(key);
    if (existing) return existing;

    const flight = Promise.resolve().then(operation);
    provisioningFlights.set(key, flight);
    try {
      return await flight;
    } finally {
      if (provisioningFlights.get(key) === flight) provisioningFlights.delete(key);
    }
  }

  async function provisionUnassigned(user) {
    if (user.storageChatId) {
      assignedAccount(user);
      return user;
    }

    const used = Number(getProvisionedStorageCount());
    if (!Number.isSafeInteger(used) || used < 0) {
      throw new Error("Provisioned storage count is invalid.");
    }
    if (used >= storageGroupLimit) {
      throw new Error(`Master Telegram storage account is full (${storageGroupLimit} user groups). Add master account #2 before registering more users.`);
    }
    if (!masterStorageReady()) {
      throw new Error("Master Telegram storage account is not configured. Run: node setup-master-account.js");
    }

    const created = await createPrivateUserStorageGroup({ username: user.username, accountId: user.id });
    user.storageChatId = String(created.botApiChatId);
    user.storageChatTitle = created.title;
    user.storageCreatedAt = now();
    assignedAccount(user);
    saveAuthData();
    rebindStorageBindingsForUser(user);

    await ensureEmptyIndexForStorage(assignedAccount(user));
    return user;
  }

  async function ensureAssigned(user) {
    if (user?.storageChatId) {
      // Login/session restore trusts the durable assignment. This validation is
      // deliberately local: no MASTER client, dialogs scan or manager cleanup.
      assignedAccount(user);
      return user;
    }

    return withProvisioningFlight(user, async () => {
      // Re-check after joining the flight so concurrent first-use calls cannot
      // create two vaults for the same account.
      if (user.storageChatId) {
        assignedAccount(user);
        return user;
      }
      return provisionUnassigned(user);
    });
  }

  async function verifyForRecovery(user, { cleanupManagerBot = true } = {}) {
    if (!user?.storageChatId) return { status: "unprovisioned", definitive: false };

    const account = assignedAccount(user);
    if (!masterStorageReady()) {
      return { status: "unavailable", definitive: false, account };
    }

    try {
      await verifyPrivateUserStorageGroup({ botApiChatId: user.storageChatId });
    } catch (error) {
      if (isDefinitiveMissingStorageError(error)) {
        return { status: "missing", definitive: true, account, error: storageErrorMessage(error) };
      }
      logger.warn?.(`[storage] vault verification unavailable for @${user.username}:`, storageErrorMessage(error));
      return { status: "unavailable", definitive: false, account, error: storageErrorMessage(error) };
    }

    if (cleanupManagerBot && managerBotUsername) {
      try {
        await ensurePrivateUserStorageBotAbsent({
          botApiChatId: user.storageChatId,
          botUsername: managerBotUsername,
        });
      } catch (error) {
        logger.warn?.(`[storage] manager-bot cleanup deferred for @${user.username}:`, storageErrorMessage(error));
        return { status: "healthy", definitive: false, account, maintenanceDeferred: true };
      }
    }

    return { status: "healthy", definitive: false, account };
  }

  async function recoverMissing(user, { expectedStorageChatId } = {}) {
    const expected = String(expectedStorageChatId || "").trim();
    if (!expected) throw new Error("Controlled storage recovery requires expectedStorageChatId.");

    return withProvisioningFlight(user, async () => {
      const current = String(user?.storageChatId || "").trim();
      if (current !== expected) {
        throw new Error("Storage assignment changed before recovery; refusing stale recovery.");
      }

      const verification = await verifyForRecovery(user, { cleanupManagerBot: false });
      if (verification.status !== "missing" || verification.definitive !== true) {
        throw new Error(`Storage recovery requires a definitive missing-vault verification; got ${verification.status}.`);
      }

      user.storageChatId = null;
      user.storageChatTitle = null;
      user.storageCreatedAt = null;
      saveAuthData();
      clearStorageBindingsForUser(user);

      return provisionUnassigned(user);
    });
  }

  return {
    ensureAssigned,
    verifyForRecovery,
    recoverMissing,
  };
}

module.exports = {
  DEFINITIVE_MISSING_STORAGE_RE,
  isDefinitiveMissingStorageError,
  createUserStorageLifecycle,
};
