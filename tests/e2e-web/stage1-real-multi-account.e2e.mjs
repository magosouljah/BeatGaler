import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { observeAuth } from "./stage1-auth-observer.mjs";
import { validateAuthHealth } from "./stage1-health-validation.mjs";
import { sha256Hex, stripMp3ContainerTags } from "./stage1-download-integrity.mjs";

const authObservers = new Map();

const REPORT_DIR = path.resolve(process.cwd(), "tmp");
const REPORT_FILE = path.join(REPORT_DIR, "stage1-real-multi-account-report.json");
const SESSION_COOKIE = "__Host-beatgaler_session";
const CSRF_COOKIE = "__Host-beatgaler_csrf";
const cohortId = String(process.env.STAGE1_COHORT_ID || "").trim();
const cohortPassword = String(process.env.STAGE1_COHORT_PASSWORD || "").trim();
const accountCount = Math.max(1, Number(process.env.STAGE1_RUN_ACCOUNTS || 2));
const singleAccountDiagnostic = accountCount === 1;
const mixedWorkload = process.env.STAGE1_MIXED_WORKLOAD === "1";
const focusedLifecycle = process.env.STAGE1_FOCUSED_LIFECYCLE === "1";
const focusedDownloadIntegrity = process.env.STAGE1_FOCUSED_DOWNLOAD_INTEGRITY === "1";
const focusedIsolation = process.env.STAGE1_FOCUSED_ISOLATION === "1";
const soakMinutes = Math.max(0, Number(process.env.STAGE1_SOAK_MINUTES || 0));
const soakMode = mixedWorkload && soakMinutes > 0;
const MIXED_REQUIRED_ACCOUNTS = 7;
const MIXED_RUN_SUFFIX = String(Date.now());
const SOAK_ROTATIONS = Math.max(
  1,
  Math.min(
    MIXED_REQUIRED_ACCOUNTS,
    Number(process.env.STAGE1_SOAK_ROTATIONS || MIXED_REQUIRED_ACCOUNTS),
  ),
);
const diagnosticSoakRound = soakMode && SOAK_ROTATIONS < MIXED_REQUIRED_ACCOUNTS;
const SOAK_FIRST_AUDIO_BUDGET_MS = 2_000;
const SOAK_HOT_LIBRARY_BUDGET_MS = 5_000;
const SOAK_LARGE_WAV_MB = Math.max(8, Math.min(256, Number(process.env.STAGE1_SOAK_LARGE_WAV_MB || 64)));
const PLAYBACK_FIXTURE_FILE = path.resolve(process.cwd(), "tests", "e2e-web", "fixtures", "stage1-playback.mp3");
const PLAYBACK_TMP_DIR = path.resolve(process.cwd(), "tmp", "stage1-playback-fixtures");
const DOWNLOAD_INTEGRITY_TMP_DIR = path.resolve(process.cwd(), "tmp", "stage1-download-integrity-fixtures");
const PLAYBACK_MIN_PROGRESS_SECONDS = 0.5;
const PLAYBACK_SOFT_START_SPREAD_MS = 2_000;

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
  version: 9,
  stage: "Etapa 1 — uso real entre cuentas independientes",
  workload_mode: focusedIsolation
  ? "focused-two-account-offensive-isolation"
  : focusedDownloadIntegrity
    ? "focused-single-account-download-integrity"
    : focusedLifecycle
      ? "focused-single-account-lifecycle"
      : soakMode
      ? diagnosticSoakRound
        ? "mixed-7-account-diagnostic-soak"
        : "mixed-7-account-30m-soak"
      : mixedWorkload
        ? "mixed-7-account"
        : "full-lifecycle",
  baseline_sha: process.env.STAGE1_GIT_HEAD || null,
  cohort_id: cohortId || null,
  requested_account_count: accountCount,
  web_server_mode: process.env.STAGE1_WEB_PREVIEW === "1" ? "vite-preview" : "vite-dev",
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
    productive_fixture_upload: true,
    concurrent_playback: !singleAccountDiagnostic,
  },
  simulated: [],
  accounts: {},
  scenarios: [
    { name: "auth_health_stability", status: "NOT_TESTED", severity: null },
    { name: "multi_account_auth_isolation", status: "NOT_TESTED", severity: null },
    { name: "authoritative_library_data_plane", status: "NOT_TESTED", severity: null },
    { name: "multi_account_direct_identity", status: "NOT_TESTED", severity: null },
    { name: "playback_fixture_provisioning", status: "NOT_TESTED", severity: null },
    ...(focusedIsolation
      ? [
          { name: "offensive_installation_isolation", status: "NOT_TESTED", severity: null },
          { name: "offensive_session_isolation", status: "NOT_TESTED", severity: null },
          { name: "offensive_capability_isolation", status: "NOT_TESTED", severity: null },
          { name: "offensive_media_reference_isolation", status: "NOT_TESTED", severity: null },
          { name: "same_profile_account_switch_isolation", status: "NOT_TESTED", severity: null },
          { name: "final_authoritative_isolation", status: "NOT_TESTED", severity: null },
        ]
      : focusedDownloadIntegrity
      ? [
          { name: "focused_download_wav_integrity", status: "NOT_TESTED", severity: null, evidence_status: "PENDIENTE POR INFRAESTRUCTURA" },
          { name: "focused_download_project_integrity", status: "NOT_TESTED", severity: null, evidence_status: "PENDIENTE POR INFRAESTRUCTURA" },
          { name: "focused_download_mp3_audio_integrity", status: "NOT_TESTED", severity: null, evidence_status: "PENDIENTE POR INFRAESTRUCTURA" },
          { name: "focused_download_mp3_id3_integrity", status: "NOT_TESTED", severity: null, evidence_status: "PENDIENTE POR INFRAESTRUCTURA" },
        ]
      : mixedWorkload
      ? [
          { name: "mixed_workload_concurrency", status: "NOT_TESTED", severity: null },
          { name: "mixed_playback", status: "NOT_TESTED", severity: null },
          { name: "mixed_upload", status: "NOT_TESTED", severity: null },
          { name: "mixed_metadata_edit", status: "NOT_TESTED", severity: null },
          { name: "mixed_master_download", status: "NOT_TESTED", severity: null },
          { name: "mixed_reload_persistence", status: "NOT_TESTED", severity: null },
          { name: "mixed_post_workload_isolation", status: "NOT_TESTED", severity: null },
          ...(soakMode
            ? [
                { name: "mixed_soak_duration", status: "NOT_TESTED", severity: null },
                { name: "mixed_role_rotation", status: "NOT_TESTED", severity: null },
                { name: "mixed_large_transfer", status: "NOT_TESTED", severity: null },
                { name: "mixed_hot_library_budget", status: "NOT_TESTED", severity: null },
                { name: "mixed_first_audio_budget", status: "NOT_TESTED", severity: null },
              ]
            : []),
        ]
        : focusedLifecycle
          ? [
              { name: "focused_seek", status: "NOT_TESTED", severity: null },
              { name: "focused_logout_relogin_authoritative", status: "NOT_TESTED", severity: null },
            ]
          : [
            { name: "simultaneous_reload_persistent_assignment", status: "NOT_TESTED", severity: null },
            { name: "playback_concurrency", status: "NOT_TESTED", severity: null },
            { name: "metadata_edit_persistence", status: "NOT_TESTED", severity: null },
            { name: "master_download", status: "NOT_TESTED", severity: null },
            { name: "remove_from_library_persistence", status: "NOT_TESTED", severity: null },
            { name: "trash_visibility_persistence", status: "NOT_TESTED", severity: null },
            { name: "trash_purge_persistence", status: "NOT_TESTED", severity: null },
          ]),
  ],
  failure: null,
};

if (focusedDownloadIntegrity || focusedIsolation) {
  const focusedScenarios = new Set([
    "auth_health_stability",
    "authoritative_library_data_plane",
    ...(focusedIsolation
      ? [
          "offensive_installation_isolation",
          "offensive_session_isolation",
          "offensive_capability_isolation",
          "offensive_media_reference_isolation",
          "same_profile_account_switch_isolation",
          "final_authoritative_isolation",
        ]
      : [
          "focused_download_wav_integrity",
          "focused_download_project_integrity",
          "focused_download_mp3_audio_integrity",
          "focused_download_mp3_id3_integrity",
        ]),
  ]);
  report.scenarios = report.scenarios.filter(item => focusedScenarios.has(item.name));
}

function scenario(name) {
  return report.scenarios.find(item => item.name === name);
}

function markScenario(name, status, severity = null, detail = null) {
  const item = scenario(name);
  if (!item) return;
  item.status = status;
  item.severity = severity;
  if (status === "PASS") item.evidence_status = "COMPROBADO";
  if (status === "FAIL") item.evidence_status = "FALLÓ";
  if (status === "BLOCKED") item.evidence_status = "PENDIENTE POR INFRAESTRUCTURA";
  if (detail) item.detail = detail;
}

const singleAccountSkippedScenarios = new Set([
  "multi_account_auth_isolation",
  "multi_account_direct_identity",
  "playback_concurrency",
]);

if (singleAccountDiagnostic) {
  for (const name of singleAccountSkippedScenarios) {
    markScenario(name, "SKIPPED", null, "Single-account diagnostic mode; multi-account evidence is intentionally not evaluated.");
  }
}

async function writeReport() {
  for (const [label, observer] of authObservers) {
    report.accounts[label] ||= {};
    report.accounts[label].auth_network = observer.snapshot();
  }
  report.finished_at = new Date().toISOString();
  await fs.mkdir(REPORT_DIR, { recursive: true });
  await fs.writeFile(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function archiveFocusedDownloadIntegrityReport() {
  if (!focusedDownloadIntegrity) return null;
  const shortSha = String(report.baseline_sha || "unknown").slice(0, 8);
  const archive = path.join(REPORT_DIR, `stage1-download-integrity-${shortSha}.json`);
  await fs.writeFile(archive, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return archive;
}

function taggedError(message, code, severity = "P1") {
  return Object.assign(new Error(message), { code, severity });
}

async function clearBrowserProfile(client, observer) {
  observer.setPhase("initial-navigation");
  await client.url("/");
  await client.deleteCookies();
  await client.execute(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  observer.setPhase("profile-reset-refresh");
  await client.refresh();
}

async function loginThroughUi(
  client,
  account,
  { resetProfile = true, reuseObserver = false } = {},
) {
  const startedAt = Date.now();
  let phase = "installing-auth-observer";
  let observer = reuseObserver ? authObservers.get(account.label) : null;
  const setPhase = value => { phase = value; observer?.setPhase(value); };
  let failure = null;

  try {
    if (!observer) {
      observer = await observeAuth(client);
      authObservers.set(account.label, observer);
    }

    if (resetProfile) {
      setPhase("profile-reset");
      await clearBrowserProfile(client, observer);
    } else {
      setPhase("relogin-existing-profile");
    }

    setPhase("waiting-for-sign-in");

    await client.waitUntil(async () => {
      const field = await client.$("#auth-login-identifier");
      return field.isDisplayed().catch(() => false);
    }, {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: `Account ${account.label} did not reach the current BeatGaler Web sign-in UI.`,
    });

    setPhase("filling-sign-in");
    await (await client.$("#auth-login-identifier")).setValue(account.identifier);
    await (await client.$("#auth-login-password")).setValue(account.password);

    setPhase("submitting-sign-in");
    await (await client.$('.bg-auth-form button[type="submit"]')).click();

    setPhase("waiting-for-login-result");

    await client.waitUntil(async () => {
      const field = await client.$("#auth-login-identifier");
      const alert = await client.$('[role="alert"]');
      const mfa = await client.$("#auth-login-mfa");

      return (
        !(await field.isExisting()) ||
        await alert.isDisplayed().catch(() => false) ||
        await mfa.isExisting()
      );
    }, {
      timeout: 60_000,
      interval: 300,
      timeoutMsg: `Account ${account.label} did not leave the current Web sign-in gate.`,
    });
  } catch {
    // WebDriver errors can contain command arguments. Do not serialize them.
    failure = phase;
  }

  let diagnostic;

  try {
    diagnostic = await client.execute(() => {
      const visible = node => Boolean(node && node.getClientRects().length);
      const form = document.querySelector(".bg-auth-form");
      const submit = form?.querySelector('button[type="submit"]');
      const mfa = visible(
        document.querySelector(
          '#auth-login-mfa, #beatgaler-login-mfa, input[autocomplete="one-time-code"]',
        ),
      );
      const login = visible(document.querySelector("#auth-login-identifier"));

      return {
        form_present: Boolean(form),
        login_present: login,
        mfa_present: mfa,
        visible_phase: mfa ? "mfa" : login ? "login" : form ? "other-auth" : "outside-sign-in",
        alerts: Array.from(document.querySelectorAll('[role="alert"]'))
          .filter(visible)
          .map(node => node.textContent || ""),
        submit_disabled: submit ? submit.disabled : null,
        submit_busy: submit?.getAttribute("aria-busy") || null,
        url: location.origin + location.pathname,
        client_id: localStorage.getItem("beatgaler:web-client-id:v1"),
      };
    });

    diagnostic.alerts = diagnostic.alerts
      .map(value => String(value)
        .split(account.password).join("[REDACTED]")
        .replace(/\b[A-Za-z0-9_+\/-]{32,}={0,2}\b/g, "[REDACTED]")
        .slice(0, 600));
  } catch {
    diagnostic = { observation_unavailable: true };
  }

  diagnostic = {
    label: account.label,
    duration_ms: Date.now() - startedAt,
    harness_phase: phase,
    ...diagnostic,
    http: observer?.snapshot() || [],
  };

  const failed =
    failure ||
    diagnostic.observation_unavailable ||
    diagnostic.form_present ||
    diagnostic.mfa_present;

  diagnostic.outcome = failed ? "FAIL" : "PASS";
  report.accounts[account.label] = { login: diagnostic };

  if (failed) {
    const http = diagnostic.http?.findLast(
      entry => entry.route === "/beatgaler-api/auth/login",
    );
    const health = diagnostic.http?.findLast(
      entry => entry.route === "/beatgaler-api/auth/health",
    );

    const detail =
      diagnostic.alerts?.join("; ") ||
      (
        diagnostic.mfa_present
          ? "MFA required"
          : `phase=${diagnostic.visible_phase || phase}; submit_disabled=${diagnostic.submit_disabled}; request=${http?.state || "not-observed"}`
      );

    throw taggedError(
      `Account ${account.label} login remained gated (HTTP ${http?.status ?? "not-observed"}; health=${health?.status ?? health?.state ?? "not-observed"}): ${detail}`,
      "STAGE1_LOGIN_FAILED",
    );
  }

  return diagnostic.duration_ms;
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

      const materialized =
        latest?.empty_gallery === true ||
        Number(latest?.beat_count || 0) > 0;

      return (
        latest?.present === true &&
        latest?.aria_busy === "false" &&
        materialized &&
        latest?.poor_connection !== true &&
        latest?.offline !== true &&
        latest?.load_error !== true
      );
    }, {
      timeout: 120_000,
      interval: 750,
      timeoutMsg: `Account ${label} did not reach an authoritative online library state.`,
    });

    return latest;
  } catch {
    const diagnostic = await client.execute(() => {
      const library = document.querySelector('[data-library-scroll="true"]');
      const cards = Array.from(document.querySelectorAll("[data-beat-card-id]"));
      return {
        aria_busy: library?.getAttribute("aria-busy") ?? null,
        card_count: cards.length,
        playback_disabled: cards.map(card => ({
          beat_id: String(card.getAttribute("data-beat-card-id") || ""),
          aria_disabled: card.querySelector("[data-beat-artwork-id]")?.getAttribute("aria-disabled") ?? null,
        })),
        relevant_console: Array.isArray(window.__stage1DiagnosticLogs)
          ? window.__stage1DiagnosticLogs.slice(-40)
          : [],
      };
    }).catch(() => ({ unavailable: true }));

    report.accounts[label] ||= {};
    report.accounts[label].library_authority_failure = {
      snapshot: latest,
      diagnostic,
    };

    const detail = latest
      ? `busy=${latest.aria_busy} beats=${latest.beat_count} empty=${latest.empty_gallery} poor=${latest.poor_connection} offline=${latest.offline} load_error=${latest.load_error}`
      : "no library snapshot";

    throw taggedError(
      `Account ${label} authoritative library did not become ready (${detail}).`,
      "STAGE1_LIBRARY_AUTHORITY_TIMEOUT",
      "P1",
    );
  }
}

async function runtimeSnapshot(client, label) {
  const snapshot = await client.execute(async () => {
    const apiBase = `${window.location.origin}/beatgaler-api`;
    const clientId =
      window.localStorage.getItem("beatgaler:web-client-id:v1") || "";
    const webSessionMarker =
      window.localStorage.getItem("beatgaler:web-session-present:v1") === "1";
    const csrfPresent = Boolean(
      window.sessionStorage.getItem("beatgaler:web-csrf:v1"),
    );

    const postJson = async (route, body) => {
      try {
        const response = await window.fetch(`${apiBase}${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body || {}),
        });

        const payload = await response.json().catch(() => ({}));

        return {
          ok: response.ok,
          status: response.status,
          payload,
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          payload: {
            error: String(error?.message || error),
          },
        };
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

    return {
      ok: true,
      user_id: String(auth.payload?.user?.id || ""),
      storage_ready: auth.payload?.user?.storage_ready === true,
      client_id: clientId,
      web_session_marker: webSessionMarker,
      csrf_present: csrfPresent,
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

  if (!snapshot.ok) {
    const cookies = await browserCookiePresence(client);
    return {
      ...snapshot,
      cookies,
    };
  }

  const observer = authObservers.get(label);

  const observedTransport = observer
    ?.snapshot()
    .findLast(entry =>
      entry.route === "/beatgaler-api/transport/session/start" &&
      entry.state === "response" &&
      entry.status >= 200 &&
      entry.status < 300 &&
      entry.transport
    )
    ?.transport;

  const cookies = await browserCookiePresence(client);

  if (!observedTransport) {
    return {
      ...snapshot,
      cookies,
      ok: false,
      phase: "observed-transport-session",
      status: 0,
      error: "The application has not established its Direct session yet.",
    };
  }

  return {
    ...snapshot,
    cookies,
    direct: observedTransport,
  };
}

async function waitForRuntimeSnapshot(client, label) {
  let latest = null;

  await client.waitUntil(async () => {
    latest = await runtimeSnapshot(client, label);
    return latest?.ok === true;
  }, {
    timeout: 120_000,
    interval: 1_000,
    timeoutMsg:
      `Account ${label} did not establish authenticated Direct bootstrap. Last phase=${latest?.phase || "unknown"} status=${latest?.status || 0} error=${latest?.error || "unknown"}`,
  });

  return latest;
}

function validateSingleAccount(label, snapshot) {
  assert.equal(
    snapshot.ok,
    true,
    `Account ${label} runtime snapshot must be ready.`,
  );

  assert.ok(
    snapshot.user_id,
    `Account ${label} must expose an authenticated user id.`,
  );

  assert.ok(
    snapshot.client_id,
    `Account ${label} must have a Web client id.`,
  );

  assert.equal(
    snapshot.web_session_marker,
    true,
    `Account ${label} must retain the Web session marker.`,
  );

  assert.equal(
    snapshot.csrf_present,
    true,
    `Account ${label} must retain Web CSRF state.`,
  );

  assert.equal(
    snapshot.cookies.session_cookie,
    true,
    `Account ${label} must have an HttpOnly browser session cookie.`,
  );

  assert.equal(
    snapshot.cookies.csrf_cookie,
    true,
    `Account ${label} must have a CSRF cookie.`,
  );

  assert.equal(
    snapshot.storage_ready,
    true,
    `Account ${label} storage must be provisioned.`,
  );

  assert.equal(
    snapshot.direct.mode,
    "galer-direct-temp-mtproto",
    `Account ${label} must use productive Web Direct mode.`,
  );

  assert.ok(
    snapshot.direct.chat_id,
    `Account ${label} must resolve a real vault chat id.`,
  );

  assert.ok(
    snapshot.direct.transport_id,
    `Account ${label} must resolve a persistent transport bot.`,
  );

  assert.ok(
    snapshot.direct.transport_user_id,
    `Account ${label} must expose the assigned transport bot user id.`,
  );

  assert.equal(
    snapshot.direct.expected_bot_id,
    snapshot.direct.transport_user_id,
    `Account ${label} temporary auth must target its assigned transport bot user identity.`,
  );
}

function requireUnique(snapshots, selector, code, message) {
  const values = snapshots.map(selector);

  if (new Set(values).size !== values.length) {
    throw taggedError(message, code, "P0");
  }
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
    throw taggedError(
      `Account ${label} changed authenticated user after Reload.`,
      "STAGE1_RELOAD_IDENTITY_CHANGED",
      "P0",
    );
  }

  if (before.client_id !== after.client_id) {
    throw taggedError(
      `Account ${label} changed Web installation id after Reload.`,
      "STAGE1_RELOAD_BROWSER_ID_CHANGED",
      "P1",
    );
  }

  if (before.direct.chat_id !== after.direct.chat_id) {
    throw taggedError(
      `Account ${label} changed vault after Reload.`,
      "STAGE1_RELOAD_VAULT_CHANGED",
      "P0",
    );
  }

  if (before.direct.transport_id !== after.direct.transport_id) {
    throw taggedError(
      `Account ${label} changed persistent transport bot after Reload.`,
      "STAGE1_RELOAD_TRANSPORT_CHANGED",
      "P1",
    );
  }
}


function playbackBeatName(account) {
  return `Stage1 Playback ${account.label}`;
}

async function playbackBeatSnapshot(client, beatName) {
  return client.execute(name => {
    const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
    const cards = Array.from(document.querySelectorAll("[data-beat-card-id]"));
    const card = cards.find(candidate => Array.from(candidate.querySelectorAll("*"))
      .some(node => node.children.length === 0 && normalize(node.textContent) === name));
    if (!card) return null;
    const beatId = String(card.getAttribute("data-beat-card-id") || "").trim();
    const artwork = card.querySelector("[data-beat-artwork-id]");
    const cloudCommitted = Boolean(
      card.querySelector('[aria-label="Cloud only"], [aria-label="Synced to Galer Cloud"]'),
    );
    return {
      beat_id: beatId,
      playback_disabled: artwork?.getAttribute("aria-disabled") === "true",
      cloud_committed: cloudCommitted,
    };
  }, beatName);
}

async function waitForPlaybackBeat(client, account, timeout = 120_000) {
  const beatName = playbackBeatName(account);
  let latest = null;
  await client.waitUntil(async () => {
    latest = await playbackBeatSnapshot(client, beatName);
    return Boolean(latest?.beat_id);
  }, { timeout, interval: 500, timeoutMsg: `Account ${account.label} did not materialize ${beatName}.` });
  return { ...latest, beat_name: beatName };
}

async function waitForPlaybackBeatCommitted(client, account, timeout = 120_000) {
  const beatName = playbackBeatName(account);
  let latest = null;
  await client.waitUntil(async () => {
    latest = await playbackBeatSnapshot(client, beatName);
    return Boolean(latest?.beat_id && latest?.cloud_committed === true);
  }, {
    timeout,
    interval: 500,
    timeoutMsg: `Account ${account.label} did not commit ${beatName} to the authoritative Cloud library.`,
  });
  return { ...latest, beat_name: beatName };
}

async function provisionPlaybackBeat(client, account) {
  const existing = await playbackBeatSnapshot(client, playbackBeatName(account));
  if (existing?.beat_id) {
    const committed = existing.cloud_committed
      ? existing
      : await waitForPlaybackBeatCommitted(client, account);
    return { ...committed, beat_name: playbackBeatName(account), created: false };
  }

  await fs.mkdir(PLAYBACK_TMP_DIR, { recursive: true });
  const localFixture = path.join(PLAYBACK_TMP_DIR, `${playbackBeatName(account)}.mp3`);
  await fs.copyFile(PLAYBACK_FIXTURE_FILE, localFixture);

  const addButton = await client.$('//button[normalize-space(.)="Add beat"]');
  await addButton.waitForDisplayed({ timeout: 30_000 });
  await addButton.click();

  const chooseButton = await client.$('//button[contains(normalize-space(.), "Choose MP3 or WAV")]');
  await chooseButton.waitForDisplayed({ timeout: 30_000 });

  await client.execute(() => {
    if (window.__beatgalerStage1OriginalFileInputClick) return;
    window.__beatgalerStage1OriginalFileInputClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function patchedStage1FileInputClick(...args) {
      if (this.type === "file") return;
      return window.__beatgalerStage1OriginalFileInputClick.apply(this, args);
    };
  });

  await chooseButton.click();

  const input = await client.$('input[type="file"][accept*=".mp3"]');
  await input.waitForExist({ timeout: 30_000 });
  await client.execute(element => {
    const original = window.__beatgalerStage1OriginalFileInputClick;
    if (original) {
      HTMLInputElement.prototype.click = original;
      delete window.__beatgalerStage1OriginalFileInputClick;
    }

    element.style.display = "block";
    element.style.position = "fixed";
    element.style.left = "8px";
    element.style.top = "8px";
    element.style.width = "240px";
    element.style.height = "40px";
    element.style.opacity = "0.01";
    element.style.zIndex = "2147483647";
    element.style.pointerEvents = "auto";
  }, input);

  const remoteFixture = await client.uploadFile(localFixture);
  await input.setValue(remoteFixture);

  const saveButton = await client.$('//button[starts-with(normalize-space(.), "Save")]');
  await saveButton.waitForDisplayed({ timeout: 30_000 });
  await saveButton.waitForEnabled({ timeout: 30_000 });
  await saveButton.click();

  const saved = await waitForPlaybackBeatCommitted(client, account);
  return { ...saved, created: true };
}


function mixedUploadBeatName(account) {
  return `Stage1 Mixed Upload ${account.label} ${MIXED_RUN_SUFFIX}`;
}

async function waitForNamedBeatCommitted(client, account, beatName, timeout = 120_000) {
  let latest = null;
  await client.waitUntil(async () => {
    latest = await playbackBeatSnapshot(client, beatName);
    return Boolean(latest?.beat_id && latest?.cloud_committed === true);
  }, {
    timeout,
    interval: 500,
    timeoutMsg: `Account ${account.label} did not commit ${beatName} to the authoritative Cloud library.`,
  });
  return { ...latest, beat_name: beatName };
}

async function uploadNamedMp3Fixture(client, account, beatName, options = {}) {
  const existing = await playbackBeatSnapshot(client, beatName);
  if (existing?.beat_id) {
    throw taggedError(
      `Account ${account.label} mixed-workload fixture already exists unexpectedly.`,
      "STAGE1_MIXED_UPLOAD_NAME_COLLISION",
      "P1",
    );
  }

  await fs.mkdir(PLAYBACK_TMP_DIR, { recursive: true });
  const extension = options.extension === ".wav" ? ".wav" : ".mp3";
  const localFixture = options.localFixture || path.join(PLAYBACK_TMP_DIR, `${beatName}${extension}`);
  if (!options.localFixture) {
    await fs.copyFile(PLAYBACK_FIXTURE_FILE, localFixture);
  }

  const addButton = await client.$('//button[normalize-space(.)="Add beat"]');
  await addButton.waitForDisplayed({ timeout: 30_000 });
  await addButton.click();

  const chooseButton = await client.$('//button[contains(normalize-space(.), "Choose MP3 or WAV")]');
  await chooseButton.waitForDisplayed({ timeout: 30_000 });

  await client.execute(() => {
    if (window.__beatgalerStage1OriginalFileInputClick) return;
    window.__beatgalerStage1OriginalFileInputClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function patchedStage1FileInputClick(...args) {
      if (this.type === "file") return;
      return window.__beatgalerStage1OriginalFileInputClick.apply(this, args);
    };
  });

  await chooseButton.click();

  const input = await client.$('input[type="file"][accept*=".mp3"]');
  await input.waitForExist({ timeout: 30_000 });
  await client.execute(element => {
    const original = window.__beatgalerStage1OriginalFileInputClick;
    if (original) {
      HTMLInputElement.prototype.click = original;
      delete window.__beatgalerStage1OriginalFileInputClick;
    }

    element.style.display = "block";
    element.style.position = "fixed";
    element.style.left = "8px";
    element.style.top = "8px";
    element.style.width = "240px";
    element.style.height = "40px";
    element.style.opacity = "0.01";
    element.style.zIndex = "2147483647";
    element.style.pointerEvents = "auto";
  }, input);

  const remoteFixture = await client.uploadFile(localFixture);
  await input.setValue(remoteFixture);

  if (options.reviewIntegrity) {
    await configureDownloadIntegrityReview(client, options.reviewIntegrity);
  }

  const saveButton = await client.$('//button[starts-with(normalize-space(.), "Save")]');
  await saveButton.waitForDisplayed({ timeout: 30_000 });
  await saveButton.waitForEnabled({ timeout: 30_000 });
  await saveButton.click();

  const saved = await waitForNamedBeatCommitted(
    client,
    account,
    beatName,
    Math.max(120_000, Number(options.commitTimeoutMs || 0)),
  );
  const stat = await fs.stat(localFixture);
  return {
    ...saved,
    created: true,
    source_extension: extension,
    source_bytes: stat.size,
  };
}

async function createSoakLargeWavFixture(beatName) {
  await fs.mkdir(PLAYBACK_TMP_DIR, { recursive: true });
  const file = path.join(PLAYBACK_TMP_DIR, `${beatName}.wav`);
  const sampleRate = 44_100;
  const channels = 2;
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const targetBytes = Math.floor(SOAK_LARGE_WAV_MB * 1024 * 1024);
  const dataBytes = Math.max(
    blockAlign,
    Math.floor((targetBytes - 44) / blockAlign) * blockAlign,
  );
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, 4, "ascii");
  header.write("fmt ", 12, 4, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, 4, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  await fs.writeFile(file, header);
  await fs.truncate(file, 44 + dataBytes);
  return {
    file,
    bytes: 44 + dataBytes,
    mb: (44 + dataBytes) / (1024 * 1024),
  };
}

function downloadIntegrityBeatName(account) {
  return `Stage1 Download Integrity ${account.label} ${MIXED_RUN_SUFFIX}`;
}

async function createDownloadIntegrityFixtures(account) {
  const beatName = downloadIntegrityBeatName(account);
  await fs.mkdir(DOWNLOAD_INTEGRITY_TMP_DIR, { recursive: true });
  const mp3 = path.join(DOWNLOAD_INTEGRITY_TMP_DIR, `${beatName}.mp3`);
  const wav = path.join(DOWNLOAD_INTEGRITY_TMP_DIR, `${beatName}.wav`);
  const project = path.join(DOWNLOAD_INTEGRITY_TMP_DIR, `${beatName}.zip`);
  await fs.copyFile(PLAYBACK_FIXTURE_FILE, mp3);

  // 1.25 MiB PCM WAV: valid, deterministic and deliberately much smaller than the soak fixture.
  const sampleRate = 44_100;
  const channels = 2;
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const dataBytes = Math.floor(((1.25 * 1024 * 1024) - 44) / blockAlign) * blockAlign;
  const wavBytes = Buffer.alloc(44 + dataBytes);
  wavBytes.write("RIFF", 0, 4, "ascii");
  wavBytes.writeUInt32LE(36 + dataBytes, 4);
  wavBytes.write("WAVEfmt ", 8, 8, "ascii");
  wavBytes.writeUInt32LE(16, 16);
  wavBytes.writeUInt16LE(1, 20);
  wavBytes.writeUInt16LE(channels, 22);
  wavBytes.writeUInt32LE(sampleRate, 24);
  wavBytes.writeUInt32LE(sampleRate * blockAlign, 28);
  wavBytes.writeUInt16LE(blockAlign, 32);
  wavBytes.writeUInt16LE(bitsPerSample, 34);
  wavBytes.write("data", 36, 4, "ascii");
  wavBytes.writeUInt32LE(dataBytes, 40);
  let state = 0x51a7c0de;
  for (let offset = 44; offset < wavBytes.length; offset += 2) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    wavBytes.writeInt16LE((state >>> 16) - 32768, offset);
  }
  await fs.writeFile(wav, wavBytes);

  const archive = new JSZip();
  const zipDate = new Date("2024-01-01T00:00:00.000Z");
  archive.file("project.flp", Buffer.from("BeatGaler deterministic FLP fixture\n", "utf8"), { date: zipDate, compression: "DEFLATE" });
  archive.file("Audio/reference.txt", "reference audio: integrity fixture\n", { date: zipDate, compression: "DEFLATE" });
  archive.file("Samples/sample.txt", "sample: byte-for-byte project verification\n", { date: zipDate, compression: "DEFLATE" });
  await fs.writeFile(project, await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 }, platform: "DOS" }));

  const [mp3Bytes, wavSource, projectSource] = await Promise.all([fs.readFile(mp3), fs.readFile(wav), fs.readFile(project)]);
  const mp3Audio = stripMp3ContainerTags(mp3Bytes);
  return {
    beat_name: beatName,
    files: { mp3, wav, project },
    source: {
      mp3: { bytes: mp3Bytes.byteLength, audio_bytes: mp3Audio.bytes.byteLength, audio_sha256: sha256Hex(mp3Audio.bytes), id3v2_bytes_removed: mp3Audio.prefixBytesRemoved, id3v1_bytes_removed: mp3Audio.suffixBytesRemoved },
      wav: { bytes: wavSource.byteLength, sha256: sha256Hex(wavSource) },
      project: { bytes: projectSource.byteLength, sha256: sha256Hex(projectSource) },
    },
    expected_metadata: { name: beatName, bpm: "128", key: "c#m", tags: ["integrity-fixture-alpha", "integrity-fixture-beta"] },
  };
}

async function setControlledInputValue(client, element, value) {
  await client.execute((input, nextValue) => {
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    descriptor?.set?.call(input, nextValue);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: nextValue }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, element, value);
}

async function attachReviewSlotFile(client, kind, localFile) {
  const button = await client.$(`//button[normalize-space(.)="+ ${kind}"]`);
  await button.waitForDisplayed({ timeout: 30_000 });
  await client.execute(() => {
    if (window.__beatgalerStage1OriginalFileInputClick) return;
    window.__beatgalerStage1OriginalFileInputClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function stage1PreventNativePicker(...args) {
      if (this.type === "file") return;
      return window.__beatgalerStage1OriginalFileInputClick.apply(this, args);
    };
  });
  await button.click();
  const accept = kind === "WAV" ? ".wav" : ".zip";
  const input = await client.$(`input[type="file"][accept*="${accept}"]`);
  await input.waitForExist({ timeout: 30_000 });
  await client.execute(element => {
    const original = window.__beatgalerStage1OriginalFileInputClick;
    if (original) {
      HTMLInputElement.prototype.click = original;
      delete window.__beatgalerStage1OriginalFileInputClick;
    }
    element.style.display = "block";
    element.style.position = "fixed";
    element.style.left = "8px";
    element.style.top = "8px";
    element.style.width = "240px";
    element.style.height = "40px";
    element.style.opacity = "0.01";
    element.style.zIndex = "2147483647";
    element.style.pointerEvents = "auto";
    }, input);
  await input.setValue(await client.uploadFile(localFile));
}

async function configureDownloadIntegrityReview(client, fixture) {
  const nameInput = await client.$('input[value*="Stage1 Download Integrity"]');
  const bpmInput = await client.$('//div[normalize-space(.)="BPM"]/parent::div//input');
  const keyInput = await client.$('//div[normalize-space(.)="KEY"]/parent::div//input');
  await setControlledInputValue(client, nameInput, fixture.expected_metadata.name);
  await setControlledInputValue(client, bpmInput, fixture.expected_metadata.bpm);
  await setControlledInputValue(client, keyInput, fixture.expected_metadata.key);
  const tagInput = await client.$('//div[normalize-space(.)="TAGS"]/following::input[not(@type="file")][1]');
  await tagInput.waitForDisplayed({ timeout: 30_000 });
  const addTagButton = await tagInput.$(
    './following-sibling::button[normalize-space(.)="Add"]',
  );
  await addTagButton.waitForDisplayed({ timeout: 30_000 });
  for (const tag of fixture.expected_metadata.tags) {
    await setControlledInputValue(client, tagInput, tag);

    await client.waitUntil(
      async () => (await tagInput.getValue()) === tag,
      {
        timeout: 5_000,
        interval: 100,
        timeoutMsg: `Tag input did not receive ${tag}.`,
      },
    );

    await addTagButton.click();

    await client.waitUntil(
      async () => (await tagInput.getValue()) === "",
      {
        timeout: 5_000,
        interval: 100,
        timeoutMsg: `Tag ${tag} was not committed by TagEditor.`,
      },
    );
  }
  await attachReviewSlotFile(client, "WAV", fixture.files.wav);
  await attachReviewSlotFile(client, "PROJECT", fixture.files.project);
}

async function provisionDownloadIntegrityBeat(client, account, fixture) {
  const committed = await uploadNamedMp3Fixture(client, account, fixture.beat_name, {
    localFixture: fixture.files.mp3,
    reviewIntegrity: fixture,
    commitTimeoutMs: 180_000,
  });
  const cardText = await beatCardText(client, committed.beat_id);
  assert.ok(cardText?.includes("128 · c#m"), "Authoritative beat did not expose the expected BPM/key.");
  return { ...committed, card_text: cardText };
}

async function offensiveTransportRequest(client, account, phase, route, body) {
  authObservers.get(account.label)?.setPhase(phase);
  return client.execute(async (requestRoute, requestBody) => {
    const response = await fetch(`${location.origin}/beatgaler-api${requestRoute}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(requestBody),
    });
    const payload = await response.json().catch(() => ({}));
    return {
      status: response.status,
      ok: response.ok,
      code: typeof payload?.code === "string" ? payload.code : null,
      error: typeof payload?.error === "string" ? payload.error.slice(0, 240) : null,
      expired: payload?.expired === true,
      released: payload?.released === true,
      operation_id: typeof payload?.operation_id === "string" ? payload.operation_id : null,
    };
  }, route, body);
}

function isolationEvidence(actor, owner, presented, result, authorityObtained = false) {
  return {
    actor,
    resource_owner: owner,
    resource_presented: presented,
    http_status: result?.status ?? null,
    semantic_code: result?.code || result?.error || null,
    authority_obtained: authorityObtained,
  };
}

function soakMetadataFor(account, round, iteration) {
  const keys = ["c#m", "d#m", "f#m", "g#m", "am", "bm", "em"];
  return {
    bpm: String(105 + ((round * 11 + iteration * 7 + Number(account.label)) % 90)),
    key: keys[(round + iteration + Number(account.label)) % keys.length],
  };
}

function metricSummary(values) {
  const clean = values
    .map(Number)
    .filter(value => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (clean.length === 0) {
    return { samples: 0, min_ms: null, avg_ms: null, p95_ms: null, max_ms: null };
  }
  const percentileIndex = Math.max(0, Math.ceil(clean.length * 0.95) - 1);
  return {
    samples: clean.length,
    min_ms: clean[0],
    avg_ms: Math.round(clean.reduce((sum, value) => sum + value, 0) / clean.length),
    p95_ms: clean[percentileIndex],
    max_ms: clean.at(-1),
  };
}

async function sleepUntilNextSoakAction(deadline, maxDelayMs = 12_000) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  await new Promise(resolve => setTimeout(resolve, Math.min(maxDelayMs, remaining)));
}

async function resetPlaybackForSoak(client) {
  await client.execute(() => {
    for (const audio of document.querySelectorAll("audio")) {
      try { audio.pause(); } catch {}
      try { audio.currentTime = 0; } catch {}
    }
  });
}

async function runSoakPlaybackRole(pairClients, pairAccounts, pairBeats, deadline, metrics) {
  let iteration = 0;
  while (Date.now() < deadline) {
    await Promise.all(pairClients.map(client => resetPlaybackForSoak(client)));
    const startedAt = Date.now();
    let playback;
    try {
      playback = await runConcurrentPlayback(pairClients, pairBeats);
    } catch (error) {
      const snapshots = await Promise.all(
        pairClients.map(client => playbackProbeSnapshot(client).catch(snapshotError => ({
          snapshot_error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
        }))),
      );
      metrics.playback_failures.push({
        iteration,
        account_labels: pairAccounts.map(account => account.label),
        elapsed_ms: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
        thrown_diagnostic: error?.stage1PlaybackDiagnostic || null,
        snapshots,
      });
      throw error;
    }
    const durationMs = Date.now() - startedAt;
    const firstAudio = playback.accounts.map(snapshot =>
      Math.max(0, Number(snapshot.first_playing_at || 0) - playback.trigger_started_at)
    );
    metrics.playback_operation_ms.push(durationMs);
    metrics.playback_start_spread_ms.push(playback.start_spread_ms);
    metrics.first_audio_ms.push(...firstAudio);
    metrics.playback_samples.push({
      iteration,
      account_labels: pairAccounts.map(account => account.label),
      duration_ms: durationMs,
      start_spread_ms: playback.start_spread_ms,
      first_audio_ms: firstAudio,
      waiting_seen: playback.accounts.map(snapshot => snapshot.waiting_seen === true),
    });
    iteration += 1;
    await sleepUntilNextSoakAction(deadline, 12_000);
  }
}

async function runSoakDownloadRole(client, account, beat, deadline, metrics) {
  let iteration = 0;
  while (Date.now() < deadline) {
    const startedAt = Date.now();
    const result = await downloadFixtureMaster(client, account, beat);
    const durationMs = Date.now() - startedAt;
    metrics.download_ms.push(durationMs);
    metrics.download_samples.push({
      iteration,
      account_label: account.label,
      duration_ms: durationMs,
      blob_size: result.blob_size,
    });
    iteration += 1;
    await sleepUntilNextSoakAction(deadline, 15_000);
  }
}

async function runSoakReloadRole(client, account, beforeSnapshot, deadline, metrics) {
  let iteration = 0;
  while (Date.now() < deadline) {
    const startedAt = Date.now();
    await client.refresh();
    const library = await waitForAuthoritativeLibrary(client, account.label);
    const libraryReadyMs = Date.now() - startedAt;
    const after = await waitForRuntimeSnapshot(client, account.label);
    validateSingleAccount(account.label, after);
    validatePersistentReload(beforeSnapshot, after, account.label);
    const durationMs = Date.now() - startedAt;
    metrics.reload_ms.push(durationMs);
    metrics.hot_library_ms.push(libraryReadyMs);
    metrics.reload_samples.push({
      iteration,
      account_label: account.label,
      duration_ms: durationMs,
      library_ready_ms: libraryReadyMs,
      library_beat_count: library.beat_count,
    });
    iteration += 1;
    await sleepUntilNextSoakAction(deadline, 15_000);
  }
}

async function runSoakMetadataRole(
  client,
  account,
  beat,
  beforeSnapshot,
  deadline,
  round,
  metrics,
  lastMetadataByAccount,
) {
  let iteration = 0;
  while (Date.now() < deadline) {
    const expected = soakMetadataFor(account, round, iteration);
    const editStartedAt = Date.now();
    await editFixtureMetadata(client, account, beat, expected);
    const editMs = Date.now() - editStartedAt;

    const reloadStartedAt = Date.now();
    await client.refresh();
    await waitForAuthoritativeLibrary(client, account.label);
    const libraryReadyMs = Date.now() - reloadStartedAt;
    const after = await waitForRuntimeSnapshot(client, account.label);
    validateSingleAccount(account.label, after);
    validatePersistentReload(beforeSnapshot, after, account.label);
    await verifyFixtureMetadataAfterReload(client, account, beat, expected);
    const reloadMs = Date.now() - reloadStartedAt;

    metrics.metadata_edit_ms.push(editMs);
    metrics.metadata_reload_ms.push(reloadMs);
    metrics.hot_library_ms.push(libraryReadyMs);
    metrics.metadata_samples.push({
      iteration,
      account_label: account.label,
      edit_ms: editMs,
      reload_ms: reloadMs,
      library_ready_ms: libraryReadyMs,
      expected,
    });
    lastMetadataByAccount[account.label] = expected;
    iteration += 1;
    await sleepUntilNextSoakAction(deadline, 12_000);
  }
}

async function validateNamedFixtureIsolation(clients, ownerIndex, beat) {
  const snapshots = await Promise.all(
    clients.map(client => playbackBeatSnapshot(client, beat.beat_name)),
  );

  snapshots.forEach((snapshot, index) => {
    if (index === ownerIndex) {
      assert.equal(
        snapshot?.beat_id,
        beat.beat_id,
        `Account ${accounts[index].label} must retain its mixed upload fixture.`,
      );
      return;
    }

    assert.equal(
      snapshot,
      null,
      `Account ${accounts[index].label} must not see Account ${accounts[ownerIndex].label}'s mixed upload fixture.`,
    );
  });

  return snapshots.map(snapshot => snapshot?.beat_id || null);
}

async function reloadDuringMixedWorkload(client, account, beforeSnapshot) {
  await client.refresh();
  const library = await waitForAuthoritativeLibrary(client, account.label);
  const after = await waitForRuntimeSnapshot(client, account.label);
  validateSingleAccount(account.label, after);
  validatePersistentReload(beforeSnapshot, after, account.label);
  return {
    library_beat_count: library.beat_count,
    session_id: after.direct.session_id,
    vault_chat_id: after.direct.chat_id,
    transport_id: after.direct.transport_id,
  };
}

async function playbackIsolationSnapshot(client) {
  return client.execute(() => {
    const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll("[data-beat-card-id]"))
      .map(card => {
        const name = Array.from(card.querySelectorAll("*"))
          .filter(node => node.children.length === 0)
          .map(node => normalize(node.textContent))
          .find(value => /^Stage1 Playback \d{2}$/.test(value));
        if (!name) return null;
        return {
          beat_id: String(card.getAttribute("data-beat-card-id") || "").trim(),
          name,
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name) || left.beat_id.localeCompare(right.beat_id));
  });
}

async function validatePlaybackFixtureIsolation(clients) {
  const snapshots = await Promise.all(clients.map(client => playbackIsolationSnapshot(client)));
  snapshots.forEach((cards, index) => {
    assert.deepEqual(
      cards.map(card => card.name),
      [playbackBeatName(accounts[index])],
      `Account ${accounts[index].label} must see only its own Stage 1 playback fixture. Observed Stage 1 playback cards: ${JSON.stringify(cards)}`,
    );
  });
  return snapshots;
}

async function installPlaybackProbe(client, beatId) {
  await client.execute(id => {
    const previous = window.__beatgalerStage1PlaybackProbe;
    if (previous?.handler) window.removeEventListener("beatgaler:web-playback-state", previous.handler);

    if (!window.__beatgalerStage1TraceCaptureInstalled) {
      const originalInfo = console.info.bind(console);
      window.__beatgalerStage1PlayTraceLines = [];
      console.info = (...args) => {
        try {
          const line = args.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" ");
          if (line.includes("[play-trace]")) {
            window.__beatgalerStage1PlayTraceLines.push({ at: Date.now(), line });
            if (window.__beatgalerStage1PlayTraceLines.length > 300) window.__beatgalerStage1PlayTraceLines.shift();
          }
        } catch {}
        return originalInfo(...args);
      };
      window.__beatgalerStage1PlaybackErrors = [];
      window.addEventListener("error", event => {
        window.__beatgalerStage1PlaybackErrors.push({
          at: Date.now(),
          type: "error",
          message: String(event?.message || "window error"),
        });
        if (window.__beatgalerStage1PlaybackErrors.length > 50) window.__beatgalerStage1PlaybackErrors.shift();
      });
      window.addEventListener("unhandledrejection", event => {
        const reason = event?.reason;
        window.__beatgalerStage1PlaybackErrors.push({
          at: Date.now(),
          type: "unhandledrejection",
          message: reason instanceof Error ? reason.message : String(reason || "unhandled rejection"),
        });
        if (window.__beatgalerStage1PlaybackErrors.length > 50) window.__beatgalerStage1PlaybackErrors.shift();
      });
      window.__beatgalerStage1TraceCaptureInstalled = true;
    }

    window.__beatgalerStage1PlayTraceLines = [];
    window.__beatgalerStage1PlaybackErrors = [];
    const probe = { beatId: id, events: [], handler: null };
    probe.handler = event => {
      const detail = event?.detail || {};
      if (String(detail.beatId || "") !== id) return;
      probe.events.push({
        at: Date.now(),
        current_time: Math.max(0, Number(detail.currentTime) || 0),
        playing: Boolean(detail.playing),
        waiting: Boolean(detail.waiting),
      });
      if (probe.events.length > 200) probe.events.shift();
    };
    window.__beatgalerStage1PlaybackProbe = probe;
    window.addEventListener("beatgaler:web-playback-state", probe.handler);
  }, beatId);
}

async function playbackProbeSnapshot(client) {
  return client.execute(() => {
    const probe = window.__beatgalerStage1PlaybackProbe;
    const events = Array.isArray(probe?.events) ? probe.events : [];
    const playingEvents = events.filter(event => event.playing);
    const audio = Array.from(document.querySelectorAll("audio")).map((node, index) => {
      const buffered = [];
      try {
        for (let i = 0; i < node.buffered.length; i += 1) {
          buffered.push([Number(node.buffered.start(i).toFixed(3)), Number(node.buffered.end(i).toFixed(3))]);
        }
      } catch {}
      return {
        index,
        paused: Boolean(node.paused),
        ended: Boolean(node.ended),
        current_time: Math.max(0, Number(node.currentTime) || 0),
        duration: Number.isFinite(Number(node.duration)) ? Number(node.duration) : null,
        ready_state: Number(node.readyState),
        network_state: Number(node.networkState),
        error_code: Number(node.error?.code || 0) || null,
        error_message: String(node.error?.message || "") || null,
        current_src_kind: String(node.currentSrc || "").startsWith("blob:") ? "blob" : String(node.currentSrc || "").startsWith("data:") ? "data" : String(node.currentSrc || "") ? "other" : "empty",
        buffered,
      };
    });
    return {
      beat_id: probe?.beatId || null,
      event_count: events.length,
      max_current_time: events.reduce((max, event) => Math.max(max, Number(event.current_time) || 0), 0),
      playing_seen: playingEvents.length > 0,
      first_playing_at: playingEvents[0]?.at || null,
      waiting_seen: events.some(event => event.waiting),
      last: events.at(-1) || null,
      recent_events: events.slice(-30),
      audio,
      visibility_state: document.visibilityState,
      online: navigator.onLine,
      play_trace: Array.isArray(window.__beatgalerStage1PlayTraceLines)
        ? window.__beatgalerStage1PlayTraceLines.slice(-120)
        : [],
      runtime_errors: Array.isArray(window.__beatgalerStage1PlaybackErrors)
        ? window.__beatgalerStage1PlaybackErrors.slice(-30)
        : [],
    };
  });
}

async function waitForPlaybackProgress(client, account) {
  let latest = null;
  try {
    await client.waitUntil(async () => {
      latest = await playbackProbeSnapshot(client);
      return latest?.playing_seen === true && latest?.max_current_time >= PLAYBACK_MIN_PROGRESS_SECONDS;
    }, { timeout: 30_000, interval: 100, timeoutMsg: `Account ${account.label} did not prove real playback progress.` });
    return latest;
  } catch (error) {
    latest = await playbackProbeSnapshot(client).catch(() => latest);
    const diagnostic = {
      account_label: account.label,
      ...(latest || {}),
    };
    const wrapped = new Error(
      `Account ${account.label} did not prove real playback progress. diagnostic=${JSON.stringify(diagnostic).slice(0, 6000)}`
    );
    wrapped.stage1PlaybackDiagnostic = diagnostic;
    wrapped.cause = error;
    throw wrapped;
  }
}

async function runConcurrentPlayback(clients, playbackBeats) {
  await Promise.all(playbackBeats.map((beat, index) => installPlaybackProbe(clients[index], beat.beat_id)));

  const artworks = await Promise.all(playbackBeats.map(async (beat, index) => {
    const artwork = await clients[index].$(`[data-beat-artwork-id="${beat.beat_id}"]`);
    await artwork.waitForDisplayed({ timeout: 30_000 });
    await clients[index].waitUntil(async () => (await artwork.getAttribute("aria-disabled")) !== "true", {
      timeout: 60_000,
      interval: 250,
      timeoutMsg: `Account ${accounts[index].label} playback never became interactive.`,
    });
    return artwork;
  }));

  const triggerStartedAt = Date.now();
  await Promise.all(artworks.map(artwork => artwork.click()));

  const snapshots = await Promise.all(clients.map((client, index) => waitForPlaybackProgress(client, accounts[index])));
  const starts = snapshots.map(snapshot => Number(snapshot.first_playing_at || 0));
  const startSpreadMs = Math.max(...starts) - Math.min(...starts);
  assert.ok(starts.every(Boolean), "Every account must observe the real HTMLAudioElement playing state.");

  return {
    trigger_started_at: triggerStartedAt,
    start_spread_ms: startSpreadMs,
    soft_target_ms: PLAYBACK_SOFT_START_SPREAD_MS,
    soft_target_exceeded: startSpreadMs > PLAYBACK_SOFT_START_SPREAD_MS,
    accounts: snapshots,
  };
}

async function seekThroughPlayerUi(client, account) {
  const before = await playbackProbeSnapshot(client);
  const beforeTime = Number(before?.last?.current_time || before?.max_current_time || 0);
  const beforeEventCount = Number(before?.event_count || 0);

  if (before?.playing_seen !== true || beforeEventCount < 1) {
    throw taggedError(
      `Account ${account.label} has no real playback state to seek from.`,
      "STAGE1_FOCUSED_SEEK_NO_PLAYBACK_STATE",
      "P1",
    );
  }

  const driveScrubber = async ratio => {
    const interaction = await client.execute(value => {
      const visible = node => Boolean(node && node.getClientRects().length);
      const previous = Array.from(document.querySelectorAll('button[title="Previous"]'))
        .find(visible);
      if (!previous) return { ok: false, reason: "player previous button missing" };

      let root = previous.parentElement;
      while (root && getComputedStyle(root).position !== "fixed") {
        root = root.parentElement;
      }
      if (!root) return { ok: false, reason: "player root missing" };

      const center = root.children?.[1];
      const column = center?.children?.[1];
      const scrubber = column?.children?.[1];
      if (!(scrubber instanceof HTMLElement)) {
        return { ok: false, reason: "player scrubber missing" };
      }

      const rect = scrubber.getBoundingClientRect();
      if (!(rect.width > 0)) return { ok: false, reason: "player scrubber has zero width" };

      const clientX = rect.left + rect.width * value;
      const clientY = rect.top + rect.height / 2;
      scrubber.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        button: 0,
        buttons: 1,
      }));
      window.dispatchEvent(new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        button: 0,
        buttons: 0,
      }));
      return { ok: true, ratio: value };
    }, ratio);

    if (!interaction?.ok) {
      throw taggedError(
        `Account ${account.label} could not drive the real Player scrubber: ${interaction?.reason || "unknown"}.`,
        "STAGE1_FOCUSED_SEEK_UI_FAILED",
        "P1",
      );
    }
    return interaction;
  };

  let seekSnapshot = null;
  let targetRatio = 0.75;
  let interaction = await driveScrubber(targetRatio);

  const waitForSeekJump = async baselineCount => {
    let latest = null;
    try {
      await client.waitUntil(async () => {
        latest = await playbackProbeSnapshot(client);
        const last = latest?.last;
        return Boolean(
          latest?.event_count > baselineCount &&
          last &&
          last.playing === true &&
          Math.abs(Number(last.current_time || 0) - beforeTime) >= 0.25
        );
      }, {
        timeout: 5_000,
        interval: 100,
        timeoutMsg: `Account ${account.label} did not emit a seek jump.`,
      });
      return latest;
    } catch {
      return null;
    }
  };

  seekSnapshot = await waitForSeekJump(beforeEventCount);

  if (!seekSnapshot) {
    const retryBefore = await playbackProbeSnapshot(client);
    targetRatio = 0.25;
    interaction = await driveScrubber(targetRatio);
    seekSnapshot = await waitForSeekJump(Number(retryBefore?.event_count || beforeEventCount));
  }

  if (!seekSnapshot) {
    const diagnostic = await playbackProbeSnapshot(client);
    throw taggedError(
      `Account ${account.label} Player scrubber did not produce a real playback-state seek jump. diagnostic=${JSON.stringify({
        before_time: beforeTime,
        event_count_before: beforeEventCount,
        event_count_after: diagnostic?.event_count || 0,
        last: diagnostic?.last || null,
        recent_events: diagnostic?.recent_events?.slice(-8) || [],
      }).slice(0, 1800)}`,
      "STAGE1_FOCUSED_SEEK_NO_STATE_JUMP",
      "P1",
    );
  }

  const seekTime = Number(seekSnapshot.last?.current_time || 0);
  const seekEventCount = Number(seekSnapshot.event_count || 0);
  let continued = null;

  await client.waitUntil(async () => {
    continued = await playbackProbeSnapshot(client);
    const playingAfterSeek = (continued?.recent_events || [])
      .filter(event => event.playing && Number(event.current_time) > seekTime + 0.10);
    return Boolean(
      continued?.event_count > seekEventCount &&
      playingAfterSeek.length > 0
    );
  }, {
    timeout: 15_000,
    interval: 100,
    timeoutMsg: `Account ${account.label} playback did not continue after seek.`,
  });

  const continuedEvent = (continued.recent_events || [])
    .filter(event => event.playing && Number(event.current_time) > seekTime + 0.10)
    .at(-1);

  return {
    current_time_before: Number(beforeTime.toFixed(3)),
    target_ratio: targetRatio,
    current_time_after_seek: Number(seekTime.toFixed(3)),
    current_time_after_continue: Number(Number(continuedEvent?.current_time || seekTime).toFixed(3)),
    seek_delta: Number(Math.abs(seekTime - beforeTime).toFixed(3)),
    continued_playing: true,
    playback_state_events_before: beforeEventCount,
    playback_state_events_after: Number(continued?.event_count || 0),
    ui_interaction: interaction,
  };
}

async function logoutReloginAuthoritative(client, account, beforeLogout, fixture) {
  const observer = authObservers.get(account.label);
  observer?.setPhase("focused-logout");

  const settings = await client.$('button[title="Settings"]');
  await settings.waitForDisplayed({ timeout: 30_000 });
  await settings.click();

  const signOut = await client.$('//button[normalize-space(.)="Sign out of BeatGaler"]');
  await signOut.waitForDisplayed({ timeout: 30_000 });
  await signOut.click();
  await client.pause(1_500);

  const afterLogoutCookies = await browserCookiePresence(client);
  const afterLogout = await client.execute(() => ({
    client_id: localStorage.getItem("beatgaler:web-client-id:v1"),
    web_session_marker:
      localStorage.getItem("beatgaler:web-session-present:v1") === "1",
    csrf_present: Boolean(sessionStorage.getItem("beatgaler:web-csrf:v1")),
    beat_count: document.querySelectorAll("[data-beat-card-id]").length,
    login_visible: Boolean(
      document.querySelector("#auth-login-identifier")?.getClientRects().length
    ),
    settings_signout_visible: Array.from(document.querySelectorAll("button"))
      .some(node =>
        node.textContent?.trim() === "Sign out of BeatGaler" &&
        node.getClientRects().length > 0
      ),
  }));

  const logoutHttp = observer?.snapshot().findLast(
    entry =>
      entry.route === "/beatgaler-api/auth/logout" &&
      entry.state === "response",
  );
  const directStopHttp = observer?.snapshot().findLast(
    entry =>
      entry.route === "/beatgaler-api/transport/session/stop" &&
      entry.state === "response",
  );

  if (!afterLogout.login_visible) {
    throw taggedError(
      `Account ${account.label} logout did not return to the sign-in gate. diagnostic=${JSON.stringify({
        logout_http_status: logoutHttp?.status ?? null,
        session_cookie_present: afterLogoutCookies.session_cookie,
        csrf_cookie_present: afterLogoutCookies.csrf_cookie,
        web_session_marker_present: afterLogout.web_session_marker,
        session_storage_csrf_present: afterLogout.csrf_present,
        client_id_preserved: afterLogout.client_id === beforeLogout.client_id,
        beat_count_after_logout: afterLogout.beat_count,
        settings_signout_visible: afterLogout.settings_signout_visible,
      }).slice(0, 1800)}`,
      "STAGE1_FOCUSED_LOGOUT_GATE_STALE",
      "P1",
    );
  }

  assert.equal(
    afterLogoutCookies.session_cookie,
    false,
    `Account ${account.label} session cookie must be cleared by logout.`,
  );
  assert.equal(
    afterLogoutCookies.csrf_cookie,
    false,
    `Account ${account.label} CSRF cookie must be cleared by logout.`,
  );
  assert.equal(
    afterLogout.web_session_marker,
    false,
    `Account ${account.label} Web session marker must be cleared by logout.`,
  );
  assert.equal(
    afterLogout.csrf_present,
    false,
    `Account ${account.label} Web CSRF state must be cleared by logout.`,
  );
  assert.equal(
    afterLogout.client_id,
    beforeLogout.client_id,
    `Account ${account.label} logout must preserve the browser installation id.`,
  );

  assert.ok(
    logoutHttp && logoutHttp.status >= 200 && logoutHttp.status < 300,
    `Account ${account.label} must observe a successful real /auth/logout response.`,
  );
  assert.ok(
    directStopHttp && directStopHttp.status >= 200 && directStopHttp.status < 300,
    `Account ${account.label} must stop the Direct session before account logout.`,
  );
  assert.ok(
    Number(directStopHttp.observed_at_ms) <= Number(logoutHttp.observed_at_ms),
    `Account ${account.label} must finish Direct stop before /auth/logout.`,
  );

  const reloginMs = await loginThroughUi(
    client,
    account,
    { resetProfile: false, reuseObserver: true },
  );
  const finalLibrary = await waitForAuthoritativeLibrary(client, account.label);
  const afterRelogin = await waitForRuntimeSnapshot(client, account.label);
  validateSingleAccount(account.label, afterRelogin);

  assert.equal(
    afterRelogin.user_id,
    beforeLogout.user_id,
    `Account ${account.label} relogin changed authenticated user.`,
  );
  assert.equal(
    afterRelogin.client_id,
    beforeLogout.client_id,
    `Account ${account.label} relogin changed browser installation id.`,
  );
  assert.equal(
    afterRelogin.direct.chat_id,
    beforeLogout.direct.chat_id,
    `Account ${account.label} relogin changed authoritative vault.`,
  );
  assert.equal(
    afterRelogin.direct.transport_id,
    beforeLogout.direct.transport_id,
    `Account ${account.label} relogin changed persistent transport assignment.`,
  );

  const restoredFixture = await waitForPlaybackBeat(client, account);
  assert.equal(
    restoredFixture.beat_id,
    fixture.beat_id,
    `Account ${account.label} relogin did not reopen the same authoritative fixture.`,
  );

  return {
    logout_http_status: logoutHttp.status,
    direct_stop_http_status: directStopHttp.status,
    client_id_preserved_while_signed_out: afterLogout.client_id === beforeLogout.client_id,
    signed_out_beat_count: afterLogout.beat_count,
    relogin_ms: reloginMs,
    user_id_preserved: afterRelogin.user_id === beforeLogout.user_id,
    client_id_preserved: afterRelogin.client_id === beforeLogout.client_id,
    vault_preserved: afterRelogin.direct.chat_id === beforeLogout.direct.chat_id,
    transport_preserved: afterRelogin.direct.transport_id === beforeLogout.direct.transport_id,
    session_id_before_logout: beforeLogout.direct.session_id,
    session_id_after_relogin: afterRelogin.direct.session_id,
    library_beat_count_after_relogin: finalLibrary.beat_count,
    fixture_beat_id_after_relogin: restoredFixture.beat_id,
  };
}


function metadataForAccount(account) {
  return { bpm: String(120 + Number(account.label)), key: "c#m" };
}

async function openBeatContextAction(client, beatId, actionLabel) {
  await client.execute(id => {
    const card = document.querySelector(`[data-beat-card-id="${id}"]`);
    if (!card) throw new Error(`Beat card ${id} is not present.`);
    const rect = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.max(1, rect.left + 24),
      clientY: Math.max(1, rect.top + 24),
      button: 2,
      buttons: 2,
    }));
  }, beatId);

  const action = await client.$(`//div[normalize-space(.)="${actionLabel}"]`);
  await action.waitForDisplayed({ timeout: 30_000 });
  await action.click();
}

async function beatCardText(client, beatId) {
  return client.execute(id => {
    const card = document.querySelector(`[data-beat-card-id="${id}"]`);
    return card ? String(card.innerText || "").replace(/\s+/g, " ").trim() : null;
  }, beatId);
}

async function editFixtureMetadata(client, account, beat, expected = metadataForAccount(account)) {
  await openBeatContextAction(client, beat.beat_id, "Edit metadata");

  const header = await client.$('//span[normalize-space(.)="Edit metadata"]');
  await header.waitForDisplayed({ timeout: 30_000 });

  const bpmInput = await client.$('//div[normalize-space(.)="BPM"]/parent::div//input');
  const keyInput = await client.$('//div[normalize-space(.)="KEY"]/parent::div//input');
  await bpmInput.waitForDisplayed({ timeout: 30_000 });
  await keyInput.waitForDisplayed({ timeout: 30_000 });

  const replaceControlledInputValue = async (element, value) => {
    await client.execute((input, nextValue) => {
      const descriptor = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      );
      descriptor?.set?.call(input, nextValue);
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: nextValue,
      }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, element, value);
  };

  await replaceControlledInputValue(bpmInput, expected.bpm);
  await replaceControlledInputValue(keyInput, expected.key);

  assert.equal(
    await bpmInput.getValue(),
    expected.bpm,
    `Account ${account.label} BPM input did not replace its previous value.`,
  );
  assert.equal(
    await keyInput.getValue(),
    expected.key,
    `Account ${account.label} Key input did not replace its previous value.`,
  );

  const save = await client.$('//button[starts-with(normalize-space(.), "Save")]');
  await save.waitForDisplayed({ timeout: 30_000 });
  await save.waitForEnabled({ timeout: 30_000 });
  await save.click();

  await client.waitUntil(async () => !(await header.isExisting()), {
    timeout: 120_000,
    interval: 300,
    timeoutMsg: `Account ${account.label} metadata editor did not close after save.`,
  });

  let text = null;
  await client.waitUntil(async () => {
    text = await beatCardText(client, beat.beat_id);
    return Boolean(text?.includes(`${expected.bpm} · ${expected.key}`));
  }, {
    timeout: 120_000,
    interval: 500,
    timeoutMsg: `Account ${account.label} did not render saved metadata.`,
  });

  return { ...expected, card_text_after_save: text };
}

async function verifyFixtureMetadataAfterReload(client, account, beat, expected = metadataForAccount(account)) {
  const reloaded = await waitForPlaybackBeat(client, account);
  assert.equal(
    reloaded.beat_id,
    beat.beat_id,
    `Account ${account.label} metadata edit changed beat identity after Reload.`,
  );

  let text = null;
  await client.waitUntil(async () => {
    text = await beatCardText(client, beat.beat_id);
    return Boolean(text?.includes(`${expected.bpm} · ${expected.key}`));
  }, {
    timeout: 120_000,
    interval: 500,
    timeoutMsg: `Account ${account.label} metadata did not persist after Reload.`,
  });

  return { ...expected, beat_id: beat.beat_id, persisted_after_reload: true, card_text: text };
}

async function installDownloadIntegrityPicker(client) {
  await client.execute(() => {
    const toBytes = async value => {
      if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      if (typeof value === "string") return new TextEncoder().encode(value);
      throw new TypeError(`Unsupported writable chunk: ${Object.prototype.toString.call(value)}`);
    };
    const hex = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(byte => byte.toString(16).padStart(2, "0")).join("");
    const id3Length = bytes => {
      if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33 || bytes[3] !== 3) return 0;
      const size = [bytes[6], bytes[7], bytes[8], bytes[9]];
      if (size.some(byte => byte > 0x7f)) return 0;
      const total = 10 + (size[0] << 21) + (size[1] << 14) + (size[2] << 7) + size[3];
      return total <= bytes.length ? total : 0;
    };
    const text = bytes => {
      if (!bytes.length) return "";
      if (bytes[0] === 1 && bytes.length >= 3) {
        const little = bytes[1] === 0xff && bytes[2] === 0xfe;
        let value = "";
        for (let offset = 3; offset + 1 < bytes.length; offset += 2) {
          const unit = little ? bytes[offset] | (bytes[offset + 1] << 8) : (bytes[offset] << 8) | bytes[offset + 1];
          if (unit === 0) break;
          value += String.fromCharCode(unit);
        }
        return value;
      }
      return new TextDecoder(bytes[0] === 3 ? "utf-8" : "latin1").decode(bytes.slice(1)).replace(/\0+$/, "");
    };
    const parse = bytes => {
      const length = id3Length(bytes);
      const frames = {};
      let popm = null;
      for (let offset = 10; length && offset + 10 <= length;) {
        const id = String.fromCharCode(...bytes.slice(offset, offset + 4));
        if (!/^[A-Z0-9]{4}$/.test(id)) break;
        const size = (bytes[offset + 4] * 0x1000000) + (bytes[offset + 5] << 16) + (bytes[offset + 6] << 8) + bytes[offset + 7];
        const end = offset + 10 + size;
        if (end > length) throw new Error(`Malformed ID3 ${id} frame.`);
        const payload = bytes.slice(offset + 10, end);
        if (id.startsWith("T")) frames[id] = text(payload);
        if (id === "POPM") {
          const zero = payload.indexOf(0);
          if (zero >= 0 && zero + 1 < payload.length) popm = { email: new TextDecoder("latin1").decode(payload.slice(0, zero)), rating: payload[zero + 1] };
        }
        offset = end;
      }
      return { id3v2_bytes: length, frames, popm };
    };
    const state = {
      records: [],
      originalSavePickerDescriptor: Object.getOwnPropertyDescriptor(window, "showSaveFilePicker"),
      originalSavePickerValue: window.showSaveFilePicker,
    };
    window.__beatgalerStage1DownloadIntegrityPicker = state;
    const picker = async options => {
      const record = { filename: String(options?.suggestedName || ""), chunks: [], closed: false, aborted: false };
      state.records.push(record);
      return {
        createWritable: async () => ({
          write: async value => { record.chunks.push(await toBytes(value)); },
          close: async () => {
            const bytes = new Uint8Array(await new Blob(record.chunks).arrayBuffer());
            const parsed = parse(bytes);
            record.closed = true;
            record.byte_count = bytes.byteLength;
            record.sha256 = await hex(bytes);
            record.audio_payload_byte_count = parsed.id3v2_bytes ? bytes.byteLength - parsed.id3v2_bytes : null;
            record.audio_payload_sha256 = parsed.id3v2_bytes ? await hex(bytes.slice(parsed.id3v2_bytes)) : null;
            record.id3 = parsed;
            delete record.chunks;
          },
          abort: async () => { record.aborted = true; record.chunks = []; },
        }),
      };
    };
    try {
      Object.defineProperty(window, "showSaveFilePicker", { configurable: true, writable: true, value: picker });
    } catch {
      window.showSaveFilePicker = picker;
    }
  });
}

async function downloadIntegrityPickerSnapshot(client) {
  return client.execute(() => {
    const records = window.__beatgalerStage1DownloadIntegrityPicker?.records || [];
    return records.map(({ chunks, ...record }) => record);
  });
}

async function restoreDownloadIntegrityPicker(client) {
  await client.execute(() => {
    const state = window.__beatgalerStage1DownloadIntegrityPicker;
    if (!state) return;
    try {
      if (state.originalSavePickerDescriptor) Object.defineProperty(window, "showSaveFilePicker", state.originalSavePickerDescriptor);
      else if (state.originalSavePickerValue === undefined) delete window.showSaveFilePicker;
      else window.showSaveFilePicker = state.originalSavePickerValue;
    } catch {}
    delete window.__beatgalerStage1DownloadIntegrityPicker;
  });
}

async function downloadIntegrityAsset(client, account, beat, label) {
  const startedAt = Date.now();
  await installDownloadIntegrityPicker(client);
  try {
    await openBeatContextAction(client, beat.beat_id, "Download");
    const button = await client.$(`//button[.//div[normalize-space(.)="${label}"]]`);
    await button.waitForEnabled({ timeout: 30_000 });
    await button.click();
    let latest = null;
    await client.waitUntil(async () => {
      latest = await downloadIntegrityPickerSnapshot(client);
      return latest.at(-1)?.closed === true;
    }, { timeout: 180_000, interval: 200, timeoutMsg: `Account ${account.label} did not materialize ${label} in the integrity picker.` });
    const close = await client.$('button[aria-label="Close download window"]');
    if (await close.isExisting()) await close.click();
    return { ...latest.at(-1), duration_ms: Date.now() - startedAt };
  } finally {
    await restoreDownloadIntegrityPicker(client).catch(() => {});
  }
}

async function installDownloadProbe(client) {
  await client.execute(() => {
    const state = {
      blobs: [],
      anchors: [],
      originalCreateObjectURL: URL.createObjectURL.bind(URL),
      originalAnchorClick: HTMLAnchorElement.prototype.click,
      originalSavePickerDescriptor: Object.getOwnPropertyDescriptor(window, "showSaveFilePicker"),
      originalSavePickerValue: window.showSaveFilePicker,
    };
    window.__beatgalerStage1DownloadProbe = state;

    try {
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        writable: true,
        value: undefined,
      });
    } catch {
      try { window.showSaveFilePicker = undefined; } catch {}
    }

    URL.createObjectURL = function stage1CreateObjectURL(blob) {
      if (blob instanceof Blob) state.blobs.push({ size: blob.size, type: blob.type || "" });
      return state.originalCreateObjectURL(blob);
    };

    HTMLAnchorElement.prototype.click = function stage1AnchorClick() {
      state.anchors.push({ download: String(this.download || ""), href: String(this.href || "") });
    };
  });
}

async function downloadProbeSnapshot(client) {
  return client.execute(() => {
    const state = window.__beatgalerStage1DownloadProbe;
    return {
      blobs: Array.isArray(state?.blobs) ? state.blobs.map(item => ({ ...item })) : [],
      anchors: Array.isArray(state?.anchors) ? state.anchors.map(item => ({ ...item })) : [],
    };
  });
}

async function restoreDownloadProbe(client) {
  await client.execute(() => {
    const state = window.__beatgalerStage1DownloadProbe;
    if (!state) return;
    if (state.originalCreateObjectURL) URL.createObjectURL = state.originalCreateObjectURL;
    if (state.originalAnchorClick) HTMLAnchorElement.prototype.click = state.originalAnchorClick;
    try {
      if (state.originalSavePickerDescriptor) {
        Object.defineProperty(window, "showSaveFilePicker", state.originalSavePickerDescriptor);
      } else if (state.originalSavePickerValue === undefined) {
        delete window.showSaveFilePicker;
      } else {
        window.showSaveFilePicker = state.originalSavePickerValue;
      }
    } catch {}
    delete window.__beatgalerStage1DownloadProbe;
  });
}

async function downloadFixtureMaster(client, account, beat) {
  await installDownloadProbe(client);
  try {
    await openBeatContextAction(client, beat.beat_id, "Download");

    const mp3 = await client.$('//button[.//div[normalize-space(.)="MP3"]]');
    await mp3.waitForDisplayed({ timeout: 30_000 });
    await mp3.waitForEnabled({ timeout: 30_000 });
    await mp3.click();

    let latest = null;
    await client.waitUntil(async () => {
      latest = await downloadProbeSnapshot(client);
      const blob = latest.blobs.at(-1);
      const anchor = latest.anchors.at(-1);
      return Boolean(
        blob &&
        blob.size > 0 &&
        blob.type === "audio/mpeg" &&
        anchor?.download?.toLowerCase().endsWith(".mp3")
      );
    }, {
      timeout: 120_000,
      interval: 250,
      timeoutMsg: `Account ${account.label} did not complete a real MASTER MP3 download.`,
    });

    const close = await client.$('button[aria-label="Close download window"]');
    if (await close.isExisting()) await close.click();

    return {
      beat_id: beat.beat_id,
      blob_size: latest.blobs.at(-1).size,
      mime_type: latest.blobs.at(-1).type,
      filename: latest.anchors.at(-1).download,
      completed: true,
    };
  } finally {
    await restoreDownloadProbe(client).catch(() => {});
  }
}

async function removeFixtureFromLibrary(client, account, beat) {
  await openBeatContextAction(client, beat.beat_id, "Remove from library");

  const dialog = await client.$('[data-beatgaler-dialog="true"]');
  await dialog.waitForDisplayed({ timeout: 30_000 });

  const confirm = await client.$('//div[@data-beatgaler-dialog="true"]//button[normalize-space(.)="Remove beat"]');
  await confirm.waitForDisplayed({ timeout: 30_000 });
  await confirm.click();

  const selector = `[data-beat-card-id="${beat.beat_id}"]`;
  await client.waitUntil(async () => !(await (await client.$(selector)).isExisting()), {
    timeout: 120_000,
    interval: 300,
    timeoutMsg: `Account ${account.label} beat did not leave the active library after Remove.`,
  });

  return {
    beat_id: beat.beat_id,
    removed_from_active_library: true,
  };
}

async function verifyFixtureAbsentFromLibrary(client, account, beat, phase) {
  const selector = `[data-beat-card-id="${beat.beat_id}"]`;
  const byId = await (await client.$(selector)).isExisting();
  const byName = await playbackBeatSnapshot(client, beat.beat_name);

  if (byId || byName?.beat_id) {
    throw taggedError(
      `Account ${account.label} removed beat resurrected in Library during ${phase}.`,
      "STAGE1_TRASH_LIBRARY_RESURRECTION",
      "P1",
    );
  }

  return true;
}

async function trashUiSnapshot(client) {
  return client.execute(() => {
    const visible = node => Boolean(node && node.getClientRects().length);
    const main = document.querySelector("main");
    const text = String(main?.innerText || "");
    const items = Array.from(document.querySelectorAll("[data-trash-item-id]"))
      .filter(visible)
      .map(node => ({
        trash_id: String(node.getAttribute("data-trash-item-id") || ""),
        beat_name: String(node.getAttribute("data-trash-beat-name") || ""),
      }));

    return {
      settings_open: Boolean(main && visible(main)),
      trash_heading: Array.from(main?.querySelectorAll("div") || [])
        .some(node => visible(node) && String(node.textContent || "").trim() === "Trash"),
      loading: text.includes("Loading…"),
      empty: text.includes("Trash is empty"),
      purge_acknowledged: text.includes("queued for permanent deletion."),
      items,
    };
  });
}

function trashFixtureMatch(snapshot, beat) {
  const prefix = `cloud-trash:${beat.beat_id}:`;
  return snapshot?.items?.find(item =>
    item.trash_id.startsWith(prefix) &&
    item.beat_name === beat.beat_name
  ) || null;
}

async function openTrashUi(client, account) {
  const settings = await client.$('button[title="Settings"]');
  await settings.waitForDisplayed({ timeout: 30_000 });
  await settings.click();

  const trashTab = await client.$('//aside//button[normalize-space(.)="trash"]');
  await trashTab.waitForDisplayed({ timeout: 30_000 });
  await trashTab.click();

  let latest = null;
  await client.waitUntil(async () => {
    latest = await trashUiSnapshot(client);
    return latest?.settings_open === true &&
      latest?.trash_heading === true &&
      latest?.loading === false;
  }, {
    timeout: 120_000,
    interval: 300,
    timeoutMsg: `Account ${account.label} Trash did not reach a loaded UI state.`,
  });

  return latest;
}

async function openTrashAndVerifyFixture(client, account, beat, allBeats, phase) {
  let latest = await openTrashUi(client, account);

  await client.waitUntil(async () => {
    latest = await trashUiSnapshot(client);
    return Boolean(trashFixtureMatch(latest, beat));
  }, {
    timeout: 120_000,
    interval: 300,
    timeoutMsg: `Account ${account.label} fixture did not appear in Trash during ${phase}.`,
  });

  const leaked = allBeats.filter(other => {
    if (other.beat_id === beat.beat_id) return false;
    const prefix = `cloud-trash:${other.beat_id}:`;
    return latest.items.some(item =>
      item.trash_id.startsWith(prefix) ||
      item.beat_name === other.beat_name
    );
  });

  if (leaked.length > 0) {
    throw taggedError(
      `Account ${account.label} Trash exposed fixture(s) from another vault during ${phase}.`,
      "STAGE1_TRASH_CROSS_VAULT_LEAK",
      "P0",
    );
  }

  return {
    beat_id: beat.beat_id,
    visible: true,
    matched_by_authoritative_trash_identity: true,
    cross_account_fixture_visible: false,
    observed_trash_item_count: latest.items.length,
  };
}

async function purgeFixtureThroughTrashUi(client, account, beat) {
  const before = await trashUiSnapshot(client);
  if (!trashFixtureMatch(before, beat)) {
    throw taggedError(
      `Account ${account.label} fixture was not present in Trash immediately before purge.`,
      "STAGE1_TRASH_FIXTURE_MISSING_BEFORE_PURGE",
      "P1",
    );
  }

  const empty = await client.$('//main//button[normalize-space(.)="Empty beat trash"]');
  await empty.waitForDisplayed({ timeout: 30_000 });
  await empty.waitForEnabled({ timeout: 30_000 });
  await empty.click();

  let latest = null;
  await client.waitUntil(async () => {
    latest = await trashUiSnapshot(client);
    return (
      latest?.purge_acknowledged === true &&
      !trashFixtureMatch(latest, beat)
    );
  }, {
    timeout: 120_000,
    interval: 300,
    timeoutMsg: `Account ${account.label} Empty Trash did not receive authoritative purge acknowledgement.`,
  });

  return {
    beat_id: beat.beat_id,
    purge_executed: true,
    purge_backend_acknowledged: true,
    absent_from_trash_after_purge_ui: true,
  };
}

async function verifyFixtureAbsentFromTrashAfterReload(client, account, beat) {
  const latest = await openTrashUi(client, account);
  const matchingByIdentity = trashFixtureMatch(latest, beat);
  const matchingByName = latest.items.some(item => item.beat_name === beat.beat_name);

  if (matchingByIdentity || matchingByName) {
    throw taggedError(
      `Account ${account.label} permanently deleted fixture resurrected in Trash after Reload.`,
      "STAGE1_TRASH_PURGE_RESURRECTION",
      "P1",
    );
  }

  return {
    beat_id: beat.beat_id,
    absent_from_trash_after_purge_reload: true,
    observed_trash_item_count: latest.items.length,
  };
}



function safeIsolationResponse(response) {
  const payload = response?.payload && typeof response.payload === "object"
    ? response.payload
    : {};
  const operationId = typeof payload.operation_id === "string" ? payload.operation_id : "";
  return {
    status: Number(response?.status || 0),
    http_ok: response?.http_ok === true,
    code: typeof payload.code === "string" ? payload.code : null,
    error: typeof payload.error === "string" ? payload.error.slice(0, 500) : null,
    ok: payload.ok === true,
    expired: payload.expired === true,
    released: payload.released === true,
    authorized: payload.authorized === true,
    wait: payload.wait === true,
    reason: typeof payload.reason === "string" ? payload.reason : null,
    operation_id_present: Boolean(operationId),
    operation_id_prefix: operationId ? operationId.slice(0, 12) + "…" : null,
    capability_vault_scope:
      typeof payload.capability?.vault_scope === "string"
        ? payload.capability.vault_scope
        : null,
    capability_object_scope:
      payload.capability?.object_scope &&
      typeof payload.capability.object_scope === "object"
        ? payload.capability.object_scope
        : null,
  };
}

async function isolationApiPost(
  client,
  route,
  body,
  { transportAuth = false } = {},
) {
  return client.execute(async input => {
    const headers = {
      "Content-Type": "application/json",
      "X-BeatGaler-Client": "web",
    };
    const csrf = window.sessionStorage.getItem("beatgaler:web-csrf:v1") || "";
    if (csrf) headers["X-BeatGaler-CSRF"] = csrf;
    if (input.transportAuth) {
      headers.Authorization = "Bearer browser-cookie-session";
    }

    try {
      const response = await window.fetch(
        window.location.origin + "/beatgaler-api" + input.route,
        {
          method: "POST",
          headers,
          credentials: "include",
          body: JSON.stringify(input.body || {}),
        },
      );
      const payload = await response.json().catch(() => ({}));
      return {
        status: response.status,
        http_ok: response.ok,
        payload,
      };
    } catch (error) {
      return {
        status: 0,
        http_ok: false,
        payload: {
          code: "NETWORK_ERROR",
          error: String(error?.message || error),
        },
      };
    }
  }, { route, body, transportAuth });
}

async function playbackRouteSnapshot(client, beatId) {
  return client.execute(id => {
    try {
      const parsed = JSON.parse(
        window.localStorage.getItem("beatgaler:web-playback-routing:v1") || "{}",
      );
      const route = parsed?.routes?.[id] || null;
      return {
        authoritative: parsed?.authoritative === true,
        message_id: Number(route?.messageId || 0) || null,
        mime_type: typeof route?.mimeType === "string" ? route.mimeType : null,
        route_present: Boolean(route),
      };
    } catch {
      return {
        authoritative: false,
        message_id: null,
        mime_type: null,
        route_present: false,
      };
    }
  }, beatId);
}


async function ensureIsolationSecretBeat(client, account) {
  const beatName = `Stage1 Isolation Secret ${account.label} v1`;
  const existing = await playbackBeatSnapshot(client, beatName);
  if (existing?.beat_id) {
    const committed = existing.cloud_committed
      ? existing
      : await waitForNamedBeatCommitted(client, account, beatName);
    return {
      ...committed,
      beat_name: beatName,
      created: false,
      marker: `BEATGALER-STAGE1-OFFENSIVE-${account.label}-MEDIA-v1`,
    };
  }

  await fs.mkdir(PLAYBACK_TMP_DIR, { recursive: true });
  const localFixture = path.join(
    PLAYBACK_TMP_DIR,
    `${beatName}.mp3`,
  );
  const marker = `BEATGALER-STAGE1-OFFENSIVE-${account.label}-MEDIA-v1`;
  await fs.copyFile(PLAYBACK_FIXTURE_FILE, localFixture);
  await fs.appendFile(localFixture, Buffer.from(`\\n${marker}\\n`, "utf8"));

  const uploaded = await uploadNamedMp3Fixture(
    client,
    account,
    beatName,
    {
      extension: ".mp3",
      localFixture,
    },
  );
  return {
    ...uploaded,
    marker,
  };
}

async function directMediaReadProbe(client, messageId, mimeType = "audio/mpeg") {
  return client.execute(async input => {
    const hex = buffer =>
      Array.from(new Uint8Array(buffer))
        .map(value => value.toString(16).padStart(2, "0"))
        .join("");

    try {
      const module = await import(
        "/src/features/playback/webStartupPlaybackCoordinator.ts"
      );
      const coordinator = module.getWebStartupPlaybackCoordinator();
      const transport = coordinator.getTransport();
      const chunks = [];

      const stream = await transport.streamFile(
        {
          messageId: Number(input.messageId),
          mimeType: input.mimeType || "audio/mpeg",
          purpose: "export",
        },
        chunk => {
          chunks.push(chunk.slice(0));
        },
      );
      const result = await stream.completed;
      const totalBytes = chunks.reduce(
        (sum, chunk) => sum + chunk.byteLength,
        0,
      );
      const joined = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
      }
      const digest = await crypto.subtle.digest("SHA-256", joined);

      return {
        ok: true,
        message_id: Number(input.messageId),
        total_bytes: totalBytes,
        stream_total_bytes: Number(result?.totalBytes || 0),
        mime_type: String(result?.mimeType || input.mimeType || ""),
        sha256: hex(digest),
      };
    } catch (error) {
      return {
        ok: false,
        message_id: Number(input.messageId),
        code: String(error?.code || "") || null,
        name: String(error?.name || "") || null,
        error: String(error?.message || error || "").slice(0, 800),
      };
    }
  }, { messageId, mimeType });
}

async function proveOwnHeartbeat(client, runtime, label) {
  const response = await isolationApiPost(
    client,
    "/transport/session/heartbeat",
    {
      beatgalerUserId: runtime.client_id,
      sessionId: runtime.direct.session_id,
      generation: runtime.direct.generation,
      credentialVersion: runtime.direct.credential_version,
    },
    { transportAuth: true },
  );
  const evidence = safeIsolationResponse(response);
  if (
    !response.http_ok ||
    response.payload?.expired === true ||
    response.payload?.ok === false
  ) {
    throw taggedError(
      "Account " + label + " lost its own Direct authority after an offensive isolation attempt. diagnostic=" +
        JSON.stringify(evidence).slice(0, 1800),
      "STAGE1_OFFENSIVE_OWNER_SESSION_DAMAGED",
      "P0",
    );
  }
  return evidence;
}

async function beginIsolationCapability(
  client,
  runtime,
  messageId,
  label,
) {
  let latest = null;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    latest = await isolationApiPost(
      client,
      "/transport/operation/begin",
      {
        beatgalerUserId: runtime.client_id,
        sessionId: runtime.direct.session_id,
        generation: runtime.direct.generation,
        credentialVersion: runtime.direct.credential_version,
        kind: "probe_media",
        scope: {
          objectType: "message",
          objectIds: [String(messageId)],
        },
        documentContext: {
          tab_id: "stage1-offensive-" + label,
          document_id: "stage1-offensive-" + label + "-" + String(Date.now()),
          generation: attempt,
        },
      },
      { transportAuth: true },
    );

    if (
      latest.http_ok &&
      typeof latest.payload?.operation_id === "string" &&
      latest.payload.operation_id.startsWith("cap_")
    ) {
      return latest;
    }

    if (latest.payload?.wait === true) {
      await client.pause(
        Math.max(100, Math.min(1_000, Number(latest.payload?.retry_after_ms || 250))),
      );
      continue;
    }

    throw taggedError(
      "Account " + label + " could not create the scoped media capability used by the isolation attack. diagnostic=" +
        JSON.stringify(safeIsolationResponse(latest)).slice(0, 1800),
      "STAGE1_OFFENSIVE_CAPABILITY_SETUP_FAILED",
      "P1",
    );
  }

  throw taggedError(
    "Account " + label + " remained backpressured while creating the scoped media capability. diagnostic=" +
      JSON.stringify(safeIsolationResponse(latest)).slice(0, 1800),
    "STAGE1_OFFENSIVE_CAPABILITY_SETUP_TIMEOUT",
    "P1",
  );
}

async function authorizeIsolationCapability(
  client,
  runtime,
  operationId,
  messageId,
) {
  return isolationApiPost(
    client,
    "/transport/capability/authorize",
    {
      beatgalerUserId: runtime.client_id,
      sessionId: runtime.direct.session_id,
      generation: runtime.direct.generation,
      operationId,
      kind: "probe_media",
      scope: {
        objectType: "message",
        objectIds: [String(messageId)],
      },
    },
    { transportAuth: true },
  );
}

async function endIsolationCapability(
  client,
  runtime,
  operationId,
) {
  return isolationApiPost(
    client,
    "/transport/operation/end",
    {
      beatgalerUserId: runtime.client_id,
      sessionId: runtime.direct.session_id,
      generation: runtime.direct.generation,
      operationId,
    },
    { transportAuth: true },
  );
}

async function signOutForIsolation(client, account, observerLabel) {
  const observer = authObservers.get(observerLabel);
  observer?.setPhase("offensive-same-profile-signout-" + account.label);

  const beforeClientId = await client.execute(
    () => window.localStorage.getItem("beatgaler:web-client-id:v1"),
  );

  let signOut = await client.$('//button[normalize-space(.)="Sign out of BeatGaler"]');
  if (!(await signOut.isDisplayed().catch(() => false))) {
    const settings = await client.$('button[title="Settings"]');
    await settings.waitForDisplayed({ timeout: 30_000 });
    await settings.click();
    signOut = await client.$('//button[normalize-space(.)="Sign out of BeatGaler"]');
  }

  await signOut.waitForDisplayed({ timeout: 30_000 });
  await signOut.click();

  await client.waitUntil(async () => {
    const login = await client.$("#auth-login-identifier");
    return login.isDisplayed().catch(() => false);
  }, {
    timeout: 30_000,
    interval: 200,
    timeoutMsg: "Account " + account.label + " did not return to the sign-in gate during offensive isolation.",
  });

  const state = await client.execute(() => ({
    client_id: window.localStorage.getItem("beatgaler:web-client-id:v1"),
    web_session_marker:
      window.localStorage.getItem("beatgaler:web-session-present:v1") === "1",
    csrf_present: Boolean(
      window.sessionStorage.getItem("beatgaler:web-csrf:v1"),
    ),
    beat_count: document.querySelectorAll("[data-beat-card-id]").length,
    audio: Array.from(document.querySelectorAll("audio")).map(node => ({
      paused: Boolean(node.paused),
      current_time: Number(node.currentTime || 0),
      src_kind: String(node.currentSrc || "").startsWith("blob:")
        ? "blob"
        : String(node.currentSrc || "")
          ? "other"
          : "empty",
    })),
  }));

  const http = observer?.snapshot() || [];
  const logout = http.findLast(
    entry =>
      entry.route === "/beatgaler-api/auth/logout" &&
      entry.state === "response",
  );
  const stop = http.findLast(
    entry =>
      entry.route === "/beatgaler-api/transport/session/stop" &&
      entry.state === "response",
  );

  assert.equal(
    state.client_id,
    beforeClientId,
    "Same-profile sign out must preserve the browser installation id.",
  );
  assert.equal(
    state.web_session_marker,
    false,
    "Same-profile sign out must clear the Web session marker.",
  );
  assert.equal(
    state.csrf_present,
    false,
    "Same-profile sign out must clear Web CSRF state.",
  );
  assert.ok(
    logout && logout.status >= 200 && logout.status < 300,
    "Same-profile sign out must receive a successful /auth/logout response.",
  );
  assert.ok(
    stop && stop.status >= 200 && stop.status < 300,
    "Same-profile sign out must stop the current Direct session.",
  );

  return {
    client_id_preserved: state.client_id === beforeClientId,
    beat_count_after_logout: state.beat_count,
    audio_after_logout: state.audio,
    logout_http_status: logout?.status ?? null,
    direct_stop_http_status: stop?.status ?? null,
  };
}

async function loginExistingProfileForIsolation(
  client,
  account,
  observerLabel,
) {
  const observer = authObservers.get(observerLabel);
  observer?.setPhase("offensive-same-profile-login-" + account.label);

  const field = await client.$("#auth-login-identifier");
  await field.waitForDisplayed({ timeout: 30_000 });
  await field.setValue(account.identifier);
  await (await client.$("#auth-login-password")).setValue(account.password);
  await (await client.$('.bg-auth-form button[type="submit"]')).click();

  await client.waitUntil(async () => {
    const login = await client.$("#auth-login-identifier");
    const alert = await client.$('[role="alert"]');
    const mfa = await client.$("#auth-login-mfa");
    return (
      !(await login.isExisting()) ||
      await alert.isDisplayed().catch(() => false) ||
      await mfa.isExisting()
    );
  }, {
    timeout: 60_000,
    interval: 250,
    timeoutMsg: "Account " + account.label + " did not leave the sign-in gate during same-profile isolation.",
  });

  const diagnostic = await client.execute(() => {
    const visible = node => Boolean(node && node.getClientRects().length);
    return {
      login_visible: visible(document.querySelector("#auth-login-identifier")),
      mfa_visible: visible(document.querySelector("#auth-login-mfa")),
      alerts: Array.from(document.querySelectorAll('[role="alert"]'))
        .filter(visible)
        .map(node => String(node.textContent || "").slice(0, 600)),
    };
  });

  if (
    diagnostic.login_visible ||
    diagnostic.mfa_visible ||
    diagnostic.alerts.length > 0
  ) {
    throw taggedError(
      "Account " + account.label + " could not enter the existing browser profile. diagnostic=" +
        JSON.stringify(diagnostic).slice(0, 1800),
      "STAGE1_OFFENSIVE_SAME_PROFILE_LOGIN_FAILED",
      "P1",
    );
  }

  const library = await waitForAuthoritativeLibrary(client, account.label);
  const runtime = await waitForRuntimeSnapshot(client, observerLabel);
  validateSingleAccount(account.label, runtime);
  return { library, runtime };
}

async function sameProfileVisibleState(
  client,
  ownFixture,
  foreignFixture,
) {
  return client.execute(input => {
    const cards = Array.from(document.querySelectorAll("[data-beat-card-id]"));
    let routing = {};
    try {
      routing = JSON.parse(
        window.localStorage.getItem("beatgaler:web-playback-routing:v1") || "{}",
      );
    } catch {}
    const bodyText = String(document.body?.innerText || "");
    return {
      beat_ids: cards
        .map(node => String(node.getAttribute("data-beat-card-id") || ""))
        .filter(Boolean),
      own_name_visible: bodyText.includes(input.ownName),
      foreign_name_visible: bodyText.includes(input.foreignName),
      own_route_present: Boolean(routing?.routes?.[input.ownId]),
      foreign_route_present: Boolean(routing?.routes?.[input.foreignId]),
      routing_authoritative: routing?.authoritative === true,
      audio_playing: Array.from(document.querySelectorAll("audio"))
        .some(node => !node.paused && !node.ended),
    };
  }, {
    ownId: ownFixture.beat_id,
    ownName: ownFixture.beat_name,
    foreignId: foreignFixture.beat_id,
    foreignName: foreignFixture.beat_name,
  });
}

async function runSingleIsolationPlayback(client, account, beat) {
  await installPlaybackProbe(client, beat.beat_id);
  const artwork = await client.$(
    '[data-beat-artwork-id="' + beat.beat_id + '"]',
  );
  await artwork.waitForDisplayed({ timeout: 30_000 });
  await client.waitUntil(
    async () => (await artwork.getAttribute("aria-disabled")) !== "true",
    {
      timeout: 60_000,
      interval: 250,
      timeoutMsg: "Account " + account.label + " same-profile playback never became interactive.",
    },
  );
  await artwork.click();
  return waitForPlaybackProgress(client, account);
}

async function runFocusedOffensiveIsolation(
  clients,
  before,
  playbackFixtures,
) {
  const [clientA, clientB] = clients;
  const [accountA, accountB] = accounts;
  const [runtimeA, runtimeB] = before;
  const [fixtureA, fixtureB] = playbackFixtures;
  const isolationSecretA = await ensureIsolationSecretBeat(
    clientA,
    accountA,
  );

  const routeA = await playbackRouteSnapshot(
    clientA,
    isolationSecretA.beat_id,
  );
  const routeB = await playbackRouteSnapshot(clientB, fixtureB.beat_id);

  if (
    !routeA.authoritative ||
    !routeB.authoritative ||
    !routeA.message_id ||
    !routeB.message_id
  ) {
    throw taggedError(
      "Task 2 requires real authoritative media references for both accounts. diagnostic=" +
        JSON.stringify({ routeA, routeB }).slice(0, 1800),
      "STAGE1_OFFENSIVE_MEDIA_REFERENCE_MISSING",
      "P1",
    );
  }

  report.offensive_isolation = {
    account_a: {
      label: accountA.label,
      user_id: runtimeA.user_id,
      installation_id: runtimeA.client_id,
      vault_chat_id: runtimeA.direct.chat_id,
      session_id_prefix:
        String(runtimeA.direct.session_id || "").slice(0, 12) + "…",
      media_message_id: routeA.message_id,
      media_beat_id: isolationSecretA.beat_id,
      media_beat_name: isolationSecretA.beat_name,
      media_fixture_created_this_run: isolationSecretA.created,
    },
    account_b: {
      label: accountB.label,
      user_id: runtimeB.user_id,
      installation_id: runtimeB.client_id,
      vault_chat_id: runtimeB.direct.chat_id,
      session_id_prefix:
        String(runtimeB.direct.session_id || "").slice(0, 12) + "…",
      media_message_id: routeB.message_id,
    },
    attacks: {},
    same_profile: null,
    final: null,
  };

  for (const observer of authObservers.values()) {
    observer.setPhase("offensive-installation-isolation");
  }

  const installationClaim = await isolationApiPost(
    clientB,
    "/auth/session",
    { beatgalerUserId: runtimeA.client_id },
  );
  report.offensive_isolation.attacks.installation_claim = safeIsolationResponse(
    installationClaim,
  );

  if (installationClaim.status !== 403) {
    throw taggedError(
      "Account B was not rejected when it attempted to bind Account A installation. diagnostic=" +
        JSON.stringify(safeIsolationResponse(installationClaim)).slice(0, 1800),
      "STAGE1_OFFENSIVE_INSTALLATION_CROSS_AUTHORITY",
      "P0",
    );
  }

  const protectedBodySpoof = await isolationApiPost(
    clientB,
    "/transport/session/heartbeat",
    {
      beatgalerUserId: runtimeA.client_id,
      sessionId: runtimeB.direct.session_id,
      generation: runtimeB.direct.generation,
      credentialVersion: runtimeB.direct.credential_version,
    },
    { transportAuth: true },
  );
  report.offensive_isolation.attacks.installation_body_spoof =
    safeIsolationResponse(protectedBodySpoof);

  if (
    !protectedBodySpoof.http_ok ||
    protectedBodySpoof.payload?.expired === true ||
    protectedBodySpoof.payload?.ok === false
  ) {
    throw taggedError(
      "Protected-route installation spoof did not canonicalize back to Account B authority. diagnostic=" +
        JSON.stringify(safeIsolationResponse(protectedBodySpoof)).slice(0, 1800),
      "STAGE1_OFFENSIVE_INSTALLATION_CANONICALIZATION_FAILED",
      "P1",
    );
  }

  report.offensive_isolation.attacks.owner_a_after_installation_attack =
    await proveOwnHeartbeat(clientA, runtimeA, accountA.label);

  markScenario(
    "offensive_installation_isolation",
    "PASS",
    null,
    "B could not claim A installation; protected-route body spoof remained canonically bound to B.",
  );

  for (const observer of authObservers.values()) {
    observer.setPhase("offensive-session-isolation");
  }

  const stolenHeartbeat = await isolationApiPost(
    clientB,
    "/transport/session/heartbeat",
    {
      beatgalerUserId: runtimeB.client_id,
      sessionId: runtimeA.direct.session_id,
      generation: runtimeA.direct.generation,
      credentialVersion: runtimeA.direct.credential_version,
    },
    { transportAuth: true },
  );
  report.offensive_isolation.attacks.stolen_session_heartbeat =
    safeIsolationResponse(stolenHeartbeat);

  if (
    stolenHeartbeat.http_ok &&
    stolenHeartbeat.payload?.expired !== true &&
    stolenHeartbeat.payload?.ok !== false
  ) {
    throw taggedError(
      "Account B gained live heartbeat authority over Account A Direct session. diagnostic=" +
        JSON.stringify(safeIsolationResponse(stolenHeartbeat)).slice(0, 1800),
      "STAGE1_OFFENSIVE_SESSION_HEARTBEAT_CROSS_AUTHORITY",
      "P0",
    );
  }

  const stolenStop = await isolationApiPost(
    clientB,
    "/transport/session/stop",
    {
      beatgalerUserId: runtimeB.client_id,
      sessionId: runtimeA.direct.session_id,
      generation: runtimeA.direct.generation,
    },
    { transportAuth: true },
  );
  report.offensive_isolation.attacks.stolen_session_stop =
    safeIsolationResponse(stolenStop);

  if (stolenStop.payload?.released === true) {
    throw taggedError(
      "Account B released Account A Direct session.",
      "STAGE1_OFFENSIVE_SESSION_STOP_CROSS_AUTHORITY",
      "P0",
    );
  }

  report.offensive_isolation.attacks.owner_a_after_session_attack =
    await proveOwnHeartbeat(clientA, runtimeA, accountA.label);

  markScenario(
    "offensive_session_isolation",
    "PASS",
    null,
    "B heartbeat could not use A session; B stop returned no authority and A remained live.",
  );

  for (const observer of authObservers.values()) {
    observer.setPhase("offensive-capability-isolation");
  }

  const capabilityA = await beginIsolationCapability(
    clientA,
    runtimeA,
    routeA.message_id,
    accountA.label,
  );
  const capA = capabilityA.payload.operation_id;
  report.offensive_isolation.attacks.owner_a_capability =
    safeIsolationResponse(capabilityA);

  const stolenAuthorize = await authorizeIsolationCapability(
    clientB,
    runtimeB,
    capA,
    routeA.message_id,
  );
  report.offensive_isolation.attacks.stolen_capability_authorize =
    safeIsolationResponse(stolenAuthorize);

  if (
    stolenAuthorize.status !== 403 ||
    stolenAuthorize.payload?.authorized === true
  ) {
    throw taggedError(
      "Account B authorized Account A scoped capability. diagnostic=" +
        JSON.stringify(safeIsolationResponse(stolenAuthorize)).slice(0, 1800),
      "STAGE1_OFFENSIVE_CAPABILITY_CROSS_AUTHORITY",
      "P0",
    );
  }

  const stolenFinish = await endIsolationCapability(
    clientB,
    runtimeB,
    capA,
  );
  report.offensive_isolation.attacks.stolen_capability_finish =
    safeIsolationResponse(stolenFinish);

  if (stolenFinish.status !== 403) {
    throw taggedError(
      "Account B was able to finish Account A capability. diagnostic=" +
        JSON.stringify(safeIsolationResponse(stolenFinish)).slice(0, 1800),
      "STAGE1_OFFENSIVE_OPERATION_FINISH_CROSS_AUTHORITY",
      "P0",
    );
  }

  const ownerAuthorize = await authorizeIsolationCapability(
    clientA,
    runtimeA,
    capA,
    routeA.message_id,
  );
  report.offensive_isolation.attacks.owner_a_capability_authorize =
    safeIsolationResponse(ownerAuthorize);
  assert.equal(
    ownerAuthorize.payload?.authorized,
    true,
    "Account A must retain authority over its own capability after B attacks.",
  );

  const ownerFinish = await endIsolationCapability(
    clientA,
    runtimeA,
    capA,
  );
  report.offensive_isolation.attacks.owner_a_capability_finish =
    safeIsolationResponse(ownerFinish);
  assert.ok(
    ownerFinish.http_ok,
    "Account A must finish its own capability after B attacks.",
  );

  markScenario(
    "offensive_capability_isolation",
    "PASS",
    null,
    "B could neither authorize nor finish A capability; A retained both operations.",
  );

  for (const observer of authObservers.values()) {
    observer.setPhase("offensive-media-reference-isolation");
  }

  const mediaScopeB = await beginIsolationCapability(
    clientB,
    runtimeB,
    routeA.message_id,
    accountB.label,
  );
  const capB = mediaScopeB.payload.operation_id;
  report.offensive_isolation.attacks.stolen_media_reference_scope =
    safeIsolationResponse(mediaScopeB);

  assert.equal(
    String(mediaScopeB.payload?.capability?.vault_scope || ""),
    String(runtimeB.direct.chat_id),
    "A stolen numeric media reference must remain scoped to Account B vault.",
  );
  assert.notEqual(
    String(mediaScopeB.payload?.capability?.vault_scope || ""),
    String(runtimeA.direct.chat_id),
    "A stolen numeric media reference must never acquire Account A vault scope.",
  );
  assert.deepEqual(
    mediaScopeB.payload?.capability?.object_scope,
    {
      object_type: "message",
      object_ids: [String(routeA.message_id)],
    },
    "The offensive media capability must prove the exact stolen A message reference was presented.",
  );

  const mediaAuthorizeB = await authorizeIsolationCapability(
    clientB,
    runtimeB,
    capB,
    routeA.message_id,
  );
  report.offensive_isolation.attacks.stolen_media_reference_authorize =
    safeIsolationResponse(mediaAuthorizeB);
  assert.equal(
    mediaAuthorizeB.payload?.authorized,
    true,
    "B may only authorize the stolen numeric message reference inside B vault scope.",
  );

  const mediaFinishB = await endIsolationCapability(
    clientB,
    runtimeB,
    capB,
  );
  report.offensive_isolation.attacks.stolen_media_reference_finish =
    safeIsolationResponse(mediaFinishB);
  assert.ok(
    mediaFinishB.http_ok,
    "B scoped media probe must finish cleanly.",
  );

  const ownerMediaRead = await directMediaReadProbe(
    clientA,
    routeA.message_id,
    routeA.mime_type || "audio/mpeg",
  );
  const attackerMediaRead = await directMediaReadProbe(
    clientB,
    routeA.message_id,
    routeA.mime_type || "audio/mpeg",
  );
  report.offensive_isolation.attacks.owner_a_media_read = ownerMediaRead;
  report.offensive_isolation.attacks.attacker_b_media_read = attackerMediaRead;

  if (
    ownerMediaRead.ok !== true ||
    !ownerMediaRead.sha256 ||
    Number(ownerMediaRead.total_bytes || 0) <= 0
  ) {
    throw taggedError(
      "Account A could not read the unique offensive media fixture used as the byte-level control. diagnostic=" +
        JSON.stringify(ownerMediaRead).slice(0, 1800),
      "STAGE1_OFFENSIVE_OWNER_MEDIA_CONTROL_FAILED",
      "P1",
    );
  }

  if (
    attackerMediaRead.ok === true &&
    Number(attackerMediaRead.total_bytes || 0) > 0 &&
    attackerMediaRead.sha256 === ownerMediaRead.sha256
  ) {
    throw taggedError(
      "Account B received byte-identical media while presenting Account A message_id. diagnostic=" +
        JSON.stringify({
          owner: ownerMediaRead,
          attacker: attackerMediaRead,
          a_vault: runtimeA.direct.chat_id,
          b_vault: runtimeB.direct.chat_id,
        }).slice(0, 1800),
      "STAGE1_OFFENSIVE_MEDIA_BYTES_CROSS_VAULT",
      "P0",
    );
  }

  report.offensive_isolation.attacks.owner_a_after_media_reference_attack =
    await proveOwnHeartbeat(clientA, runtimeA, accountA.label);

  markScenario(
    "offensive_media_reference_isolation",
    "PASS",
    null,
    attackerMediaRead.ok
      ? "B resolved the stolen numeric message_id only inside B vault and the returned bytes did not match A unique media."
      : "B could not resolve A message_id in B vault; A unique media bytes remained inaccessible.",
  );

  for (const observer of authObservers.values()) {
    observer.setPhase("offensive-same-profile-switch");
  }

  const aPlayback = await runSingleIsolationPlayback(
    clientA,
    accountA,
    fixtureA,
  );
  const logoutA = await signOutForIsolation(
    clientA,
    accountA,
    accountA.label,
  );
  const logoutBOriginal = await signOutForIsolation(
    clientB,
    accountB,
    accountB.label,
  );

  const bOnAProfile = await loginExistingProfileForIsolation(
    clientA,
    accountB,
    accountA.label,
  );

  assert.equal(
    bOnAProfile.runtime.user_id,
    runtimeB.user_id,
    "Same browser profile must authenticate as B after A logout.",
  );
  assert.equal(
    bOnAProfile.runtime.client_id,
    runtimeA.client_id,
    "Same-profile A to B switch must preserve the browser installation id.",
  );
  assert.equal(
    bOnAProfile.runtime.direct.chat_id,
    runtimeB.direct.chat_id,
    "Same-profile B login must resolve B authoritative vault.",
  );

  const bVisible = await sameProfileVisibleState(
    clientA,
    fixtureB,
    fixtureA,
  );
  assert.ok(
    bVisible.beat_ids.includes(fixtureB.beat_id),
    "B fixture must be visible after same-profile switch.",
  );
  assert.equal(
    bVisible.beat_ids.includes(fixtureA.beat_id),
    false,
    "A fixture must not remain visible after same-profile switch to B.",
  );
  assert.equal(
    bVisible.foreign_name_visible,
    false,
    "A fixture name must not remain visible after same-profile switch to B.",
  );
  assert.equal(
    bVisible.foreign_route_present,
    false,
    "A playback routing cache entry must not survive into B.",
  );
  assert.equal(
    bVisible.audio_playing,
    false,
    "A playback must not continue after same-profile switch to B.",
  );

  const bPlayback = await runSingleIsolationPlayback(
    clientA,
    accountB,
    fixtureB,
  );

  const logoutBOnAProfile = await signOutForIsolation(
    clientA,
    accountB,
    accountA.label,
  );
  const aRestored = await loginExistingProfileForIsolation(
    clientA,
    accountA,
    accountA.label,
  );
  const bRestored = await loginExistingProfileForIsolation(
    clientB,
    accountB,
    accountB.label,
  );

  assert.equal(
    aRestored.runtime.user_id,
    runtimeA.user_id,
    "Account A must restore its original identity after same-profile test.",
  );
  assert.equal(
    aRestored.runtime.direct.chat_id,
    runtimeA.direct.chat_id,
    "Account A must restore its original vault after same-profile test.",
  );
  assert.equal(
    bRestored.runtime.user_id,
    runtimeB.user_id,
    "Account B must restore its original identity after same-profile test.",
  );
  assert.equal(
    bRestored.runtime.direct.chat_id,
    runtimeB.direct.chat_id,
    "Account B must restore its original vault after same-profile test.",
  );

  const aVisible = await sameProfileVisibleState(
    clientA,
    fixtureA,
    fixtureB,
  );
  const bRestoredVisible = await sameProfileVisibleState(
    clientB,
    fixtureB,
    fixtureA,
  );
  assert.equal(aVisible.foreign_name_visible, false);
  assert.equal(aVisible.foreign_route_present, false);
  assert.equal(bRestoredVisible.foreign_name_visible, false);
  assert.equal(bRestoredVisible.foreign_route_present, false);

  report.offensive_isolation.same_profile = {
    a_playback_progress_s: Number(aPlayback?.max_current_time || 0),
    logout_a: logoutA,
    logout_b_original: logoutBOriginal,
    b_on_a_profile: {
      preserved_installation_id:
        bOnAProfile.runtime.client_id === runtimeA.client_id,
      resolved_b_user:
        bOnAProfile.runtime.user_id === runtimeB.user_id,
      resolved_b_vault:
        bOnAProfile.runtime.direct.chat_id === runtimeB.direct.chat_id,
      a_beat_visible: bVisible.beat_ids.includes(fixtureA.beat_id),
      a_name_visible: bVisible.foreign_name_visible,
      a_route_present: bVisible.foreign_route_present,
      inherited_audio_playing: bVisible.audio_playing,
      b_playback_progress_s: Number(bPlayback?.max_current_time || 0),
    },
    logout_b_on_a_profile: logoutBOnAProfile,
    restored: {
      a_user: aRestored.runtime.user_id === runtimeA.user_id,
      a_vault: aRestored.runtime.direct.chat_id === runtimeA.direct.chat_id,
      b_user: bRestored.runtime.user_id === runtimeB.user_id,
      b_vault: bRestored.runtime.direct.chat_id === runtimeB.direct.chat_id,
    },
  };

  markScenario(
    "same_profile_account_switch_isolation",
    "PASS",
    null,
    "A playback stopped; A UI/routing state disappeared; B opened B vault and played B fixture in the same browser profile.",
  );

  const finalLibraries = await Promise.all([
    waitForAuthoritativeLibrary(clientA, accountA.label),
    waitForAuthoritativeLibrary(clientB, accountB.label),
  ]);
  const finalSnapshots = [aRestored.runtime, bRestored.runtime];

  validateCrossAccountIsolation(finalSnapshots);
  await validatePlaybackFixtureIsolation(clients);

  const finalA = await playbackBeatSnapshot(clientA, fixtureA.beat_name);
  const finalB = await playbackBeatSnapshot(clientB, fixtureB.beat_name);
  assert.equal(finalA?.beat_id, fixtureA.beat_id);
  assert.equal(finalB?.beat_id, fixtureB.beat_id);

  report.offensive_isolation.final = {
    account_a: {
      user_id: finalSnapshots[0].user_id,
      installation_id: finalSnapshots[0].client_id,
      vault_chat_id: finalSnapshots[0].direct.chat_id,
      library_beat_count: finalLibraries[0].beat_count,
      fixture_beat_id: finalA?.beat_id || null,
    },
    account_b: {
      user_id: finalSnapshots[1].user_id,
      installation_id: finalSnapshots[1].client_id,
      vault_chat_id: finalSnapshots[1].direct.chat_id,
      library_beat_count: finalLibraries[1].beat_count,
      fixture_beat_id: finalB?.beat_id || null,
    },
  };

  markScenario(
    "final_authoritative_isolation",
    "PASS",
    null,
    "Both accounts restored unique installations and authoritative vaults with their own fixtures intact.",
  );

  return {
    finalSnapshots,
    finalLibraries,
  };
}


describe("BeatGaler Stage 1 real multi-account Web E2E", () => {
  it(
    `runs ${accountCount} seeded real accounts concurrently and preserves productive authority across Reload`,
    async () => {
      if ((focusedLifecycle || focusedDownloadIntegrity) && accountCount !== 1) {
        throw taggedError(
          "Focused Stage 1 modes require --accounts 1.",
          "STAGE1_FOCUSED_ACCOUNT_COUNT",
          "P1",
        );
      }

      if (focusedIsolation && accountCount !== 2) {
        throw taggedError(
          "STAGE1_FOCUSED_ISOLATION requires --accounts 2.",
          "STAGE1_FOCUSED_ISOLATION_ACCOUNT_COUNT",
          "P1",
        );
      }

      if (focusedIsolation && (focusedLifecycle || mixedWorkload)) {
        throw taggedError(
          "STAGE1_FOCUSED_ISOLATION cannot be combined with lifecycle or mixed-workload modes.",
          "STAGE1_FOCUSED_ISOLATION_MODE_CONFLICT",
          "P1",
        );
      }

      if (!cohortId || !cohortPassword) {
        report.overall = "BLOCKED";

        report.failure = {
          code: "STAGE1_COHORT_MISSING",
          severity: null,
          message: "Reusable Stage 1 cohort is not seeded.",
        };

        await writeReport();
        await archiveFocusedDownloadIntegrityReport();

        throw taggedError(
          "Stage 1 reusable account cohort is missing. Run the seed command first.",
          "STAGE1_COHORT_MISSING",
          null,
        );
      }

      const clients = accounts.map(account =>
        browser.getInstance(account.browserName)
      );

      try {
        const loginResults = await Promise.allSettled(
          accounts.map((account, index) =>
            loginThroughUi(clients[index], account)
          ),
        );

        const loginFailures = loginResults.filter(
          result => result.status === "rejected",
        );

        if (loginFailures.length) {
          throw taggedError(
            loginFailures
              .map(result => result.reason.message)
              .join(" | "),
            "STAGE1_LOGIN_FAILED",
          );
        }

        const loginTimes = loginResults.map(result => result.value);

        for (const observer of authObservers.values()) {
          observer.setPhase("authoritative-startup");
        }

        const startupStartedAt = Date.now();

        const librariesBefore = await Promise.all(
          accounts.map((account, index) =>
            waitForAuthoritativeLibrary(
              clients[index],
              account.label,
            )
          ),
        );

        markScenario(
          "authoritative_library_data_plane",
          "PASS",
          null,
          `${accountCount} authoritative libraries ready`,
        );

        const before = await Promise.all(
          accounts.map((account, index) =>
            waitForRuntimeSnapshot(
              clients[index],
              account.label,
            )
          ),
        );

        const startupMs = Date.now() - startupStartedAt;

        before.forEach((snapshot, index) =>
          validateSingleAccount(
            accounts[index].label,
            snapshot,
          )
        );

        if (!singleAccountDiagnostic) {
          validateCrossAccountIsolation(before);

          markScenario(
            "multi_account_auth_isolation",
            "PASS",
            null,
            `${accountCount} unique users/browser ids`,
          );

          markScenario(
            "multi_account_direct_identity",
            "PASS",
            null,
            `${accountCount} unique vaults`,
          );
        }

        if (focusedDownloadIntegrity) {
          const fixture = await createDownloadIntegrityFixtures(accounts[0]);
          const integrityBeat = await provisionDownloadIntegrityBeat(clients[0], accounts[0], fixture);
          const observer = authObservers.get(accounts[0].label);
          observer?.setPhase("download-integrity-authoritative-reload");
          await clients[0].refresh();
          await waitForAuthoritativeLibrary(clients[0], accounts[0].label);
          const authoritativeIntegrityBeat = await waitForNamedBeatCommitted(
            clients[0],
            accounts[0],
            fixture.beat_name,
          );
          assert.equal(
            authoritativeIntegrityBeat.beat_id,
            integrityBeat.beat_id,
            "Focused download-integrity beat changed identity after authoritative Reload.",
          );

          const wav = await downloadIntegrityAsset(clients[0], accounts[0], authoritativeIntegrityBeat, "WAV");
          if (!wav.filename.toLowerCase().endsWith(".wav") || wav.byte_count <= 0 || wav.byte_count !== fixture.source.wav.bytes || wav.sha256 !== fixture.source.wav.sha256) {
            throw taggedError("WAV download bytes/hash/name differ from the uploaded fixture.", "STAGE1_DOWNLOAD_INTEGRITY_WAV", "P1");
          }
          markScenario("focused_download_wav_integrity", "PASS", null, "WAV bytes and SHA-256 match the original fixture.");

          const project = await downloadIntegrityAsset(clients[0], accounts[0], authoritativeIntegrityBeat, "Full Project");
          if (!project.filename.toLowerCase().endsWith(".zip") || project.byte_count <= 0 || project.byte_count !== fixture.source.project.bytes || project.sha256 !== fixture.source.project.sha256) {
            throw taggedError("PROJECT download bytes/hash/name differ from the uploaded ZIP fixture.", "STAGE1_DOWNLOAD_INTEGRITY_PROJECT", "P1");
          }
          markScenario("focused_download_project_integrity", "PASS", null, "Project ZIP bytes and SHA-256 match the original fixture.");

          const mp3 = await downloadIntegrityAsset(clients[0], accounts[0], authoritativeIntegrityBeat, "MP3");
          if (!mp3.filename.toLowerCase().endsWith(".mp3") || !mp3.id3?.id3v2_bytes || mp3.audio_payload_byte_count <= 0 || mp3.audio_payload_sha256 !== fixture.source.mp3.audio_sha256) {
            throw taggedError("MP3 MPEG payload SHA-256 differs after removing only the generated ID3v2 tag.", "STAGE1_DOWNLOAD_INTEGRITY_MP3_AUDIO", "P1");
          }
          markScenario("focused_download_mp3_audio_integrity", "PASS", null, "Generated ID3v2 was excluded; the remaining MPEG payload SHA-256 matches the upload payload.");

          const observed = mp3.id3.frames || {};
          const expectedTags = fixture.expected_metadata.tags.join("; ");
          if (observed.TIT2 !== fixture.expected_metadata.name || observed.TBPM !== fixture.expected_metadata.bpm || observed.TKEY !== fixture.expected_metadata.key || observed.TCON !== expectedTags) {
            throw taggedError("Generated MP3 ID3v2.3 metadata does not match the authoritative fixture metadata.", "STAGE1_DOWNLOAD_INTEGRITY_MP3_ID3", "P1");
          }
          markScenario("focused_download_mp3_id3_integrity", "PASS", null, "ID3v2.3 TIT2/TBPM/TKEY/TCON match the authoritative Review metadata.");

          validateAuthHealth(observer?.snapshot() || [], accounts[0].label);
          markScenario("auth_health_stability", "PASS", null, "No observed health probe failed during the focused download-integrity flow.");
          report.accounts[accounts[0].label] = {
            ...report.accounts[accounts[0].label],
            login_ms: loginTimes[0],
            user_id: before[0].user_id,
            client_id: before[0].client_id,
            vault_chat_id: before[0].direct.chat_id,
            transport_id: before[0].direct.transport_id,
            download_integrity_beat: { beat_id: authoritativeIntegrityBeat.beat_id, beat_name: authoritativeIntegrityBeat.beat_name },
          };
          report.download_integrity = {
            baseline_sha: report.baseline_sha,
            beat_id: authoritativeIntegrityBeat.beat_id,
            beat_name: authoritativeIntegrityBeat.beat_name,
            authoritative_reload_verified: true,
            beat_id_before_reload: integrityBeat.beat_id,
            beat_id_after_reload: authoritativeIntegrityBeat.beat_id,
            source: fixture.source,
            expected_id3_metadata: fixture.expected_metadata,
            downloads: {
              wav: { filename: wav.filename, byte_count: wav.byte_count, sha256: wav.sha256, duration_ms: wav.duration_ms },
              project: { filename: project.filename, byte_count: project.byte_count, sha256: project.sha256, duration_ms: project.duration_ms },
              mp3: { filename: mp3.filename, byte_count: mp3.byte_count, sha256: mp3.sha256, audio_payload_byte_count: mp3.audio_payload_byte_count, audio_payload_sha256: mp3.audio_payload_sha256, generated_id3_bytes: mp3.id3.id3v2_bytes, observed_id3_metadata: observed, duration_ms: mp3.duration_ms },
            },
          };
          report.timings = { startup_ms: startupMs, wav_download_ms: wav.duration_ms, project_download_ms: project.duration_ms, mp3_download_ms: mp3.duration_ms };
          report.overall = "PASS";
          report.severity = null;
          await writeReport();
          const archive = await archiveFocusedDownloadIntegrityReport();
          console.log(`[stage1-real] PASS focused download integrity account=${accounts[0].label}; report=${archive}`);
          return;
        }

        const playbackFixtures = await Promise.all(
          accounts.map((account, index) =>
            provisionPlaybackBeat(clients[index], account)
          ),
        );

        if (!singleAccountDiagnostic) await validatePlaybackFixtureIsolation(clients);

        markScenario(
          "playback_fixture_provisioning",
          "PASS",
          null,
          singleAccountDiagnostic
            ? "1 productive MASTER upload committed to the authoritative library"
            : `${accountCount} productive MASTER uploads committed to isolated authoritative libraries`,
        );

        if (focusedIsolation) {
          const isolation = await runFocusedOffensiveIsolation(
            clients,
            before,
            playbackFixtures,
          );

          for (const account of accounts) {
            const observer = authObservers.get(account.label);
            validateAuthHealth(observer?.snapshot() || [], account.label);
          }
          markScenario(
            "auth_health_stability",
            "PASS",
            null,
            "No observed auth health request failed during the two-account offensive isolation run",
          );

          report.accounts = Object.fromEntries(
            accounts.map((account, index) => [
              account.label,
              {
                ...report.accounts[account.label],
                login_ms: loginTimes[index],
                initial_user_id: before[index].user_id,
                initial_client_id: before[index].client_id,
                initial_vault_chat_id: before[index].direct.chat_id,
                initial_session_id_prefix:
                  String(before[index].direct.session_id || "").slice(0, 12) + "…",
                final_user_id: isolation.finalSnapshots[index].user_id,
                final_client_id: isolation.finalSnapshots[index].client_id,
                final_vault_chat_id:
                  isolation.finalSnapshots[index].direct.chat_id,
                final_library_beat_count:
                  isolation.finalLibraries[index].beat_count,
                playback_fixture: {
                  beat_id: playbackFixtures[index].beat_id,
                  beat_name: playbackFixtures[index].beat_name,
                  created_this_run: playbackFixtures[index].created,
                },
              },
            ]),
          );

          report.timings = {
            startup_ms: startupMs,
          };
          report.overall = "PASS";
          report.severity = null;
          await writeReport();
          console.log(
            `[stage1-real] PASS focused offensive isolation accounts=${accounts[0].label}/${accounts[1].label}; installation+session+capability+media-scope+same-profile. report=${REPORT_FILE}`,
          );
          return;
        }

        if (mixedWorkload) {
          if (accountCount !== MIXED_REQUIRED_ACCOUNTS) {
            throw taggedError(
              `Mixed workload mode requires exactly ${MIXED_REQUIRED_ACCOUNTS} accounts; received ${accountCount}.`,
              "STAGE1_MIXED_ACCOUNT_COUNT",
              null,
            );
          }

          report.accounts = Object.fromEntries(
            accounts.map((account, index) => [
              account.label,
              {
                ...report.accounts[account.label],
                login_ms: loginTimes[index],
                user_id: before[index].user_id,
                client_id: before[index].client_id,
                vault_chat_id: before[index].direct.chat_id,
                transport_id: before[index].direct.transport_id,
                transport_user_id: before[index].direct.transport_user_id,
                membership_bootstrap_mode: before[index].direct.mode,
                session_id_before: before[index].direct.session_id,
                library_beats_before: librariesBefore[index].beat_count,
                playback_fixture: {
                  beat_id: playbackFixtures[index].beat_id,
                  beat_name: playbackFixtures[index].beat_name,
                  created_this_run: playbackFixtures[index].created,
                },
              },
            ]),
          );


          if (soakMode) {
            const soakTargetMs = Math.round(soakMinutes * 60_000);
            const roundTargetMs = Math.max(1, Math.floor(soakTargetMs / SOAK_ROTATIONS));
            const soakStartedAt = Date.now();
            const metrics = {
              first_audio_ms: [],
              playback_operation_ms: [],
              playback_start_spread_ms: [],
              hot_library_ms: [],
              upload_ms: [],
              download_ms: [],
              metadata_edit_ms: [],
              metadata_reload_ms: [],
              reload_ms: [],
              playback_samples: [],
              playback_failures: [],
              upload_samples: [],
              download_samples: [],
              metadata_samples: [],
              reload_samples: [],
              final_reload_samples: [],
            };
            const roleCounts = Object.fromEntries(
              accounts.map(account => [
                account.label,
                { playback: 0, upload: 0, metadata_reload: 0, download: 0, reload: 0 },
              ]),
            );
            const createdUploads = [];
            const lastMetadataByAccount = {};
            report.soak = {
              requested_minutes: soakMinutes,
              target_duration_ms: soakTargetMs,
              large_transfer_target_mb: SOAK_LARGE_WAV_MB,
              transfer_budgets: "observational-only; no single-account transfer budget was established",
              started_at: new Date(soakStartedAt).toISOString(),
              finished_at: null,
              rounds: [],
              role_counts: roleCounts,
              metrics,
            };

            const largeOwnerIndex = 2;
            const largeBeatName = `Stage1 Soak Large ${accounts[largeOwnerIndex].label} ${MIXED_RUN_SUFFIX}`;
            const largeFixture = await createSoakLargeWavFixture(largeBeatName);
            report.soak.large_transfer_fixture = {
              owner_account: accounts[largeOwnerIndex].label,
              beat_name: largeBeatName,
              bytes: largeFixture.bytes,
              mb: Number(largeFixture.mb.toFixed(2)),
            };

            for (let round = 0; round < SOAK_ROTATIONS; round += 1) {
              const roundStartedAt = Date.now();
              const deadline = roundStartedAt + roundTargetMs;
              const slotAccountIndex = slot => (slot + round) % accountCount;
              const playbackIndices = [slotAccountIndex(0), slotAccountIndex(1)];
              const uploadIndex = slotAccountIndex(2);
              const metadataIndex = slotAccountIndex(3);
              const downloadIndex = slotAccountIndex(4);
              const reloadIndices = [slotAccountIndex(5), slotAccountIndex(6)];

              for (const index of playbackIndices) roleCounts[accounts[index].label].playback += 1;
              roleCounts[accounts[uploadIndex].label].upload += 1;
              roleCounts[accounts[metadataIndex].label].metadata_reload += 1;
              roleCounts[accounts[downloadIndex].label].download += 1;
              for (const index of reloadIndices) roleCounts[accounts[index].label].reload += 1;

              await Promise.all(clients.map(client => resetPlaybackForSoak(client)));

              const roundEvidence = {
                round: round + 1,
                started_at: new Date(roundStartedAt).toISOString(),
                target_ms: roundTargetMs,
                roles: {
                  playback: playbackIndices.map(index => accounts[index].label),
                  upload: accounts[uploadIndex].label,
                  metadata_reload: accounts[metadataIndex].label,
                  download: accounts[downloadIndex].label,
                  reload: reloadIndices.map(index => accounts[index].label),
                },
                status: "RUNNING",
              };
              report.soak.rounds.push(roundEvidence);

              for (const observer of authObservers.values()) {
                observer.setPhase(`mixed-soak-round-${round + 1}`);
              }

              const uploadBeatName = round === 0
                ? largeBeatName
                : `Stage1 Soak Upload ${accounts[uploadIndex].label} R${String(round + 1).padStart(2, "0")} ${MIXED_RUN_SUFFIX}`;

              const uploadTask = (async () => {
                const startedAt = Date.now();
                const result = round === 0
                  ? await uploadNamedMp3Fixture(
                      clients[uploadIndex],
                      accounts[uploadIndex],
                      uploadBeatName,
                      {
                        extension: ".wav",
                        localFixture: largeFixture.file,
                        commitTimeoutMs: 300_000,
                      },
                    )
                  : await uploadNamedMp3Fixture(
                      clients[uploadIndex],
                      accounts[uploadIndex],
                      uploadBeatName,
                    );
                const durationMs = Date.now() - startedAt;
                metrics.upload_ms.push(durationMs);
                metrics.upload_samples.push({
                  round: round + 1,
                  account_label: accounts[uploadIndex].label,
                  duration_ms: durationMs,
                  source_bytes: result.source_bytes,
                  source_extension: result.source_extension,
                  large_transfer: round === 0,
                });
                createdUploads.push({
                  owner_index: uploadIndex,
                  large_transfer: round === 0,
                  ...result,
                });
                return result;
              })();

              const roundResults = await Promise.allSettled([
                runSoakPlaybackRole(
                  playbackIndices.map(index => clients[index]),
                  playbackIndices.map(index => accounts[index]),
                  playbackIndices.map(index => playbackFixtures[index]),
                  deadline,
                  metrics,
                ),
                uploadTask,
                runSoakMetadataRole(
                  clients[metadataIndex],
                  accounts[metadataIndex],
                  playbackFixtures[metadataIndex],
                  before[metadataIndex],
                  deadline,
                  round,
                  metrics,
                  lastMetadataByAccount,
                ),
                runSoakDownloadRole(
                  clients[downloadIndex],
                  accounts[downloadIndex],
                  playbackFixtures[downloadIndex],
                  deadline,
                  metrics,
                ),
                ...reloadIndices.map(index =>
                  runSoakReloadRole(
                    clients[index],
                    accounts[index],
                    before[index],
                    deadline,
                    metrics,
                  )
                ),
              ]);

              const failures = roundResults
                .map((result, index) => ({ result, index }))
                .filter(({ result }) => result.status === "rejected");
              if (failures.length > 0) {
                roundEvidence.status = "FAIL";
                roundEvidence.finished_at = new Date().toISOString();
                roundEvidence.failures = failures.map(({ result, index }) => ({
                  task_index: index,
                  message: String(result.reason?.message || result.reason).slice(0, 800),
                }));
                throw taggedError(
                  `Mixed soak round ${round + 1} failed: ${roundEvidence.failures.map(item => item.message).join(" | ")}`,
                  "STAGE1_MIXED_SOAK_ROUND_FAILED",
                  "P1",
                );
              }

              if (Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, deadline - Date.now()));
              }
              roundEvidence.status = "PASS";
              roundEvidence.finished_at = new Date().toISOString();
              roundEvidence.actual_ms = Date.now() - roundStartedAt;
              await writeReport();
            }

            const soakElapsedMs = Date.now() - soakStartedAt;
            report.soak.finished_at = new Date().toISOString();
            report.soak.actual_duration_ms = soakElapsedMs;

            if (!diagnosticSoakRound) {
              for (const counts of Object.values(roleCounts)) {
                assert.ok(counts.playback >= 2, "Every account must rotate through playback twice.");
                assert.ok(counts.upload >= 1, "Every account must rotate through upload.");
                assert.ok(counts.metadata_reload >= 1, "Every account must rotate through metadata + Reload.");
                assert.ok(counts.download >= 1, "Every account must rotate through download.");
                assert.ok(counts.reload >= 2, "Every account must rotate through Reload twice.");
              }

              markScenario(
                "mixed_role_rotation",
                "PASS",
                null,
                "Seven rotations covered every account in playback, upload, metadata+Reload, download, and Reload roles",
              );
            } else {
              markScenario(
                "mixed_role_rotation",
                "SKIPPED",
                null,
                `Diagnostic reproduction requested ${SOAK_ROTATIONS} fixed round(s); full role rotation is intentionally not evaluated.`,
              );
            }
            if (soakElapsedMs < soakTargetMs) {
              throw taggedError(
                `Mixed soak ended early at ${soakElapsedMs} ms; target was ${soakTargetMs} ms.`,
                "STAGE1_MIXED_SOAK_TOO_SHORT",
                "P1",
              );
            }
            markScenario(
              "mixed_soak_duration",
              "PASS",
              null,
              `Mixed workload remained active for ${soakElapsedMs} ms (target ${soakTargetMs} ms)`,
            );

            for (const observer of authObservers.values()) {
              observer.setPhase("mixed-soak-final-authoritative-reload");
            }

            const finalReloadStartedAt = Date.now();
            const finalLibraryResults = await Promise.all(
              accounts.map(async (account, index) => {
                const refreshStartedAt = Date.now();
                await clients[index].refresh();
                const refreshResolvedAt = Date.now();
                const library = await waitForAuthoritativeLibrary(clients[index], account.label);
                const libraryReadyAt = Date.now();
                const refreshCommandMs = refreshResolvedAt - refreshStartedAt;
                const libraryAfterRefreshMs = libraryReadyAt - refreshResolvedAt;
                const readyMs = libraryReadyAt - refreshStartedAt;
                metrics.hot_library_ms.push(readyMs);
                metrics.final_reload_samples.push({
                  account_label: account.label,
                  refresh_command_ms: refreshCommandMs,
                  library_after_refresh_ms: libraryAfterRefreshMs,
                  library_ready_ms: readyMs,
                  library_beat_count: library.beat_count,
                });
                return {
                  library,
                  ready_ms: readyMs,
                  refresh_command_ms: refreshCommandMs,
                  library_after_refresh_ms: libraryAfterRefreshMs,
                };
              }),
            );
            const finalSnapshots = await Promise.all(
              accounts.map((account, index) =>
                waitForRuntimeSnapshot(clients[index], account.label)
              ),
            );

            finalSnapshots.forEach((snapshot, index) => {
              validateSingleAccount(accounts[index].label, snapshot);
              validatePersistentReload(before[index], snapshot, accounts[index].label);
            });
            validateCrossAccountIsolation(finalSnapshots);
            await validatePlaybackFixtureIsolation(clients);

            for (const upload of createdUploads) {
              const persisted = await waitForNamedBeatCommitted(
                clients[upload.owner_index],
                accounts[upload.owner_index],
                upload.beat_name,
              );
              assert.equal(
                persisted.beat_id,
                upload.beat_id,
                `Account ${accounts[upload.owner_index].label} soak upload changed identity after final Reload.`,
              );
              await validateNamedFixtureIsolation(
                clients,
                upload.owner_index,
                upload,
              );
            }

            for (let index = 0; index < accounts.length; index += 1) {
              const expected = lastMetadataByAccount[accounts[index].label];
              if (!expected) {
                if (!diagnosticSoakRound) {
                  assert.fail(`Account ${accounts[index].label} never completed its metadata role.`);
                }
                continue;
              }
              await verifyFixtureMetadataAfterReload(
                clients[index],
                accounts[index],
                playbackFixtures[index],
                expected,
              );
            }

            const largeUpload = createdUploads.find(upload => upload.large_transfer);
            assert.ok(largeUpload, "The mixed soak must include one large transfer.");
            assert.ok(
              largeUpload.source_bytes >= Math.floor(SOAK_LARGE_WAV_MB * 1024 * 1024 * 0.99),
              "The large transfer fixture was smaller than requested.",
            );
            markScenario(
              "mixed_large_transfer",
              "PASS",
              null,
              `A ${(largeUpload.source_bytes / (1024 * 1024)).toFixed(2)} MiB WAV committed while the other six accounts remained active`,
            );

            const summaries = {
              first_audio: metricSummary(metrics.first_audio_ms),
              hot_library: metricSummary(metrics.hot_library_ms),
              upload: metricSummary(metrics.upload_ms),
              download: metricSummary(metrics.download_ms),
              metadata_edit: metricSummary(metrics.metadata_edit_ms),
              metadata_reload: metricSummary(metrics.metadata_reload_ms),
              reload: metricSummary(metrics.reload_ms),
              playback_operation: metricSummary(metrics.playback_operation_ms),
              playback_start_spread: metricSummary(metrics.playback_start_spread_ms),
            };
            report.soak.metric_summaries = summaries;
            report.soak.budgets = {
              first_audio: {
                budget_ms: SOAK_FIRST_AUDIO_BUDGET_MS,
                p95_ms: summaries.first_audio.p95_ms,
                samples: summaries.first_audio.samples,
                within_budget:
                  summaries.first_audio.samples > 0 &&
                  summaries.first_audio.p95_ms <= SOAK_FIRST_AUDIO_BUDGET_MS,
              },
              hot_library: {
                budget_ms: SOAK_HOT_LIBRARY_BUDGET_MS,
                p95_ms: summaries.hot_library.p95_ms,
                samples: summaries.hot_library.samples,
                within_budget:
                  summaries.hot_library.samples > 0 &&
                  summaries.hot_library.p95_ms <= SOAK_HOT_LIBRARY_BUDGET_MS,
              },
            };

            const firstAudioBudgetOk = report.soak.budgets.first_audio.within_budget;
            const hotLibraryBudgetOk = report.soak.budgets.hot_library.within_budget;
            markScenario(
              "mixed_first_audio_budget",
              firstAudioBudgetOk ? "PASS" : "FAIL",
              firstAudioBudgetOk ? null : "P1",
              `p95=${summaries.first_audio.p95_ms} ms; budget<=${SOAK_FIRST_AUDIO_BUDGET_MS} ms; samples=${summaries.first_audio.samples}`,
            );
            markScenario(
              "mixed_hot_library_budget",
              hotLibraryBudgetOk ? "PASS" : "FAIL",
              hotLibraryBudgetOk ? null : "P1",
              `p95=${summaries.hot_library.p95_ms} ms; budget<=${SOAK_HOT_LIBRARY_BUDGET_MS} ms; samples=${summaries.hot_library.samples}`,
            );

            markScenario(
              "mixed_playback",
              "PASS",
              null,
              `${metrics.first_audio_ms.length} playback starts completed during the soak`,
            );
            markScenario(
              "mixed_upload",
              "PASS",
              null,
              `${createdUploads.length} real audio uploads committed and remained isolated after final Reload`,
            );
            markScenario(
              "mixed_metadata_edit",
              "PASS",
              null,
              `${metrics.metadata_edit_ms.length} metadata edits persisted through Reload`,
            );
            markScenario(
              "mixed_master_download",
              "PASS",
              null,
              `${metrics.download_ms.length} MASTER MP3 downloads materialized during the soak`,
            );
            markScenario(
              "mixed_reload_persistence",
              "PASS",
              null,
              `${metrics.reload_ms.length + metrics.metadata_reload_ms.length} Reload cycles preserved identity/vault/transport`,
            );
            markScenario(
              "mixed_workload_concurrency",
              "PASS",
              null,
              `Seven rotating real accounts remained under mixed workload for ${soakElapsedMs} ms`,
            );
            markScenario(
              "mixed_post_workload_isolation",
              "PASS",
              null,
              "Final authoritative Reload preserved seven unique accounts/vaults/transports; all soak uploads remained vault-isolated",
            );

            report.timings = {
              startup_ms: startupMs,
              mixed_soak_ms: soakElapsedMs,
              final_authoritative_reload_ms: Date.now() - finalReloadStartedAt,
              first_audio_p95_ms: summaries.first_audio.p95_ms,
              hot_library_p95_ms: summaries.hot_library.p95_ms,
            };
            report.transport_distribution = Object.fromEntries(
              [...new Set(before.map(snapshot => snapshot.direct.transport_id))].map(transportId => [
                transportId,
                before.filter(snapshot => snapshot.direct.transport_id === transportId).length,
              ]),
            );

            finalSnapshots.forEach((snapshot, index) => {
              Object.assign(report.accounts[accounts[index].label], {
                soak_role_counts: roleCounts[accounts[index].label],
                session_id_after_soak: snapshot.direct.session_id,
                library_beats_after_soak: finalLibraryResults[index].library.beat_count,
                final_library_ready_ms: finalLibraryResults[index].ready_ms,
                visible_error_after_soak: snapshot.visible_error,
              });
            });

            for (const [label, observer] of authObservers) {
              validateAuthHealth(observer.snapshot(), label);
            }
            markScenario(
              "auth_health_stability",
              "PASS",
              null,
              diagnosticSoakRound
                ? "No observed health probe failed during the diagnostic mixed-soak reproduction"
                : "No observed health probe failed during the 30-minute mixed soak",
            );

            if (!firstAudioBudgetOk || !hotLibraryBudgetOk) {
              report.overall = "FAIL";
              report.severity = "P1";
              await writeReport();
              throw taggedError(
                `Mixed soak completed functionally but missed performance budget(s): first_audio_p95=${summaries.first_audio.p95_ms} ms, hot_library_p95=${summaries.hot_library.p95_ms} ms.`,
                "STAGE1_MIXED_SOAK_BUDGET_MISS",
                "P1",
              );
            }

            report.overall = "PASS";
            report.severity = null;
            await writeReport();
            console.log(
              `[stage1-real] PASS mixed-soak accounts=${accountCount} duration_ms=${soakElapsedMs}; rotations=${SOAK_ROTATIONS}; large_transfer_mb=${largeUpload.source_bytes / (1024 * 1024)}. report=${REPORT_FILE}`,
            );
            return;
          }

          const mixedBeatName = mixedUploadBeatName(accounts[2]);
          for (const observer of authObservers.values()) {
            observer.setPhase("mixed-workload-concurrency");
          }

          const mixedStartedAt = Date.now();
          const mixedTasks = [
            {
              name: "playback",
              scenario: "mixed_playback",
              run: runConcurrentPlayback(
                clients.slice(0, 2),
                playbackFixtures.slice(0, 2),
              ),
            },
            {
              name: "upload",
              scenario: "mixed_upload",
              run: uploadNamedMp3Fixture(
                clients[2],
                accounts[2],
                mixedBeatName,
              ),
            },
            {
              name: "metadata",
              scenario: "mixed_metadata_edit",
              run: editFixtureMetadata(
                clients[3],
                accounts[3],
                playbackFixtures[3],
              ),
            },
            {
              name: "download",
              scenario: "mixed_master_download",
              run: downloadFixtureMaster(
                clients[4],
                accounts[4],
                playbackFixtures[4],
              ),
            },
            {
              name: "reload-06",
              scenario: "mixed_reload_persistence",
              run: reloadDuringMixedWorkload(
                clients[5],
                accounts[5],
                before[5],
              ),
            },
            {
              name: "reload-07",
              scenario: "mixed_reload_persistence",
              run: reloadDuringMixedWorkload(
                clients[6],
                accounts[6],
                before[6],
              ),
            },
          ];

          const mixedResults = await Promise.allSettled(
            mixedTasks.map(task => task.run),
          );
          const mixedMs = Date.now() - mixedStartedAt;
          const mixedFailures = mixedResults
            .map((result, index) => ({ result, task: mixedTasks[index] }))
            .filter(({ result }) => result.status === "rejected");

          if (mixedFailures.length > 0) {
            for (const { task } of mixedFailures) {
              markScenario(
                task.scenario,
                "FAIL",
                "P1",
                `Mixed role ${task.name} failed while the other roles were active.`,
              );
            }
            throw taggedError(
              mixedFailures
                .map(({ result, task }) =>
                  `${task.name}: ${String(result.reason?.message || result.reason).slice(0, 600)}`
                )
                .join(" | "),
              "STAGE1_MIXED_WORKLOAD_FAILED",
              "P1",
            );
          }

          const playbackRun = mixedResults[0].value;
          const mixedUpload = mixedResults[1].value;
          const metadataEdit = mixedResults[2].value;
          const masterDownload = mixedResults[3].value;
          const reload06 = mixedResults[4].value;
          const reload07 = mixedResults[5].value;

          markScenario(
            "mixed_playback",
            "PASS",
            null,
            `Accounts 01-02 advanced real playback while upload/edit/download/Reload operations were in flight; start_spread_ms=${playbackRun.start_spread_ms}`,
          );
          markScenario(
            "mixed_master_download",
            "PASS",
            null,
            "Account 05 materialized a real MASTER MP3 while the other mixed roles were active",
          );
          markScenario(
            "mixed_reload_persistence",
            "PASS",
            null,
            "Accounts 06-07 reloaded during the mixed workload and preserved user/client/vault/transport identity",
          );
          markScenario(
            "mixed_workload_concurrency",
            "PASS",
            null,
            `Six concurrent role operations covered all 7 accounts in ${mixedMs} ms`,
          );

          report.accounts["01"].mixed_role = {
            role: "playback",
            playback: playbackRun.accounts[0],
          };
          report.accounts["02"].mixed_role = {
            role: "playback",
            playback: playbackRun.accounts[1],
          };
          report.accounts["03"].mixed_role = {
            role: "upload",
            upload: mixedUpload,
          };
          report.accounts["04"].mixed_role = {
            role: "metadata_edit",
            metadata_after_save: metadataEdit,
          };
          report.accounts["05"].mixed_role = {
            role: "master_download",
            master_download: masterDownload,
          };
          report.accounts["06"].mixed_role = {
            role: "reload",
            reload: reload06,
          };
          report.accounts["07"].mixed_role = {
            role: "reload",
            reload: reload07,
          };

          for (const observer of authObservers.values()) {
            observer.setPhase("mixed-post-workload-authoritative-reload");
          }

          const postReloadStartedAt = Date.now();
          await Promise.all(clients.map(client => client.refresh()));

          const finalLibraries = await Promise.all(
            accounts.map((account, index) =>
              waitForAuthoritativeLibrary(clients[index], account.label)
            ),
          );
          const finalSnapshots = await Promise.all(
            accounts.map((account, index) =>
              waitForRuntimeSnapshot(clients[index], account.label)
            ),
          );

          finalSnapshots.forEach((snapshot, index) => {
            validateSingleAccount(accounts[index].label, snapshot);
            validatePersistentReload(before[index], snapshot, accounts[index].label);
          });
          validateCrossAccountIsolation(finalSnapshots);

          const finalPlaybackFixtures = await Promise.all(
            accounts.map((account, index) =>
              waitForPlaybackBeat(clients[index], account)
            ),
          );
          finalPlaybackFixtures.forEach((beat, index) => {
            assert.equal(
              beat.beat_id,
              playbackFixtures[index].beat_id,
              `Account ${accounts[index].label} playback fixture changed identity after mixed workload.`,
            );
          });
          await validatePlaybackFixtureIsolation(clients);

          const uploadPersisted = await waitForNamedBeatCommitted(
            clients[2],
            accounts[2],
            mixedUpload.beat_name,
          );
          assert.equal(
            uploadPersisted.beat_id,
            mixedUpload.beat_id,
            "Account 03 mixed upload changed identity after authoritative Reload.",
          );
          const mixedUploadVisibility = await validateNamedFixtureIsolation(
            clients,
            2,
            mixedUpload,
          );
          markScenario(
            "mixed_upload",
            "PASS",
            null,
            "Account 03 uploaded a new MP3 during concurrent activity; it persisted after Reload and remained isolated to its vault",
          );

          const metadataPersisted = await verifyFixtureMetadataAfterReload(
            clients[3],
            accounts[3],
            playbackFixtures[3],
          );
          markScenario(
            "mixed_metadata_edit",
            "PASS",
            null,
            "Account 04 committed BPM/Key during concurrent activity and preserved the edit after Reload",
          );

          const postReloadMs = Date.now() - postReloadStartedAt;

          finalSnapshots.forEach((snapshot, index) => {
            Object.assign(report.accounts[accounts[index].label], {
              session_id_after_mixed_reload: snapshot.direct.session_id,
              library_beats_after_mixed_reload: finalLibraries[index].beat_count,
              visible_error_after_mixed_reload: snapshot.visible_error,
            });
          });
          report.accounts["03"].mixed_role.upload_after_reload = uploadPersisted;
          report.accounts["03"].mixed_role.visibility_across_accounts =
            mixedUploadVisibility;
          report.accounts["04"].mixed_role.metadata_after_reload =
            metadataPersisted;

          markScenario(
            "mixed_post_workload_isolation",
            "PASS",
            null,
            "All 7 accounts survived the authoritative post-workload Reload with unique users/client ids/vaults; fixtures remained isolated",
          );

          report.timings = {
            startup_ms: startupMs,
            mixed_workload_ms: mixedMs,
            post_mixed_authoritative_reload_ms: postReloadMs,
            playback_start_spread_ms: playbackRun.start_spread_ms,
          };

          report.transport_distribution = Object.fromEntries(
            [
              ...new Set(
                before.map(snapshot => snapshot.direct.transport_id),
              ),
            ].map(transportId => [
              transportId,
              before.filter(
                snapshot => snapshot.direct.transport_id === transportId,
              ).length,
            ]),
          );

          for (const [label, observer] of authObservers) {
            validateAuthHealth(observer.snapshot(), label);
          }

          markScenario(
            "auth_health_stability",
            "PASS",
            null,
            "No observed health probe failed during the 7-account mixed workload",
          );

          report.overall = "PASS";
          report.severity = null;
          await writeReport();

          console.log(
            `[stage1-real] PASS mixed-workload accounts=${accountCount}; playback+upload+metadata+download+reload overlapped and persisted. report=${REPORT_FILE}`,
          );
          return;
        }

        const reloadStartedAt = Date.now();

        for (const observer of authObservers.values()) {
          observer.setPhase("simultaneous-reload");
        }

        await Promise.all(
          clients.map(client => client.refresh()),
        );

        const librariesAfter = await Promise.all(
          accounts.map((account, index) =>
            waitForAuthoritativeLibrary(
              clients[index],
              account.label,
            )
          ),
        );

        const after = await Promise.all(
          accounts.map((account, index) =>
            waitForRuntimeSnapshot(
              clients[index],
              account.label,
            )
          ),
        );

        const reloadMs = Date.now() - reloadStartedAt;

        after.forEach((snapshot, index) =>
          validateSingleAccount(
            accounts[index].label,
            snapshot,
          )
        );

        if (!singleAccountDiagnostic) validateCrossAccountIsolation(after);

        before.forEach((snapshot, index) =>
          validatePersistentReload(
            snapshot,
            after[index],
            accounts[index].label,
          )
        );

        markScenario(
          "simultaneous_reload_persistent_assignment",
          "PASS",
          null,
          singleAccountDiagnostic
            ? "Single-account diagnostic Reload preserved the persistent assignment"
            : `${accountCount} simultaneous reloads preserved assignment`,
        );

        const playbackAfterReload = await Promise.all(
          accounts.map((account, index) =>
            waitForPlaybackBeat(clients[index], account)
          ),
        );

        playbackAfterReload.forEach((beat, index) => {
          assert.equal(
            beat.beat_id,
            playbackFixtures[index].beat_id,
            `Account ${accounts[index].label} playback fixture identity changed after Reload.`,
          );
        });

        if (!singleAccountDiagnostic) await validatePlaybackFixtureIsolation(clients);

        const playbackRun = await runConcurrentPlayback(
          clients,
          playbackAfterReload,
        );

        if (!singleAccountDiagnostic) {
          markScenario(
            "playback_concurrency",
            "PASS",
            null,
            `${accountCount} accounts advanced real playback concurrently; start_spread_ms=${playbackRun.start_spread_ms}; soft_target_exceeded=${playbackRun.soft_target_exceeded}`,
          );
        }

        if (focusedLifecycle) {
          const seek = await seekThroughPlayerUi(clients[0], accounts[0]);
          markScenario(
            "focused_seek",
            "PASS",
            null,
            `Player scrubber moved currentTime by ${seek.seek_delta}s and playback continued to ${seek.current_time_after_continue}s`,
          );

          const logoutRelogin = await logoutReloginAuthoritative(
            clients[0],
            accounts[0],
            after[0],
            playbackAfterReload[0],
          );
          markScenario(
            "focused_logout_relogin_authoritative",
            "PASS",
            null,
            "Real Sign out cleared auth state; relogin without profile reset preserved installation/user/vault/transport and reopened the authoritative fixture",
          );

          const observer = authObservers.get(accounts[0].label);
          validateAuthHealth(observer?.snapshot() || [], accounts[0].label);
          markScenario(
            "auth_health_stability",
            "PASS",
            null,
            "No observed health probe failed during focused seek + logout/relogin",
          );

          report.accounts[accounts[0].label] = {
            ...report.accounts[accounts[0].label],
            login_ms: loginTimes[0],
            user_id: after[0].user_id,
            client_id: after[0].client_id,
            vault_chat_id: after[0].direct.chat_id,
            transport_id: after[0].direct.transport_id,
            playback_fixture: {
              beat_id: playbackAfterReload[0].beat_id,
              beat_name: playbackAfterReload[0].beat_name,
              created_this_run: playbackFixtures[0].created,
            },
            playback: playbackRun.accounts[0],
            seek,
            logout_relogin: logoutRelogin,
          };
          report.timings = {
            startup_ms: startupMs,
            simultaneous_reload_ms: reloadMs,
            playback_start_spread_ms: playbackRun.start_spread_ms,
            relogin_ms: logoutRelogin.relogin_ms,
          };
          report.overall = "PASS";
          report.severity = null;
          await writeReport();
          console.log(
            `[stage1-real] PASS focused lifecycle account=${accounts[0].label}; seek+logout+relogin authoritative. report=${REPORT_FILE}`,
          );
          return;
        }

        report.accounts = Object.fromEntries(
          accounts.map((account, index) => [
            account.label,
            {
              ...report.accounts[account.label],
              login_ms: loginTimes[index],
              user_id: before[index].user_id,
              client_id: before[index].client_id,
              vault_chat_id: before[index].direct.chat_id,
              transport_id: before[index].direct.transport_id,
              transport_user_id:
                before[index].direct.transport_user_id,
              membership_bootstrap_mode:
                before[index].direct.mode,
              session_id_before:
                before[index].direct.session_id,
              session_id_after:
                after[index].direct.session_id,
              library_beats_before:
                librariesBefore[index].beat_count,
              library_beats_after:
                librariesAfter[index].beat_count,
              visible_error_before:
                before[index].visible_error,
              visible_error_after:
                after[index].visible_error,
              playback_fixture: {
                beat_id: playbackAfterReload[index].beat_id,
                beat_name: playbackAfterReload[index].beat_name,
                created_this_run: playbackFixtures[index].created,
              },
              playback: playbackRun.accounts[index],
              before_reload: {
                user_id: before[index].user_id,
                client_id: before[index].client_id,
                vault_chat_id:
                  before[index].direct.chat_id,
                transport_id:
                  before[index].direct.transport_id,
                transport_user_id:
                  before[index].direct.transport_user_id,
                expected_bot_id:
                  before[index].direct.expected_bot_id,
              },
              after_reload: {
                user_id: after[index].user_id,
                client_id: after[index].client_id,
                vault_chat_id:
                  after[index].direct.chat_id,
                transport_id:
                  after[index].direct.transport_id,
                transport_user_id:
                  after[index].direct.transport_user_id,
                expected_bot_id:
                  after[index].direct.expected_bot_id,
              },
            },
          ]),
        );


        const metadataEdits = await Promise.all(
          accounts.map((account, index) =>
            editFixtureMetadata(clients[index], account, playbackAfterReload[index])
          ),
        );

        for (const observer of authObservers.values()) {
          observer.setPhase("metadata-persistence-reload");
        }

        await Promise.all(clients.map(client => client.refresh()));
        await Promise.all(
          accounts.map((account, index) =>
            waitForAuthoritativeLibrary(clients[index], account.label)
          ),
        );

        const metadataPersisted = await Promise.all(
          accounts.map((account, index) =>
            verifyFixtureMetadataAfterReload(
              clients[index],
              account,
              playbackAfterReload[index],
            )
          ),
        );

        metadataPersisted.forEach((result, index) => {
          report.accounts[accounts[index].label].metadata = {
            ...metadataEdits[index],
            ...result,
          };
        });

        markScenario(
          "metadata_edit_persistence",
          "PASS",
          null,
          `${accountCount} accounts committed BPM/Key edits and preserved them across Reload`,
        );

        const downloads = await Promise.all(
          accounts.map((account, index) =>
            downloadFixtureMaster(
              clients[index],
              account,
              playbackAfterReload[index],
            )
          ),
        );

        downloads.forEach((result, index) => {
          report.accounts[accounts[index].label].master_download = result;
        });

        markScenario(
          "master_download",
          "PASS",
          null,
          `${accountCount} accounts streamed and materialized real MASTER MP3 downloads`,
        );

        const removals = await Promise.all(
          accounts.map((account, index) =>
            removeFixtureFromLibrary(
              clients[index],
              account,
              playbackAfterReload[index],
            )
          ),
        );

        removals.forEach((result, index) => {
          report.accounts[accounts[index].label].remove_from_library = result;
        });

        const trashBeforeReload = await Promise.all(
          accounts.map((account, index) =>
            openTrashAndVerifyFixture(
              clients[index],
              account,
              playbackAfterReload[index],
              playbackAfterReload,
              "before Reload",
            )
          ),
        );

        trashBeforeReload.forEach((result, index) => {
          report.accounts[accounts[index].label].trash = {
            beat_id: result.beat_id,
            visible_before_reload: result.visible,
            matched_by_authoritative_trash_identity_before_reload:
              result.matched_by_authoritative_trash_identity,
            cross_account_fixture_visible_before_reload:
              result.cross_account_fixture_visible,
            observed_trash_item_count_before_reload:
              result.observed_trash_item_count,
          };
        });

        for (const observer of authObservers.values()) {
          observer.setPhase("trash-visibility-reload");
        }

        await Promise.all(clients.map(client => client.refresh()));
        await Promise.all(
          accounts.map((account, index) =>
            waitForAuthoritativeLibrary(clients[index], account.label)
          ),
        );

        await Promise.all(
          accounts.map((account, index) =>
            verifyFixtureAbsentFromLibrary(
              clients[index],
              account,
              playbackAfterReload[index],
              "Remove + Reload",
            )
          ),
        );

        removals.forEach((_, index) => {
          report.accounts[accounts[index].label].remove_from_library.absent_after_reload = true;
        });

        markScenario(
          "remove_from_library_persistence",
          "PASS",
          null,
          `${accountCount} removals stayed absent from the authoritative library after Reload`,
        );

        const trashAfterReload = await Promise.all(
          accounts.map((account, index) =>
            openTrashAndVerifyFixture(
              clients[index],
              account,
              playbackAfterReload[index],
              playbackAfterReload,
              "after Reload",
            )
          ),
        );

        trashAfterReload.forEach((result, index) => {
          Object.assign(report.accounts[accounts[index].label].trash, {
            visible_after_reload: result.visible,
            matched_by_authoritative_trash_identity_after_reload:
              result.matched_by_authoritative_trash_identity,
            cross_account_fixture_visible_after_reload:
              result.cross_account_fixture_visible,
            observed_trash_item_count_after_reload:
              result.observed_trash_item_count,
          });
        });

        markScenario(
          "trash_visibility_persistence",
          "PASS",
          null,
          `${accountCount} fixtures remained in isolated Trash views after authoritative Reload`,
        );

        const firstPurge = await purgeFixtureThroughTrashUi(
          clients[0],
          accounts[0],
          playbackAfterReload[0],
        );
        Object.assign(report.accounts[accounts[0].label].trash, firstPurge);

        if (accountCount > 1) {
          for (const observer of authObservers.values()) {
            observer.setPhase("trash-cross-vault-purge-isolation");
          }

          await Promise.all(clients.slice(1).map(client => client.refresh()));
          await Promise.all(
            accounts.slice(1).map((account, offset) =>
              waitForAuthoritativeLibrary(clients[offset + 1], account.label)
            ),
          );

          await Promise.all(
            accounts.slice(1).map((account, offset) =>
              verifyFixtureAbsentFromLibrary(
                clients[offset + 1],
                account,
                playbackAfterReload[offset + 1],
                "another vault purge",
              )
            ),
          );

          const survivedFirstVaultPurge = await Promise.all(
            accounts.slice(1).map((account, offset) =>
              openTrashAndVerifyFixture(
                clients[offset + 1],
                account,
                playbackAfterReload[offset + 1],
                playbackAfterReload,
                `after Account ${accounts[0].label} purged its own vault`,
              )
            ),
          );

          survivedFirstVaultPurge.forEach((result, offset) => {
            Object.assign(report.accounts[accounts[offset + 1].label].trash, {
              survived_other_vault_purge_after_authoritative_reload: result.visible,
              cross_account_fixture_visible_after_other_vault_purge:
                result.cross_account_fixture_visible,
            });
          });
        }

        const remainingPurges = await Promise.all(
          accounts.slice(1).map((account, offset) =>
            purgeFixtureThroughTrashUi(
              clients[offset + 1],
              account,
              playbackAfterReload[offset + 1],
            )
          ),
        );

        remainingPurges.forEach((result, offset) => {
          Object.assign(report.accounts[accounts[offset + 1].label].trash, result);
        });

        for (const observer of authObservers.values()) {
          observer.setPhase("trash-purge-persistence-reload");
        }

        await Promise.all(clients.map(client => client.refresh()));
        await Promise.all(
          accounts.map((account, index) =>
            waitForAuthoritativeLibrary(clients[index], account.label)
          ),
        );

        await Promise.all(
          accounts.map((account, index) =>
            verifyFixtureAbsentFromLibrary(
              clients[index],
              account,
              playbackAfterReload[index],
              "Empty Trash + Reload",
            )
          ),
        );

        const trashAfterPurgeReload = await Promise.all(
          accounts.map((account, index) =>
            verifyFixtureAbsentFromTrashAfterReload(
              clients[index],
              account,
              playbackAfterReload[index],
            )
          ),
        );

        trashAfterPurgeReload.forEach((result, index) => {
          Object.assign(report.accounts[accounts[index].label].trash, {
            absent_from_library_after_purge_reload: true,
            absent_from_trash_after_purge_reload:
              result.absent_from_trash_after_purge_reload,
            observed_trash_item_count_after_purge_reload:
              result.observed_trash_item_count,
          });
        });

        markScenario(
          "trash_purge_persistence",
          "PASS",
          null,
          accountCount === 1
            ? "Fixture was purged permanently and stayed absent from Library + Trash after Reload"
            : `${accountCount} vaults purged their fixtures; Account ${accounts[0].label} purge was proven isolated before the remaining vaults purged, and no fixture resurrected after Reload`,
        );

        report.timings = {
          startup_ms: startupMs,
          simultaneous_reload_ms: reloadMs,
          playback_start_spread_ms: playbackRun.start_spread_ms,
        };

        report.transport_distribution = Object.fromEntries(
          [
            ...new Set(
              before.map(
                snapshot =>
                  snapshot.direct.transport_id,
              ),
            ),
          ].map(transportId => [
            transportId,
            before.filter(
              snapshot =>
                snapshot.direct.transport_id === transportId,
            ).length,
          ]),
        );

        for (const [label, observer] of authObservers) {
          validateAuthHealth(
            observer.snapshot(),
            label,
          );
        }

        markScenario(
          "auth_health_stability",
          "PASS",
          null,
          "No observed health probe failed; Web auth no longer depends on a mandatory health preflight",
        );

        report.overall = "PASS";
        report.severity = null;

        await writeReport();

        console.log(
          `[stage1-real] PASS accounts=${accountCount} isolated; reload preserved vault+transport. report=${REPORT_FILE}`,
        );
      } catch (error) {
        const severity = error?.severity || "P1";

        report.overall =
          error?.code === "STAGE1_COHORT_MISSING"
            ? "BLOCKED"
            : "FAIL";

        report.severity = severity;

        report.failure = {
          code: String(
            error?.code || "STAGE1_E2E_FAILURE",
          ),
          severity,
          message: String(error?.message || error),
        };

        if (
          String(error?.code).startsWith(
            "STAGE1_HEALTH_",
          )
        ) {
          markScenario(
            "auth_health_stability",
            "FAIL",
            severity,
          );
        }

        const coreFailureScenarios = focusedIsolation
          ? ["authoritative_library_data_plane", "multi_account_auth_isolation", "multi_account_direct_identity"]
          : focusedDownloadIntegrity
          ? [
              "authoritative_library_data_plane",
            ]
          : mixedWorkload
          ? [
              "multi_account_auth_isolation",
              "authoritative_library_data_plane",
              "multi_account_direct_identity",
              "playback_fixture_provisioning",
              "mixed_workload_concurrency",
            ]
          : focusedIsolation
            ? [
                "multi_account_auth_isolation",
                "authoritative_library_data_plane",
                "multi_account_direct_identity",
                "playback_fixture_provisioning",
              ]
            : focusedLifecycle
              ? [
                  "authoritative_library_data_plane",
                  "playback_fixture_provisioning",
                ]
              : [
                "multi_account_auth_isolation",
                "authoritative_library_data_plane",
                "multi_account_direct_identity",
                "simultaneous_reload_persistent_assignment",
                "playback_fixture_provisioning",
                "playback_concurrency",
              ];

        for (const name of coreFailureScenarios) {
          if (
            scenario(name)?.status === "NOT_TESTED" &&
            (
              error?.code !== "STAGE1_LOGIN_FAILED" ||
              name === "multi_account_auth_isolation"
            )
          ) {
            markScenario(
              name,
              report.overall === "BLOCKED"
                ? "BLOCKED"
                : "FAIL",
              severity,
            );
          }
        }

        const postCoreScenarios = focusedIsolation
          ? ["offensive_installation_isolation", "offensive_session_isolation", "offensive_capability_isolation", "offensive_media_reference_isolation", "same_profile_account_switch_isolation", "final_authoritative_isolation"]
          : focusedDownloadIntegrity
          ? [
              "focused_download_wav_integrity",
              "focused_download_project_integrity",
              "focused_download_mp3_audio_integrity",
              "focused_download_mp3_id3_integrity",
            ]
          : mixedWorkload
          ? [
              "mixed_playback",
              "mixed_upload",
              "mixed_metadata_edit",
              "mixed_master_download",
              "mixed_reload_persistence",
              "mixed_post_workload_isolation",
              ...(soakMode
                ? [
                    "mixed_soak_duration",
                    "mixed_role_rotation",
                    "mixed_large_transfer",
                    "mixed_hot_library_budget",
                    "mixed_first_audio_budget",
                  ]
                : []),
            ]
          : focusedIsolation
            ? [
                "offensive_installation_isolation",
                "offensive_session_isolation",
                "offensive_capability_isolation",
                "offensive_media_reference_isolation",
                "same_profile_account_switch_isolation",
                "final_authoritative_isolation",
              ]
            : focusedLifecycle
              ? [
                  "focused_seek",
                  "focused_logout_relogin_authoritative",
                ]
              : [
                "metadata_edit_persistence",
                "master_download",
                "remove_from_library_persistence",
                "trash_visibility_persistence",
                "trash_purge_persistence",
              ];
        const coreReachedPostPhase = (
          mixedWorkload
            ? [
                "multi_account_auth_isolation",
                "authoritative_library_data_plane",
                "multi_account_direct_identity",
                "playback_fixture_provisioning",
              ]
            : focusedLifecycle
              ? [
                  "authoritative_library_data_plane",
                  "playback_fixture_provisioning",
                ]
              : [
                  "multi_account_auth_isolation",
                  "authoritative_library_data_plane",
                  "multi_account_direct_identity",
                  "simultaneous_reload_persistent_assignment",
                  "playback_fixture_provisioning",
                  "playback_concurrency",
                ]
        ).every(name => {
          const status = scenario(name)?.status;
          return status === "PASS" || (singleAccountDiagnostic && status === "SKIPPED");
        });

        if (!coreReachedPostPhase || report.overall === "BLOCKED") {
          for (const name of postCoreScenarios) {
            if (scenario(name)?.status === "NOT_TESTED") {
              markScenario(name, "BLOCKED", severity, "Not reached because an earlier Stage 1 gate failed.");
            }
          }
        } else {
          let firstPending = true;
          for (const name of postCoreScenarios) {
            if (scenario(name)?.status !== "NOT_TESTED") continue;
            markScenario(
              name,
              firstPending ? "FAIL" : "BLOCKED",
              severity,
              firstPending
                ? "This was the active Stage 1 scenario when the run failed."
                : "Not reached because the previous Stage 1 scenario failed.",
            );
            firstPending = false;
          }
        }

        await writeReport();
        await archiveFocusedDownloadIntegrityReport();
        throw error;
      } finally {
        await Promise.allSettled(
          [...authObservers.values()].map(
            observer => observer.remove(),
          ),
        );

        authObservers.clear();
        await fs.rm(PLAYBACK_TMP_DIR, { recursive: true, force: true }).catch(() => {});
        await fs.rm(DOWNLOAD_INTEGRITY_TMP_DIR, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});
