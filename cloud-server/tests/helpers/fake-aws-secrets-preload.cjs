'use strict';
// Precarga SOLO para pruebas de arranque en producción simulada: sustituye `@aws-sdk/client-secrets-manager` por un doble
// local que devuelve un llavero de sobres fijo (nunca contacta AWS; la red ya la bloquea catalog-net-guard).
const Module = require('node:module');
const { AWS_SECRET_SCHEMA } = require('../../secret-envelope-provider');

const SECRET = JSON.stringify({ schema: AWS_SECRET_SCHEMA, activeKeyVersion: 1, keys: { 1: Buffer.alloc(32, 7).toString('base64') } });
class SecretsManagerClient { async send() { return { SecretString: SECRET }; } }
class GetSecretValueCommand { constructor(input) { this.input = input; } }
const fake = { SecretsManagerClient, GetSecretValueCommand };

const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === '@aws-sdk/client-secrets-manager') return fake;
  return originalLoad.call(this, request, ...rest);
};
