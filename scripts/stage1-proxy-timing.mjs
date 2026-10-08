import { createWriteStream, writeFile } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Session } from 'node:inspector';

const CRITICAL_PATH_ROUTES = new Set([
  '/beatgaler-api/auth/session',
  '/beatgaler-api/transport/session/start',
  '/beatgaler-api/transport/session/activate',
  '/beatgaler-api/transport/operation/begin',
  '/beatgaler-api/transport/capability/authorize',
  '/beatgaler-api/transport/operation/end',
]);

function traceId(req) {
  const header = String(req.headers['x-stage1-critical-path'] || '').trim();
  const query = new URL(req.url || '/', 'http://stage1.invalid').searchParams.get('stage1_cp') || '';
  const value = header || query;
  return /^[a-zA-Z0-9:-]{1,100}$/.test(value) ? value : null;
}

function criticalPathRequest(req) {
  const id = traceId(req);
  const path = (req.url || '').split('?')[0];
  return id && (CRITICAL_PATH_ROUTES.has(path) || path === '/');
}

export function stage1ViteTiming() {
  return {
    name: 'stage1-vite-timing',
    configureServer(server) {
      const file = process.env.STAGE1_PROXY_TIMING_FILE;
      if (!file) return;
      let profiler;
      if (process.env.STAGE1_VITE_PROFILE) {
        profiler = new Session();
        profiler.connect();
        profiler.post('Profiler.enable', () => profiler.post('Profiler.start'));
      }
      const stopProfile = () => {
        if (!profiler) return;
        const current = profiler; profiler = null;
        current.post('Profiler.stop', (error, result) => {
          if (!error) writeFile(process.env.STAGE1_VITE_PROFILE, JSON.stringify(result.profile), () => current.disconnect());
          else current.disconnect();
        });
      };
      const stream = createWriteStream(file, { flags: 'a' });
      stream.on('error', () => {});
      const delay = monitorEventLoopDelay({ resolution: 20 });
      delay.enable();
      let previous = performance.now();
      const sampler = setInterval(() => {
        const now = performance.now();
        if (now - previous > 100) stream.write(JSON.stringify({ event: 'vite_loop_gap', at_ms: Date.now(), mono_ms: now, gap_ms: now - previous }) + '\n');
        previous = now;
      }, 20);
      sampler.unref();
      server.httpServer.prependListener('request', req => {
        const id = traceId(req);
        if (!id || !criticalPathRequest(req)) return;
        stopProfile();
        stream.write(JSON.stringify({ id, event: 'vite_ingress', path: req.url?.split('?')[0] || null, at_ms: Date.now(), mono_ms: performance.now(), loop_max_ms: delay.max / 1e6, loop_p99_ms: delay.percentile(99) / 1e6 }) + '\n');
        delay.reset();
      });
      server.httpServer.once('close', () => { stopProfile(); clearInterval(sampler); delay.disable(); stream.end(); });
    },
  };
}

export function stage1ProxyTiming(proxy) {
  const file = process.env.STAGE1_PROXY_TIMING_FILE;
  if (!file) return;
  const stream = createWriteStream(file, { flags: 'a' });
  stream.on('error', () => {});
  const log = (req, event) => {
    const id = traceId(req);
    if (!id || !criticalPathRequest(req)) return;
    stream.write(JSON.stringify({ id, event, path: req.url?.split('?')[0] || null, at_ms: Date.now(), mono_ms: performance.now() }) + '\n');
  };
  proxy.on('start', req => log(req, 'vite_proxy_start'));
  proxy.on('proxyReq', (proxyReq, req) => {
    log(req, 'vite_proxy_upstream_request');
    const socket = proxyReq.socket;
    if (socket) {
      log(req, socket.connecting ? 'proxy_socket_connecting' : 'proxy_socket_connected');
      socket.once('connect', () => log(req, 'proxy_socket_connect'));
    }
    proxyReq.once('finish', () => log(req, 'vite_proxy_upstream_request_finish'));
    proxyReq.once('close', () => log(req, 'vite_proxy_upstream_request_close'));
  });
  proxy.on('proxyRes', (res, req) => {
    log(req, 'vite_proxy_upstream_response');
    res.once('end', () => log(req, 'vite_proxy_response_to_browser_end'));
  });
  proxy.on('error', (_error, req) => log(req, 'proxy_error'));
}
