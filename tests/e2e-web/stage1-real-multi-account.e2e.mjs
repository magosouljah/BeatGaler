import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_DIR = path.resolve(process.cwd(), "tmp");
const REPORT_FILE = path.join(REPORT_DIR, "stage1-real-multi-account-report.json");
const SESSION_COOKIE = "__Host-beatgaler_session";
const CSRF_COOKIE = "__Host-beatgaler_csrf";
const cohortId = String(process.env.STAGE1_COHORT_ID || "").trim();
const cohortPassword = String(process.env.STAGE1_COHORT_PASSWORD || "").trim();
const accountCount = Math.max(2, Number(process.env.STAGE1_RUN_ACCOUNTS || 2));

const accounts = Array.from({ length: accountCount }, (_, index) => {
  const label = String(index + 1).padStart(2, "0");
  return {
    label,
    browserName: `account${label}`,
    identifier: `stage1.${cohortId}.${label}@beatgaler.test`,
    password: cohortPassword,
  };
});

const report = {
  version: 2,
  stage: "Etapa 1 — uso real entre cuentas independientes",
  baseline_sha: process.env.STAGE1_GIT_HEAD || null,
  cohort_id: cohortId || null,
  requested_account_count: accountCount,
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
    { name: "multi_account_auth_isolation", status: "NOT_TESTED", severity: null },
    { name: "authoritative_library_data_plane", status: "NOT_TESTED", severity: null },
    { name: "multi_account_direct_identity", status: "NOT_TESTED", severity: null },
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
    const field = await client.$("#auth-login-identifier");
    return field.isDisplayed().catch(() => false);
  }, {
    timeout: 30_000,
    interval: 250,
    timeoutMsg: `Account ${account.label} did not reach the current BeatGaler Web sign-in UI.`,
  });

  await (await client.$("#auth-login-identifier")).setValue(account.identifier);
  await (await client.$("#auth-login-password")).setValue(account.password);
  await (await client.$('.bg-auth-form button[type="submit"]')).click();

  await client.waitUntil(async () => {
    const field = await client.$("#auth-login-identifier");
    return !(await field.isExisting());
  }, {
    timeout: 60_000,
    interval: 300,
    timeoutMsg: `Account ${account.label} did not leave the current Web sign-in gate.`,
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
      timeout: 120_000,
      interval: 750,
      timeoutMsg: `Account ${label} did not reach an authoritative online library state.`,
    });
    return latest;
  } catch {
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
    timeout: 120_000,
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

function requireUnique(snapshots, selector, code, message) {
  const values = snapshots.map(selector);
  if (new Set(values).size !== values.length) throw taggedError(message, code, "P0");
}

function validateCrossAccountIsolation(snapshots) {
  requireUnique(
    snapshots,
    snapshot => snapshot.user_id,
    "STAGE1_IDENTITY_COLLISION",
    "Independent browser sessions authenticated as the same BeatGaler user.",
  );
  requireUnique(
    snapshots,
    snapshot => snapshot.client_id,
    "STAGE1_BROWSER_ID_COLLISION",
    "Independent browser sessions reused a Web installation id.",
  );
  requireUnique(
    snapshots,
    snapshot => snapshot.direct.chat_id,
    "STAGE1_VAULT_COLLISION",
    "Independent BeatGaler accounts resolved the same vault.",
  );
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
  it(`runs ${accountCount} seeded real accounts concurrently and preserves productive authority across Reload`, async () => {
    if (!cohortId || !cohortPassword) {
      report.overall = "BLOCKED";
      report.failure = { code: "STAGE1_COHORT_MISSING", severity: null, message: "Reusable Stage 1 cohort is not seeded." };
      await writeReport();
      throw taggedError("Stage 1 reusable account cohort is missing. Run the seed command first.", "STAGE1_COHORT_MISSING", null);
    }

    const clients = accounts.map(account => browser.getInstance(account.browserName));

    try {
      const loginTimes = await Promise.all(
        accounts.map((account, index) => loginThroughUi(clients[index], account)),
      );

      const startupStartedAt = Date.now();
      const librariesBefore = await Promise.all(
        accounts.map((account, index) => waitForAuthoritativeLibrary(clients[index], account.label)),
      );
      markScenario("authoritative_library_data_plane", "PASS", null, `${accountCount} authoritative libraries ready`);

      const before = await Promise.all(
        accounts.map((account, index) => waitForRuntimeSnapshot(clients[index], account.label)),
      );
      const startupMs = Date.now() - startupStartedAt;

      before.forEach((snapshot, index) => validateSingleAccount(accounts[index].label, snapshot));
      validateCrossAccountIsolation(before);
      markScenario("multi_account_auth_isolation", "PASS", null, `${accountCount} unique users/browser ids`);
      markScenario("multi_account_direct_identity", "PASS", null, `${accountCount} unique vaults`);

      const reloadStartedAt = Date.now();
      await Promise.all(clients.map(client => client.refresh()));
      const librariesAfter = await Promise.all(
        accounts.map((account, index) => waitForAuthoritativeLibrary(clients[index], account.label)),
      );
      const after = await Promise.all(
        accounts.map((account, index) => waitForRuntimeSnapshot(clients[index], account.label)),
      );
      const reloadMs = Date.now() - reloadStartedAt;

      after.forEach((snapshot, index) => validateSingleAccount(accounts[index].label, snapshot));
      validateCrossAccountIsolation(after);
      before.forEach((snapshot, index) => validatePersistentReload(snapshot, after[index], accounts[index].label));
      markScenario("simultaneous_reload_persistent_assignment", "PASS", null, `${accountCount} simultaneous reloads preserved assignment`);

      report.accounts = Object.fromEntries(accounts.map((account, index) => [account.label, {
        login_ms: loginTimes[index],
        user_id: before[index].user_id,
        client_id: before[index].client_id,
        vault_chat_id: before[index].direct.chat_id,
        transport_id: before[index].direct.transport_id,
        membership_bootstrap_mode: before[index].direct.mode,
        session_id_before: before[index].direct.session_id,
        session_id_after: after[index].direct.session_id,
        library_beats_before: librariesBefore[index].beat_count,
        library_beats_after: librariesAfter[index].beat_count,
        visible_error_before: before[index].visible_error,
        visible_error_after: after[index].visible_error,
      }]));
      report.timings = { startup_ms: startupMs, simultaneous_reload_ms: reloadMs };
      report.transport_distribution = Object.fromEntries(
        [...new Set(before.map(snapshot => snapshot.direct.transport_id))].map(transportId => [
          transportId,
          before.filter(snapshot => snapshot.direct.transport_id === transportId).length,
        ]),
      );
      report.overall = "PASS";
      report.severity = null;
      await writeReport();

      console.log(`[stage1-real] PASS accounts=${accountCount} isolated; reload preserved vault+transport. report=${REPORT_FILE}`);
    } catch (error) {
      const severity = error?.severity || "P1";
      report.overall = error?.code === "STAGE1_COHORT_MISSING" ? "BLOCKED" : "FAIL";
      report.severity = severity;
      report.failure = {
        code: String(error?.code || "STAGE1_E2E_FAILURE"),
        severity,
        message: String(error?.message || error),
      };
      for (const name of ["multi_account_auth_isolation", "authoritative_library_data_plane", "multi_account_direct_identity", "simultaneous_reload_persistent_assignment"]) {
        if (scenario(name)?.status === "NOT_TESTED") markScenario(name, report.overall === "BLOCKED" ? "BLOCKED" : "FAIL", severity);
      }
      await writeReport();
      throw error;
    }
  });
});
