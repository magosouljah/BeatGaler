import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperPath = path.join(root, "src-tauri", "direct-transport", "transport-helper.cjs");
const helper = readFileSync(helperPath, "utf8");
const mainMarker = "\nasync function main() {";
const mainOffset = helper.indexOf(mainMarker);
if (mainOffset < 0) throw new Error("Direct helper main() marker was not found.");

const context = vm.createContext({
  require,
  process,
  console,
  URL,
  AbortController,
  Buffer,
  setTimeout,
  clearTimeout,
});

vm.runInContext(
  `${helper.slice(0, mainOffset)}\n` +
  `globalThis.__beatgalerMasterCleanupTest = { collectReplacedMasterMessageIds, deleteMessageWithRetry };`,
  context,
  { filename: helperPath },
);

const api = context.__beatgalerMasterCleanupTest;
if (!api) throw new Error("Could not expose Direct MASTER cleanup helpers.");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function manifest(messageId) {
  return {
    beats: [{
      id: "beat-1",
      master: { telegram_message_id: messageId },
      telegram_message_id: messageId,
    }],
    trash: [],
  };
}

const replaced = api.collectReplacedMasterMessageIds(manifest(101), manifest(202));
assert(replaced.size === 1 && replaced.has(101), "Replaced MASTER cleanup must target only the previous MASTER message.");

const unchanged = api.collectReplacedMasterMessageIds(manifest(202), manifest(202));
assert(unchanged.size === 0, "Unchanged MASTER must never be scheduled for cleanup.");

// Keep the regression fast and deterministic: retry behavior is under test,
// not wall-clock backoff or diagnostic-file I/O.
vm.runInContext("diag = () => {}; sleep = async () => {};", context);

context.__deleteAttempts = 0;
vm.runInContext(`
  botApi = async () => {
    globalThis.__deleteAttempts += 1;
    if (globalThis.__deleteAttempts < 3) throw new Error('transient delete failure');
    return true;
  };
`, context);
const recovered = await api.deleteMessageWithRetry({ chatId: "vault" }, 101, 4, "REPLACED_MASTER");
assert(recovered.ok === true, "Replaced MASTER cleanup must recover from a transient delete failure.");
assert(recovered.attempts === 3 && context.__deleteAttempts === 3, "Replaced MASTER cleanup must retry until the delete succeeds.");

context.__deleteAttempts = 0;
vm.runInContext(`
  botApi = async () => {
    globalThis.__deleteAttempts += 1;
    throw new Error('persistent delete failure');
  };
`, context);
const failed = await api.deleteMessageWithRetry({ chatId: "vault" }, 101, 4, "REPLACED_MASTER");
assert(failed.ok === false, "Persistent MASTER cleanup failure must be reported instead of silently becoming success.");
assert(failed.attempts === 4 && context.__deleteAttempts === 4, "Persistent MASTER cleanup must exhaust the bounded retry budget.");

context.__deleteAttempts = 0;
vm.runInContext(`
  botApi = async () => {
    globalThis.__deleteAttempts += 1;
    throw new Error('Bad Request: message to delete not found');
  };
`, context);
const absent = await api.deleteMessageWithRetry({ chatId: "vault" }, 101, 4, "REPLACED_MASTER");
assert(absent.ok === true && absent.already_absent === true, "An already-absent old MASTER must be treated as idempotent cleanup success.");
assert(absent.attempts === 1 && context.__deleteAttempts === 1, "Already-absent cleanup must not waste retries.");

console.log("PASS Direct MASTER replacement cleanup retries transient failures, surfaces persistent failures, and treats already-absent media idempotently");
