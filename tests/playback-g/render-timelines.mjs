import fs from 'node:fs';

const source = process.argv[2] || 'tests/playback-g/timelines.json';
const { rows } = JSON.parse(fs.readFileSync(source, 'utf8'));
const lines = [
  '# Test G — timelines de cada Play ≥3 s',
  '',
  'Milisegundos relativos a la marca previa a `artwork.click()`. `WD` termina en `CARD_PLAY_CLICK`; `Ctrl` termina en `APP_HANDLE_PLAY_ENTER`; `Pref` termina en `PLAY_PREFIX_READY`; `MSE` termina en `SOURCE_FIRST_PLAYABLE_RANGE`; `Playing` termina en `AUDIO_EVENT_PLAYING`; `Prog` termina en `AUDIO_FIRST_PROGRESS`; `0,5` termina en el primer evento con `currentTime ≥0.5`. El JSON adjunto conserva las marcas de WARM, worker, RPC, MSE y audio por caso. `ND` indica marca ausente.',
  '',
  '| Serie | Run | Cuenta | Ronda | Total | WD→click | click→Ctrl | Ctrl→Pref | Pref→MSE | MSE→Playing | Playing→Prog | Prog→0,5 | Gap | getMessages | getFile send→result |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
];
const value = n => n == null ? 'ND' : String(n);
for (const row of rows) {
  const s = row.segments;
  const first = row.events.AUDIO_FIRST_PROGRESS;
  const play = row.events.AUDIO_EVENT_PLAYING;
  const firstFile = row.getFile[0]?.send_to_result_ms;
  lines.push(`| ${row.experiment} | ${row.run} | ${row.account} | ${row.round} | ${row.total_ms} | ${value(s.webdriver_to_dom_click)} | ${value(s.dom_click_to_controller)} | ${value(s.controller_to_prefix)} | ${value(s.prefix_to_mse_range)} | ${value(s.mse_range_to_playing)} | ${value(first != null && play != null ? first - play : null)} | ${value(first != null ? row.total_ms - first : null)} | ${value(row.gap_ms)} | ${value(row.getMessages?.total_ms)} | ${value(firstFile)} |`);
}
lines.push('', 'Los subintervalos se redondean individualmente; por eso el gap puede ser ±2 ms. Una llamada `getMessages` o `getFile` puede empezar durante WARM antes del click DOM: sus duraciones están **dentro** de las seis etapas, y no se suman otra vez al total.', '');
process.stdout.write(lines.join('\n'));
