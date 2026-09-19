import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { authPreload, observeAuth } from "./stage1-auth-observer.mjs";

function fakeBrowser() {
  let preload, listener, context;
  let documentNumber = 0;
  const client = {
    async addInitScript(fn) {
      preload = fn;
      return {
        on(event, callback) { assert.equal(event, "data"); listener = callback; },
        async remove() { preload = null; listener = null; },
      };
    },
    async execute(fn) { return vm.runInContext(`(${fn})()`, context); },
  };
  return {
    client,
    navigate(fetch) {
      context = vm.createContext({
        window: { fetch }, location: { href: "http://localhost:1421/", origin: "http://localhost:1421" },
        URL, Headers, performance, crypto: { randomUUID: () => `document-${++documentNumber}` },
        emit: data => listener?.(data),
      });
      if (preload) vm.runInContext(`(${preload})(emit)`, context);
      return context.window;
    },
  };
}

test("preload observes before UI, survives fresh documents, preserves phases and excludes secrets", async () => {
  const browser = fakeBrowser();
  const observer = await observeAuth(browser.client);
  const response = { status: 200, body: "SECRET", headers: { authorization: "SECRET" } };
  const original = async () => response;
  let page = browser.navigate(original);
  assert.equal(await page.fetch("/beatgaler-api/auth/health?token=SECRET"), response);
  observer.setPhase("profile-reset-refresh");
  page = browser.navigate(original);
  await page.fetch(new URL("http://localhost:1421/beatgaler-api/auth/session"));
  observer.setPhase("submitting-sign-in");
  await page.fetch({ url: "http://localhost:1421/beatgaler-api/auth/login", body: "SECRET" }, { headers: { cookie: "SECRET" } });
  await page.fetch("/beatgaler-api/auth/account");
  await page.fetch("http://elsewhere.test/beatgaler-api/auth/login");
  await page.fetch("/unrelated");
  const entries = observer.snapshot();
  assert.equal(entries.length, 4);
  assert.deepEqual(entries.map(e => e.harness_phase), ["initial-navigation", "profile-reset-refresh", "submitting-sign-in", "submitting-sign-in"]);
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), ["abort_at_ms", "document_id", "duration_ms", "harness_phase", "observed_at_ms", "route", "started_at_ms", "state", "status", "trace_id"]);
    assert.match(entry.document_id, /^document-\d+$/);
    assert.equal(entry.state, "response");
    assert.equal(entry.status, 200);
  }
  assert.equal(JSON.stringify(entries).includes("SECRET"), false);
  await observer.remove();
  assert.equal(page.fetch, original);
  page = browser.navigate(original);
  await page.fetch("/beatgaler-api/auth/login");
  assert.equal(observer.snapshot().length, 4);
});

test("early failures and pending requests survive navigation without a DOM snapshot", async () => {
  const browser = fakeBrowser();
  const observer = await observeAuth(browser.client);
  const abort = Object.assign(new Error("SECRET"), { name: "AbortError" });
  const network = new TypeError("SECRET");
  const page = browser.navigate(async url => {
    if (url.endsWith("health")) throw abort;
    if (url.endsWith("session")) throw network;
    return new Promise(() => {});
  });
  await assert.rejects(page.fetch("/beatgaler-api/auth/health"), e => e === abort);
  await assert.rejects(page.fetch("/beatgaler-api/auth/session"), e => e === network);
  void page.fetch("/beatgaler-api/auth/login");
  observer.setPhase("profile-reset-refresh");
  browser.navigate(async () => ({ status: 503 }));
  const entries = observer.snapshot();
  assert.deepEqual(entries.map(e => e.state), ["aborted", "network-error", "pending"]);
  assert.ok(entries.every(e => e.status === null && e.duration_ms >= 0 && e.harness_phase === "initial-navigation"));
  assert.equal(JSON.stringify(entries).includes("SECRET"), false);
  await observer.remove();
});

test("accounts have separate collectors", async () => {
  const a = fakeBrowser(), b = fakeBrowser();
  const first = await observeAuth(a.client), second = await observeAuth(b.client);
  await a.navigate(async () => ({ status: 401 })).fetch("/beatgaler-api/auth/login");
  await b.navigate(async () => ({ status: 200 })).fetch("/beatgaler-api/auth/login");
  assert.equal(first.snapshot()[0].status, 401);
  assert.equal(second.snapshot()[0].status, 200);
  await Promise.all([first.remove(), second.remove()]);
});

test("health correlation preserves options and records the actual abort signal time", async () => {
  const browser = fakeBrowser();
  const observer = await observeAuth(browser.client);
  const controller = new AbortController();
  let observed;
  const page = browser.navigate((_url, init) => {
    observed = init;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('SECRET'), { name: 'AbortError' }))));
  });
  const options = { signal: controller.signal, credentials: 'same-origin', headers: { 'x-existing': 'kept' } };
  const request = page.fetch('/beatgaler-api/auth/health', options);
  assert.equal(observed.signal, controller.signal);
  assert.equal(observed.credentials, 'same-origin');
  assert.equal(observed.headers.get('x-existing'), 'kept');
  assert.equal(observed.headers.get('x-stage1-trace'), observer.snapshot()[0].trace_id);
  assert.equal(options.headers['x-stage1-trace'], undefined);
  controller.abort();
  await assert.rejects(request);
  const entry = observer.snapshot()[0];
  assert.equal(entry.state, 'aborted');
  assert.ok(entry.abort_at_ms >= entry.started_at_ms);
  assert.ok(entry.observed_at_ms >= entry.abort_at_ms);
  await observer.remove();
});

test('resource timing emits only numeric timing fields for an observed auth request', async () => {
  let receive, disconnected = false;
  const emitted = [];
  const context = vm.createContext({
    window: { fetch: async () => ({ status: 200 }) },
    URL, Headers, performance, crypto: { randomUUID: () => 'timing-document' },
    location: { href: 'http://localhost:1421/', origin: 'http://localhost:1421' },
    emit: value => emitted.push(value),
    PerformanceObserver: class {
      constructor(callback) { receive = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
  });
  vm.runInContext(`(${authPreload})(emit)`, context);
  await context.window.fetch('/beatgaler-api/auth/health?secret=SECRET');
  receive({ getEntries: () => [{ name: 'http://localhost:1421/beatgaler-api/auth/health?secret=SECRET', startTime: performance.now(), requestStart: 10, responseStart: 20, secret: 'SECRET' }, { name: 'http://localhost:1421/other', startTime: performance.now(), secret: 'SECRET' }] });
  const timing = emitted.find(value => value.resource_timing);
  assert.equal(timing.id, emitted[0].id);
  assert.equal(timing.resource_timing.requestStart, 10);
  assert.equal(JSON.stringify(emitted).includes('SECRET'), false);
  context.window.__stage1RestoreFetch();
  assert.equal(disconnected, true);
});

test("transport observation keeps only safe Direct metadata and preserves the real response", async () => {
  const browser = fakeBrowser();
  const observer = await observeAuth(browser.client);
  let cloneCalls = 0;

  const response = {
    status: 200,
    ok: true,
    clone() {
      cloneCalls += 1;

      return {
        async json() {
          return {
            mode: "galer-direct-temp-mtproto",
            session_id: "session-1",
            transport_id: "transport-1",
            transport_user_id: "bot-user-1",
            chat_id: "vault-1",
            generation: 2,
            credential_version: 3,
            token: "SECRET",
            credentials: "SECRET",
            temp_auth: {
              expected_bot_id: "bot-user-1",
              token: "SECRET",
            },
          };
        },
      };
    },
  };

  const page = browser.navigate(async () => response);

  const returned = await page.fetch(
    "/beatgaler-api/transport/session/start",
    {
      method: "POST",
      body: "SECRET",
    },
  );

  assert.equal(returned, response);
  assert.equal(cloneCalls, 1);

  const [entry] = observer.snapshot();

  assert.equal(
    entry.route,
    "/beatgaler-api/transport/session/start",
  );

  assert.equal(entry.state, "response");
  assert.equal(entry.status, 200);

  assert.deepEqual({ ...entry.transport }, {
    mode: "galer-direct-temp-mtproto",
    session_id: "session-1",
    transport_id: "transport-1",
    transport_user_id: "bot-user-1",
    chat_id: "vault-1",
    generation: 2,
    credential_version: 3,
    expected_bot_id: "bot-user-1",
  });

  assert.equal(
    JSON.stringify(entry).includes("SECRET"),
    false,
  );

  await observer.remove();
});
