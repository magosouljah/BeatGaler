import { createWriteStream, writeFile } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Session } from 'node:inspector';

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
        const id = req.headers['x-stage1-trace'];
        if (!/^[a-zA-Z0-9:-]{1,100}$/.test(id || '') || req.url?.split('?')[0] !== '/beatgaler-api/auth/health') return;
        stopProfile();
        stream.write(JSON.stringify({ id, event: 'vite_arrival', at_ms: Date.now(), mono_ms: performance.now(), loop_max_ms: delay.max / 1e6, loop_p99_ms: delay.percentile(99) / 1e6 }) + '\n');
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
    const id = req.headers['x-stage1-trace'];
    if (!/^[a-zA-Z0-9:-]{1,100}$/.test(id || '') || !req.url?.split('?')[0].endsWith('/auth/health')) return;
    stream.write(JSON.stringify({ id, event, at_ms: Date.now(), mono_ms: performance.now() }) + '\n');
  };
  proxy.on('start', req => log(req, 'proxy_arrival'));
  proxy.on('proxyReq', (proxyReq, req) => {
    log(req, 'proxy_request');
    const socket = proxyReq.socket;
    if (socket) {
      log(req, socket.connecting ? 'proxy_socket_connecting' : 'proxy_socket_connected');
      socket.once('connect', () => log(req, 'proxy_socket_connect'));
    }
    proxyReq.once('finish', () => log(req, 'proxy_request_finish'));
    proxyReq.once('close', () => log(req, 'proxy_request_close'));
  });
  proxy.on('proxyRes', (res, req) => {
    log(req, 'proxy_response');
    res.once('end', () => log(req, 'proxy_response_end'));
  });
  proxy.on('error', (_error, req) => log(req, 'proxy_error'));
}
