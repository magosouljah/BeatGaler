import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfigFromFile } from 'vite';

// Behavior of the same-origin dev/preview proxy the Web app uses to reach the Cloud (/beatgaler-api).
async function loadProxy(section, env = {}) {
  const saved = process.env.STAGE1_CLOUD_URL;
  if (env.STAGE1_CLOUD_URL === undefined) delete process.env.STAGE1_CLOUD_URL; else process.env.STAGE1_CLOUD_URL = env.STAGE1_CLOUD_URL;
  try {
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'web' }, path.resolve('vite.config.ts'));
    assert.ok(loaded, 'vite.config.ts must load');
    return loaded.config[section].proxy['/beatgaler-api'];
  } finally {
    if (saved === undefined) delete process.env.STAGE1_CLOUD_URL; else process.env.STAGE1_CLOUD_URL = saved;
  }
}

for (const section of ['server', 'preview']) {
  test(`${section} proxies /beatgaler-api to the local Cloud and strips the prefix`, async () => {
    const proxy = await loadProxy(section);
    assert.equal(proxy.target, 'http://127.0.0.1:4000');
    assert.equal(proxy.changeOrigin, true);
    assert.equal(proxy.rewrite('/beatgaler-api/auth/login?x=1'), '/auth/login?x=1');
    assert.equal(proxy.rewrite('/other/beatgaler-api/x'), '/other/beatgaler-api/x');
  });

  test(`${section} proxy target follows STAGE1_CLOUD_URL`, async () => {
    const proxy = await loadProxy(section, { STAGE1_CLOUD_URL: 'http://127.0.0.1:4999' });
    assert.equal(proxy.target, 'http://127.0.0.1:4999');
  });
}
