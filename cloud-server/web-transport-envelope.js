\'use strict\';

const crypto = require(\'crypto\');

const ENVELOPE_FORMAT = \'beatgaler-web-transport-v1\';

function importBrowserPublicKey(publicJwk) {
  if (!publicJwk || typeof publicJwk !== \'object\' || Array.isArray(publicJwk)) {
    throw new Error(\'Web transport public key is required.\');
  }
  if (publicJwk.kty !== \'RSA\' || publicJwk.alg !== \'RSA-OAEP-256\' || publicJwk.key_ops?.includes(\'encrypt\') === false) {
    throw new Error(\'Web transport public key is invalid.\');
  }
  const key = crypto.createPublicKey({ key: publicJwk, format: \'jwk\' });
  const bits = Number(key.asymmetricKeyDetails?.modulusLength || 0);
  if (key.asymmetricKeyType !== \'rsa\' || bits < 2048) {
    throw new Error(\'Web transport public key must use RSA-2048 or stronger.\');
  }
  return key;
}

function wrapWebTransportSession(session, publicJwk) {
  if (!publicJwk) return session;
  const key = importBrowserPublicKey(publicJwk);
  const compactCredentials = {
    t: String(session?.bot_token || \'\'),
    i: Number(session?.telegram_api_id || 0),
    h: String(session?.telegram_api_hash || \'\'),
  };
  if (!compactCredentials.t || !compactCredentials.i || !compactCredentials.h) {
    throw new Error(\'Web transport credentials are incomplete.\');
  }

  const plaintext = Buffer.from(JSON.stringify(compactCredentials), \'utf8\');
  const ciphertext = crypto.publicEncrypt({
    key,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: \'sha256\',
  }, plaintext);

  const wrapped = { ...session };
  delete wrapped.bot_token;
  delete wrapped.telegram_api_id;
  delete wrapped.telegram_api_hash;
  wrapped.mode = \'galer-direct-web-mtproto\';
  wrapped.credential_envelope = {
    version: 1,
    format: ENVELOPE_FORMAT,
    algorithm: \'RSA-OAEP-256\',
    ciphertext: ciphertext.toString(\'base64url\'),
  };
  return wrapped;
}

module.exports = { ENVELOPE_FORMAT, importBrowserPublicKey, wrapWebTransportSession };
