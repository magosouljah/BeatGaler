"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { hashPassword, verifyPassword, SCRYPT_KEY_LENGTH } = require("../password-kdf");

test("hashPassword waits for the asynchronous scrypt result", async t => {
  const derivedKey = Buffer.alloc(SCRYPT_KEY_LENGTH, 42);
  let complete;
  const scrypt = t.mock.method(crypto, "scrypt", (_password, _salt, _length, callback) => {
    complete = callback;
  });
  const scryptSync = t.mock.method(crypto, "scryptSync", () => {
    throw new Error("Unexpected synchronous scrypt");
  });

  let finished = false;
  const pending = hashPassword("test password", "0011").then(hash => {
    finished = true;
    return hash;
  });
  // Keep early rejection handled until the assertions can run.
  pending.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scryptSync.mock.callCount(), 0);
  assert.equal(scrypt.mock.callCount(), 1);
  assert.equal(finished, false);

  complete(null, derivedKey);
  assert.equal(await pending, derivedKey.toString("hex"));
});

test("hash and verify preserve legacy scrypt hashes without synchronous derivation", async t => {
  const password = "correct horse battery staple";
  const saltHex = "00112233445566778899aabbccddeeff";
  const expected = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), SCRYPT_KEY_LENGTH).toString("hex");

  const sync = t.mock.method(crypto, "scryptSync", () => {
    throw new Error("Unexpected synchronous scrypt");
  });

  const actual = await hashPassword(password, saltHex);
  assert.equal(actual, expected, "async KDF must preserve existing scrypt hash compatibility");
  assert.equal(await verifyPassword(password, { passwordSalt: saltHex, passwordHash: expected }), true);
  assert.equal(await verifyPassword("wrong password", { passwordSalt: saltHex, passwordHash: expected }), false);
  assert.equal(sync.mock.callCount(), 0);
});

test("login and password change use the asynchronous KDF end to end over HTTP", async t => {
  const { account, withCloud } = require("./helpers/composition-cloud.cjs");
  const browser = { "x-beatgaler-client": "web", origin: "http://127.0.0.1", host: "127.0.0.1" };
  const login = (send, password) => send("POST", "/auth/login", {
    headers: browser,
    body: { email: account.email, password, beatgalerUserId: account.beatgalerUserId },
  });
  // No request path may fall back to synchronous derivation.
  const sync = t.mock.method(crypto, "scryptSync", () => { throw new Error("Unexpected synchronous scrypt"); });

  const verification = require("../email-verification-authority");
  const statusForUser = t.mock.method(verification, "statusForUser", async () => ({ email_verified: true }));
  await withCloud(async (_app, send) => {
    const legacy = await login(send, account.password);
    assert.equal(legacy.status, 200, "an account stored with the legacy scrypt hash must still sign in");
    assert.equal((await login(send, "wrong password")).status, 401);

    const cookies = legacy.headers["set-cookie"].map(value => value.split(";", 1)[0]);
    const session = { ...browser, cookie: cookies.join("; "), "x-beatgaler-csrf": JSON.parse(legacy.data).csrf_token };
    const change = body => send("POST", "/auth/password/change", { headers: session, body });
    const wrong = await change({ currentPassword: "not the password", newPassword: "another password 1" });
    assert.equal(wrong.status, 401, `password change must verify the current password: ${wrong.data}`);
    const short = await change({ currentPassword: account.password, newPassword: "short" });
    assert.equal(short.status, 400);
    const changed = await change({ currentPassword: account.password, newPassword: "another password 1" });
    assert.equal(changed.status, 200, changed.data);

    assert.equal((await login(send, account.password)).status, 401, "the old password must stop working");
    assert.equal((await login(send, "another password 1")).status, 200, "the new password must sign in");
    const stored = JSON.parse(fs.readFileSync(path.join(process.env.BEATGALER_STATE_DIR, "accounts-data.json"), "utf8"))
      .users.find(user => user.id === account.id);
    assert.notEqual(stored.passwordSalt, "0123456789abcdef0123456789abcdef", "password change must rotate the salt");
    assert.ok(statusForUser.mock.callCount() > 0, "the real sensitive-route guard must run before the handler");
    sync.mock.restore();
    const expected = crypto.scryptSync("another password 1", Buffer.from(stored.passwordSalt, "hex"), SCRYPT_KEY_LENGTH).toString("hex");
    assert.equal(stored.passwordHash, expected, "the stored hash must be the scrypt derivation of the new password");
  });
});

// /auth/register needs a pending signup backed by PostgreSQL (the composition
// Cloud has none), so its KDF wiring is still checked as source text.
test("register handler awaits the asynchronous KDF", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server-core.js"), "utf8");
  assert.equal(serverSource.includes("scryptSync"), false, "request paths must not contain synchronous scrypt");
  assert.match(serverSource, /passwordHash:\s*await hashPassword\(password, salt\)/, "register must await async KDF");
});
