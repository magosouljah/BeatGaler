'use strict';

const { encryptSecretForStorage, decryptSecretFromStorage } = require('./secret-envelope');
const { normalizeSecretKeyring } = require('./secret-keyring');

function stored(row, prefix) {
  return {
    ciphertext: row[`${prefix}_ciphertext`],
    nonce: row[`${prefix}_nonce`],
    keyVersion: row.secret_key_version,
  };
}

function decryptWith(keyring, value, aad) {
  return decryptSecretFromStorage(value, {
    aad,
    resolveKey: version => keyring.resolveKey(version),
  });
}

function encryptWith(keyring, plaintext, aad) {
  return encryptSecretForStorage(plaintext, {
    key: keyring.encryptKey,
    keyVersion: keyring.activeKeyVersion,
    aad,
  });
}

async function rotateStoredControlPlaneSecrets(pool, { sourceKeyring, targetKeyring }) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('PostgreSQL pool is required.');
  const source = normalizeSecretKeyring(sourceKeyring);
  const target = normalizeSecretKeyring(targetKeyring);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const providers = (await client.query(`SELECT id,user_id,provider,access_token_ciphertext,access_token_nonce,
      refresh_token_ciphertext,refresh_token_nonce,secret_key_version
      FROM provider_identities
      WHERE secret_key_version IS NOT NULL
      ORDER BY id
      FOR UPDATE`)).rows;
    const mfa = (await client.query(`SELECT id,user_id,factor_type,secret_ciphertext,secret_nonce,secret_key_version
      FROM mfa_factors
      ORDER BY id
      FOR UPDATE`)).rows;

    let providerSecrets = 0;
    for (const row of providers) {
      let access = null;
      let refresh = null;
      if (row.access_token_ciphertext) {
        const plaintext = decryptWith(source, stored(row, 'access_token'), `provider:${row.provider}:${row.user_id}:access`);
        access = encryptWith(target, plaintext, `provider:${row.provider}:${row.user_id}:access`);
        providerSecrets += 1;
      }
      if (row.refresh_token_ciphertext) {
        const plaintext = decryptWith(source, stored(row, 'refresh_token'), `provider:${row.provider}:${row.user_id}:refresh`);
        refresh = encryptWith(target, plaintext, `provider:${row.provider}:${row.user_id}:refresh`);
        providerSecrets += 1;
      }
      await client.query(`UPDATE provider_identities
        SET access_token_ciphertext=$2,access_token_nonce=$3,
          refresh_token_ciphertext=$4,refresh_token_nonce=$5,
          secret_key_version=$6,updated_at=now()
        WHERE id=$1`, [
        row.id,
        access?.ciphertext || null,
        access?.nonce || null,
        refresh?.ciphertext || null,
        refresh?.nonce || null,
        target.activeKeyVersion,
      ]);
    }

    for (const row of mfa) {
      if (row.factor_type !== 'totp') throw new Error(`Unsupported MFA factor during secret rotation: ${row.factor_type}`);
      const plaintext = decryptSecretFromStorage({
        ciphertext: row.secret_ciphertext,
        nonce: row.secret_nonce,
        keyVersion: row.secret_key_version,
      }, {
        aad: `mfa:${row.user_id}:totp`,
        resolveKey: version => source.resolveKey(version),
      });
      const encrypted = encryptWith(target, plaintext, `mfa:${row.user_id}:totp`);
      await client.query(`UPDATE mfa_factors
        SET secret_ciphertext=$2,secret_nonce=$3,secret_key_version=$4
        WHERE id=$1`, [row.id, encrypted.ciphertext, encrypted.nonce, target.activeKeyVersion]);
    }

    await client.query('COMMIT');
    return Object.freeze({
      fromVersions: source.availableVersions,
      activeKeyVersion: target.activeKeyVersion,
      providerRows: providers.length,
      providerSecrets,
      mfaRows: mfa.length,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { rotateStoredControlPlaneSecrets };
