'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
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
} = require('../auth-helpers');
const { STATE_DIR } = require('../state-dir');

test('normalizeEmail recorta, convierte a minúsculas y usa vacío para valores falsy', () => {
  assert.equal(normalizeEmail(' \tÉL@EXAMPLE.COM\u00a0'), 'él@example.com');
  assert.equal(normalizeEmail(' E\u0301@EXAMPLE.COM '), 'e\u0301@example.com');
  assert.equal(normalizeEmail(' E L@Example.com '), 'e l@example.com');
  assert.equal(normalizeEmail(''), '');
  assert.equal(normalizeEmail(0), '');
  assert.equal(normalizeEmail(null), '');
  assert.equal(normalizeEmail(42), '42');
});

const maxLengthEmail = `${'a'.repeat(250)}@b.c`;

for (const [validate, normalizesFirst] of [
  [validEmailAfterNormalization, true],
  [validEmailAsProvided, false],
]) {
  test(validate.name, () => {
    assert.equal(validate('ÉL@EXAMPLE.COM'), true);
    assert.equal(validate('\tÉL@EXAMPLE.COM\u00a0'), normalizesFirst);
    assert.equal(validate(['A@B.C', 'D']), true);
    assert.equal(validate('a b@c.d'), false);
    assert.equal(validate('a@b'), false);
    assert.equal(validate(''), false);
    assert.equal(validate(undefined), false);
    assert.equal(validate(maxLengthEmail), true);
    assert.equal(validate(`${maxLengthEmail}d`), false);
    assert.equal(validate([`${maxLengthEmail}d`]), !normalizesFirst);
    assert.equal(validate(`${'a'.repeat(249)}İ@b.c`), !normalizesFirst);
  });
}

for (const [parse, acceptsMissingRequest] of [
  [bearerTokenOptionalRequest, true],
  [bearerTokenRequiredRequest, false],
]) {
  test(parse.name, () => {
    for (const [authorization, expected] of [
      ['Bearer token', 'token'],
      ['bEaReR\t  TökEn\u00a0 ', 'TökEn'],
      ['Bearer\u00a0a b', 'a b'],
      [' Bearer token', ''],
      ['Bearertoken', ''],
      ['Bearer', ''],
      ['Bearer  ', ''],
      ['', ''],
      [null, ''],
    ]) {
      assert.equal(parse({ headers: { authorization } }), expected);
    }
    assert.equal(parse({}), '');
    if (acceptsMissingRequest) {
      assert.equal(parse(undefined), '');
      assert.equal(parse(null), '');
    } else {
      assert.throws(() => parse(undefined), TypeError);
      assert.throws(() => parse(null), TypeError);
    }
  });
}

const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const unicodeHash = 'f7a24842833517713fb17bc0ee13c6914086fa39a68768579ad20b911487467f';
const binaryHash = 'ea5dbf9596d187e9500f23e9a680109475341cf4e81f7e043f7d97152c10772f';

for (const hash of [sha256String]) {
  test(hash.name, () => {
    assert.equal(hash(' Éa '), unicodeHash);
    assert.equal(hash(''), emptyHash);
    assert.equal(hash(null), emptyHash);
    assert.equal(hash(false), emptyHash);
    assert.equal(hash(0), emptyHash);
    assert.equal(hash('0'), '5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9');
  });
}

test('sha256Bytes acepta bytes sin coerción y siempre devuelve hex', () => {
  assert.equal(sha256Bytes(' Éa '), unicodeHash);
  assert.equal(sha256Bytes(''), emptyHash);
  assert.equal(sha256Bytes(Buffer.from([0xff, 0x00]), 'base64'), binaryHash);
  assert.throws(() => sha256Bytes(0), { code: 'ERR_INVALID_ARG_TYPE' });
});

test('sha256WithEncoding acepta bytes sin coerción y permite elegir encoding', () => {
  assert.equal(sha256WithEncoding(' Éa '), unicodeHash);
  assert.equal(sha256WithEncoding(''), emptyHash);
  assert.equal(sha256WithEncoding(Buffer.from([0xff, 0x00]), 'base64'), '6l2/lZbRh+lQDyPppoAQlHU0HPToH34EP32XFSwQdy8=');
  assert.throws(() => sha256WithEncoding(0), { code: 'ERR_INVALID_ARG_TYPE' });
});

test('accountsDataPath conserva el nombre y el directorio que eligió el llamador', () => {
  assert.equal(ACCOUNTS_FILE_NAME, 'accounts-data.json');
  assert.equal(accountsDataPath(STATE_DIR), path.join(STATE_DIR, 'accounts-data.json'));
  assert.equal(accountsDataPath(''), 'accounts-data.json');
  assert.equal(accountsDataPath(`test${path.sep}estádo`), `test${path.sep}estádo${path.sep}accounts-data.json`);
});
