import fs from 'node:fs';
import path from 'node:path';
import { summarize, metrics, csv, markdown } from './report.mjs';

const directory = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(directory, 'trace.jsonl'))) throw new Error('Usage: node tests/playback-b/rebuild-report.mjs <result-directory>');
const summaryFile = path.join(directory, 'summary.json');
const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
const events = fs.readFileSync(path.join(directory, 'trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
summary.rows = summary.rows.map(previous => summarize(events.filter(event => event.run_id === previous.run_id), {
  run_id: previous.run_id, intent_id: previous.intent_id, mode: previous.mode,
}));
summary.metrics = metrics(summary.rows);
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(directory, 'runs.csv'), csv(summary.rows));
fs.writeFileSync(path.join(directory, 'report.md'), markdown(summary, events));
console.log(JSON.stringify(summary.metrics));
