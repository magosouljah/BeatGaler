'use strict';
// Precarga SOLO para pruebas de arranque: al llegar a listen imprime la firma de la pila Express (capas, rutas, métodos y
// nombres de handlers) en una línea `BOOT_STACK <json>`, antes del aviso de boot-gates-preload (debe cargarse antes que él).
const express = require('express');

const originalListen = express.application.listen;
express.application.listen = function listen(...args) {
  const app = this;
  const server = originalListen.apply(this, args);
  server.once('listening', () => {
    const stack = app.router?.stack || app._router?.stack || [];
    const signature = stack.map(layer => layer.route
      ? `${[].concat(layer.route.path).join('|')}:${Object.keys(layer.route.methods).join(',')}:${layer.route.stack.map(s => s.name).join('>')}`
      : `${layer.name}:${layer.path ?? ''}`);
    console.log(`BOOT_STACK ${JSON.stringify(signature)}`);
  });
  return server;
};
