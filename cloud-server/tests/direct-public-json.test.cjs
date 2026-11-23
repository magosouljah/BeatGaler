'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { stripDirectCredentials } = require('../catalog/authority');
const { stripPermanentSecrets, transformSession } = require('../productive-temp-auth-boundary');

function sessionWithInjectedCredentials() {
  return {
    ok: false,
    api_id: 123,
    telegram_api_id: 123,
    permanent_auth_key: 'fake-top-level-key',
    details: {
      items: [
        null,
        { label: 'retained', api_id: 123, bot_token: 'fake-token', api_hash: 'fake-hash', permanent_auth_key: 'fake-key' },
        {
          toJSON() {
            return {
              api_id: 456,
              binding: { perm_auth_key_id: { low: 1, high: 2 }, encrypted_message: 'fake-encrypted-message' },
              nested: [{ BOT_TOKEN: 'fake-injected-token', telegram_api_hash: 'fake-injected-hash', perm_auth_key: 'fake-injected-key' }],
            };
          },
        },
      ],
    },
  };
}

const publicDetails = {
  items: [
    null,
    { label: 'retained', api_id: 123 },
    {
      api_id: 456,
      binding: { perm_auth_key_id: { low: 1, high: 2 }, encrypted_message: 'fake-encrypted-message' },
      nested: [{}],
    },
  ],
};

function wire(value) {
  return JSON.parse(JSON.stringify(value));
}

test('la autoridad filtra secretos anidados y añadidos al serializar', () => {
  const source = sessionWithInjectedCredentials();
  assert.deepEqual(wire(stripDirectCredentials(source)), { ok: false, details: publicDetails });
  assert.equal(source.details.items[1].bot_token, 'fake-token');
});

test('la frontera temporal filtra secretos anidados e inyectados y conserva el JSON público', async () => {
  const source = {
    ...sessionWithInjectedCredentials(),
    bot_token: 'fake-top-level-token',
    credential_envelope: { ciphertext: 'fake-legacy-envelope' },
  };
  const expected = { ok: false, api_id: 123, details: publicDetails };
  assert.deepEqual(wire(stripPermanentSecrets(source)), expected);
  assert.deepEqual(wire(await transformSession(source, null)), expected);
});
