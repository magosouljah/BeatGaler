'use strict';

const assert = require('node:assert/strict');

process.env.BEATGALER_DIRECT_TRANSPORT = 'false';

const direct = require('../direct-transport-control.js');

async function main() {
  const inviteAndPromote = direct?.__test?.inviteAndPromote;
  assert.equal(typeof inviteAndPromote, 'function', 'real Direct provisioning primitive must be testable');

  // Telegram can report USER_ALREADY_PARTICIPANT when repair races propagation
  // or when only admin rights were lost. That is success for the invite step:
  // the same bot must continue into EditAdmin instead of failing/reassigning.
  const calls = [];
  const master = {
    async invoke(request) {
      calls.push(request);
      if (calls.length === 1) {
        const error = new Error('USER_ALREADY_PARTICIPANT');
        error.errorMessage = 'USER_ALREADY_PARTICIPANT';
        throw error;
      }
      return { ok: true };
    },
  };
  await inviteAndPromote(master, { id: 7001 }, { id: 8001 });
  assert.equal(calls.length, 2, 'already-participant invite must continue into admin-right repair');

  const firstName = String(calls[0]?.className || calls[0]?.constructor?.name || '');
  const secondName = String(calls[1]?.className || calls[1]?.constructor?.name || '');
  assert.match(firstName, /InviteToChannel/i);
  assert.match(secondName, /EditAdmin/i);

  // Other Telegram failures are not swallowed. Repair stops after one attempt,
  // letting the persistent membership state remain REPAIR for an explicit retry.
  let failureCalls = 0;
  const deniedMaster = {
    async invoke() {
      failureCalls += 1;
      const error = new Error('CHAT_ADMIN_REQUIRED');
      error.errorMessage = 'CHAT_ADMIN_REQUIRED';
      throw error;
    },
  };
  await assert.rejects(
    () => inviteAndPromote(deniedMaster, { id: 7002 }, { id: 8002 }),
    /CHAT_ADMIN_REQUIRED/,
  );
  assert.equal(failureCalls, 1);

  console.log('PASS Direct provisioning primitive: USER_ALREADY_PARTICIPANT continues to EditAdmin; other errors fail once');
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
