const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('../../cloud-server/node_modules/express');
const install = require('../../scripts/stage1-cloud-timing.cjs');

test('Cloud trace separates socket arrival, HTTP dispatch, handler, durability and finish without exposing payloads', async () => {
  let release;
  let entered;

  const blocked = new Promise(resolve => {
    release = resolve;
  });

  const waiting = new Promise(resolve => {
    entered = resolve;
  });

  class Runtime {
    async flush() {
      entered();
      await blocked;
    }
  }

  const runtime = new Runtime();
  const app = express();

  app.get('/auth/health', async (_req, res) => {
    await runtime.flush();
    res.json({
      account_auth: true,
      private: 'SECRET',
    });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage1-timing-'));
  const file = path.join(dir, 'timing.jsonl');

  const originalEmit = http.Server.prototype.emit;
  const originalFlush = Runtime.prototype.flush;

  const uninstall = install({
    express,
    Runtime,
    file,
  });

  try {
    const responsePromise = fetch(
      `http://127.0.0.1:${server.address().port}/auth/health?secret=SECRET`,
      {
        headers: {
          'x-stage1-trace': 'test-1',
          authorization: 'SECRET',
        },
      },
    );

    await waiting;
    release();

    const response = await responsePromise;
    const body = await response.json();

    assert.equal(body.account_auth, true);
  } finally {
    uninstall();
    await new Promise(resolve => server.close(resolve));
  }

  assert.equal(http.Server.prototype.emit, originalEmit);
  assert.equal(Runtime.prototype.flush, originalFlush);

  // stream.end() completes asynchronously.
  let raw = '';

  for (let i = 0; i < 100; i += 1) {
    raw = fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8')
      : '';

    if (raw.includes('cloud_close')) break;
    await new Promise(setImmediate);
  }

  assert.equal(raw.includes('SECRET'), false);
  assert.equal(raw.includes('authorization'), false);

  const events = raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);

  assert.deepEqual(
    events.map(event => event.event),
    [
      'cloud_socket_accept',
      'cloud_socket_first_data',
      'cloud_arrival',
      'handler_start',
      'flush_start',
      'flush_end',
      'handler_response',
      'cloud_finish',
      'cloud_close',
    ],
  );

  assert.ok(
    events.every(
      event =>
        event.id === 'test-1' &&
        Number.isFinite(event.mono_ms) &&
        Number.isFinite(event.at_ms),
    ),
  );

  const accept = events.find(event => event.event === 'cloud_socket_accept');
  const firstData = events.find(event => event.event === 'cloud_socket_first_data');
  const arrival = events.find(event => event.event === 'cloud_arrival');

  assert.equal(accept.request_index, 1);
  assert.equal(accept.socket_reused, false);

  assert.equal(firstData.request_index, 1);
  assert.equal(firstData.socket_reused, false);
  assert.ok(firstData.data_count >= 1);

  assert.equal(arrival.request_index, 1);
  assert.equal(arrival.socket_tracking, 'tracked');
  assert.ok(Number.isFinite(arrival.loop_max_ms));
  assert.ok(Number.isFinite(arrival.loop_p99_ms));

  assert.ok(accept.mono_ms <= firstData.mono_ms);
  assert.ok(firstData.mono_ms <= arrival.mono_ms);
});
