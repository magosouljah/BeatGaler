globalThis.__M0_E2_RESULT__ = { status: "running" };

const worker = new Worker(new URL("./m0-e2-web-worker.js", import.meta.url), {
  type: "module",
  name: "BeatGaler-M0-E2",
});

globalThis.__M0_E2_WORKER__ = worker;

worker.onmessage = event => {
  globalThis.__M0_E2_RESULT__ = event.data;
  worker.terminate();
};

worker.onerror = event => {
  globalThis.__M0_E2_RESULT__ = {
    status: "fail",
    error: event.message || "M0-E2 Worker error",
    web_browser_proven: false,
    web_worker_proven: true,
    production_runtime_changed: false,
  };
  worker.terminate();
};
