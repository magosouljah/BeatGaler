#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nginxBin = process.env.NGINX_BIN || 'nginx';
const requireNginx = process.argv.includes('--require-nginx');
const unknown = process.argv.slice(2).filter(arg => arg !== '--require-nginx');
if (unknown.length) {
  console.error('usage: node scripts/step15-project-ingress-smoke.mjs [--require-nginx]');
  process.exit(64);
}

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

function assertProjectContract(config, label) {
  const project = blockFor(config, 'location = /beatgaler-api/transport/project/upload');
  const generic = blockFor(config, 'location /beatgaler-api/');
  const required = [
    /proxy_pass\s+http:\/\/127\.0\.0\.1:4000\/transport\/project\/upload\s*;/,
    /proxy_request_buffering\s+off\s*;/,
    /client_body_timeout\s+30m\s*;/,
    /proxy_read_timeout\s+30m\s*;/,
    /proxy_send_timeout\s+30m\s*;/,
    /send_timeout\s+30m\s*;/,
    /client_max_body_size\s+2g\s*;/,
  ];
  for (const check of required) {
    if (!check.test(project)) throw new Error(`${label}: PROJECT ingress contract missing ${check}`);
  }
  if (!/client_max_body_size\s+2m\s*;/.test(generic)) {
    throw new Error(`${label}: generic API limit is no longer 2 MiB`);
  }
  return { project, generic };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function post(port, path, bytes) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'POST', headers: {
      'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length,
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(bytes);
  });
}

async function waitForPort(port, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`nginx exited early with ${child.exitCode}`);
    try {
      await new Promise((resolve, reject) => {
        const req = httpRequest({ hostname: '127.0.0.1', port, path: '/__probe', method: 'GET' }, res => {
          res.resume();
          res.on('end', resolve);
        });
        req.setTimeout(100, () => req.destroy());
        req.on('error', reject);
        req.end();
      });
      return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('nginx smoke listener did not become ready');
}

const finalConfig = readFileSync(resolve(root, 'deploy/web/beatgaler.com.conf'), 'utf8');
const bootstrapConfig = readFileSync(resolve(root, 'deploy/web/beatgaler.com.bootstrap.conf'), 'utf8');
const finalBlocks = assertProjectContract(finalConfig, 'final');
assertProjectContract(bootstrapConfig, 'bootstrap');

if (spawnSync(nginxBin, ['-v'], { stdio: 'ignore' }).status !== 0) {
  const message = `${nginxBin} is unavailable; static PROJECT ingress contract passed`;
  if (requireNginx) throw new Error(message);
  console.log(JSON.stringify({ kind: 'STEP15_PROJECT_INGRESS_SMOKE', result: 'SKIP', reason: message }, null, 2));
  process.exit(0);
}

const temp = mkdtempSync(join(tmpdir(), 'beatgaler-step15-nginx-'));
const bodyDir = join(temp, 'body');
mkdirSync(bodyDir);
let nginx = null;
let upstream = null;
try {
  let upstreamRequests = 0;
  upstream = createServer((req, res) => {
    upstreamRequests += 1;
    let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ url: req.url, bytes }));
    });
  });
  const upstreamPort = await listen(upstream);
  const portProbe = createServer();
  const proxyPort = await listen(portProbe);
  await new Promise(resolve => portProbe.close(resolve));

  const rewrite = block => block.replaceAll('127.0.0.1:4000', `127.0.0.1:${upstreamPort}`);
  const nginxConfig = `worker_processes 1;\npid "${join(temp, 'nginx.pid')}";\nerror_log "${join(temp, 'error.log')}" info;\nevents { worker_connections 64; }\nhttp {\naccess_log off;\nclient_body_temp_path "${bodyDir}";\nserver {\nlisten 127.0.0.1:${proxyPort};\n${rewrite(finalBlocks.project)}\n${rewrite(finalBlocks.generic)}\n}\n}\n`;
  const configPath = join(temp, 'nginx.conf');
  writeFileSync(configPath, nginxConfig);

  const syntax = spawnSync(nginxBin, ['-t', '-c', configPath, '-p', `${temp}/`], { encoding: 'utf8' });
  if (syntax.status !== 0) throw new Error(`nginx -t failed: ${syntax.stderr || syntax.stdout}`);
  nginx = spawn(nginxBin, ['-c', configPath, '-p', `${temp}/`, '-g', 'daemon off;'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForPort(proxyPort, nginx);

  const payload = Buffer.alloc(3 * 1024 * 1024, 0x53);
  const project = await post(proxyPort, '/beatgaler-api/transport/project/upload', payload);
  if (project.status !== 200) throw new Error(`PROJECT >2 MiB returned HTTP ${project.status}`);
  const echoed = JSON.parse(project.body);
  if (echoed.url !== '/transport/project/upload' || echoed.bytes !== payload.length) {
    throw new Error(`PROJECT proxy mismatch: ${project.body}`);
  }
  const afterProject = upstreamRequests;
  const generic = await post(proxyPort, '/beatgaler-api/not-project', payload);
  if (generic.status !== 413) throw new Error(`generic API >2 MiB expected 413, got ${generic.status}`);
  if (upstreamRequests !== afterProject) throw new Error('generic >2 MiB payload reached upstream');

  console.log(JSON.stringify({
    kind: 'STEP15_PROJECT_INGRESS_SMOKE',
    result: 'PASS',
    bytes: payload.length,
    projectStatus: project.status,
    projectUpstreamPath: echoed.url,
    genericStatus: generic.status,
    genericReachedUpstream: false,
  }, null, 2));
} finally {
  if (nginx && nginx.exitCode === null) {
    const configPath = join(temp, 'nginx.conf');
    spawnSync(nginxBin, ['-s', 'stop', '-c', configPath, '-p', `${temp}/`], { stdio: 'ignore' });
    nginx.kill('SIGTERM');
  }
  if (upstream) await new Promise(resolve => upstream.close(resolve));
  rmSync(temp, { recursive: true, force: true });
}
