import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

test('real Vite watcher policy excludes packaged runtime trees and permits Web sources', { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.resolve('tmp/stage1-watch-'));
  await fs.mkdir(path.join(root, 'runtime', 'nested'), { recursive: true });
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'runtime', 'nested', 'artifact.js'), '');
  await fs.writeFile(path.join(root, 'src', 'main.js'), '');
  const server = await createServer({
    root, cacheDir: path.join(root, '.cache'), configFile: path.resolve('vite.config.ts'), logLevel: 'silent',
    server: { middlewareMode: true },
  });
  try {
    // Exercise Chokidar's actual matcher after Vite merges defaults and config.
    const ignored = relative => server.watcher._isIgnored(path.join(root, relative).replaceAll('\\', '/'));
    assert.equal(ignored('runtime'), true);
    assert.equal(ignored('runtime/nested/artifact.js'), true);
    assert.equal(ignored('src'), false);
    assert.equal(ignored('src/main.js'), false);
  } finally {
    await server.close();
    // Only this test-created, unique workspace temp directory is removed.
    assert.ok(path.resolve(root).startsWith(path.resolve('tmp') + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  }
});
