// Run with: node tests/web-wav-master.browser.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { remote } from "webdriverio";

const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--mode", "web", "--host", "127.0.0.1", "--port", "4187", "--strictPort"], { stdio: "pipe", windowsHide: true });
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch("http://127.0.0.1:4187", { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready) break;
    if (server.exitCode !== null) throw new Error("Vite exited before the browser test.");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, "Vite must start");
  browser = await remote({ logLevel: "error", capabilities: {
    browserName: "chrome", "goog:chromeOptions": { args: ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage"] },
  } });
  // Same origin for module imports, without booting the app's account/network startup.
  await browser.url("http://127.0.0.1:4187/package.json");
  await browser.setTimeout({ script: 60000 });
  const result = await browser.executeAsync(async done => {
    try {
      const { createWebImportCandidate, webImportPort } = await import("/src/platform/webImport.ts");
      window.jsmediatags = { read(_file, callbacks) { callbacks.onSuccess({ tags: {} }); } };
      const results = [];
      for (const [channels, bits, sampleRate] of [[1, 16, 44100], [2, 24, 48000], [2, 32, 96000]]) {
        const frames = sampleRate / 4;
        const bytesPerSample = bits / 8;
        const wav = new ArrayBuffer(44 + frames * channels * bytesPerSample);
        const view = new DataView(wav);
        const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
        text(0, "RIFF"); view.setUint32(4, wav.byteLength - 8, true); text(8, "WAVE"); text(12, "fmt ");
        view.setUint32(16, 16, true); view.setUint16(20, bits === 32 ? 3 : 1, true);
        view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * channels * bytesPerSample, true);
        view.setUint16(32, channels * bytesPerSample, true); view.setUint16(34, bits, true);
        text(36, "data"); view.setUint32(40, wav.byteLength - 44, true);
        for (let frame = 0; frame < frames; frame++) {
          for (let channel = 0; channel < channels; channel++) {
            const sample = 0.5 * Math.sin(frame * 2 * Math.PI * (channel ? 880 : 440) / sampleRate);
            const offset = 44 + (frame * channels + channel) * bytesPerSample;
            if (bits === 32) view.setFloat32(offset, sample, true);
            else if (bits === 16) view.setInt16(offset, Math.round(sample * 32767), true);
            else {
              const value = Math.round(sample * 8388607);
              view.setUint8(offset, value & 255); view.setUint8(offset + 1, (value >> 8) & 255); view.setUint8(offset + 2, (value >> 16) & 255);
            }
          }
        }
        const source = new File([wav], "Browser.wav", { type: "audio/wav" });
        const candidate = createWebImportCandidate(source);
        const beat = await candidate.hydrated;
        const slots = webImportPort.slotFilesForBeat(beat.id);
        const bytes = new Uint8Array(await slots.MASTER.arrayBuffer());
        const context = new OfflineAudioContext(2, 1, 44100);
        const decoded = await context.decodeAudioData(await (await fetch(beat.playback_path)).arrayBuffer());
        results.push({ channels, bits, sampleRate, originalPreserved: slots.WAV === source,
          master: slots.MASTER.name, mime: slots.MASTER.type, bitrateIndex: bytes[2] >> 4,
          decodedChannels: decoded.numberOfChannels, duration: decoded.duration,
          audible: decoded.getChannelData(0).some(sample => Math.abs(sample) > 0.1) });
        webImportPort.releaseBeat(beat.id);
      }
      let failure;
      try { await createWebImportCandidate(new File(["broken"], "Broken.wav")).hydrated; }
      catch (error) { failure = error.message; }
      done({ results, failure });
    } catch (error) { done({ error: String(error) }); }
  });
  assert.equal(result.error, undefined);
  for (const row of result.results) {
    assert.equal(row.originalPreserved, true);
    assert.equal(row.master, "Browser.mp3");
    assert.equal(row.mime, "audio/mpeg");
    assert.equal(row.bitrateIndex, 14);
    assert.equal(row.decodedChannels, row.channels);
    assert.ok(row.duration >= 0.25 && row.duration < 0.4);
    assert.equal(row.audible, true);
  }
  assert.match(result.failure, /Could not convert WAV to MASTER MP3 at 320 kbps/);
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (browser) await browser.deleteSession();
  server.kill();
}
