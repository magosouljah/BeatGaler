import { sanitizeUserVisibleText } from "../../src/lib/userVisibleError.js";
import { equal, runSuite } from "../helpers/testHarness.js";

runSuite("user-visible error sanitization", [
  ["removes internal storage names and token-looking credentials", () => {
    const raw = "telegram-bot-api failed in TDLib for transport bot; Telegram token 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";
    const safe = sanitizeUserVisibleText(raw);
    equal(/telegram|tdlib|bot api|transport bot/i.test(safe), false, "Internal storage names reached UI text");
    equal(safe.includes("123456789:"), false, "Token-looking credential was not redacted");
    equal(safe.includes("Galer Storage") || safe.includes("Galer Cloud"), true, "Sanitized error lost its useful storage context");
  }],
  ["leaves neutral cloud errors unchanged", () => {
    const neutral = "Cloud PROJECT upload failed. Please retry.";
    equal(sanitizeUserVisibleText(neutral), neutral, "Neutral error changed unexpectedly");
  }],
]);
