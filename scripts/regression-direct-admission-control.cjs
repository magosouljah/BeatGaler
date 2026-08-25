'use strict';

const assert = require('assert');
const { installDirectTransportAdmission } = require('../cloud-server/direct-transport-admission.js');

function makeFakeDirect(botCount = 3) {
  const bots = Array.from({ length: botCount }, (_, i) => ({
    id: `Bot${i + 1}`,
    active_vaults: 0,
    quarantined: false,
    rotation_pending: false,
  }));
  const sessions = new Map();
  let seq = 0;

  return {
    bots,
    async startSession(args) {
      const eligible = bots.filter(bot => !bot.quarantined && !bot.rotation_pending);
      const min = Math.min(...eligible.map(bot => bot.active_vaults));
      const bot = eligible.find(item => item.active_vaults === min);
      bot.active_vaults += 1;
      const session_id = `fake-${++seq}`;
      sessions.set(session_id, bot.id);
      await new Promise(resolve => setTimeout(resolve, 2));
      return { ok: true, session_id, bot_id: bot.id, installation_id: args.installationId };
    },
    async stopSession({ sessionId }) {
      const botId = sessions.get(sessionId);
      if (!botId) return { ok: true, released: false };
      sessions.delete(sessionId);
      const bot = bots.find(item => item.id === botId);
      bot.active_vaults -= 1;
      return { ok: true, released: true };
    },
    poolStatus() {
      return { configured: true, bots: bots.map(bot => ({ ...bot })) };
    },
  };
}

async function expectReject(promise, code) {
  try {
    await promise;
    assert.fail(`Expected ${code}`);
  } catch (error) {
    assert.equal(error.code, code);
  }
}

(async () => {
  const direct = makeFakeDirect(3);
  installDirectTransportAdmission(direct, {
    maxVaultsPerBot: 4,
    waitlistMax: 2,
    waitTimeoutMs: 500,
    pumpIntervalMs: 10,
  });

  // 3 bots x 4 vaults = 12 active vaults maximum.
  const sessions = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    direct.startSession({ installationId: `install-${i}`, chatId: `vault-${i}` })
  ));
  assert.deepEqual(direct.bots.map(bot => bot.active_vaults), [4, 4, 4]);
  assert(direct.bots.every(bot => bot.active_vaults <= 4));

  const statusAtCapacity = direct.poolStatus();
  assert.equal(statusAtCapacity.admission.total_capacity, 12);
  assert.equal(statusAtCapacity.admission.available_slots, 0);
  assert.equal(statusAtCapacity.admission.free_bots, 0);
  assert.equal(statusAtCapacity.admission.shared_bots, 3);
  assert.equal(statusAtCapacity.admission.shared_leases, 9);
  assert.equal(statusAtCapacity.admission.max_vaults_per_bot, 4);

  // 13th waits instead of creating a fifth vault on any bot.
  let thirteenthSettled = false;
  const thirteenth = direct.startSession({ installationId: 'install-13', chatId: 'vault-13' })
    .then(value => { thirteenthSettled = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(thirteenthSettled, false);
  assert.equal(direct.poolStatus().admission.waitlist_depth, 1);
  assert.deepEqual(direct.bots.map(bot => bot.active_vaults), [4, 4, 4]);

  // Releasing one slot drains the waitlist and never exceeds 4.
  await direct.stopSession({ sessionId: sessions[0].session_id });
  const admitted13 = await thirteenth;
  assert(admitted13.session_id);
  assert(direct.bots.every(bot => bot.active_vaults <= 4));
  assert.deepEqual(direct.bots.map(bot => bot.active_vaults), [4, 4, 4]);

  // Bounded waitlist: two may wait, the third is rejected immediately.
  const q1 = direct.startSession({ installationId: 'q1', chatId: 'q1' });
  const q2 = direct.startSession({ installationId: 'q2', chatId: 'q2' });
  await expectReject(direct.startSession({ installationId: 'q3', chatId: 'q3' }), 'POOL_WAITLIST_FULL');
  assert.equal(direct.poolStatus().admission.waitlist_depth, 2);

  await direct.stopSession({ sessionId: sessions[1].session_id });
  await direct.stopSession({ sessionId: sessions[2].session_id });
  await Promise.all([q1, q2]);
  assert(direct.bots.every(bot => bot.active_vaults <= 4));

  // Timeout is finite and explicit.
  const timeoutDirect = makeFakeDirect(1);
  installDirectTransportAdmission(timeoutDirect, {
    maxVaultsPerBot: 4,
    waitlistMax: 1,
    waitTimeoutMs: 100,
    pumpIntervalMs: 10,
  });
  await Promise.all(Array.from({ length: 4 }, (_, i) =>
    timeoutDirect.startSession({ installationId: `t-${i}`, chatId: `t-${i}` })
  ));
  await expectReject(
    timeoutDirect.startSession({ installationId: 'timeout', chatId: 'timeout' }),
    'POOL_WAIT_TIMEOUT',
  );

  const finalStatus = direct.poolStatus().admission;
  assert(finalStatus.shared_fallback_assignments_total > 0);
  assert(finalStatus.exclusive_assignments_total > 0);
  assert(finalStatus.waitlist_enqueued_total >= 3);
  assert(finalStatus.waitlist_admitted_total >= 3);
  assert(finalStatus.waitlist_rejected_total >= 1);

  console.log(JSON.stringify({
    max_vaults_per_bot_enforced: true,
    capacity_3_bots: 12,
    fifth_vault_per_bot_blocked: true,
    bounded_waitlist_proven: true,
    waitlist_full_rejection_proven: true,
    waitlist_timeout_proven: true,
    waitlist_recovery_after_release_proven: true,
    observability_fields_proven: true,
    fair_scheduler_replaced: false,
    token_rotation_or_revoke: false,
    real_vaults_used: false,
  }, null, 2));
  console.log('PASS Direct admission control: max 4 vaults/bot + bounded waitlist.');
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
