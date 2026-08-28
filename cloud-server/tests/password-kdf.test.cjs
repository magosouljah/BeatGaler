"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { hashPassword, verifyPassword, SCRYPT_KEY_LENGTH } = require("../password-kdf");

(async () => {
  const password = "correct horse battery staple";
  const saltHex = "00112233445566778899aabbccddeeff";
  const expected = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), SCRYPT_KEY_LENGTH).toString("hex");

  const source = require("node:fs").readFileSync(require.resolve("../password-kdf"), "utf8");
  assert.equal(source.includes("scryptSync"), false, "production password KDF must not call synchronous scrypt");
  assert.match(source, /crypto\.scrypt\s*\(/, "production password KDF must use Node async scrypt");

  const pending = hashPassword(password, saltHex);
  let eventLoopTicked = false;
  await new Promise(resolve => setImmediate(() => {
    eventLoopTicked = true;
    resolve();
  }));
  assert.equal(eventLoopTicked, true, "hashPassword must yield to the event loop");

  const actual = await pending;
  assert.equal(actual, expected, "async KDF must preserve existing scrypt hash compatibility");
  assert.equal(await verifyPassword(password, { passwordSalt: saltHex, passwordHash: expected }), true);
  assert.equal(await verifyPassword("wrong password", { passwordSalt: saltHex, passwordHash: expected }), false);

  console.log("PASS async password KDF: no scryptSync, event-loop yield, legacy hash compatibility");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
