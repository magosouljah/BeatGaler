#!/usr/bin/env node

/**
 * Telegram admin-rights churn probe for BeatGaler Task 5.1.
 *
 * Purpose: measure how quickly one MASTER account can grant/revoke a delicate
 * admin right across one or many transport bots before Telegram returns a
 * FLOOD_WAIT / rate-limit error. This is a lab tool only; it does not touch
 * BeatGaler production flows.
 *
 * Safety rules:
 * - Requires an explicit acknowledgement flag.
 * - Uses only the configured test supergroup and target bot IDs.
 * - Ramps load gradually and stops on the first FLOOD_WAIT/rate-limit signal.
 * - Never retries through a FLOOD_WAIT.
 * - Restores every bot's original admin rights in finally{}.
 * - Keeps can_pin_messages unchanged unless it was already present.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TelegramClient, Api } = require('../cloud-server/node_modules/telegram');
const { StringSession } = require('../cloud-server/node_modules/telegram/sessions');

const ACK = 'I_UNDERSTAND_THIS_IS_A_CONTROLLED_TEST';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function parsePositiveInt(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function parseCsv(name) {
  return required(name).split(',').map((v) => v.trim()).filter(Boolean);
}

function floodWaitSeconds(error) {
  const text = `${error?.errorMessage || ''} ${error?.message || ''}`;
  const match = text.match(/FLOOD_WAIT_?(\d+)?/i) || text.match(/wait of (\d+) seconds/i);
  if (match?.[1]) return Number(match[1]);
  if (/FLOOD_WAIT|FLOOD|Too Many Requests/i.test(text) || Number(error?.code) === 420 || Number(error?.code) === 429) return -1;
  return null;
}

function rightsToPlain(rights) {
  if (!rights) return {};
  return {
    changeInfo: Boolean(rights.changeInfo),
    postMessages: Boolean(rights.postMessages),
    editMessages: Boolean(rights.editMessages),
    deleteMessages: Boolean(rights.deleteMessages),
    banUsers: Boolean(rights.banUsers),
    inviteUsers: Boolean(rights.inviteUsers),
    pinMessages: Boolean(rights.pinMessages),
    addAdmins: Boolean(rights.addAdmins),
    anonymous: Boolean(rights.anonymous),
    manageCall: Boolean(rights.manageCall),
    other: Boolean(rights.other),
    manageTopics: Boolean(rights.manageTopics),
    postStories: Boolean(rights.postStories),
    editStories: Boolean(rights.editStories),
    deleteStories: Boolean(rights.deleteStories),
    manageDirectMessages: Boolean(rights.manageDirectMessages),
    manageRanks: Boolean(rights.manageRanks),
  };
}

function buildRights(base, deleteMessages) {
  return new Api.ChatAdminRights({
    ...base,
    deleteMessages: Boolean(deleteMessages),
    pinMessages: Boolean(base.pinMessages),
  });
}

function peerIdString(entity) {
  const id = entity?.id ?? entity?.userId ?? null;
  return id === null || id === undefined ? null : String(id);
}

async function resolveBotsFromVault(client, channel, botRefs) {
  // A bare numeric Telegram user ID is not enough for MTProto calls: the
  // client also needs the user's access_hash. Fetching participants from the
  // explicitly configured test vault hydrates those entities safely without
  // requiring usernames or extra secrets.
  const participants = await client.getParticipants(channel, { limit: 10000 });
  const byId = new Map();
  for (const participant of participants) {
    const id = peerIdString(participant);
    if (id) byId.set(id, participant);
  }

  const resolved = [];
  const missing = [];
  for (const ref of botRefs) {
    const entity = byId.get(String(ref));
    if (entity) resolved.push({ ref, entity });
    else missing.push(ref);
  }

  if (missing.length) {
    throw new Error(`Could not resolve bot(s) ${missing.join(', ')} from the configured test vault. Confirm each bot is already a member of PERMISSION_CHURN_CHAT.`);
  }
  return resolved;
}

async function readBotRights(client, channel, botEntity) {
  const result = await client.invoke(new Api.channels.GetParticipant({
    channel,
    participant: botEntity,
  }));
  const participant = result?.participant;
  return rightsToPlain(participant?.adminRights);
}

async function setBotRights(client, channel, botEntity, rights) {
  const started = performance.now();
  await client.invoke(new Api.channels.EditAdmin({
    channel,
    userId: botEntity,
    adminRights: rights,
    rank: '',
  }));
  return performance.now() - started;
}

async function main() {
  if (process.env.PERMISSION_CHURN_ACK !== ACK) {
    throw new Error(`Set PERMISSION_CHURN_ACK=${ACK} to run this controlled test.`);
  }

  const apiId = Number(required('TELEGRAM_API_ID'));
  const apiHash = required('TELEGRAM_API_HASH');
  const chatRef = required('PERMISSION_CHURN_CHAT');
  const botRefs = parseCsv('PERMISSION_CHURN_BOTS');
  const cyclesPerStep = parsePositiveInt('PERMISSION_CHURN_CYCLES_PER_STEP', 10);
  const intervals = String(process.env.PERMISSION_CHURN_INTERVALS_MS || '5000,2500,1000,500')
    .split(',').map((v) => Number(v.trim())).filter((v) => Number.isInteger(v) && v >= 250);
  if (!intervals.length) throw new Error('PERMISSION_CHURN_INTERVALS_MS must contain intervals >= 250ms');

  const sessionPath = path.resolve(process.env.PERMISSION_CHURN_SESSION_FILE || 'cloud-server/master-session.txt');
  const session = fs.readFileSync(sessionPath, 'utf8').trim();
  if (!session) throw new Error(`Empty Telegram session: ${sessionPath}`);

  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
  });

  const report = {
    started_at: now(),
    chat: chatRef,
    bot_count: botRefs.length,
    cycles_per_step: cyclesPerStep,
    intervals_ms: intervals,
    events: [],
    result: 'INCOMPLETE',
  };

  const originals = new Map();
  let channel;
  let bots = [];

  try {
    await client.connect();
    if (!(await client.checkAuthorization())) throw new Error('MASTER Telegram session is not authorized');

    channel = await client.getEntity(chatRef);
    bots = await resolveBotsFromVault(client, channel, botRefs);

    for (const bot of bots) {
      const original = await readBotRights(client, channel, bot.entity);
      originals.set(bot.ref, original);
      report.events.push({ at: now(), type: 'baseline', bot: bot.ref, rights: original });
    }

    let operation = 0;
    outer:
    for (const intervalMs of intervals) {
      console.log(`\n=== Step: ${intervalMs} ms between rights changes; ${cyclesPerStep} cycles; ${bots.length} bot(s) ===`);
      const latencies = [];

      for (let cycle = 1; cycle <= cyclesPerStep; cycle += 1) {
        for (const bot of bots) {
          const base = originals.get(bot.ref);

          for (const enabled of [true, false]) {
            operation += 1;
            try {
              const latencyMs = await setBotRights(client, channel, bot.entity, buildRights(base, enabled));
              latencies.push(latencyMs);
              const event = { at: now(), type: 'change', operation, interval_ms: intervalMs, cycle, bot: bot.ref, delete_messages: enabled, latency_ms: Math.round(latencyMs) };
              report.events.push(event);
              console.log(`#${operation} ${bot.ref} delete=${enabled} ${Math.round(latencyMs)}ms`);
            } catch (error) {
              const wait = floodWaitSeconds(error);
              report.events.push({ at: now(), type: 'error', operation, interval_ms: intervalMs, cycle, bot: bot.ref, delete_messages: enabled, flood_wait_seconds: wait, code: error?.code ?? null, message: String(error?.errorMessage || error?.message || error) });
              if (wait !== null) {
                report.result = 'FLOOD_WAIT_REACHED';
                console.error(`Telegram rate limit reached${wait >= 0 ? `: ${wait}s` : ''}. Stopping immediately; no automatic retry.`);
                break outer;
              }
              throw error;
            }

            await sleep(intervalMs);
          }
        }
      }

      if (latencies.length) {
        const sorted = [...latencies].sort((a, b) => a - b);
        const p50 = sorted[Math.floor(sorted.length * 0.50)];
        const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
        report.events.push({ at: now(), type: 'step_summary', interval_ms: intervalMs, operations: latencies.length, p50_ms: Math.round(p50), p95_ms: Math.round(p95), max_ms: Math.round(sorted.at(-1)) });
      }
    }

    if (report.result === 'INCOMPLETE') report.result = 'NO_FLOOD_WAIT_WITHIN_TEST_ENVELOPE';
  } finally {
    if (channel && bots.length) {
      console.log('\nRestoring original rights...');
      for (const bot of bots) {
        const original = originals.get(bot.ref);
        if (!original) continue;
        try {
          await setBotRights(client, channel, bot.entity, new Api.ChatAdminRights(original));
          report.events.push({ at: now(), type: 'restore_ok', bot: bot.ref });
        } catch (error) {
          report.events.push({ at: now(), type: 'restore_failed', bot: bot.ref, message: String(error?.errorMessage || error?.message || error) });
          console.error(`RESTORE FAILED for ${bot.ref}:`, error?.errorMessage || error?.message || error);
        }
      }
    }

    report.finished_at = now();
    const outDir = path.resolve(process.env.PERMISSION_CHURN_REPORT_DIR || 'artifacts/security-probes');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `telegram-admin-rights-churn-${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(`\nReport: ${outPath}`);
    await client.disconnect();
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
