'use strict';

// Opt-in live diagnostics: metadata only, no bodies, cookies or credentials.
const fs = require('node:fs');
const http = require('node:http');
const { AsyncLocalStorage } = require('node:async_hooks');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');

const context = new AsyncLocalStorage();

module.exports = function install({ express, Runtime, file }) {
  const stream = fs.createWriteStream(file, { flags: 'a' });
  stream.on('error', () => {});

  const stamp = () => ({
    at_ms: Date.now(),
    mono_ms: performance.now(),
  });

  const logAt = (id, event, when = stamp(), extra = {}) => {
    stream.write(JSON.stringify({
      id,
      event,
      at_ms: when.at_ms,
      mono_ms: when.mono_ms,
      ...extra,
    }) + '\n');
  };

  const log = (id, event, extra = {}) => {
    logAt(id, event, stamp(), extra);
  };

  const originalEmit = http.Server.prototype.emit;
  const restoreHandlers = [];
  const targetServers = new Set();
  const trackedSockets = new Map();

  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();

  // Locate only the already-live HTTP server that owns /auth/health and patch
  // the route handler so handler_start remains distinct from HTTP dispatch.
  for (const server of process._getActiveHandles()) {
    if (!(server instanceof http.Server)) continue;

    let ownsHealthRoute = false;

    for (const app of server.listeners('request')) {
      for (const layer of app.router?.stack || []) {
        if (layer.route?.path !== '/auth/health') continue;

        ownsHealthRoute = true;

        for (const handler of layer.route.stack) {
          const original = handler.handle;

          handler.handle = function (...args) {
            const id = context.getStore();
            if (id) log(id, 'handler_start');
            return original.apply(this, args);
          };

          restoreHandlers.push(() => {
            handler.handle = original;
          });
        }
      }
    }

    if (ownsHealthRoute) targetServers.add(server);
  }

  http.Server.prototype.emit = function (event, ...args) {
    if (event === 'connection' && targetServers.has(this)) {
      const [socket] = args;
      const accepted = stamp();

      // Let Node install its normal HTTP connection/parser listeners first.
      // Attaching our data listener before this call could change stream
      // semantics, which would invalidate the diagnostic experiment.
      const result = originalEmit.call(this, event, ...args);

      if (!socket || typeof socket.prependListener !== 'function') {
        return result;
      }

      const state = {
        accepted,
        firstData: null,
        latestData: null,
        dataCount: 0,
        requestIndex: 0,
        onData: null,
        onClose: null,
      };

      // Metadata only. Deliberately ignore the data argument: do not inspect,
      // stringify, copy or retain request bytes.
      state.onData = () => {
        const when = stamp();
        state.dataCount += 1;
        if (!state.firstData) state.firstData = when;
        state.latestData = when;
      };

      state.onClose = () => {
        trackedSockets.delete(socket);
      };

      trackedSockets.set(socket, state);

      // Node's HTTP parser is already installed because originalEmit returned.
      // prependListener now timestamps a data event immediately before the
      // existing parser processes that same event.
      socket.prependListener('data', state.onData);
      socket.once('close', state.onClose);

      return result;
    }

    const [req, res] = args;
    const id = req?.headers?.['x-stage1-trace'];

    if (
      event !== 'request' ||
      !targetServers.has(this) ||
      req.url?.split('?')[0] !== '/auth/health' ||
      !/^[a-zA-Z0-9:-]{1,100}$/.test(id || '')
    ) {
      return originalEmit.call(this, event, ...args);
    }

    const socketState = trackedSockets.get(req.socket);
    let requestIndex = null;

    if (socketState) {
      socketState.requestIndex += 1;
      requestIndex = socketState.requestIndex;

      logAt(
        id,
        'cloud_socket_accept',
        socketState.accepted,
        {
          request_index: requestIndex,
          socket_reused: requestIndex > 1,
        },
      );

      if (socketState.latestData) {
        logAt(
          id,
          requestIndex === 1
            ? 'cloud_socket_first_data'
            : 'cloud_socket_data_before_request',
          socketState.latestData,
          {
            request_index: requestIndex,
            socket_reused: requestIndex > 1,
            data_count: socketState.dataCount,
          },
        );
      }
    }

    const loopMaxMs = loopDelay.max / 1e6;
    const loopP99Ms = loopDelay.percentile(99) / 1e6;
    loopDelay.reset();

    log(id, 'cloud_arrival', {
      request_index: requestIndex,
      socket_tracking: socketState ? 'tracked' : 'missing',
      loop_max_ms: loopMaxMs,
      loop_p99_ms: loopP99Ms,
    });

    res.once('finish', () => log(id, 'cloud_finish'));
    res.once('close', () => log(id, 'cloud_close'));

    return context.run(id, () => originalEmit.call(this, event, ...args));
  };

  const json = express.response.json;

  express.response.json = function (...args) {
    const id = context.getStore();
    if (id) log(id, 'handler_response');
    return json.apply(this, args);
  };

  const flush = Runtime.prototype.flush;

  Runtime.prototype.flush = async function (...args) {
    const id = context.getStore();

    if (id) log(id, 'flush_start');

    try {
      return await flush.apply(this, args);
    } finally {
      if (id) log(id, 'flush_end');
    }
  };

  return () => {
    http.Server.prototype.emit = originalEmit;
    express.response.json = json;
    Runtime.prototype.flush = flush;

    for (const restore of restoreHandlers) restore();

    for (const [socket, state] of trackedSockets) {
      socket.removeListener('data', state.onData);
      socket.removeListener('close', state.onClose);
    }

    trackedSockets.clear();

    loopDelay.disable();
    stream.end();
  };
};
