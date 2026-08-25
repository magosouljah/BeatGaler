'use strict';

const fs = require('fs');
const path = require('path');

function backendPath(value, fallbackName) {
  const raw = String(value || '').trim();
  if (!raw) return path.join(__dirname, fallbackName);
  return path.isAbsolute(raw) ? raw : path.resolve(__dirname, raw);
}

function collectMediaMessageIds(manifest) {
  const out = new Set();
  const add = value => {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) out.add(n);
  };
  const addBeat = beat => {
    if (!beat || typeof beat !== 'object') return;
    add(beat.telegram_message_id);
    add(beat.master?.telegram_message_id);
    add(beat.artwork?.telegram_message_id);
    add(beat.metadata_message_id);
    for (const file of beat.files || []) {
      add(file?.telegram_message_id);
      for (const part of file?.manifest?.parts || file?.parts || []) add(part?.telegram_message_id);
    }
    const project = beat.project?.manifest || beat.project;
    add(project?.telegram_message_id);
    for (const part of project?.parts || []) add(part?.telegram_message_id);
  };
  for (const beat of manifest?.beats || []) addBeat(beat);
  for (const item of manifest?.trash || []) addBeat(item?.beat);
  return out;
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function installDirectMediaCleanupHook({
  directTransport,
  stateFile = backendPath(process.env.TRANSPORT_POOL_STATE, 'transport-pool-state.json'),
  logger = console,
  snapshotTtlMs = 10 * 60 * 1000,
} = {}) {
  if (!directTransport) throw new Error('directTransport is required.');
  if (directTransport.__beatgalerMasterMediaCleanupInstalled) {
    return directTransport.__beatgalerMasterMediaCleanupInstalled;
  }

  const originalBeginOperation = directTransport.beginOperation.bind(directTransport);
  const originalRecordIndexPointer = directTransport.recordIndexPointer.bind(directTransport);
  const beforeByChat = new Map();
  const inflight = new Set();

  function operationChatId(operationId, args) {
    const state = readState(stateFile);
    const operation = state?.operations?.[String(operationId || '')];
    if (!operation) return null;
    if (String(operation.session_id || '') !== String(args?.sessionId || '')) return null;
    if (String(operation.installation_id || '') !== String(args?.installationId || '')) return null;
    const chatId = Number(operation.chat_id);
    return Number.isSafeInteger(chatId) && chatId !== 0 ? chatId : null;
  }

  async function readCurrentManifest(chatId, expectedMessageId = null) {
    let lastError = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const pinned = await directTransport.getPinnedMessage(chatId);
        const messageId = Number(pinned?.message_id || 0);
        if (!messageId) throw new Error('No pinned Galer Library INDEX is available.');
        if (expectedMessageId && messageId !== Number(expectedMessageId)) {
          throw new Error(`Pinned INDEX propagation pending (${messageId} != ${expectedMessageId}).`);
        }
        const raw = await directTransport.downloadMessageBuffer(chatId, messageId);
        const manifest = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || ''));
        if (manifest?.schema !== 'beatgaler.telegram.library') {
          throw new Error('Pinned document is not a Galer Library INDEX.');
        }
        return { messageId, manifest };
      } catch (error) {
        lastError = error;
        if (attempt < 5) await sleep(120 * attempt);
      }
    }
    throw lastError || new Error('Could not read Galer Library INDEX.');
  }

  async function capturePreviousIndex(args, result) {
    if (String(args?.kind || '').toLowerCase() !== 'replace_index') return;
    if (!result?.ok || !result?.operation_id) return;
    const chatId = operationChatId(result.operation_id, args);
    if (!chatId) {
      logger.warn?.('[direct] MASTER media cleanup snapshot skipped: operation vault was not resolved.');
      return;
    }
    try {
      const previous = await readCurrentManifest(chatId);
      beforeByChat.set(String(chatId), {
        operationId: String(result.operation_id),
        messageId: previous.messageId,
        refs: collectMediaMessageIds(previous.manifest),
        capturedAt: Date.now(),
      });
    } catch (error) {
      // Best effort only. The Desktop transport bot still keeps its existing
      // <48h Bot API cleanup path, so a temporary MASTER read failure must not
      // block an otherwise valid INDEX transaction.
      logger.warn?.('[direct] MASTER media cleanup snapshot skipped:', error?.message || error);
    }
  }

  async function deleteWithMaster(chatId, ids) {
    const unique = [...new Set((ids || []).map(Number).filter(id => Number.isInteger(id) && id > 0))];
    if (!unique.length) return { deleted: 0, alreadyAbsent: 0, failed: [] };

    try {
      await directTransport.deleteMessages(chatId, unique);
      return { deleted: unique.length, alreadyAbsent: 0, failed: [] };
    } catch (batchError) {
      // The Desktop bot may already have deleted recent (<48h) objects. If a
      // mixed batch contains one now-missing id, retry individually so an old
      // (>48h) object can still be removed through MASTER MTProto.
      let deleted = 0;
      let alreadyAbsent = 0;
      const failed = [];
      for (const id of unique) {
        try {
          await directTransport.deleteMessages(chatId, [id]);
          deleted += 1;
        } catch (error) {
          const message = String(error?.message || error || '');
          if (/MSG_ID_INVALID|MESSAGE_ID_INVALID|message.*not found/i.test(message)) {
            alreadyAbsent += 1;
          } else {
            failed.push({ id, error: message });
          }
        }
      }
      if (failed.length && !deleted && !alreadyAbsent) {
        logger.warn?.('[direct] MASTER media cleanup batch failed:', batchError?.message || batchError);
      }
      return { deleted, alreadyAbsent, failed };
    }
  }

  async function cleanupAfterCommit(chatId, expectedMessageId) {
    const key = String(chatId);
    const previous = beforeByChat.get(key);
    if (!previous) return;
    beforeByChat.delete(key);
    if (Date.now() - Number(previous.capturedAt || 0) > snapshotTtlMs) return;

    try {
      const current = await readCurrentManifest(chatId, expectedMessageId);
      const nextRefs = collectMediaMessageIds(current.manifest);
      const obsolete = [...previous.refs].filter(id => !nextRefs.has(id));
      if (!obsolete.length) return;
      const summary = await deleteWithMaster(chatId, obsolete);
      if (summary.failed.length) {
        logger.warn?.(`[direct] MASTER_MEDIA_CLEANUP_PARTIAL vault=${chatId} deleted=${summary.deleted} absent=${summary.alreadyAbsent} failed=${summary.failed.length}`);
      } else {
        logger.log?.(`[direct] MASTER_MEDIA_CLEANUP_OK vault=${chatId} deleted=${summary.deleted} absent=${summary.alreadyAbsent}`);
      }
    } catch (error) {
      logger.warn?.('[direct] MASTER media cleanup deferred:', error?.message || error);
    }
  }

  directTransport.beginOperation = async function beginOperationWithMediaSnapshot(args) {
    const result = await originalBeginOperation(args);
    await capturePreviousIndex(args, result);
    return result;
  };

  directTransport.recordIndexPointer = function recordIndexPointerWithMediaCleanup(chatId, pointer) {
    const result = originalRecordIndexPointer(chatId, pointer);
    if (beforeByChat.has(String(chatId))) {
      const task = cleanupAfterCommit(Number(chatId), Number(pointer?.messageId || 0));
      inflight.add(task);
      task.finally(() => inflight.delete(task));
    }
    return result;
  };

  const handle = {
    collectMediaMessageIds,
    flush: () => Promise.allSettled([...inflight]),
  };
  Object.defineProperty(directTransport, '__beatgalerMasterMediaCleanupInstalled', {
    value: handle,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return handle;
}

module.exports = {
  collectMediaMessageIds,
  installDirectMediaCleanupHook,
};
