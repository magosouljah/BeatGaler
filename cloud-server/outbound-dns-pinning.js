const dns = require("dns");
const http = require("http");
const https = require("https");
const net = require("net");
const { EventEmitter } = require("events");

const INSTALLED = Symbol.for("beatgaler.outboundDnsPinning.installed");

function normalizeHostname(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
}

function parseIpv4(address) {
  const parts = String(address || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

function isBlockedIpv4(address) {
  const parts = parseIpv4(address);
  if (!parts) return true;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isBlockedAddress(value) {
  const address = String(value || "").trim().toLowerCase().split("%")[0];
  const family = net.isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family !== 6) return true;

  if (address === "::" || address === "::1") return true;
  if (address.startsWith("::ffff:")) return true;
  if (address.startsWith("64:ff9b:")) return true;
  if (address.startsWith("fc") || address.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(address)) return true;
  if (address.startsWith("2001:db8:")) return true;
  return false;
}

function normalizeLookupRows(result) {
  const rows = Array.isArray(result) ? result : [result];
  return rows
    .map(row => {
      if (typeof row === "string") return { address: row, family: net.isIP(row) };
      if (!row || typeof row !== "object") return null;
      const address = String(row.address || "");
      const family = Number(row.family || net.isIP(address));
      return address && (family === 4 || family === 6) ? { address, family } : null;
    })
    .filter(Boolean);
}

function blockedRequest(message) {
  const request = new EventEmitter();
  request.destroy = () => request;
  request.setTimeout = () => request;
  process.nextTick(() => {
    const error = new Error(message);
    error.code = "ESECURITY";
    request.emit("error", error);
  });
  return request;
}

function installOutboundDnsPinning({
  dnsModule = dns,
  httpModule = http,
  httpsModule = https,
  ttlMs = 10_000,
} = {}) {
  if (dnsModule[INSTALLED]) return dnsModule[INSTALLED];

  // A FIFO per hostname keeps concurrent validated requests independent. Every
  // outbound connection consumes exactly one public resolution. Blocked DNS
  // results throw before server-core can reach http(s).get().
  const pins = new Map();
  const originalPromiseLookup = dnsModule.promises.lookup.bind(dnsModule.promises);
  const originalDnsLookup = dnsModule.lookup.bind(dnsModule);
  const originalHttpGet = httpModule.get.bind(httpModule);
  const originalHttpsGet = httpsModule.get.bind(httpsModule);

  function rememberPublicResolution(hostname, result, options) {
    if (!options || typeof options !== "object" || options.all !== true) return;
    const key = normalizeHostname(hostname);
    const rows = normalizeLookupRows(result);
    if (!key || rows.length === 0 || rows.some(row => isBlockedAddress(row.address))) {
      const error = new Error("Private, local, translated, or reserved DNS targets are not allowed.");
      error.code = "ESECURITY";
      throw error;
    }
    const queue = pins.get(key) || [];
    queue.push({ rows, expiresAt: Date.now() + ttlMs });
    pins.set(key, queue);
  }

  dnsModule.promises.lookup = async function beatGalerPinnedValidationLookup(hostname, options) {
    const result = await originalPromiseLookup(hostname, options);
    rememberPublicResolution(hostname, result, options);
    return result;
  };

  function consumePin(hostname) {
    const key = normalizeHostname(hostname);
    const queue = pins.get(key);
    if (!queue || queue.length === 0) return { state: "none", key };
    const entry = queue.shift();
    if (queue.length === 0) pins.delete(key);
    else pins.set(key, queue);
    if (entry.expiresAt <= Date.now()) return { state: "expired", key };
    return { state: "pinned", key, rows: entry.rows };
  }

  function pinnedLookup(pin) {
    return function lookup(hostname, options, callback) {
      let lookupOptions = options;
      let done = callback;
      if (typeof lookupOptions === "function") {
        done = lookupOptions;
        lookupOptions = {};
      } else if (typeof lookupOptions === "number") {
        lookupOptions = { family: lookupOptions };
      } else {
        lookupOptions = lookupOptions || {};
      }
      if (typeof done !== "function" || normalizeHostname(hostname) !== pin.key) {
        return originalDnsLookup(hostname, options, callback);
      }

      const family = Number(lookupOptions.family || 0);
      const candidates = family === 4 || family === 6
        ? pin.rows.filter(row => row.family === family)
        : pin.rows;
      if (candidates.length === 0) {
        const error = new Error(`Validated DNS resolution has no address for requested family ${family}.`);
        error.code = "ENOTFOUND";
        return process.nextTick(() => done(error));
      }
      if (lookupOptions.all === true) {
        return process.nextTick(() => done(null, candidates.map(row => ({ ...row }))));
      }
      const selected = candidates[0];
      return process.nextTick(() => done(null, selected.address, selected.family));
    };
  }

  function wrapGet(originalGet) {
    return function beatGalerPinnedGet(input, options, callback) {
      let parsed;
      try {
        parsed = input instanceof URL ? input : new URL(String(input));
      } catch {
        return originalGet(input, options, callback);
      }

      const pin = consumePin(parsed.hostname);
      if (pin.state === "none") return originalGet(input, options, callback);
      if (pin.state === "expired") {
        return blockedRequest("Validated DNS resolution expired before the outbound connection; refusing to re-resolve.");
      }

      let requestOptions = options;
      let requestCallback = callback;
      if (typeof requestOptions === "function") {
        requestCallback = requestOptions;
        requestOptions = {};
      } else {
        requestOptions = requestOptions && typeof requestOptions === "object" ? { ...requestOptions } : {};
      }
      requestOptions.lookup = pinnedLookup(pin);
      return originalGet(input, requestOptions, requestCallback);
    };
  }

  httpModule.get = wrapGet(originalHttpGet);
  httpsModule.get = wrapGet(originalHttpsGet);

  const installation = {
    pins,
    restore() {
      dnsModule.promises.lookup = originalPromiseLookup;
      dnsModule.lookup = originalDnsLookup;
      httpModule.get = originalHttpGet;
      httpsModule.get = originalHttpsGet;
      delete dnsModule[INSTALLED];
    },
  };
  dnsModule[INSTALLED] = installation;
  return installation;
}

module.exports = {
  installOutboundDnsPinning,
  isBlockedAddress,
};
