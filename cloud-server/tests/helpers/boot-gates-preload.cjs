'use strict';
// Precarga SOLO para pruebas de arranque (catalog-boot-gates*): arranca el server.js real en un proceso hijo, pero
// el bind va a 127.0.0.1:0 y el hijo avisa con una línea cuando llega a listen. No altera ninguna compuerta.
const express = require('express');

require('../../master-storage').masterStorageReady = () => false;
const originalListen = express.application.listen;
express.application.listen = function listen(_port, _host, callback) {
  const server = originalListen.call(this, 0, '127.0.0.1', callback);
  server.once('listening', () => console.log('BOOT_GATES_LISTENING'));
  return server;
};
