#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { createServer } = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createProjectUploadHandlers } = require('../project-upload-route');

const PAYLOAD_BYTES = 3 * 1024 * 1024;
const PLAN_MAX_BYTES = 4 * 1024 * 1024;
const nginxBin = process.env.NGINX_BIN || 'nginx';
const repoRoot = path.resolve(__dirname, '..', '..');

function blockFor(config, header) {
  const start = config.indexOf(header);
  if (start < 0) throw new Error(`Missing nginx block: ${header}`);
  const open = config.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < config.length; i += 1) {
    if (config[i] === '{') depth += 1;
    if (config[i] === '}') {
      depth -= 1;
      if (depth === 0) return config.slice(start, i + 1);
    }
  }
  throw new Error(`Unclosed nginx block: ${header}`);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function waitForEmpty(dir, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.readdirSync(dir).length === 0) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`PROJECT tempdir did not clean up: ${fs.readdirSync(dir).join(', ')}`);
}

async function waitForProxy(port, child) {
  for (let attempt = 0; attempt < 75; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`nginx exited early with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__step15_probe`, { signal: AbortSignal.timeout(150) });
      await response.arrayBuffer();
      return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('nginx proxy smoke listener did not become ready');
}

async function main() {
  if (spawnSync(nginxBin, ['-v'], { stdio: 'ignore' }).status !== 0) {
    throw new Error(`${nginxBin} is required for STEP15 proxy+route smoke.`);
  }

  const nginxSource = fs.readFileSync(path.join(repoRoot, 'deploy', 'web', 'beatgaler.com.conf'), 'utf8');
  const projectBlock = blockFor(nginxSource, 'location = /beatgaler-api/transport/project/upload');
  const genericBlock = blockFor(nginxSource, 'location /beatgaler-api/');
  const requiredProjectDirectives = [
    'proxy_request_buffering off;',
    'client_body_timeout 30m;',
    'proxy_read_timeout 30m;',
    'proxy_send_timeout 30m;',
    'send_timeout 30m;',
    'client_max_body_size 2g;',
  ];
  for (const directive of requiredProjectDirectives) {
    if (!projectBlock.includes(directive)) throw new Error(`PROJECT nginx block missing: ${directive}`);
  }
  if (!genericBlock.includes('client_max_body_size 2m;')) {
    throw new Error('Generic API nginx block no longer has the 2 MiB limit.');
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-step15-proxy-route-'));
  const uploadTempDir = path.join(temp, 'uploads');
  const nginxBodyDir = path.join(temp, 'nginx-body');
  fs.mkdirSync(uploadTempDir);
  fs.mkdirSync(nginxBodyDir);

  let appServer = null;
  let nginx = null;
  try {
    const app = express();
    let publisherMode = 'success';
    let publisherCalls = 0;
    let genericHits = 0;

    app.post('/transport/project/upload', ...createProjectUploadHandlers({
      tempDir: uploadTempDir,
      authenticate: () => ({ user: { id: 'step15-user' }, account: { chatId: 'step15-vault' } }),
      async verifyCapability(req) {
        if (req.body.operationId !== 'step15-operation' || req.body.beatId !== 'step15-beat') {
          throw Object.assign(new Error('Unexpected STEP15 capability.'), { status: 403, code: 'STEP15_CAPABILITY_MISMATCH' });
        }
      },
      async authorizeProject() { return { maxBytes: PLAN_MAX_BYTES }; },
      async uploadProject(input) {
        publisherCalls += 1;
        const bytes = fs.statSync(input.filePath).size;
        if (bytes !== PAYLOAD_BYTES) throw new Error(`Expected ${PAYLOAD_BYTES} bytes, got ${bytes}.`);
        if (publisherMode === 'fail') {
          throw Object.assign(new Error('Simulated MASTER publication failure.'), {
            status: 503,
            code: 'STEP15_MASTER_FAILURE_SMOKE',
          });
        }
        return { messageId: 1515, bytes };
      },
      storageChatId: account => account.chatId,
    }));
    app.post('/not-project', express.raw({ type: '*/*', limit: '8mb' }), (_req, res) => {
      genericHits += 1;
      res.status(200).end();
    });
    app.use((error, _req, res, _next) => {
      res.status(error?.code === 'LIMIT_FILE_SIZE' ? 413 : Number(error?.status || 500))
        .json({ code: error?.code || 'STEP15_PROJECT_PROXY_ROUTE_SMOKE_FAILED' });
    });

    appServer = createServer(app);
    const upstreamPort = await listen(appServer);
    const portProbe = createServer();
    const proxyPort = await listen(portProbe);
    await new Promise(resolve => portProbe.close(resolve));

    const rewrite = block => block.replaceAll('127.0.0.1:4000', `127.0.0.1:${upstreamPort}`);
    const nginxConfig = [
      'worker_processes 1;',
      `pid "${path.join(temp, 'nginx.pid')}";`,
      `error_log "${path.join(temp, 'nginx-error.log')}" info;`,
      'events { worker_connections 64; }',
      'http {',
      'access_log off;',
      `client_body_temp_path "${nginxBodyDir}";`,
      'server {',
      `listen 127.0.0.1:${proxyPort};`,
      rewrite(projectBlock),
      rewrite(genericBlock),
      'location / { return 404; }',
      '}',
      '}',
      '',
    ].join('\n');
    const configPath = path.join(temp, 'nginx.conf');
    fs.writeFileSync(configPath, nginxConfig);

    const syntax = spawnSync(nginxBin, ['-t', '-c', configPath, '-p', `${temp}/`], { encoding: 'utf8' });
    if (syntax.status !== 0) throw new Error(`nginx -t failed: ${syntax.stderr || syntax.stdout}`);
    nginx = spawn(nginxBin, ['-c', configPath, '-p', `${temp}/`, '-g', 'daemon off;'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    await waitForProxy(proxyPort, nginx);

    async function sendProject(size) {
      const form = new FormData();
      form.append('file', new Blob([Buffer.alloc(size, 0x53)]), 'step15-project.zip');
      const response = await fetch(`http://127.0.0.1:${proxyPort}/beatgaler-api/transport/project/upload`, {
        method: 'POST',
        headers: {
          'X-BeatGaler-Project-Beat': 'step15-beat',
          'X-BeatGaler-Project-Kind': 'commit_import',
          'X-BeatGaler-Project-Operation': 'step15-operation',
          'X-BeatGaler-Project-Session': 'step15-session',
          'X-BeatGaler-Project-Generation': '1',
          'X-BeatGaler-Project-Thread': '42',
        },
        body: form,
      });
      return { response, body: await response.json().catch(() => ({})) };
    }

    const success = await sendProject(PAYLOAD_BYTES);
    if (success.response.status !== 200 || success.body.original_size !== PAYLOAD_BYTES) {
      throw new Error(`PROJECT proxy success failed HTTP ${success.response.status}: ${JSON.stringify(success.body)}`);
    }
    await waitForEmpty(uploadTempDir);

    publisherMode = 'fail';
    const failed = await sendProject(PAYLOAD_BYTES);
    if (failed.response.status !== 503 || failed.body.code !== 'STEP15_MASTER_FAILURE_SMOKE') {
      throw new Error(`PROJECT proxy publisher failure mismatch HTTP ${failed.response.status}: ${JSON.stringify(failed.body)}`);
    }
    await waitForEmpty(uploadTempDir);

    publisherMode = 'success';
    const tooLarge = await sendProject(PLAN_MAX_BYTES + 1);
    if (tooLarge.response.status !== 413 || tooLarge.body.code !== 'LIMIT_FILE_SIZE') {
      throw new Error(`PROJECT proxy plan limit mismatch HTTP ${tooLarge.response.status}: ${JSON.stringify(tooLarge.body)}`);
    }
    await waitForEmpty(uploadTempDir);

    const generic = await fetch(`http://127.0.0.1:${proxyPort}/beatgaler-api/not-project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(PAYLOAD_BYTES, 0x47),
    });
    await generic.arrayBuffer();
    if (generic.status !== 413) throw new Error(`Generic API >2 MiB expected 413, got ${generic.status}.`);
    if (genericHits !== 0) throw new Error('Generic >2 MiB request reached the Cloud route.');
    if (publisherCalls !== 2) throw new Error(`Expected exactly 2 publisher calls, got ${publisherCalls}.`);

    console.log(JSON.stringify({
      kind: 'STEP15_PROJECT_PROXY_ROUTE_SMOKE',
      result: 'PASS',
      projectPayloadBytes: PAYLOAD_BYTES,
      planMaxBytes: PLAN_MAX_BYTES,
      successStatus: success.response.status,
      simulatedMasterFailureStatus: failed.response.status,
      planOverLimitStatus: tooLarge.response.status,
      genericOver2MiBStatus: generic.status,
      genericReachedCloud: false,
      tempfileCleanAfterEachProjectCase: true,
      publisherCalls,
      externalServicesUsed: false,
    }, null, 2));
  } finally {
    if (nginx && nginx.exitCode === null) {
      const configPath = path.join(temp, 'nginx.conf');
      spawnSync(nginxBin, ['-s', 'stop', '-c', configPath, '-p', `${temp}/`], { stdio: 'ignore' });
      nginx.kill('SIGTERM');
    }
    if (appServer) await new Promise(resolve => appServer.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
