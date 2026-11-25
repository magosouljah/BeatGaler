'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const ACCOUNTS_FILE_NAME = 'accounts-data.json';

function accountsDataPath(dataDir) {
  return path.join(dataDir, ACCOUNTS_FILE_NAME);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmailAfterNormalization(value) {
  const email = normalizeEmail(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function validEmailAsProvided(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function bearerTokenOptionalRequest(req) {
  const raw = String(req?.headers?.authorization || '');
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function bearerTokenRequiredRequest(req) {
  const raw = String(req.headers?.authorization || "");
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function sha256String(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}


function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256WithEncoding(value, encoding = 'hex') {
  return crypto.createHash('sha256').update(value).digest(encoding);
}

module.exports = {
  ACCOUNTS_FILE_NAME,
  accountsDataPath,
  normalizeEmail,
  validEmailAfterNormalization,
  validEmailAsProvided,
  bearerTokenOptionalRequest,
  bearerTokenRequiredRequest,
  sha256String,
  sha256Bytes,
  sha256WithEncoding,
};
