// Attach only to the existing local Cloud process. Does not restart or reset state.
const targets = await fetch('http://127.0.0.1:9229/json/list').then(r => r.json());
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const expression = process.argv.includes('--remove') ? `(() => {
  global.__stage1TimingUninstall?.();
  delete global.__stage1TimingUninstall;
  return 'timing removed';
})()` : `(() => {
  if (global.__stage1TimingUninstall) throw new Error('Timing is already installed');
  const r = process.mainModule.require.bind(process.mainModule);
  global.__stage1TimingUninstall = r('../scripts/stage1-cloud-timing.cjs')({
    express: r('express'),
    Runtime: r('./postgres-control-plane-runtime').PostgresControlPlaneRuntime,
    file: '/tmp/beatgaler-stage1-cloud-timing.jsonl'
  });
  return 'timing installed';
})()`;
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression } }));
await new Promise((resolve, reject) => {
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id !== 1) return;
    if (message.result?.exceptionDetails || message.error) reject(new Error('Cloud timing installation failed'));
    else { console.log(message.result.result.value); resolve(); }
  };
});
ws.close();
