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
const accountCount = Math.max(2, Number(process.env.STAGE1_RUN_ACCOUNTS || 2));
const PLAYBACK_FIXTURE_FILE = path.resolve(process.cwd(), "tests", "e2e-web", "fixtures", "stage1-playback.mp3");
const PLAYBACK_TMP_DIR = path.resolve(process.cwd(), "tmp", "stage1-playback-fixtures");
const PLAYBACK_MIN_PROGRESS_SECONDS = 0.5;
const PLAYBACK_MAX_START_SPREAD_MS = 2_000;

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
  version: 4,
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
    concurrent_playback: true,
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
  return \`Stage1 Playback \${account.label}\`;
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
    return { beat_id: beatId, playback_disabled: artwork?.getAttribute("aria-disabled") === "true" };
  }, beatName);
}

async function waitForPlaybackBeat(client, account, timeout = 120_000) {
  const beatName = playbackBeatName(account);
  let latest = null;
  await client.waitUntil(async () => {
    latest = await playbackBeatSnapshot(client, beatName);
    return Boolean(latest?.beat_id);
  }, { timeout, interval: 500, timeoutMsg: \`Account \${account.label} did not materialize \${beatName}.\` });
  return { ...latest, beat_name: beatName };
}

async function provisionPlaybackBeat(client, account) {
  const existing = await playbackBeatSnapshot(client, playbackBeatName(account));
  if (existing?.beat_id) return { ...existing, beat_name: playbackBeatName(account), created: false };

  await fs.mkdir(PLAYBACK_TMP_DIR, { recursive: true });
  const localFixture = path.join(PLAYBACK_TMP_DIR, \`\${playbackBeatName(account)}.mp3\`);
  await fs.copyFile(PLAYBACK_FIXTURE_FILE, localFixture);

  const addButton = await client.$('//button[normalize-space(.)="Add beat"]');
  await addButton.waitForDisplayed({ timeout: 30_000 });
  await addButton.click();

  const chooseButton = await client.$('//button[contains(normalize-space(.), "Choose MP3 or WAV")]');
  await chooseButton.waitForDisplayed({ timeout: 30_000 });
  await chooseButton.click();

  const input = await client.$('input[type="file"][accept*=".mp3"]');
  await input.waitForExist({ timeout: 30_000 });
  await client.execute(element => {
    element.style.display = "block";
    element.style.position = "fixed";
    element.style.left = "-10000px";
    element.style.top = "0";
  }, input);

  const remoteFixture = await client.uploadFile(localFixture);
  await input.setValue(remoteFixture);

  const saveButton = await client.$('//button[starts-with(normalize-space(.), "Save")]');
  await saveButton.waitForDisplayed({ timeout: 30_000 });
  await saveButton.waitForEnabled({ timeout: 30_000 });
  await saveButton.click();

  const saved = await waitForPlaybackBeat(client, account);
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
    assert.deepEqual(names, [playbackBeatName(accounts[index])], \`Account \${accounts[index].label} must see only its own Stage 1 playback fixture.\`);
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
  }, { timeout: 30_000, interval: 100, timeoutMsg: \`Account \${account.label} did not prove real playback progress.\` });
  return latest;
}

async function runConcurrentPlayback(clients, playbackBeats) {
  await Promise.all(playbackBeats.map((beat, index) => installPlaybackProbe(clients[index], beat.beat_id)));

  const artworks = await Promise.all(playbackBeats.map(async (beat, index) => {
    const artwork = await clients[index].$(\`[data-beat-artwork-id="\${beat.beat_id}"]\`);
    await artwork.waitForDisplayed({ timeout: 30_000 });
    await clients[index].waitUntil(async () => (await artwork.getAttribute("aria-disabled")) !== "true", {
      timeout: 60_000,
      interval: 250,
      timeoutMsg: \`Account \${accounts[index].label} playback never became interactive.\`,
    });
    return artwork;
  }));

  const triggerStartedAt = Date.now();
  await Promise.all(artworks.map(artwork => artwork.click()));

  const snapshots = await Promise.all(clients.map((client, index) => waitForPlaybackProgress(client, accounts[index])));
  const starts = snapshots.map(snapshot => Number(snapshot.first_playing_at || 0));
  const startSpreadMs = Math.max(...starts) - Math.min(...starts);
  assert.ok(starts.every(Boolean), "Every account must observe the real HTMLAudioElement playing state.");
  assert.ok(startSpreadMs <= PLAYBACK_MAX_START_SPREAD_MS, \`Concurrent playback start spread was \${startSpreadMs} ms; expected <= \${PLAYBACK_MAX_START_SPREAD_MS} ms.\`);

  return { trigger_started_at: triggerStartedAt, start_spread_ms: startSpreadMs, accounts: snapshots };
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

        const playbackFixtures = await Promise.all(
          accounts.map((account, index) =>
            provisionPlaybackBeat(clients[index], account)
          ),
        );

        await validatePlaybackFixtureIsolation(clients);

        markScenario(
          "playback_fixture_provisioning",
          "PASS",
          null,
          `${accountCount} productive MASTER uploads committed to isolated authoritative libraries`,
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

        validateCrossAccountIsolation(after);

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
          `${accountCount} simultaneous reloads preserved assignment`,
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

        await validatePlaybackFixtureIsolation(clients);

        const playbackRun = await runConcurrentPlayback(
          clients,
          playbackAfterReload,
        );

        markScenario(
          "playback_concurrency",
          "PASS",
          null,
          `${accountCount} accounts advanced real playback concurrently; start_spread_ms=${playbackRun.start_spread_ms}`,
        );

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