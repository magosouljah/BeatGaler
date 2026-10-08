import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'tmp/playback-e');
fs.mkdirSync(out, { recursive: true });
const selected = process.argv.includes('--phase') ? process.argv[process.argv.indexOf('--phase') + 1] : 'all';
const cases = [
  { name: 'e1-baseline', phase: 'main', batches: 5, runs: 50, writer: 'shared', ids: '96,101' },
  { name: 'e2-e10-fresh', phase: 'main', batches: 10, runs: 50, writer: 'fresh', ids: '96,101' },
  { name: 'e3-microtask', phase: 'controls', runs: 25, writer: 'fresh', ids: '96,101', timing: 'microtask' },
  { name: 'e3-immediate', phase: 'controls', runs: 25, writer: 'fresh', ids: '96,101', timing: 'immediate' },
  { name: 'e3-delay1', phase: 'controls', runs: 25, writer: 'fresh', ids: '96,101', timing: 'delay', offset: 1 },
  { name: 'e2-cross-over', phase: 'controls', runs: 80, writer: 'shared', ids: '96,101', alternate: true },
  { name: 'e2-cross-over-b', phase: 'controls', runs: 20, writer: 'shared', ids: '96,101', alternate: true },
  { name: 'e8-inverse-shared', phase: 'controls', runs: 25, writer: 'shared', ids: '101,96' },
  { name: 'e8-inverse-fresh', phase: 'controls', runs: 25, writer: 'fresh', ids: '101,96' },
  { name: 'e6-one-shared', phase: 'controls', runs: 25, writer: 'shared', ids: '96' },
  { name: 'e6-one-fresh', phase: 'controls', runs: 25, writer: 'fresh', ids: '96' },
  { name: 'e6-three-shared', phase: 'controls', runs: 20, writer: 'shared', ids: '96,101,101' },
  { name: 'e6-three-fresh', phase: 'controls', runs: 20, writer: 'fresh', ids: '96,101,101' },
  { name: 'e6-four-shared', phase: 'controls', runs: 20, writer: 'shared', ids: '96,101,101,101' },
  { name: 'e6-four-fresh', phase: 'controls', runs: 20, writer: 'fresh', ids: '96,101,101,101' },
  { name: 'e7-small-small-shared', phase: 'controls', runs: 25, writer: 'shared', ids: '96,96' },
  { name: 'e7-small-small-fresh', phase: 'controls', runs: 25, writer: 'fresh', ids: '96,96' },
  { name: 'e11-stress-shared', phase: 'controls', batches: 2, runs: 10, writer: 'shared', ids: '96,101,101,101,101,101,101' },
  { name: 'e11-stress-fresh', phase: 'controls', batches: 2, runs: 10, writer: 'fresh', ids: '96,101,101,101,101,101,101' },
  { name: 'e2-switch', phase: 'supplement', runs: 45, writer: 'fresh', ids: '96,101',
    schedule: 'fresh:15,shared:15,fresh:15' },
  { name: 'e2-reset', phase: 'supplement', runs: 30, writer: 'fresh', ids: '96,101',
    schedule: 'fresh:10,shared:5,fresh:15', reconnectBefore: 21 },
  { name: 'e2-reset-immediate', phase: 'supplement', runs: 24, writer: 'fresh', ids: '96,101',
    schedule: 'fresh:10,shared:3,fresh:11', reconnectBefore: 15 },
];
for (const item of cases) {
  if (selected !== 'all' && selected !== item.phase) continue;
  for (let batch = 1; batch <= (item.batches || 1); batch++) {
    const name = item.batches ? `${item.name}-${String(batch).padStart(2, '0')}` : item.name;
    const dir = path.join(out, name);
    const summary = path.join(dir, 'summary.json');
    if (fs.existsSync(summary) && JSON.parse(fs.readFileSync(summary)).status === 'COMPLETE') {
      console.log(`${name}: complete, reusing`); continue;
    }
    if (name === 'e2-cross-over' && fs.existsSync(summary)) {
      const previous = JSON.parse(fs.readFileSync(summary));
      if (previous.rows.filter(row => row.status === 'OK').length >= 60
          && previous.rows.some(row => row.status !== 'OK')
          && fs.readFileSync(path.join(dir,'trace.jsonl'),'utf8').includes('AUTH_KEY_UNREGISTERED')) {
        console.log(`${name}: retaining ${previous.rows.filter(row=>row.status==='OK').length} valid runs before temporary auth expired`);
        continue;
      }
    }
    if (fs.existsSync(path.join(dir, 'trace.jsonl'))) throw new Error(`${name}: incomplete existing trace; inspect manually`);
    const args = ['scripts/run-playback-direct.mjs', '--runs', String(item.runs),
      '--mode', 'test-d-raw', '--test-d-mode', 'observe', '--test-e-writer', item.writer,
      '--test-e-message-ids', item.ids, '--test-e-timing', item.timing || 'same',
      '--test-d-offset-ms', String(item.offset || 0), '--test-e-capture',
      batch === 1 && ['e1-baseline', 'e2-e10-fresh'].includes(item.name) ? 'true' : 'false',
      '--test-e-alternate', item.alternate ? 'true' : 'false',
      '--test-e-schedule', item.schedule || '',
      '--test-e-reconnect-before', String(item.reconnectBefore || 0),
      '--out', dir];
    console.log(`${new Date().toISOString()} ${name} starting`);
    fs.mkdirSync(dir, { recursive: true });
    const log = fs.openSync(path.join(dir, 'console.txt'), 'w');
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    const status = fs.existsSync(summary) ? JSON.parse(fs.readFileSync(summary)).status : 'MISSING';
    console.log(`${new Date().toISOString()} ${name} exit=${result.status} status=${status}`);
    if (result.status !== 0 || status !== 'COMPLETE') throw new Error(`${name} failed; inspect ${dir}`);
  }
}
