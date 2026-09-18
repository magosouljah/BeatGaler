import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { observeAuth } from "./stage1-auth-observer.mjs";
import { validateAuthHealth } from "./stage1-health-validation.mjs";

const authObservers = new Map();

const REPORT_DIR = path.resolve(process.cwd(), "tmp");
const REPORT_FILE = path.join(REPORT_DIR, "stage1-real-multi-account-report.json");
const SESSION_COOKIE = "__Host-beatgaler_session";
const CSRF_COOKIE = "__Host-beatgaler_csrf";
const cohortId = String(process.env.STAGE1_COHORT_ID || "").trim();
const cohortPassword = String(process.env.STAGE1_COHORT_PASSWORD || "").trim();
const accountCount = Math.max(1, Number(process.env.STAGE1_RUN_ACCOUNTS || 2));
const singleAccountDiagnostic = accountCount === 1;
const PLAYBACK_FIXTURE_FILE = path.resolve(process.cwd(), "tests", "e2e-web", "fixtures", "stage1-playback.mp3");
const PLAYBACK_TMP_DIR = path.resolve(process.cwd(), "tmp", "stage1-playback-fixtures");
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
  version: 6,
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
    { name: "simultaneous_reload_persistent_assignment", status: "NOT_TESTED", severity: null },
    { name: "playback_fixture_provisioning", status: "NOT_TESTED", severity: null },
    { name: "playback_concurrency", status: "NOT_TESTED", severity: null },
    { name: "metadata_edit_persistence", status: "NOT_TESTED", severity: null },
    { name: "master_download", status: "NOT_TESTED", severity: null },
    { name: "remove_from_library_persistence", status: "NOT_TESTED", severity: null },
    { name: "trash_visibility_persistence", status: "NOT_TESTED", severity: null },
    { name: "trash_purge_persistence", status: "NOT_TESTED", severity: null },
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

async function loginThroughUi(client, account) {
  const startedAt = Date.now();
  let phase = "installing-auth-observer";
  let observer;
  const setPhase = value => { phase = value; observer?.setPhase(value); };
  let failure = null;

  try {
    observer = await observeAuth(client);
    authObservers.set(account.label, observer);

    setPhase("profile-reset");
    await clearBrowserProfile(client, observer);

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

async function playbackIsolationSnapshot(client) {
  return client.execute(() => {
    const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll("[data-beat-card-id]"))
      .flatMap(card => Array.from(card.querySelectorAll("*"))
        .filter(node => node.children.length === 0)
        .map(node => normalize(node.textContent))
        .filter(value => /^Stage1 Playback \d{2}$/.test(value))
        .slice(0, 1))
      .sort();
  });
}

async function validatePlaybackFixtureIsolation(clients) {
  const snapshots = await Promise.all(clients.map(client => playbackIsolationSnapshot(client)));
  snapshots.forEach((names, index) => {
    assert.deepEqual(names, [playbackBeatName(accounts[index])], `Account ${accounts[index].label} must see only its own Stage 1 playback fixture.`);
  });
  return snapshots;
}

async function installPlaybackProbe(client, beatId) {
  await client.execute(id => {
    const previous = window.__beatgalerStage1PlaybackProbe;
    if (previous?.handler) window.removeEventListener("beatgaler:web-playback-state", previous.handler);
    const probe = { beatId: id, events: [], handler: null };
    probe.handler = event => {
      const detail = event?.detail || {};
      if (String(detail.beatId || "") !== id) return;
      probe.events.push({ at: Date.now(), current_time: Math.max(0, Number(detail.currentTime) || 0), playing: Boolean(detail.playing), waiting: Boolean(detail.waiting) });
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
    return {
      beat_id: probe?.beatId || null,
      event_count: events.length,
      max_current_time: events.reduce((max, event) => Math.max(max, Number(event.current_time) || 0), 0),
      playing_seen: playingEvents.length > 0,
      first_playing_at: playingEvents[0]?.at || null,
      waiting_seen: events.some(event => event.waiting),
      last: events.at(-1) || null,
    };
  });
}

async function waitForPlaybackProgress(client, account) {
  let latest = null;
  await client.waitUntil(async () => {
    latest = await playbackProbeSnapshot(client);
    return latest?.playing_seen === true && latest?.max_current_time >= PLAYBACK_MIN_PROGRESS_SECONDS;
  }, { timeout: 30_000, interval: 100, timeoutMsg: `Account ${account.label} did not prove real playback progress.` });
  return latest;
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

async function editFixtureMetadata(client, account, beat) {
  const expected = metadataForAccount(account);
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

async function verifyFixtureMetadataAfterReload(client, account, beat) {
  const expected = metadataForAccount(account);
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


describe("BeatGaler Stage 1 real multi-account Web E2E", () => {
  it(
    `runs ${accountCount} seeded real accounts concurrently and preserves productive authority across Reload`,
    async () => {
      if (!cohortId || !cohortPassword) {
        report.overall = "BLOCKED";

        report.failure = {
          code: "STAGE1_COHORT_MISSING",
          severity: null,
          message: "Reusable Stage 1 cohort is not seeded.",
        };

        await writeReport();

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

        for (const name of [
          "multi_account_auth_isolation",
          "authoritative_library_data_plane",
          "multi_account_direct_identity",
          "simultaneous_reload_persistent_assignment",
          "playback_fixture_provisioning",
          "playback_concurrency",
        ]) {
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

        const postCoreScenarios = [
          "metadata_edit_persistence",
          "master_download",
          "remove_from_library_persistence",
          "trash_visibility_persistence",
          "trash_purge_persistence",
        ];
        const coreReachedPostPhase = [
          "multi_account_auth_isolation",
          "authoritative_library_data_plane",
          "multi_account_direct_identity",
          "simultaneous_reload_persistent_assignment",
          "playback_fixture_provisioning",
          "playback_concurrency",
        ].every(name => {
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
        throw error;
      } finally {
        await Promise.allSettled(
          [...authObservers.values()].map(
            observer => observer.remove(),
          ),
        );

        authObservers.clear();
        await fs.rm(PLAYBACK_TMP_DIR, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});