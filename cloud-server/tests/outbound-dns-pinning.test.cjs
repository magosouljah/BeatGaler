"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { installOutboundDnsPinning, isBlockedAddress } = require("../outbound-dns-pinning");

function fakeRuntime() {
  let nextRows = [{ address: "93.184.216.34", family: 4 }];
  const calls = [];
  const dnsModule = {
    lookup(hostname, options, callback) {
      let done = callback;
      let opts = options;
      if (typeof opts === "function") {
        done = opts;
        opts = {};
      }
      const rows = nextRows.map(row => ({ ...row }));
      if (opts?.all) return process.nextTick(() => done(null, rows));
      const row = rows[0];
      return process.nextTick(() => done(null, row.address, row.family));
    },
    promises: {
      async lookup() {
        return nextRows.map(row => ({ ...row }));
      },
    },
  };

  function makeTransport() {
    return {
      get(input, options, callback) {
        let opts = options;
        let cb = callback;
        if (typeof opts === "function") {
          cb = opts;
          opts = {};
        }
        calls.push({ input: String(input), options: opts || {} });
        if (typeof opts?.lookup === "function") {
          opts.lookup(new URL(String(input)).hostname, { family: 0 }, (error, address, family) => {
            calls[calls.length - 1].resolved = { error, address, family };
          });
        }
        cb?.({});
        return { on() { return this; } };
      },
    };
  }

  return {
    dnsModule,
    httpModule: makeTransport(),
    httpsModule: makeTransport(),
    calls,
    setRows(rows) { nextRows = rows; },
  };
}

test("validated public DNS result is pinned through the outbound connection", async () => {
  const runtime = fakeRuntime();
  const installation = installOutboundDnsPinning(runtime);
  try {
    const validated = await runtime.dnsModule.promises.lookup("example.com", { all: true });
    assert.equal(validated[0].address, "93.184.216.34");

    runtime.setRows([{ address: "127.0.0.1", family: 4 }]);
    runtime.httpModule.get("http://example.com/artwork.png", () => {});
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(runtime.calls.length, 1);
    assert.deepEqual(runtime.calls[0].resolved, {
      error: null,
      address: "93.184.216.34",
      family: 4,
    });
  } finally {
    installation.restore();
  }
});

test("private or reserved validation results are never pinned", async () => {
  const runtime = fakeRuntime();
  runtime.setRows([{ address: "127.0.0.1", family: 4 }]);
  const installation = installOutboundDnsPinning(runtime);
  try {
    await runtime.dnsModule.promises.lookup("example.com", { all: true });
    runtime.httpModule.get("http://example.com/artwork.png", () => {});
    assert.equal(runtime.calls[0].options.lookup, undefined);
  } finally {
    installation.restore();
  }
});

test("blocked address classifier covers local, private, mapped, and documentation networks", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "100.64.0.1",
    "198.51.100.7",
    "203.0.113.10",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  assert.equal(isBlockedAddress("93.184.216.34"), false);
  assert.equal(isBlockedAddress("2606:4700:4700::1111"), false);
});
