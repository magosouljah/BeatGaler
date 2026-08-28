"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { hashPassword, verifyPassword, SCRYPT_KEY_LENGTH } = require("../password-kdf");

(async () => {
  const password = "correct horse battery staple";
  const saltHex = "00112233445566778899aabbccddeeff";
  const expected = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), SCRYPT_KEY_LENGTH).toString("hex");

  const source = fs.readFileSync(require.resolve("../password-kdf"), "utf8");
  assert.equal(source.includes("scryptSync"), false, "production password KDF must not call synchronous scrypt");
  assert.match(source, /crypto\.scrypt\s*\(/, "production password KDF must use Node async scrypt");

  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server-core.js"), "utf8");
  assert.equal(serverSource.includes("scryptSync"), false, "request paths must not contain synchronous scrypt");
  assert.match(serverSource, /const \{ hashPassword, verifyPassword \} = require\("\.\/password-kdf"\);/);
  assert.match(serverSource, /passwordHash:\s*await hashPassword\(password, salt\)/, "register must await async KDF");
  assert.match(serverSource, /!\(await verifyPassword\(password, user\)\)/, "login must await async password verification");
  assert.match(serverSource, /app\.post\("\/auth\/password\/change", async \(req, res\) => \{/,
    "password change handler must be async");
  assert.match(serverSource, /!\(await verifyPassword\(currentPassword, user\)\)/,
    "password change must await current-password verification");
  assert.match(serverSource, /user\.passwordHash = await hashPassword\(newPassword, salt\)/,
    "password change must await new password KDF");

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

  console.log("PASS async password KDF: request wiring, event-loop yield, legacy hash compatibility");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
