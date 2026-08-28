"use strict";

const crypto = require("crypto");

const SCRYPT_KEY_LENGTH = 64;

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
    const actual = Buffer.from(await hashPassword(password, user?.passwordSalt), "hex");
    const expected = Buffer.from(String(user?.passwordHash || ""), "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

module.exports = {
  SCRYPT_KEY_LENGTH,
  hashPassword,
  verifyPassword,
};
