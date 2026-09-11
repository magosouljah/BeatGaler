import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { File } from 'node:buffer';
import ts from 'typescript';
import { prepareCleanMp3CloudUpload } from '../src-tauri/direct-transport/clean-mp3-cloud.mjs';

// Execute the checked-in implementations, replacing imports/transport only.
// This is deterministic adapter evidence, not a live Telegram permissions probe.
const CHAT = -1007000000001;
const BOT = '2002';
const CAPTION = 'BEATGALER_LIBRARY_INDEX_V1';
const empty = () => ({ schema: 'beatgaler.telegram.library', version: 2, beats: [], trash: [], deleted: [] });

function executableSource(filename, desktop = false) {
  const source = fs.readFileSync(filename, 'utf8');
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  assert.equal(ast.parseDiagnostics.length, 0);
  let mainRemoved = 0;
  const body = ast.statements.filter(node => {
    if (ts.isImportDeclaration(node)) return false;
    if (desktop && ts.isExpressionStatement(node) && node.getText(ast).startsWith('main().catch(')) {
      mainRemoved += 1;
      return false;
    }
    return true;
  }).map(node => node.getText(ast)).join('\n');
  if (desktop) assert.equal(mainRemoved, 1, 'omit only the CLI entrypoint, never helper implementation');
  return ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}

function harness(desktop = false) {
  const messages = new Map();
  const calls = [];
  const events = [];
  let pinned = 0;
  let nextId = 100;
  const faults = { pin: false, verifyPin: false, read: false, delete: false };
  const add = (id, bytes, author = BOT, text = '') => {
    const data = Buffer.from(bytes);
    const message = { id, senderId: author, text, media: { type: 'document', fileId: `direct:${id}`, fileSize: data.length, mimeType: 'application/octet-stream', messageId: id }, data };
    messages.set(id, message);
    return message;
  };
  const telegram = {
    async getMe() { calls.push(['getMe', BOT]); return { id: BOT, isBot: true }; },
    async getChat(chatId) { assert.equal(chatId, CHAT); calls.push(['getChat', chatId]); return { id: CHAT }; },
    async getFullChat(chatId) {
      assert.equal(chatId, CHAT); calls.push(['getFullChat', pinned]);
      if (faults.read) throw new Error('socket timeout');
      return { pinnedMsgId: faults.verifyPin && pinned >= 100 ? 0 : pinned };
    },
    async getMessages(chatId, ids) { assert.equal(chatId, CHAT); calls.push(['getMessages', ...ids]); return ids.map(id => messages.get(id) || null); },
    async sendMedia(chatId, document, options) {
      assert.equal(chatId, CHAT);
      const parts = [];
      if (document.file instanceof File) parts.push(Buffer.from(await document.file.arrayBuffer()));
      else {
        const reader = document.file.getReader();
        while (true) { const item = await reader.read(); if (item.done) break; parts.push(Buffer.from(item.value)); }
      }
      const data = Buffer.concat(parts);
      assert.equal(data.length, document.options.fileSize);
      const message = add(nextId++, data, BOT, document.options.caption || '');
      calls.push(['sendMedia', message.id, BOT, data.length]);
      options.progressCallback?.(data.length);
      return message;
    },
    async pinMessage({ chatId, message }) {
      assert.equal(chatId, CHAT); calls.push(['pin', message]);
      if (faults.pin) throw new Error('CHAT_ADMIN_REQUIRED');
      pinned = message;
    },
    async deleteMessagesById(chatId, ids) {
      assert.equal(chatId, CHAT); calls.push(['delete', ...ids]);
      if (faults.delete) throw new Error('MESSAGE_DELETE_FORBIDDEN');
      for (const id of ids) messages.delete(id);
    },
    async downloadAsBuffer(media) { calls.push(['download', media.messageId]); return messages.get(media.messageId).data; },
    async downloadChunk({ location, offset = 0, limit }) { calls.push(['chunk', location.messageId, offset]); return messages.get(location.messageId).data.subarray(offset, offset + limit); },
    async *downloadAsIterable(media, options = {}) {
      calls.push(['stream', media.messageId, options.offset || 0]);
      const bytes = messages.get(media.messageId).data;
      for (let offset = options.offset || 0; offset < bytes.length; offset += 4096) {
        if (options.abortSignal?.aborted) return;
        yield bytes.subarray(offset, offset + 4096);
      }
    },
  };
  let context;
  context = vm.createContext({
    fs, os, path, Readable, Buffer, File, process, console, TextEncoder, TextDecoder, Uint8Array,
    ArrayBuffer, AbortController, DOMException, setTimeout, clearTimeout, performance,
    InputMedia: { document: (file, options) => ({ file, options }) },
    MemoryStorage: class {}, prepareCleanMp3CloudUpload,
    playTrace() {}, playTraceSpan() {},
    WEB_PLAYBACK_DATA_LANES: 7, WEB_PLAYBACK_FIRST_CHUNK_BYTES: 65536,
    WEB_PLAYBACK_FIRST_CHUNK_KB: 64, STARTUP_PREFIX_BYTES: 65536,
    WEB_DIRECT_MAX_FILE_BYTES: 1900 * 1024 * 1024,
    // Prefetch byte/routing correctness is asserted here; decoding is covered by
    // the separate real mp3PlayablePrefix and Web playback tests.
    measureMp3PlayablePrefix: () => null,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    fetch() { throw new Error('Data-plane bytes must never use Cloud fetch'); },
    postMessage(event) {
      events.push(event);
      if (event.event === 'download-chunk') queueMicrotask(() => vm.runInContext(`acknowledgeStream(${JSON.stringify(event.requestId)})`, context));
    },
    telegram, CHAT, BOT, exports: {},
  });
  const filename = desktop ? 'src-tauri/direct-transport/transport-helper.source.mjs' : 'src/features/cloud/webTransport.worker.ts';
  vm.runInContext(executableSource(filename, desktop), context, { filename });
  const api = vm.runInContext(desktop
    ? 'client=telegram; session={chat_id:String(CHAT),transport_id:"Bot02",transport_user_id:BOT}; tempExpiresAt=Number.MAX_SAFE_INTEGER; ({getIndex,replaceIndex,upload,download,downloadRange,ensureIndex})'
    : 'client=telegram; chatId=CHAT; expectedBotId=BOT; vaultVerified=true; ({getLibraryIndex,replaceLibraryIndex,upload,download,stream,prefetch,verifyIdentity,verifyReady})', context);
  return { api, calls, events, messages, faults, add, get pinned() { return pinned; }, set pinned(id) { pinned = id; } };
}

test('Desktop INDEX is authored by assigned bot; cross-bot old INDEX and replaced media are deleted after verified pin', async () => {
  const h = harness(true);
  const old = { ...empty(), beats: [{ id: 'beat-A', master: { telegram_message_id: 11 } }] };
  h.add(10, JSON.stringify(old), '1001', CAPTION); h.add(11, 'old MP3', '1001'); h.pinned = 10;
  assert.equal((await h.api.getIndex()).message_id, 10);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-index-test-'));
  try {
    const file = path.join(dir, 'index.json');
    fs.writeFileSync(file, JSON.stringify({ ...empty(), beats: [{ id: 'beat-A', master: { telegram_message_id: 12 } }] }));
    const result = await h.api.replaceIndex({ path: file });
    assert.equal(h.messages.get(result.message_id).senderId, BOT);
    assert.equal(h.pinned, result.message_id);
    assert.equal(h.messages.has(10), false); assert.equal(h.messages.has(11), false);
    const pin = h.calls.findIndex(call => call[0] === 'pin');
    const verify = h.calls.findIndex((call, index) => index > pin && call[0] === 'getFullChat');
    assert.ok(h.calls.findIndex(call => call[0] === 'delete') > verify);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Desktop failed pin verification preserves prior INDEX/media and never changes bot', async () => {
  const h = harness(true); h.add(10, JSON.stringify(empty()), '1001', CAPTION); h.pinned = 10; h.faults.verifyPin = true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-index-failure-'));
  try {
    const file = path.join(dir, 'index.json'); fs.writeFileSync(file, JSON.stringify({ ...empty(), beats: [{ id: 'new' }] }));
    await assert.rejects(h.api.replaceIndex({ path: file }), /verify authoritative INDEX pin/);
    assert.equal(h.messages.has(10), true); assert.equal(h.calls.some(call => call[0] === 'delete'), false);
    assert.ok(h.calls.filter(call => call[0] === 'sendMedia').every(call => call[2] === BOT));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Desktop initial INDEX and MP3/WAV/artwork/PROJECT bytes use Direct upload/download/range', async () => {
  const h = harness(true); const index = await h.api.ensureIndex();
  assert.equal(h.messages.get(index.message.id).senderId, BOT); assert.equal(h.pinned, index.message.id);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-media-test-'));
  try {
    for (const name of ['track.mp3', 'track.wav', 'cover.png', 'PROJECT.zip']) {
      const bytes = Buffer.alloc(18000, 31); bytes[0] = 255;
      const file = path.join(dir, name); fs.writeFileSync(file, bytes);
      const sent = await h.api.upload({ path: file, filename: name });
      assert.equal(h.messages.get(sent.message_id).senderId, BOT);
      assert.deepEqual(h.messages.get(sent.message_id).data, bytes);
      const output = path.join(dir, 'export', name);
      await h.api.download({ message_id: sent.message_id, output });
      assert.deepEqual(fs.readFileSync(output), bytes);
      const range = path.join(dir, 'range.bin');
      await h.api.downloadRange({ message_id: sent.message_id, output: range, start: 4200, length: 2500 });
      assert.deepEqual(fs.readFileSync(range), bytes.subarray(4200, 6700));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Web empty INDEX creation, cross-bot replacement, stale protection and failed-pin rollback execute actual worker', async () => {
  const h = harness();
  const initial = await h.api.replaceLibraryIndex({ manifest: empty(), expectedMessageId: 0 });
  assert.equal(h.messages.get(initial.messageId).senderId, BOT);
  // Model a persisted legacy message by a different bot. There is no author
  // filter in the implementation: deletion addresses vault + message ID.
  h.messages.get(initial.messageId).senderId = '1001';
  const next = { ...empty(), beats: [{ id: 'beat-A' }] };
  const replacement = await h.api.replaceLibraryIndex({ manifest: next, expectedMessageId: initial.messageId });
  assert.equal(h.messages.has(initial.messageId), false);
  assert.deepEqual(JSON.parse(JSON.stringify((await h.api.getLibraryIndex()).manifest)), next);
  await assert.rejects(h.api.replaceLibraryIndex({ manifest: empty(), expectedMessageId: replacement.messageId }), /stale library update/);
  await assert.rejects(h.api.replaceLibraryIndex({ manifest: next, expectedMessageId: 0 }), /another device/);
  h.faults.pin = true;
  await assert.rejects(h.api.replaceLibraryIndex({ manifest: next, expectedMessageId: replacement.messageId }), /CHAT_ADMIN_REQUIRED/);
  assert.equal(h.messages.has(replacement.messageId), true);
  assert.equal(h.messages.size, 1, 'failed candidate cleaned, prior winning INDEX retained');
});

test('Web bootstrap never interprets network failure or a foreign pinned message as empty vault', async () => {
  const h = harness(); h.faults.read = true;
  await assert.rejects(h.api.replaceLibraryIndex({ manifest: empty(), expectedMessageId: 0 }), /socket timeout/);
  assert.equal(h.calls.some(call => call[0] === 'sendMedia'), false);
  h.faults.read = false; h.add(9, 'not an index', '1001', 'foreign pinned message'); h.pinned = 9;
  await assert.rejects(h.api.replaceLibraryIndex({ manifest: empty(), expectedMessageId: 0 }), /not available/);
  assert.equal(h.calls.some(call => call[0] === 'sendMedia'), false);
});

test('Web MP3/WAV/artwork/PROJECT upload, export/playback streams and warm prefixes stay on Telegram adapter', async () => {
  const h = harness(); await h.api.verifyIdentity(); await h.api.verifyReady();
  for (const [filename, mime, kind] of [['track.mp3', 'audio/mpeg', 'MASTER'], ['track.wav', 'audio/wav', 'WAV'], ['artwork.png', 'image/png', 'ARTWORK'], ['PROJECT.zip', 'application/zip', 'PROJECT']]) {
    const bytes = Buffer.alloc(20000, 77);
    const result = await h.api.upload(`upload-${kind}`, { file: new File([bytes], filename, { type: mime }), filename, kind, beatId: 'beat-A', threadId: 1 });
    const id = result.telegram_message_id;
    assert.equal(h.messages.get(id).senderId, BOT); assert.deepEqual(h.messages.get(id).data, bytes);
    for (const purpose of ['export', 'playback']) {
      const requestId = `${kind}-${purpose}`;
      await h.api.stream(requestId, { messageId: id, mimeType: mime, purpose });
      const downloaded = Buffer.concat(h.events.filter(event => event.requestId === requestId && event.event === 'download-chunk').map(event => Buffer.from(event.chunk)));
      assert.deepEqual(downloaded, bytes);
    }
    const warm = await h.api.prefetch({ messageId: id, mimeType: mime });
    assert.deepEqual(Buffer.from(warm.prefix), bytes);
    if (kind === 'ARTWORK') assert.equal((await h.api.download({ messageId: id, mimeType: mime })).dataUrl, `data:${mime};base64,${bytes.toString('base64')}`);
  }
});
