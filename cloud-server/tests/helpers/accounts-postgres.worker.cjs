'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const express = require('express');

require('../../master-storage').masterStorageReady = () => false;
require('../../billing-web-runtime').configure = async () => ({ ready: false, failureCode: 'TEST_PROVIDER_DISABLED' });
require('../../account-email-ses').createSesEmailNotifier = () => async message => {
  fs.appendFileSync(path.join(process.env.BEATGALER_STATE_DIR, 'mail.jsonl'), `${JSON.stringify(message)}\n`);
};

const originalRequest = https.request;
https.request = function request(options, ...args) {
  if (options?.hostname !== 'api.telegram.org' || options.method !== 'HEAD') {
    return originalRequest.call(this, options, ...args);
  }
  const probe = new EventEmitter();
  probe.end = () => queueMicrotask(() => probe.emit('error', new Error('Telegram fake offline')));
  return probe;
};

// Conservar la cadena de arranque real, cambiando solo el enlace HTTP.
const originalListen = express.application.listen;
express.application.listen = function listen(_port, _host, callback) {
  const server = originalListen.call(this, 0, '127.0.0.1', callback);
  server.once('listening', () => process.send({ port: server.address().port }));
  return server;
};

require('../../server');
