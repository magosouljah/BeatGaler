'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-direct-no-cap-'));
const poolFile = path.join(tmp, 'transport-bots.json');
const stateFile = path.join(tmp, 'transport-pool-state.json');
const bot = { id: 'Bot01', token: 'fake-token' };

fs.writeFileSync(poolFile, JSON.stringify({ bots: [bot] }));
process.env.TRANSPORT_BOTS_FILE = poolFile;
process.env.TRANSPORT_POOL_STATE = stateFile;
process.env.DIRECT_DIAGNOSTICS_DIR = path.join(tmp, 'diag');
process.env.BEATGALER_DIRECT_TRANSPORT = 'false';
process.env.DIRECT_TOKEN_ROTATION_ENABLED = 'false';

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'telegram') return { TelegramClient: class {}, Api: {} };
  if (request === 'telegram/sessions') return { StringSession: class {} };
  if (request === 'telegram/client/uploads') return { CustomFile: class {} };
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const direct = require('../direct-transport-control.js');
  const { prepareAssignedLease } = require('../direct-persistent-session-runtime');
  const pool = [bot];
  for (let index = 0; index < 5; index += 1) {
    const result = prepareAssignedLease({
      directTransport: direct,
      status: direct.poolStatus(),
      transportBotId: bot.id,
      installationId: `install-${index + 1}`,
      chatId: `vault-${index + 1}`,
    });
    assert.equal(result.lease.bot_id, 'Bot01');
    assert.equal(result.reused, false);
    assert.equal(direct.__test.leasesForBot(direct.__test.stateSnapshot(pool), 'Bot01').length, index + 1);
  }
  const state = direct.__test.stateSnapshot(pool);
  assert.equal(direct.__test.leasesForBot(state, 'Bot01').length, 5);
  console.log('PASS Direct allocator has no artificial four-session ceiling');
} finally {
  Module._load = originalLoad;
  fs.rmSync(tmp, { recursive: true, force: true });
}
