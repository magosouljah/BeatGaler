import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_DIR = path.resolve(process.cwd(), "tmp");
const REPORT_FILE = path.join(REPORT_DIR, "stage1-real-multi-account-report.json");
const SESSION_COOKIE = "__Host-beatgaler_session";
const CSRF_COOKIE = "__Host-beatgaler_csrf";

const accounts = [
  {
    label: "A",
    browserName: "accountA",
    identifier: process.env.STAGE1_ACCOUNT_A_IDENTIFIER || "",
    password: process.env.STAGE1_ACCOUNT_A_PASSWORD || "",
  },
  {
    label: "B",
    browserName: "accountB",
    identifier: process.env.STAGE1_ACCOUNT_B_IDENTIFIER || "",
    password: process.env.STAGE1_ACCOUNT_B_PASSWORD || "",
  },
];

const report = {
  version: 1,
  stage: "Etapa 1 — uso real entre cuentas independientes",
  baseline_sha: process.env.STAGE1_GIT_HEAD || null,
  started_at: new Date().toISOString(),
  finished_at: null,
  overall: "NOT_TESTED",
  severity: null,
  real: {
    browser: true,
    ui_login: true,
    cloud_control_plane: true,
    postgres_persistent_assignment_via_productive_control_plane: true,
    direct_bootstrap: true,
    authoritative_library_data_plane: true,
  },
  simulated: [],
  accounts: {},
  scenarios: [
    { name: "two_account_auth_isolation", status: "NOT_TESTED", severity: null },
    { name: "authoritative_library_data_plane", status: "NOT_TESTED", severity: null },
    { name: "two_account_direct_identity", status: "NOT_TESTED", severity: null },
    { name: "simultaneous_reload_persistent_assignment", status: "NOT_TESTED", severity: null },
    { name: "playback_concurrency", status: "NOT_TESTED", severity: null },
    { name: "uploads_metadata_downloads_trash", status: "NOT_TESTED", severity: null },
  ],
  failure: null,
};

function scenario(name) {
  return report.scenarios.find(item => item.name === name);
}

function markScenario(name, status, severity = null, detail = null) {
  const item = scenario(name);
  if (!item) return;
  item.status = status;
  item.severity = severity;
  if (detail) item.detail = detail;
}

async function writeReport() {
  report.finished_at = new Date().toISOString();
  await fs.mkdir(REPORT_DIR, { recursive: true });
  await fs.writeFile(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function taggedError(message, code, severity = "P1") {
  return Object.assign(new Error(message), { code, severity });
}

async function clearBrowserProfile(client) {
  await client.url("/");
  await client.deleteCookies();
  await client.execute(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await client.refresh();
}

async function loginThroughUi(client, account) {
  const startedAt = Date.now();
  await clearBrowserProfile(client);

  await client.waitUntil(async () => {
    const field = await client.$("#beatgaler-login-identifier");
    return field.isDisplayed().catch(() => false);
  }, {
    timeout: 30_000,
    interval: 250,
    timeoutMsg: `Account ${account.label} did not reach the BeatGaler sign-in UI.`,
  });

  await (await client.$("#beatgaler-login-identifier")).setValue(account.identifier);
  await (await client.$("#beatgaler-login-password")).setValue(account.password);
  await (await client.$("button.bg-account-submit")).click();

  await client.waitUntil(async () => {
    const field = await client.$("#beatgaler-login-identifier");
    return !(await field.isExisting());
  }, {
    timeout: 60_000,
    interval: 300,
    timeoutMsg: `Account ${account.label} did not leave the sign-in gate.`,
  });

  return Date.now() - startedAt;
}

async function browserCookiePresence(client) {
  const cookies = await client.getCookies();
  return {
    session_cookie: cookies.some(cookie => cookie.name === SESSION_COOKIE),
    csrf_cookie: cookies.some(cookie => cookie.name === CSRF_COOKIE),
  };
}

async function libraryAuthoritySnapshot(client) {
  return client.execute(() => {
    const library = document.querySelector('[data-library-scroll="true"]');
    const text = String(document.body?.innerText || "");
    const beatIds = Array.from(document.querySelectorAll("[data-beat-card-id]"))
      .map(node => String(node.getAttribute("data-beat-card-id") || "").trim())
      .filter(Boolean);
    return {
      present: Boolean(library),
      aria_busy: library?.getAttribute("aria-busy") ?? null,
      beat_ids: beatIds,
      beat_count: beatIds.length,
      empty_gallery: text.includes("Empty Gallery"),
      poor_connection: text.includes("Poor connection."),
      offline: text.includes("You're offline."),
      load_error: text.includes("Galer Cloud could not load your library"),
    };
  });
}

async function waitForAuthoritativeLibrary(client, label) {
  let latest = null;
  try {
    await client.waitUntil(async () => {
      latest = await libraryAuthoritySnapshot(client);
      const materialized = latest?.empty_gallery === true || Number(latest?.beat_count || 0) > 0;
      return latest?.present === true && latest?.aria_busy === "false" && materialized &&
        latest?.poor_connection !== true && latest?.offline !== true && latest?.load_error !== true;
    }, {
      timeout: 90_000,
      interval: 750,
      timeoutMsg: `Account ${label} did not reach an authoritative online library state.`,
    });
    return latest;
  } catch (error) {
    const detail = latest
      ? `busy=${latest.aria_busy} beats=${latest.beat_count} empty=${latest.empty_gallery} poor=${latest.poor_connection} offline=${latest.offline} load_error=${latest.load_error}`
      : "no library snapshot";
    throw taggedError(`Account ${label} authoritative library did not become ready (${detail}).`, "STAGE1_LIBRARY_AUTHORITY_TIMEOUT", "P1");
  }
}

async function runtimeSnapshot(client) {
  const snapshot = await client.execute(async () => {
    const apiBase = `${window.location.origin}/beatgaler-api`;
    const clientId = window.localStorage.getItem("beatgaler:web-client-id:v1") || "";
    const webSessionMarker = window.localStorage.getItem("beatgaler:web-session-present:v1") === "1";
    const csrfPresent = Boolean(window.sessionStorage.getItem("beatgaler:web-csrf:v1"));

    const postJson = async (route, body) => {
      try {
        const response = await window.fetch(`${apiBase}${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body || {}),
        });
        const payload = await response.json().catch(() => ({}));
        return { ok: response.ok, status: response.status, payload };
      } catch (error) {
        return { ok: false, status: 0, payload: { error: String(error?.message || error) } };
      }
    };

    const auth = await postJson("/auth/account", {});
    if (!auth.ok) {
      return {
        ok: false,
        phase: "auth/account",
        status: auth.status,
        error: String(auth.payload?.error || "auth/account failed"),
        client_id: clientId || null,
        web_session_marker: webSessionMarker,
        csrf_present: csrfPresent,
      };
    }

    if (!clientId) {
      return {
        ok: false,
        phase: "web-client-id",
        status: 0,
        error: "BeatGaler Web client id was not created.",
        user_id: String(auth.payload?.user?.id || ""),
        web_session_marker: webSessionMarker,
        csrf_present: csrfPresent,
      };
    }

    const direct = await postJson("/transport/session/start", {
      browserClientId: clientId,
      beatgalerUserId: clientId,
    });
    if (!direct.ok) {
      return {
        ok: false,
        phase: "transport/session/start",
        status: direct.status,
        error: String(direct.payload?.error || "transport/session/start failed"),
        user_id: String(auth.payload?.user?.id || ""),
        client_id: clientId,
        web_session_marker: webSessionMarker,
        csrf_present: csrfPresent,
      };
    }

    const payload = direct.payload || {};
    return {
      ok: true,
      user_id: String(auth.payload?.user?.id || ""),
      storage_ready: auth.payload?.user?.storage_ready === true,
      client_id: clientId,
      web_session_marker: webSessionMarker,
      csrf_present: csrfPresent,
      direct: {
        mode: String(payload.mode || ""),
        session_id: String(payload.session_id || ""),
        transport_id: String(payload.transport_id || ""),
        chat_id: String(payload.chat_id || ""),
        generation: Number(payload.generation || 0),
        credential_version: Number(payload.credential_version || 0),
        temp_auth_required: payload.temp_auth_required === true,
        expected_bot_id: String(payload.temp_auth?.expected_bot_id || ""),
      },
      visible_error: (() => {
        const text = String(document.body?.innerText || "");
        const known = [
          "Could not reach BeatGaler Cloud",
          "Session expired",
          "Poor connection",
          "Galer Cloud could not load your library",
        ].find(value => text.includes(value));
        return known || null;
      })(),
    };
  });

  const cookies = await browserCookiePresence(client);
  return { ...snapshot, cookies };
}

async function waitForRuntimeSnapshot(client, label) {
  let latest = null;
  await client.waitUntil(async () => {
    latest = await runtimeSnapshot(client);
    return latest?.ok === true;
  }, {
    timeout: 90_000,
    interval: 1_000,
    timeoutMsg: `Account ${label} did not establish authenticated Direct bootstrap. Last phase=${latest?.phase || "unknown"} status=${latest?.status || 0} error=${latest?.error || "unknown"}`,
  });
  return latest;
}

function validateSingleAccount(label, snapshot) {
  assert.equal(snapshot.ok, true, `Account ${label} runtime snapshot must be ready.`);
  assert.ok(snapshot.user_id, `Account ${label} must expose an authenticated user id.`);
  assert.ok(snapshot.client_id, `Account ${label} must have a Web client id.`);
  assert.equal(snapshot.web_session_marker, true, `Account ${label} must retain the Web session marker.`);
  assert.equal(snapshot.csrf_present, true, `Account ${label} must retain Web CSRF state.`);
  assert.equal(snapshot.cookies.session_cookie, true, `Account ${label} must have an HttpOnly browser session cookie.`);
  assert.equal(snapshot.cookies.csrf_cookie, true, `Account ${label} must have a CSRF cookie.`);
  assert.equal(snapshot.storage_ready, true, `Account ${label} storage must be provisioned.`);
  assert.equal(snapshot.direct.mode, "galer-direct-temp-mtproto", `Account ${label} must use productive Web Direct mode.`);
  assert.ok(snapshot.direct.chat_id, `Account ${label} must resolve a real vault chat id.`);
  assert.ok(snapshot.direct.transport_id, `Account ${label} must resolve a persistent transport bot.`);
  assert.equal(snapshot.direct.expected_bot_id, snapshot.direct.transport_id, `Account ${label} temporary auth must target its assigned transport bot.`);
}

function validateCrossAccountIsolation(a, b) {
  if (a.user_id === b.user_id) {
    throw taggedError("Both browser sessions authenticated as the same BeatGaler user.", "STAGE1_IDENTITY_COLLISION", "P0");
  }
  if (a.client_id === b.client_id) {
    throw taggedError("Both browser sessions reused the same Web installation id.", "STAGE1_BROWSER_ID_COLLISION", "P0");
  }
  if (a.direct.chat_id === b.direct.chat_id) {
    throw taggedError("Two independent BeatGaler accounts resolved the same vault.", "STAGE1_VAULT_COLLISION", "P0");
  }
}

function validatePersistentReload(before, after, label) {
  if (before.user_id !== after.user_id) {
    throw taggedError(`Account ${label} changed authenticated user after Reload.`, "STAGE1_RELOAD_IDENTITY_CHANGED", "P0");
  }
  if (before.client_id !== after.client_id) {
    throw taggedError(`Account ${label} changed Web installation id after Reload.`, "STAGE1_RELOAD_BROWSER_ID_CHANGED", "P1");
  }
  if (before.direct.chat_id !== after.direct.chat_id) {
    throw taggedError(`Account ${label} changed vault after Reload.`, "STAGE1_RELOAD_VAULT_CHANGED", "P0");
  }
  if (before.direct.transport_id !== after.direct.transport_id) {
    throw taggedError(`Account ${label} changed persistent transport bot after Reload.`, "STAGE1_RELOAD_TRANSPORT_CHANGED", "P1");
  }
}

describe("BeatGaler Stage 1 real multi-account Web E2E", () => {
  it("runs two isolated real accounts concurrently and preserves productive Direct authority across Reload", async () => {
    const missing = accounts.flatMap(account => [
      !account.identifier ? `STAGE1_ACCOUNT_${account.label}_IDENTIFIER` : null,
      !account.password ? `STAGE1_ACCOUNT_${account.label}_PASSWORD` : null,
    ]).filter(Boolean);

    if (missing.length) {
      report.overall = "BLOCKED";
      report.failure = { code: "STAGE1_CREDENTIALS_MISSING", severity: null, message: `Missing local variables: ${missing.join(", ")}` };
      await writeReport();
      throw taggedError("Stage 1 dedicated account credentials are missing from the local environment.", "STAGE1_CREDENTIALS_MISSING", null);
    }

    const clientA = browser.getInstance("accountA");
    const clientB = browser.getInstance("accountB");

    try {
      const [loginMsA, loginMsB] = await Promise.all([
        loginThroughUi(clientA, accounts[0]),
        loginThroughUi(clientB, accounts[1]),
      ]);

      const startupStartedAt = Date.now();
      const [libraryBeforeA, libraryBeforeB] = await Promise.all([
        waitForAuthoritativeLibrary(clientA, "A"),
        waitForAuthoritativeLibrary(clientB, "B"),
      ]);
      markScenario("authoritative_library_data_plane", "PASS");

      const [beforeA, beforeB] = await Promise.all([
        waitForRuntimeSnapshot(clientA, "A"),
        waitForRuntimeSnapshot(clientB, "B"),
      ]);
      const startupMs = Date.now() - startupStartedAt;

      validateSingleAccount("A", beforeA);
      validateSingleAccount("B", beforeB);
      validateCrossAccountIsolation(beforeA, beforeB);
      markScenario("two_account_auth_isolation", "PASS");
      markScenario("two_account_direct_identity", "PASS");

      const reloadStartedAt = Date.now();
      await Promise.all([clientA.refresh(), clientB.refresh()]);
      const [libraryAfterA, libraryAfterB] = await Promise.all([
        waitForAuthoritativeLibrary(clientA, "A"),
        waitForAuthoritativeLibrary(clientB, "B"),
      ]);
      const [afterA, afterB] = await Promise.all([
        waitForRuntimeSnapshot(clientA, "A"),
        waitForRuntimeSnapshot(clientB, "B"),
      ]);
      const reloadMs = Date.now() - reloadStartedAt;

      validateSingleAccount("A", afterA);
      validateSingleAccount("B", afterB);
      validateCrossAccountIsolation(afterA, afterB);
      validatePersistentReload(beforeA, afterA, "A");
      validatePersistentReload(beforeB, afterB, "B");
      markScenario("simultaneous_reload_persistent_assignment", "PASS");

      report.accounts = {
        A: {
          login_ms: loginMsA,
          user_id: beforeA.user_id,
          client_id: beforeA.client_id,
          vault_chat_id: beforeA.direct.chat_id,
          transport_id: beforeA.direct.transport_id,
          membership_bootstrap_mode: beforeA.direct.mode,
          session_id_before: beforeA.direct.session_id,
          session_id_after: afterA.direct.session_id,
          library_before: { beat_count: libraryBeforeA.beat_count, beat_ids: libraryBeforeA.beat_ids, empty_gallery: libraryBeforeA.empty_gallery },
          library_after: { beat_count: libraryAfterA.beat_count, beat_ids: libraryAfterA.beat_ids, empty_gallery: libraryAfterA.empty_gallery },
          visible_error_before: beforeA.visible_error,
          visible_error_after: afterA.visible_error,
        },
        B: {
          login_ms: loginMsB,
          user_id: beforeB.user_id,
          client_id: beforeB.client_id,
          vault_chat_id: beforeB.direct.chat_id,
          transport_id: beforeB.direct.transport_id,
          membership_bootstrap_mode: beforeB.direct.mode,
          session_id_before: beforeB.direct.session_id,
          session_id_after: afterB.direct.session_id,
          library_before: { beat_count: libraryBeforeB.beat_count, beat_ids: libraryBeforeB.beat_ids, empty_gallery: libraryBeforeB.empty_gallery },
          library_after: { beat_count: libraryAfterB.beat_count, beat_ids: libraryAfterB.beat_ids, empty_gallery: libraryAfterB.empty_gallery },
          visible_error_before: beforeB.visible_error,
          visible_error_after: afterB.visible_error,
        },
      };
      report.timings = { startup_ms: startupMs, simultaneous_reload_ms: reloadMs };
      report.overall = "PASS";
      report.severity = null;
      await writeReport();

      console.log(`[stage1-real] PASS two accounts isolated; authoritative library + reload preserved vault+transport. report=${REPORT_FILE}`);
    } catch (error) {
      const severity = error?.severity || "P1";
      report.overall = error?.code === "STAGE1_CREDENTIALS_MISSING" ? "BLOCKED" : "FAIL";
      report.severity = severity;
      report.failure = {
        code: String(error?.code || "STAGE1_E2E_FAILURE"),
        severity,
        message: String(error?.message || error),
      };
      if (scenario("two_account_auth_isolation")?.status === "NOT_TESTED") {
        markScenario("two_account_auth_isolation", report.overall === "BLOCKED" ? "BLOCKED" : "FAIL", severity);
      }
      if (error?.code === "STAGE1_LIBRARY_AUTHORITY_TIMEOUT") {
        markScenario("authoritative_library_data_plane", "FAIL", severity, error.message);
      }
      await writeReport();
      throw error;
    }
  });
});
