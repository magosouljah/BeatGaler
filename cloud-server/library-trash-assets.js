'use strict';

const crypto = require('node:crypto');
const { LibraryQuotaError } = require('./library-beat-quota');

function invalid(message) { throw new LibraryQuotaError(message, 'LIBRARY_PURGE_ASSETS_UNVERIFIED'); }
function messageIds(value, out = new Set()) {
  if (Array.isArray(value)) { for (const item of value) messageIds(item, out); return out; }
  if (!value || typeof value !== 'object') return out;
  const explicit = value.telegram_message_id;
  const metadata = value.metadata_message_id;
  const locator = value.telegram_file_id;
  if (explicit != null && explicit !== '') {
    const id = Number(explicit);
    if (!Number.isSafeInteger(id) || id <= 0) invalid('Beat asset has an invalid Telegram message ID.');
    out.add(id);
  }
  if (metadata != null && metadata !== '') {
    const id = Number(metadata);
    if (!Number.isSafeInteger(id) || id <= 0) invalid('Beat metadata has an invalid Telegram message ID.');
    out.add(id);
  }
  if (locator != null && locator !== '') {
    const match = /^direct:(\d+)$/.exec(String(locator));
    if (!match) invalid('Beat asset has an unverifiable Telegram file locator.');
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id <= 0 || (explicit != null && explicit !== '' && id !== Number(explicit))) {
      invalid('Beat asset locator does not match its Telegram message ID.');
    }
    out.add(id);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'telegram_message_id' && key !== 'metadata_message_id' && key !== 'telegram_file_id') messageIds(child, out);
  }
  return out;
}

function beatAssets(beat) {
  if (!beat || typeof beat !== 'object' || !beat.master) invalid('Trash beat has no verifiable master asset.');
  const master = messageIds(beat.master);
  if (!master.size) invalid('Trash beat master has no Telegram message ID.');
  for (const section of [beat.artwork, beat.project, ...(Array.isArray(beat.files) ? beat.files : [])]) {
    if (section && !messageIds(section).size) invalid('Trash beat has an asset without a Telegram message ID.');
  }
  return [...messageIds(beat)].sort((a, b) => a - b);
}

function beatHash(beat) { return crypto.createHash('sha256').update(JSON.stringify(beat ?? null)).digest('hex'); }

module.exports = { beatAssets, beatHash, messageIds };
