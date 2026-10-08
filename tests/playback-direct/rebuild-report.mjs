import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { summarizeRun, csv, markdown } from './report.mjs';

for (const directory of process.argv.slice(2)) {
  const filename = path.join(directory, 'summary.json');
  const summary = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const events = fs.readFileSync(path.join(directory, 'trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  summary.route ||= 'prefetch';
  summary.rows = summary.rows.map((row, i) => {
    const start = events.find(e => e.run_id === `setup-${i + 1}` && e.stage === 'SESSION_SETUP_BEGIN');
    const end = events.find(e => e.run_id === `setup-${i + 1}` && e.stage === 'SESSION_SETUP_DONE');
    return summarizeRun(events, { run_id: row.run_id, intent_id: row.intent_id, route: row.route || summary.route,
      session_setup_ms: start && end ? Math.round((end.ts_ms - start.ts_ms) * 10) / 10 : null,
      status: row.status, ...(row.error_name ? { error_name: row.error_name } : {}) });
  });
  summary.report_rebuilt_at = new Date().toISOString();
  summary.report_rebuilt_with_sha256 = createHash('sha256').update(fs.readFileSync(new URL('./report.mjs', import.meta.url))).digest('hex');
  fs.writeFileSync(filename, JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(directory, 'runs.csv'), csv(summary.rows));
  fs.writeFileSync(path.join(directory, 'report.md'), markdown(summary));
  console.log(`${directory}: ${summary.rows.length} rows, raw trace unchanged`);
}
