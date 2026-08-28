"use strict";

const crypto = require("crypto");

const SCRYPT_KEY_LENGTH = 64;
let passwordAuthorityResolver = null;

function setPasswordAuthorityResolver(resolver) {
  passwordAuthorityResolver = typeof resolver === "function" ? resolver : null;
}

function hashPassword(password, saltHex) {
  return new Promise((resolve, reject) => {
    let salt;
    try {
      salt = Buffer.from(String(saltHex || ""), "hex");
    } catch (error) {
      reject(error);
      return;
    }

    crypto.scrypt(String(password), salt, SCRYPT_KEY_LENGTH, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey.toString("hex"));
    });
  });
}

async function verifyPassword(password, user) {
  try {
    const override = passwordAuthorityResolver?.(String(user?.id || "")) || null;
    const authority = override?.passwordHash && override?.passwordSalt
      ? { ...user, ...override }
      : user;
    const actual = Buffer.from(await hashPassword(password, authority?.passwordSalt), "hex");
    const expected = Buffer.from(String(authority?.passwordHash || ""), "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

module.exports = {
  SCRYPT_KEY_LENGTH,
  hashPassword,
  verifyPassword,
  setPasswordAuthorityResolver,
};
