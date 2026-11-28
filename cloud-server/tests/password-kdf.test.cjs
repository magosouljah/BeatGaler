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

// Behaviour: the pending-signup runtime (the only live register path) derives the
// password hash with the asynchronous KDF and stores exactly that derivation.
test("pending signup create() waits for async scrypt and stores its derivation", async t => {
  const { createPendingSignupRuntime } = require("../pending-signup-runtime");
  const inserts = [];
  let connects = 0;
  const client = {
    async query(sql, params) {
      if (String(sql).includes("INSERT INTO pending_signups")) inserts.push(params);
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { connects += 1; return client; } };
  const derivedKey = Buffer.alloc(SCRYPT_KEY_LENGTH, 7);
  let complete;
  let scryptSalt;
  const scrypt = t.mock.method(crypto, "scrypt", (_password, salt, _length, callback) => {
    scryptSalt = salt;
    complete = callback;
  });
  const scryptSync = t.mock.method(crypto, "scryptSync", () => {
    throw new Error("Unexpected synchronous scrypt");
  });
  const runtime = createPendingSignupRuntime({
    pool,
    keyring: { key: Buffer.alloc(32, 7), keyVersion: 1 },
    env: { BEATGALER_SIGNUP_PEPPER: "p".repeat(32) },
  });
  let finished = false;
  const pending = runtime.create({ email: "kdf@example.com", usernameBase: "kdfuser", password: "password-123" })
    .then(result => { finished = true; return result; });
  pending.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scrypt.mock.callCount(), 1);
  assert.equal(scryptSync.mock.callCount(), 0);
  assert.equal(finished, false, "create() must not resolve before the KDF callback");
  assert.equal(connects, 0, "no database work may start before the KDF finishes");

  complete(null, derivedKey);
  const result = await pending;
  assert.equal(result.status, "DELIVERY_PENDING");
  assert.equal(scryptSync.mock.callCount(), 0);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][3], derivedKey.toString("hex"), "inserted hash must be the scrypt derivation");
  assert.equal(inserts[0][4], scryptSalt.toString("hex"), "inserted salt must be the one fed to scrypt");
});

// Text guard (not behaviour): the classic request paths contain no synchronous scrypt.
test("server-core source has no synchronous scrypt (text guard)", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server-core.js"), "utf8");
  assert.equal(serverSource.includes("scryptSync"), false, "request paths must not contain synchronous scrypt");
});
