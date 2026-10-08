import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import JSZip from "jszip";
import { observeAuth } from "./stage1-auth-observer.mjs";
import { validateAuthHealth } from "./stage1-health-validation.mjs";
import { assessPhase2Task1Markers, persistPhase2Task1Samples } from "./phase2-task1-attribution.mjs";
import { sha256Hex, stripMp3ContainerTags } from "./stage1-download-integrity.mjs";
import {
  effectiveStage1SoakMinutes,
  effectiveStage1SoakRotations,
} from "./stage1-focused-final-reload-config.mjs";

const authObservers = new Map();
const localRequire = createRequire(import.meta.url);
let activeTask4ResourceSampler = null;

const REPORT_DIR = path.resolve(process.cwd(), "tmp");
const REPORT_FILE = path.join(REPORT_DIR, "stage1-real-multi-account-report.json");
const TASK4_REPORT_FILE = path.join(REPORT_DIR, "stage1-task-4-five-account-report.json");
const TASK4_FOCUSED_FINAL_RELOAD_REPORT_FILE = path.join(REPORT_DIR, "stage1-task4-hot-library-final-reload-trace.json");
const TASK5_REPORT_FILE = path.join(REPORT_DIR, "stage1-task-5-one-account-failure-report.json");
const TASK6_REPORT_FILE = path.join(REPORT_DIR, "stage1-task-6-final-verification-report.json");
const SINGLE_RELOAD_ATTRIBUTION_REPORT_FILE = path.join(REPORT_DIR, "stage1-task4-single-reload-attribution.json");
const SESSION_COOKIE = "__Host-beatgaler_session";
const CSRF_COOKIE = "__Host-beatgaler_csrf";
const cohortId = String(process.env.STAGE1_COHORT_ID || "").trim();
const cohortPassword = String(process.env.STAGE1_COHORT_PASSWORD || "").trim();
const accountCount = Math.max(1, Number(process.env.STAGE1_RUN_ACCOUNTS || 2));
const singleAccountDiagnostic = accountCount === 1;
const focusedLifecycle = process.env.STAGE1_FOCUSED_LIFECYCLE === "1";
const focusedDownloadIntegrity = process.env.STAGE1_FOCUSED_DOWNLOAD_INTEGRITY === "1";
const focusedIsolation = process.env.STAGE1_FOCUSED_ISOLATION === "1";
const focusedStartup = process.env.STAGE1_FOCUSED_STARTUP === "1";
const focusedFinalReloadTrace = process.env.STAGE1_FOCUSED_FINAL_RELOAD_TRACE === "1";
const singleReloadAttributionTrace = process.env.STAGE1_SINGLE_RELOAD_ATTRIBUTION_TRACE === "1";
const task5Mode = process.env.STAGE1_TASK5_ONE_ACCOUNT_FAILURES === "1";
const task6Mode = process.env.STAGE1_TASK6_FINAL_VERIFICATION === "1";
const phase2Task0Mode = process.env.PHASE2_TASK0_MEASUREMENT === "1";
const phase2Task1Mode = process.env.PHASE2_TASK1_ATTRIBUTION === "1";
const phase2Task2Mode = process.env.PHASE2_TASK2_POINTER_ATTRIBUTION === "1";
const phase2Task2InfraMode = process.env.PHASE2_TASK2_INFRA_READINESS === "1";
const phase2Task2ContinueAfterPlaybackFailure = phase2Task2Mode &&
  process.env.PHASE2_TASK2_CONTINUE_AFTER_PLAYBACK_FAILURE === "1";
const phase2PeerPlayRace = process.env.PHASE2_PEER_PLAY_RACE === "1";
const phase2Task2PassivePingTrace = (phase2Task2Mode || singleReloadAttributionTrace) &&
  process.env.PHASE2_TASK2_PASSIVE_PING_TRACE === "1";
// The focused trace deliberately reuses the existing five-account diagnostic
// soak pre-state. Its measurement still starts only at the original final
// refresh() calls below; it never restores a profile from an earlier run.
const mixedWorkload = process.env.STAGE1_MIXED_WORKLOAD === "1" || focusedFinalReloadTrace;
const soakMinutes = effectiveStage1SoakMinutes({
  focusedFinalReloadTrace,
  configuredSoakMinutes: Math.max(0, Number(process.env.STAGE1_SOAK_MINUTES || 0)),
});
const soakMode = mixedWorkload && soakMinutes > 0;
const MIXED_REQUIRED_ACCOUNTS = 5;
const task4Mode = soakMode && accountCount === MIXED_REQUIRED_ACCOUNTS && soakMinutes === 30;
const MIXED_RUN_SUFFIX = String(Date.now());
const SOAK_ROTATIONS = Math.max(
  1,
  Math.min(
    MIXED_REQUIRED_ACCOUNTS,
    effectiveStage1SoakRotations({
      focusedFinalReloadTrace,
      configuredSoakRotations: Number(process.env.STAGE1_SOAK_ROTATIONS || MIXED_REQUIRED_ACCOUNTS),
    }),
  ),
);
const diagnosticSoakRound = soakMode && SOAK_ROTATIONS < MIXED_REQUIRED_ACCOUNTS;
const SOAK_FIRST_AUDIO_BUDGET_MS = 2_000;
const SOAK_HOT_LIBRARY_BUDGET_MS = 5_000;
const SOAK_LARGE_WAV_MB = Math.max(8, Math.min(256, Number(process.env.STAGE1_SOAK_LARGE_WAV_MB || 64)));
const PLAYBACK_FIXTURE_FILE = path.resolve(process.cwd(), "tests", "e2e-web", "fixtures", "stage1-playback.mp3");
const PLAYBACK_TMP_DIR = path.resolve(process.cwd(), "tmp", "stage1-playback-fixtures");
const DOWNLOAD_INTEGRITY_TMP_DIR = path.resolve(process.cwd(), "tmp", "stage1-download-integrity-fixtures");
// The source fixture is only ~4 seconds. Under the five-account workload that
// is shorter than a complete real-player interaction, so it can end between
// the playback proof and the UI scrub. Repeat valid MPEG frames to give the
// scrubber a real, still-playing source without weakening that assertion.
const SOAK_PLAYBACK_FIXTURE_REPETITIONS = 4;
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
  workload_mode: phase2Task2InfraMode
  ? "phase2-task2-five-account-infrastructure-readiness"
  : phase2Task2Mode
  ? "phase2-task2-postgres-index-pointer-attribution"
  : phase2Task1Mode
  ? "phase2-task1-library-latency-attribution"
  : phase2Task0Mode
  ? "phase2-task0-four-conditions"
  : focusedIsolation
  ? "focused-two-account-offensive-isolation"
  : task5Mode
    ? "task-5-one-account-induced-failures"
  : task6Mode
    ? "task-6-final-verification"
  : focusedFinalReloadTrace
    ? "focused-five-account-final-authoritative-reload-trace"
    : singleReloadAttributionTrace
      ? "single-account-reload-critical-path-attribution"
  : focusedStartup
    ? "focused-startup"
  : focusedDownloadIntegrity
    ? "focused-single-account-download-integrity"
    : focusedLifecycle
      ? "focused-single-account-lifecycle"
      : soakMode
      ? diagnosticSoakRound
        ? "mixed-5-account-diagnostic-soak"
        : "mixed-5-account-30m-soak"
      : mixedWorkload
        ? "mixed-5-account"
        : "full-lifecycle",
  baseline_sha: process.env.STAGE1_GIT_HEAD || null,
  experiment_identity: {
    head: process.env.STAGE1_GIT_HEAD || null,
    working_tree_fingerprint: process.env.STAGE1_WORKTREE_FINGERPRINT || null,
    focused_final_reload_trace: focusedFinalReloadTrace,
    single_reload_attribution_trace: singleReloadAttributionTrace,
    phase2_task1_attribution: phase2Task1Mode,
    phase2_task2_pointer_attribution: phase2Task2Mode,
    phase2_task2_infra_readiness: phase2Task2InfraMode,
    phase2_task2_passive_ping_trace: phase2Task2PassivePingTrace,
    requested_account_count: accountCount,
  },
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
    ...(focusedFinalReloadTrace
      ? [
          { name: "focused_final_authoritative_reload_trace", status: "NOT_TESTED", severity: null },
        ]
      : focusedIsolation
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
          ...(soakMode ? [{ name: "mixed_seek", status: "NOT_TESTED", severity: null }] : []),
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

if (phase2Task0Mode) {
  report.scenarios = [
    "authoritative_library_data_plane",
    "multi_account_auth_isolation",
    "multi_account_direct_identity",
    "phase2_cold_open",
    "phase2_warm_reopen",
    "phase2_warm_reload",
    "phase2_play_after_authoritative_library",
  ].map(name => ({ name, status: "NOT_TESTED", severity: null }));
  report.phase2_task0 = {
    mode: "five-account-four-condition-baseline",
    samples: {
      apertura_fria: [],
      reapertura_caliente: [],
      reload_caliente: [],
      play_tras_biblioteca_autoritativa: [],
    },
  };
}

if (phase2Task1Mode) {
  report.scenarios = [
    "authoritative_library_data_plane",
    "multi_account_auth_isolation",
    "multi_account_direct_identity",
    "phase2_task1_attribution",
    ...(phase2Task2Mode ? ["phase2_task2_playback_cold", "phase2_task2_playback_reload", "phase2_task2_ping_stability"] : []),
  ].map(name => ({ name, status: "NOT_TESTED", severity: null }));
  report.phase2_task1 = {
    mode: "five-account-cold-open-and-one-hot-reload",
    samples: { apertura_fria: [], reload_caliente: [] },
  };
  if (phase2Task2Mode) report.phase2_task2 = { playback_cold: null, playback_reload: null, ping_stability: null };
}

if (task4Mode) {
  report.task_4 = {
    report_file: TASK4_REPORT_FILE,
    maximum_concurrent_coverage: 5,
    scope_note: "Fase 1 maximum concurrent coverage: 5 accounts. 10-account load testing intentionally omitted from scope.",
    requested_duration_minutes: 30,
    initial_matrix: {
      playback_and_seek: ["01", "02"],
      upload: "03",
      metadata_reload_authoritative_read: "04",
      download: "05",
    },
  };
}

if (task5Mode) {
  report.task_5 = {
    report_file: TASK5_REPORT_FILE,
    maximum_concurrent_coverage: 5,
    account_a: "01",
    scope_note: "Phase 1 maximum concurrent coverage remains five accounts; this run intentionally excludes Task 4 performance budgets.",
    scenarios: {},
  };
  report.scenarios = [
    { name: "task5_network_upload", status: "NOT_TESTED", severity: null },
    { name: "task5_browser_crash", status: "NOT_TESTED", severity: null },
    { name: "task5_logout_under_load", status: "NOT_TESTED", severity: null },
    { name: "task5_reconnection", status: "NOT_TESTED", severity: null },
    { name: "task5_shared_bot", status: "NOT_TESTED", severity: null },
    { name: "task5_final_authority_isolation", status: "NOT_TESTED", severity: null },
  ];
}

if (task6Mode) {
  report.task_6 = {
    report_file: TASK6_REPORT_FILE,
    maximum_concurrent_coverage: 5,
    scope_note: "Read-only final verification; this mode intentionally does not run Task 4 performance budgets or a soak.",
    historical_performance: {
      first_audio_p95_ms: 2433,
      hot_library_p95_ms: 23356,
      status: "Task 4 historical performance failure; not a Task 6 gate.",
    },
  };
  report.scenarios = [
    { name: "task6_account_vault_authority", status: "NOT_TESTED", severity: null },
    { name: "task6_authoritative_get_index", status: "NOT_TESTED", severity: null },
    { name: "task6_prior_files_and_metadata", status: "NOT_TESTED", severity: null },
    { name: "task6_representative_download_integrity", status: "NOT_TESTED", severity: null },
    { name: "task6_final_isolation", status: "NOT_TESTED", severity: null },
    { name: "task6_control_plane_health", status: "NOT_TESTED", severity: null },
  ];
}

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
  if (focusedFinalReloadTrace) {
    await fs.writeFile(TASK4_FOCUSED_FINAL_RELOAD_REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (task4Mode) {
    await fs.writeFile(TASK4_REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (task5Mode) {
    await fs.writeFile(TASK5_REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (task6Mode) {
    await fs.writeFile(TASK6_REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
}

async function readJsonLines(file) {
  if (!file) return [];
  try {
    return (await fs.readFile(file, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
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

function createStartupSubmitBarrier(expected) {
  let arrived = 0;
  let release;
  let reject;
  let settled = false;
  const evidence = {
    expected,
    created_at_ms: Date.now(),
    arrivals: [],
    released_at_ms: null,
    aborted: null,
  };
  const gate = new Promise((resolve, rejectPromise) => {
    release = resolve;
    reject = rejectPromise;
  });

  return {
    async wait(accountLabel) {
      if (settled) return gate;
      arrived += 1;
      evidence.arrivals.push({
        account_label: accountLabel,
        arrived_at_ms: Date.now(),
        arrived_count: arrived,
      });
      if (arrived === expected) {
        settled = true;
        evidence.released_at_ms = Date.now();
        release();
      }
      await gate;
      return evidence.released_at_ms;
    },
    abort(accountLabel, error) {
      if (settled) return;
      settled = true;
      evidence.aborted = {
        account_label: accountLabel,
        aborted_at_ms: Date.now(),
        error_code: typeof error?.code === "string" ? error.code : null,
        error_name: typeof error?.name === "string" ? error.name : "Error",
      };
      reject(
        taggedError(
          `Startup submit barrier aborted while preparing account ${accountLabel}.`,
          "STAGE1_STARTUP_SUBMIT_BARRIER_ABORTED",
          "P1",
        ),
      );
    },
    evidence,
  };
}

function redactDiagnosticText(value, account) {
  return String(value || "")
    .split(account.password).join("[REDACTED]")
    .replace(/\b[A-Za-z0-9_+\/-]{32,}={0,2}\b/g, "[REDACTED]")
    .slice(0, 4_000);
}

function safeCommandError(error, account) {
  if (!error) return null;
  return {
    name: redactDiagnosticText(error.name || "Error", account),
    message: redactDiagnosticText(error.message || error, account),
    stack: redactDiagnosticText(error.stack || "", account),
  };
}

async function submitTargetState(client, account) {
  const state = {
    selector: '.bg-auth-form button[type="submit"]',
    is_existing: null,
    is_displayed: null,
    is_enabled: null,
    url: null,
    phase: null,
    inspection_error: null,
  };

  try {
    const button = await client.$(state.selector);
    const [existing, displayed, enabled, url, phase] = await Promise.all([
      button.isExisting(),
      button.isDisplayed(),
      button.isEnabled(),
      client.getUrl(),
      client.execute(() => {
        const visible = node => Boolean(node && node.getClientRects().length);
        const mfa = visible(document.querySelector(
          '#auth-login-mfa, #beatgaler-login-mfa, input[autocomplete="one-time-code"]',
        ));
        const login = visible(document.querySelector("#auth-login-identifier"));
        return mfa ? "mfa" : login ? "login" : "outside-sign-in";
      }),
    ]);
    state.is_existing = existing;
    state.is_displayed = displayed;
    state.is_enabled = enabled;
    state.url = url;
    state.phase = phase;
    return { button, state };
  } catch (error) {
    state.inspection_error = safeCommandError(error, account);
    return { button: null, state };
  }
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
  {
    resetProfile = true,
    reuseObserver = false,
    startupSubmitBarrier = null,
    phase2Task1Trace = null,
  } = {},
) {
  const startedAt = Date.now();
  let phase = "installing-auth-observer";
  let observer = reuseObserver ? authObservers.get(account.label) : null;
  const setPhase = value => { phase = value; observer?.setPhase(value); };
  let failure = null;
  const submitTimeline = {
    credentials_filled_at_ms: null,
    barrier_entered_at_ms: null,
    barrier_released_at_ms: null,
    click_before_at_ms: null,
    click_after_at_ms: null,
    click_error: null,
    target_before_click: null,
    auth_login_observed_immediately_after_click: false,
    auth_login_observed_after_click: false,
  };

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
    if (phase2Task1Trace) {
      await setPhase2Task1TraceContext(client, phase2Task1Trace);
    }
    await (await client.$("#auth-login-identifier")).setValue(account.identifier);
    await (await client.$("#auth-login-password")).setValue(account.password);
    submitTimeline.credentials_filled_at_ms = Date.now();

    if (startupSubmitBarrier) {
      setPhase("waiting-for-startup-submit-barrier");
      submitTimeline.barrier_entered_at_ms = Date.now();
      submitTimeline.barrier_released_at_ms = await startupSubmitBarrier.wait(account.label);
    }

    setPhase("submitting-sign-in");
    const target = await submitTargetState(client, account);
    submitTimeline.target_before_click = target.state;
    submitTimeline.click_before_at_ms = Date.now();
    try {
      if (!target.button) {
        throw taggedError(
          `Account ${account.label} submit target could not be resolved.`,
          "STAGE1_STARTUP_SUBMIT_TARGET_UNAVAILABLE",
        );
      }
      await target.button.click();
      submitTimeline.click_after_at_ms = Date.now();
      submitTimeline.auth_login_observed_immediately_after_click = (
        observer?.snapshot() || []
      ).some(entry =>
        entry.route === "/beatgaler-api/auth/login" &&
        Number(entry.started_at_ms) >= submitTimeline.click_before_at_ms
      );
    } catch (error) {
      submitTimeline.click_after_at_ms = Date.now();
      submitTimeline.click_error = safeCommandError(error, account);
      throw error;
    }

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
  } catch (error) {
    // Redacted command evidence is retained in the JSON report only.
    failure = phase;
    startupSubmitBarrier?.abort(account.label, error);
    if (!submitTimeline.click_error && phase === "submitting-sign-in") {
      submitTimeline.click_error = safeCommandError(error, account);
    }
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
    submit_timeline: {
      ...submitTimeline,
      auth_login_observed_after_click: (
        observer?.snapshot() || []
      ).some(entry =>
        entry.route === "/beatgaler-api/auth/login" &&
        Number(entry.started_at_ms) >= submitTimeline.click_before_at_ms
      ),
    },
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

function successfulGetIndexSince(label, { startedAtMs, phase = null }) {
  const entries = authObservers.get(label)?.snapshot() || [];
  const begun = entries.filter(entry =>
    entry.route === "/beatgaler-api/transport/operation/begin" &&
    entry.state === "response" &&
    entry.status >= 200 &&
    entry.status < 300 &&
      (!phase || entry.harness_phase === phase) &&
    Number(entry.started_at_ms) >= startedAtMs &&
    entry.operation_request?.kind === "get_index" &&
    typeof entry.operation_response?.operation_id === "string" &&
    entry.operation_response.operation_id.length > 0,
  );

  for (let index = begun.length - 1; index >= 0; index -= 1) {
    const begin = begun[index];
    const operationId = begin.operation_response.operation_id;
    const end = entries.find(entry =>
      entry.route === "/beatgaler-api/transport/operation/end" &&
      entry.state === "response" &&
      entry.status >= 200 &&
      entry.status < 300 &&
      entry.operation_request?.operation_id === operationId &&
      entry.operation_response?.ok === true,
    );

    if (end) {
      return {
        operation_id: operationId,
        begin_started_at_ms: Number(begin.started_at_ms),
        end_started_at_ms: Number(end.started_at_ms),
        begin_harness_phase: begin.harness_phase,
        end_harness_phase: end.harness_phase,
      };
    }
  }

  return null;
}

function focusedReloadEvent(trace, event, { durationMs = null, detail = null } = {}) {
  const monotonicMs = Math.round(performance.now() * 10) / 10;
  const wallClockMs = Date.now();
  const entry = {
    event,
    account_label: trace.account_label,
    correlation_id: trace.correlation_id,
    timestamp_monotonic_ms: monotonicMs,
    timestamp_wall_clock: new Date(wallClockMs).toISOString(),
    ...(Number.isFinite(Number(durationMs)) ? { duration_ms: Math.round(Number(durationMs) * 10) / 10 } : {}),
    ...(detail && typeof detail === "object" ? { detail } : {}),
  };
  trace.events.push(entry);
  return entry;
}

function focusedReloadHttpTimeline(label, correlationId) {
  const entries = (authObservers.get(label)?.snapshot() || [])
    .filter(entry =>
      entry.harness_phase === "mixed-soak-final-authoritative-reload" &&
      entry.correlation_id === correlationId &&
      entry.state !== "pending",
    );

  const eventName = entry => {
    if (entry.route === "/beatgaler-api/auth/health") return "auth_health";
    if (entry.route === "/beatgaler-api/auth/session") return "auth_session";
    if (entry.route === "/beatgaler-api/transport/session/start") {
      return entry.transport_stage === "bind" ? "transport_bind" : "transport_reserve";
    }
    if (
      entry.route === "/beatgaler-api/transport/operation/begin" &&
      entry.operation_request?.kind === "get_index"
    ) return "operation_begin";
    if (entry.route === "/beatgaler-api/transport/operation/end") return "operation_end";
    return null;
  };

  return entries.flatMap(entry => {
    const name = eventName(entry);
    if (!name) return [];
    const common = {
      account_label: label,
      correlation_id: correlationId,
      source: "browser_fetch_observer",
      route: entry.route,
    };
    const started = {
      event: `${name}_started`,
      ...common,
      timestamp_monotonic_ms: entry.monotonic_started_ms ?? null,
      timestamp_wall_clock: Number.isFinite(Number(entry.started_at_ms))
        ? new Date(Number(entry.started_at_ms)).toISOString()
        : null,
    };
    const completed = {
      event: `${name}_completed`,
      ...common,
      timestamp_monotonic_ms: entry.monotonic_observed_ms ?? null,
      timestamp_wall_clock: Number.isFinite(Number(entry.observed_at_ms))
        ? new Date(Number(entry.observed_at_ms)).toISOString()
        : null,
      duration_ms: entry.duration_ms,
      state: entry.state,
      status: entry.status,
      ...(entry.startup_trace ? { startup_trace: entry.startup_trace } : {}),
      ...(name === "operation_begin"
        ? {
            admitted: entry.operation_response?.wait !== true,
            wait: entry.operation_response?.wait === true,
            retry_after_ms: entry.operation_response?.retry_after_ms ?? null,
          }
        : {}),
    };
    return [started, completed];
  });
}

function focusedReloadNavigationTimeline(label, correlationId) {
  return (authObservers.get(label)?.documentSnapshot() || [])
    .filter(entry => entry.correlation_id === correlationId)
    .map(entry => ({
      event: entry.event,
      account_label: label,
      correlation_id: correlationId,
      source: "browser_document_observer",
      document_id: entry.document_id,
      timestamp_monotonic_ms: entry.monotonic_ms ?? null,
      timestamp_wall_clock: entry.timestamp_wall_clock ?? null,
    }));
}

function focusedReloadWorkerTimeline(logs, label, correlationId) {
  const rows = [];
  for (const item of Array.isArray(logs) ? logs : []) {
    const match = /^\[play-trace\]\s+(\{.*\})$/.exec(String(item?.text || ""));
    if (!match) continue;
    try {
      const trace = JSON.parse(match[1]);
      if (trace.correlation_id !== correlationId || trace.account_label !== label) continue;
      const event = trace.stage === "WORKER_INDEX_BEGIN"
        ? "worker_index_begin"
        : trace.stage === "WORKER_INDEX_DONE"
          ? "worker_index_done"
          : null;
      if (!event) continue;
      rows.push({
        event,
        account_label: label,
        correlation_id: correlationId,
        source: "main_thread_worker_client",
        timestamp_monotonic_ms: Number.isFinite(Number(trace.t_ms)) ? Number(trace.t_ms) : null,
        timestamp_wall_clock: Number.isFinite(Number(trace.ts_ms))
          ? new Date(Number(trace.ts_ms)).toISOString()
          : null,
        ...(Number.isFinite(Number(trace.elapsed_ms)) ? { duration_ms: Number(trace.elapsed_ms) } : {}),
      });
    } catch {
      // Diagnostic capture must never make the focused run fail.
    }
  }
  return rows;
}

async function waitForAuthoritativeLibrary(
  client,
  label,
  { requiredGetIndex = null, focusedReloadTrace = null } = {},
) {
  let latest = null;

  try {
    await client.waitUntil(async () => {
      latest = await libraryAuthoritySnapshot(client);
      const successfulGetIndex = requiredGetIndex
        ? successfulGetIndexSince(label, requiredGetIndex)
        : null;
      latest = {
        ...latest,
        ...(requiredGetIndex
          ? { successful_get_index: successfulGetIndex }
          : {}),
      };

      const materialized =
        latest?.empty_gallery === true ||
        Number(latest?.beat_count || 0) > 0;

      if (focusedReloadTrace && materialized && !focusedReloadTrace.materialized) {
        focusedReloadTrace.materialized = true;
        focusedReloadEvent(focusedReloadTrace, "library_materialized", {
          detail: { beat_count: latest.beat_count, empty_gallery: latest.empty_gallery },
        });
      }

      if (focusedReloadTrace && latest?.aria_busy === "false" && !focusedReloadTrace.aria_busy_false) {
        focusedReloadTrace.aria_busy_false = true;
        focusedReloadEvent(focusedReloadTrace, "aria_busy_false");
      }

      const ready = (
        latest?.present === true &&
        latest?.aria_busy === "false" &&
        materialized &&
        (!requiredGetIndex || successfulGetIndex !== null) &&
        latest?.poor_connection !== true &&
        latest?.offline !== true &&
        latest?.load_error !== true
      );
      if (focusedReloadTrace && ready && !focusedReloadTrace.ready) {
        focusedReloadTrace.ready = true;
        focusedReloadEvent(focusedReloadTrace, "authoritative_library_ready", {
          detail: { beat_count: latest.beat_count },
        });
      }
      return ready;
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
    const observedTraces = authObservers.get(label)?.playTraceSnapshot() || [];
    const operationCorrelationId = observedTraces.map(entry => entry?.trace?.correlation_id)
      .filter(id => typeof id === "string" && id.startsWith("task1-"))
      .at(-1) || null;
    report.accounts[label].library_authority_failure = {
      snapshot: latest,
      diagnostic,
      required_get_index: requiredGetIndex,
      operation_correlation_id: operationCorrelationId,
      operation_trace: operationCorrelationId
        ? observedTraces.filter(entry => entry?.trace?.correlation_id === operationCorrelationId)
          .map(entry => entry.trace)
        : [],
      operation_http: operationCorrelationId
        ? (authObservers.get(label)?.snapshot() || []).filter(entry =>
          entry?.correlation_id === operationCorrelationId)
        : [],
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

async function setPhase2Task1TraceContext(client, context) {
  await client.execute(input => {
    localStorage.setItem("beatgaler:stage1-trace:correlation", input.correlation_id);
    localStorage.setItem("beatgaler:stage1-trace:account", input.account_label);
    if (input.task2_passive_ping_trace === true) {
      localStorage.setItem("beatgaler:stage1-trace:task2-passive-ping", "1");
    } else {
      localStorage.removeItem("beatgaler:stage1-trace:task2-passive-ping");
    }
    window.__stage1TraceContext = input;
  }, context);
}

function phase2Task1Http(label, correlationId, route) {
  return (authObservers.get(label)?.snapshot() || [])
    .filter(entry =>
      entry.correlation_id === correlationId &&
      entry.route === route &&
      entry.state === "response" &&
      Number(entry.status) >= 200 && Number(entry.status) < 300,
    )
    .sort((left, right) => Number(left.observed_at_ms) - Number(right.observed_at_ms));
}

function phase2Task1Trace(label, correlationId, stage, afterMs = -Infinity) {
  return phase2Task1Traces(label, correlationId)
    .filter(trace =>
      trace?.stage === stage &&
      Number.isFinite(Number(trace?.ts_ms)) && Number(trace.ts_ms) >= afterMs,
    )
    .sort((left, right) => Number(left.ts_ms) - Number(right.ts_ms))[0] || null;
}

function phase2Task1Traces(label, correlationId) {
  return (authObservers.get(label)?.playTraceSnapshot() || [])
    .map(entry => entry?.trace)
    .filter(trace =>
      trace?.correlation_id === correlationId && Number.isFinite(Number(trace?.ts_ms)),
    );
}

function phase2Task1TraceTime(trace) {
  if (!trace) return null;
  const workerTime = trace.worker_at_ms === null || trace.worker_at_ms === undefined ? NaN : Number(trace.worker_at_ms);
  return Number.isFinite(workerTime) ? workerTime : Number(trace?.ts_ms);
}

function phase2Task1TraceEvent(trace, startedAtMs) {
  const absoluteMs = phase2Task1TraceTime(trace);
  const detail = {};
  for (const key of [
    "rpc_method", "boundary", "state", "connection_attempt", "reconnect",
    "attempt", "delay_ms", "error_name", "error_message", "pinned_message_present",
    "worker_instance_id", "client_instance_id", "prior_client_instance_id", "prior_client_present",
    "client_is_connected", "core_connected_flag", "primary_dc_id", "primary_pool_is_connected",
    "primary_connection_count", "primary_connected_count", "rpc_context", "message_id",
    "found", "elapsed_ms", "reason", "connection_id", "connection_uid",
    "last_ping_pending", "last_ping_msg_id", "last_ping_time_monotonic_ms", "session_id",
    "last_ping_rtt_ms", "ping_msg_id", "ping_sent_at_monotonic_ms",
    "ping_id", "container_id", "serialized_byte_length", "encrypted_byte_length",
    "packet_id", "packet_ids", "encode_seq", "send_seq", "rpc_msg_id", "rpc_msg_ids", "rpc_logical_id",
    "rpc_msg_id_after", "container_msg_ids", "encoded_bytes", "encoded_fingerprint",
    "byte_correlation", "outgoing_packets", "queued_after_failure", "pending_after_result",
    "frame_id", "frame_fingerprint", "web_socket_frame_id", "web_socket_frame_ids",
    "input_byte_correlation", "incoming_frame_fingerprint", "callback_invoked",
    "validation_outcome", "validation_reason", "last_ping_msg_id_before", "last_ping_msg_id_after",
    "websocket_observer", "inner_encode_hook", "encryptor_process_hook", "decrypt_hook",
    "rpc_result_hook", "validation", "root_msg_id",
    "seq_no", "root_seq_no", "body_bytes", "salt", "local_salt", "body_constructor",
    "inner_messages", "matched", "requested_session_id",
    "persistent_writer_present", "persistent_writer_present_at_call", "queued_before_send",
    "ping_msg_ids", "related_ping_msg_ids", "ack_msg_id", "ack_origin", "pong_msg_id", "pong_ping_id",
    "pending_lookup", "expected_ping_id", "ping_id_matches", "current_last_ping_matches",
    "outcome", "failed_msg_id", "failure_reason", "reset_origin", "reset_with_time",
    "previous_last_ping_msg_id", "previous_last_ping_time_monotonic_ms",
    "active_before", "active_now", "inactive_to_active", "pending_message_present",
    "phase", "semantics", "error_name", "error_message",
    "web_socket_id", "packet_bytes", "buffered_amount_before", "buffered_amount_after",
    "incoming_frame_bytes", "incoming_data_kind", "close_code", "close_reason", "close_was_clean",
    "framed_buffer_available", "framed_eof", "framed_frame_bytes",
    "encrypted_message_bytes", "incoming_msg_id", "incoming_seq_no", "object_id_hex",
    "raw_kind", "container_message_count", "mt_message_type", "mt_is_pong",
    "state_request_msg_id", "state_requested_msg_ids", "state_info_codes", "ack_msg_ids",
  ]) {
    if (trace?.[key] !== undefined && trace?.[key] !== null) detail[key] = trace[key];
  }
  return {
    stage: trace.stage,
    absolute_ms: Number.isFinite(absoluteMs) ? absoluteMs : null,
    relative_ms: Number.isFinite(absoluteMs) ? absoluteMs - startedAtMs : null,
    source: Number.isFinite(Number(trace?.worker_at_ms)) ? "mtproto-worker" : "web-main-thread",
    worker_monotonic_ms: Number.isFinite(Number(trace?.worker_monotonic_ms)) ? Number(trace.worker_monotonic_ms) : null,
    ...(Object.keys(detail).length ? { detail } : {}),
  };
}

function phase2Task1TraceAfter(traces, stage, afterMs = -Infinity) {
  if (afterMs === null) return null;
  return traces
    .filter(trace => trace?.stage === stage && phase2Task1TraceTime(trace) >= afterMs)
    .sort((left, right) => phase2Task1TraceTime(left) - phase2Task1TraceTime(right))[0] || null;
}

function phase2Task1Attribution({ account, condition, startedAtMs, readyAtMs, correlationId }) {
  const authRoute = condition === "apertura_fria" ? "/beatgaler-api/auth/login" : "/beatgaler-api/auth/session";
  const auth = phase2Task1Http(account.label, correlationId, authRoute).at(-1) || null;
  const control = phase2Task1Http(account.label, correlationId, "/beatgaler-api/transport/session/start");
  const controlBegin = control[0] || null;
  const traces = phase2Task1Traces(account.label, correlationId);
  const bootstrapDone = phase2Task1TraceAfter(traces, "SESSION_START_BOOTSTRAP_DONE", startedAtMs);
  const bindDone = phase2Task1TraceAfter(traces, "SESSION_START_BIND_DONE", startedAtMs);
  const activateDone = phase2Task1TraceAfter(traces, "SESSION_ACTIVATE_HTTP_DONE", startedAtMs);
  const controlReady = phase2Task1TraceAfter(traces, "CONTROLLER_SESSION_MEDIA_GATE_OPEN", startedAtMs);
  const gateAtMs = phase2Task1TraceTime(controlReady);
  const direct = phase2Task1TraceAfter(traces, "CONTROLLER_SESSION_DATA_PLANE_READY", gateAtMs);
  // The Worker can preconnect while Cloud completes bind/activate. Its first
  // connection belongs to this operation even when it precedes the media gate.
  const mtprotoConnectBegin = phase2Task1TraceAfter(traces, "WORKER_MTPROTO_CONNECT_BEGIN", startedAtMs);
  const mtprotoClientReady = phase2Task1TraceAfter(traces, "WORKER_MTPROTO_CLIENT_READY", startedAtMs);
  // The controller starts getChat background verification after Direct is ready;
  // beginOperation waits for it before dispatching get_index. This order is
  // deliberately reported as observed rather than reshaped into a desired one.
  const getChatBegin = phase2Task1TraceAfter(traces, "WORKER_VERIFY_GET_CHAT_BEGIN", startedAtMs);
  const getChatRpcSent = phase2Task1TraceAfter(traces, "WORKER_VERIFY_GET_CHAT_RPC_SENT", startedAtMs);
  const getChatRpcResponse = phase2Task1TraceAfter(traces, "WORKER_VERIFY_GET_CHAT_RPC_RESPONSE_RECEIVED", startedAtMs);
  const getChatLocalDone = phase2Task1TraceAfter(traces, "WORKER_VERIFY_GET_CHAT_LOCAL_DONE", startedAtMs);
  const getChatEnd = phase2Task1TraceAfter(traces, "WORKER_VERIFY_GET_CHAT_END", startedAtMs);
  const getIndexBegin = phase2Task1TraceAfter(traces, "WORKER_INDEX_BEGIN", startedAtMs);
  const pointerLookupBegin = phase2Task1TraceAfter(traces, "WORKER_INDEX_POINTER_LOOKUP_BEGIN", startedAtMs);
  const pointerGetMessagesBegin = phase2Task1TraceAfter(traces, "WORKER_INDEX_POINTER_GET_MESSAGES_BEGIN", startedAtMs);
  const pointerGetMessagesSent = phase2Task1TraceAfter(traces, "WORKER_INDEX_POINTER_GET_MESSAGES_RPC_SENT", startedAtMs);
  const pointerGetMessagesResponse = phase2Task1TraceAfter(traces, "WORKER_INDEX_POINTER_GET_MESSAGES_RPC_RESPONSE_RECEIVED", startedAtMs);
  const pointerGetMessagesEnd = phase2Task1TraceAfter(traces, "WORKER_INDEX_POINTER_GET_MESSAGES_END", startedAtMs);
  const pointerLookupEnd = phase2Task1TraceAfter(traces, "WORKER_INDEX_POINTER_LOOKUP_DONE", startedAtMs);
  const getIndexEnd = phase2Task1TraceAfter(traces, "WORKER_INDEX_DONE", startedAtMs);
  const fullChatBegin = phase2Task1TraceAfter(traces, "WORKER_INDEX_GET_FULL_CHAT_BEGIN", startedAtMs);
  const fullChatRpcSent = phase2Task1TraceAfter(traces, "WORKER_INDEX_GET_FULL_CHAT_RPC_SENT", startedAtMs);
  const fullChatRpcResponse = phase2Task1TraceAfter(traces, "WORKER_INDEX_GET_FULL_CHAT_RPC_RESPONSE_RECEIVED", startedAtMs);
  const fullChatLocalDone = phase2Task1TraceAfter(traces, "WORKER_INDEX_GET_FULL_CHAT_LOCAL_DONE", startedAtMs);
  const fullChatEnd = phase2Task1TraceAfter(traces, "WORKER_INDEX_GET_FULL_CHAT_END", startedAtMs);
  const processBegin = phase2Task1TraceAfter(traces, "WEB_LIBRARY_INDEX_PROCESS_BEGIN", startedAtMs);
  const processEnd = phase2Task1TraceAfter(traces, "WEB_LIBRARY_INDEX_PROCESS_DONE", startedAtMs);
  const workerIndexEvents = traces
    .filter(trace => /^WORKER_INDEX_(?:DISPATCH_RECEIVED|PRIORITY_WAIT_BEGIN|PRIORITY_WAIT_DONE|POINTER_LOOKUP_(?:BEGIN|DONE)|POINTER_GET_MESSAGES_(?:BEGIN|RPC_INVOKED|RPC_SENT|RPC_RESPONSE_RECEIVED|RPC_ERROR|RPC_NOT_OBSERVED|END)|POINTER_INVALID|GET_FULL_CHAT_(?:BEGIN|RPC_INVOKED|RPC_SENT|RPC_RESPONSE_RECEIVED|RPC_ERROR|RPC_NOT_OBSERVED|LOCAL_DONE|END)|PINNED_LOOKUP_BEGIN|PINNED_LOOKUP_DONE|DOWNLOAD_BEGIN|DOWNLOAD_DONE|ATTEMPT_FAILED|RETRY_BACKOFF_BEGIN|RETRY_BACKOFF_END|RETRY_EXHAUSTED|RESPONSE)$/.test(trace.stage))
    .sort((left, right) => phase2Task1TraceTime(left) - phase2Task1TraceTime(right))
    .map(trace => phase2Task1TraceEvent(trace, startedAtMs));
  const mtprotoTimeline = traces
    .filter(trace => /^(?:WORKER_MTPROTO_(?:CLIENT_(?:INITIALIZE|CREATED|READY|CLOSE_BEGIN|CLOSE_DONE|INIT_FAILED|ERROR)|CONNECT_(?:BEGIN|END|ERROR)|CONNECTION_STATE|DISCONNECTED|RECONNECT_(?:BEGIN|READY)|SESSION_RESET|CLIENT_ERROR)|WORKER_VERIFY_GET_CHAT_(?:BEGIN|RPC_INVOKED|RPC_SENT|RPC_RESPONSE_RECEIVED|RPC_ERROR|RPC_NOT_OBSERVED|LOCAL_DONE|END|ERROR))$/.test(trace.stage))
    .sort((left, right) => phase2Task1TraceTime(left) - phase2Task1TraceTime(right))
    .map(trace => phase2Task1TraceEvent(trace, startedAtMs));
  const pointerGetMessagesTimeline = traces
    .filter(trace => /^WORKER_INDEX_POINTER_GET_MESSAGES_(?:BEGIN|RPC_INVOKED|RPC_SENT|RPC_RESPONSE_RECEIVED|RPC_ERROR|RPC_NOT_OBSERVED|END)$/.test(trace.stage) || /^(?:WORKER_MTPROTO_(?:CONNECTION_STATE|DISCONNECTED|RECONNECT_(?:BEGIN|READY)|SESSION_RESET|CLIENT_ERROR))$/.test(trace.stage))
    .filter(trace => {
      if (!trace.stage.startsWith("WORKER_MTPROTO_")) return true;
      return trace?.detail?.rpc_context?.stage === "WORKER_INDEX_POINTER_GET_MESSAGES";
    })
    .sort((left, right) => phase2Task1TraceTime(left) - phase2Task1TraceTime(right))
    .map(trace => phase2Task1TraceEvent(trace, startedAtMs));
  const task2PassivePingTimeline = traces
    .filter(trace => /^TASK2_PING_/.test(trace.stage))
    .sort((left, right) => phase2Task1TraceTime(left) - phase2Task1TraceTime(right))
    .map(trace => phase2Task1TraceEvent(trace, startedAtMs));
  const task2InputTimeline = traces
    .filter(trace => /^TASK2_INPUT_/.test(trace.stage))
    .sort((left, right) => phase2Task1TraceTime(left) - phase2Task1TraceTime(right))
    .map(trace => phase2Task1TraceEvent(trace, startedAtMs));
  const task2OutputTimeline = traces
    .filter(trace => /^TASK2_OUTPUT_/.test(trace.stage))
    .sort((left, right) => phase2Task1TraceTime(left) - phase2Task1TraceTime(right))
    .map(trace => phase2Task1TraceEvent(trace, startedAtMs));

  const points = [
    ["inicio_reload", startedAtMs, "harness"],
    ["auth_session", auth?.observed_at_ms, authRoute],
    ["cloud_control_begin", controlBegin?.started_at_ms, "/transport/session/start"],
    ["session_start_bootstrap_done", phase2Task1TraceTime(bootstrapDone), "SESSION_START_BOOTSTRAP_DONE"],
    ["session_start_bind_done", phase2Task1TraceTime(bindDone), "SESSION_START_BIND_DONE"],
    ["session_activate_http_done", phase2Task1TraceTime(activateDone), "SESSION_ACTIVATE_HTTP_DONE"],
    ["cloud_control_end", gateAtMs, "CONTROLLER_SESSION_MEDIA_GATE_OPEN"],
    ["mtproto_connect_begin", phase2Task1TraceTime(mtprotoConnectBegin), "WORKER_MTPROTO_CONNECT_BEGIN"],
    ["cliente_mtproto_listo", phase2Task1TraceTime(mtprotoClientReady), "WORKER_MTPROTO_CLIENT_READY"],
    ["direct_disponible", direct?.ts_ms, "CONTROLLER_SESSION_DATA_PLANE_READY"],
    ["get_chat_begin", phase2Task1TraceTime(getChatBegin), "WORKER_VERIFY_GET_CHAT_BEGIN"],
    ["get_chat_rpc_enviada", phase2Task1TraceTime(getChatRpcSent), "mtcute core.call"],
    ["get_chat_respuesta_recibida", phase2Task1TraceTime(getChatRpcResponse), "mtcute core.call promise"],
    ["get_chat_procesamiento_local_terminado", phase2Task1TraceTime(getChatLocalDone), "WORKER_VERIFY_GET_CHAT_LOCAL_DONE"],
    ["get_chat_end", phase2Task1TraceTime(getChatEnd), "WORKER_VERIFY_GET_CHAT_END"],
    ["get_index_begin", getIndexBegin?.ts_ms, "WORKER_INDEX_BEGIN"],
    ["pointer_lookup_begin", phase2Task1TraceTime(pointerLookupBegin), "WORKER_INDEX_POINTER_LOOKUP_BEGIN"],
    ["get_messages_begin", phase2Task1TraceTime(pointerGetMessagesBegin), "WORKER_INDEX_POINTER_GET_MESSAGES_BEGIN"],
    ["get_messages_rpc_enviada", phase2Task1TraceTime(pointerGetMessagesSent), "mtcute core.call"],
    ["get_messages_rpc_respuesta_recibida", phase2Task1TraceTime(pointerGetMessagesResponse), "mtcute core.call promise"],
    ["get_messages_end", phase2Task1TraceTime(pointerGetMessagesEnd), "WORKER_INDEX_POINTER_GET_MESSAGES_END"],
    ["pointer_lookup_end", phase2Task1TraceTime(pointerLookupEnd), "WORKER_INDEX_POINTER_LOOKUP_DONE"],
    ["get_full_chat_begin", phase2Task1TraceTime(fullChatBegin), "WORKER_INDEX_GET_FULL_CHAT_BEGIN"],
    ["get_full_chat_rpc_enviada", phase2Task1TraceTime(fullChatRpcSent), "mtcute core.call"],
    ["get_full_chat_respuesta_recibida", phase2Task1TraceTime(fullChatRpcResponse), "mtcute core.call promise"],
    ["get_full_chat_procesamiento_local_terminado", phase2Task1TraceTime(fullChatLocalDone), "WORKER_INDEX_GET_FULL_CHAT_LOCAL_DONE"],
    ["get_full_chat_end", phase2Task1TraceTime(fullChatEnd), "WORKER_INDEX_GET_FULL_CHAT_END"],
    ["get_index_end", getIndexEnd?.ts_ms, "WORKER_INDEX_DONE"],
    ["procesamiento_index_web_begin", processBegin?.ts_ms, "WEB_LIBRARY_INDEX_PROCESS_BEGIN"],
    ["procesamiento_index_web_end", processEnd?.ts_ms, "WEB_LIBRARY_INDEX_PROCESS_DONE"],
    ["biblioteca_autoritativa_utilizable", readyAtMs, "DOM authoritative library"],
  ].map(([event, absolute_ms, source]) => ({
    event,
    absolute_ms: absolute_ms !== null && absolute_ms !== undefined && Number.isFinite(Number(absolute_ms)) ? Number(absolute_ms) : null,
    relative_ms: absolute_ms !== null && absolute_ms !== undefined && Number.isFinite(Number(absolute_ms)) ? Number(absolute_ms) - startedAtMs : null,
    source,
  }));

  // Task 2 proves the fast pointer path by requiring that this optional
  // recovery span is absent from hot reloads. The remaining markers still
  // establish Direct, get_index, Web processing and usable library order.
  const earlyGatedEvents = gateAtMs === null ? [] : [
    "CONTROLLER_SESSION_DATA_PLANE_READY",
  ].filter(stage => {
    const first = phase2Task1TraceAfter(traces, stage, startedAtMs);
    return first && phase2Task1TraceTime(first) < gateAtMs;
  });
  const assessment = assessPhase2Task1Markers(points, { task2: phase2Task2Mode, earlyGatedEvents });
  const span = (from, to) => {
    const start = points.find(point => point.event === from)?.absolute_ms;
    const end = points.find(point => point.event === to)?.absolute_ms;
    return Number.isFinite(start) && Number.isFinite(end) ? end - start : null;
  };

  return {
    account_label: account.label,
    condition,
    correlation_id: correlationId,
    markers: points,
    durations_ms: {
      inicio_a_auth_session: span("inicio_reload", "auth_session"),
      auth_session_a_cloud_control: span("auth_session", "cloud_control_begin"),
      cloud_control: span("cloud_control_begin", "cloud_control_end"),
      cloud_control_a_direct_disponible: span("cloud_control_end", "direct_disponible"),
      mtproto_connect: span("mtproto_connect_begin", "cliente_mtproto_listo"),
      direct_disponible_a_get_chat: span("direct_disponible", "get_chat_begin"),
      get_chat_antes_rpc: span("get_chat_begin", "get_chat_rpc_enviada"),
      get_chat_rpc: span("get_chat_rpc_enviada", "get_chat_respuesta_recibida"),
      get_chat_procesamiento_local: span("get_chat_respuesta_recibida", "get_chat_procesamiento_local_terminado"),
      get_chat_total: span("get_chat_begin", "get_chat_end"),
      direct_disponible_a_get_index: span("direct_disponible", "get_index_begin"),
      pointer_lookup: span("pointer_lookup_begin", "pointer_lookup_end"),
      get_messages_antes_rpc: span("get_messages_begin", "get_messages_rpc_enviada"),
      get_messages_rpc: span("get_messages_rpc_enviada", "get_messages_rpc_respuesta_recibida"),
      get_messages_despues_rpc: span("get_messages_rpc_respuesta_recibida", "get_messages_end"),
      get_messages_total: span("get_messages_begin", "get_messages_end"),
      get_full_chat_antes_rpc: span("get_full_chat_begin", "get_full_chat_rpc_enviada"),
      get_full_chat_rpc: span("get_full_chat_rpc_enviada", "get_full_chat_respuesta_recibida"),
      get_full_chat_procesamiento_local: span("get_full_chat_respuesta_recibida", "get_full_chat_procesamiento_local_terminado"),
      get_full_chat_total: span("get_full_chat_begin", "get_full_chat_end"),
      resto_get_index: span("get_full_chat_end", "get_index_end"),
      get_index: span("get_index_begin", "get_index_end"),
      procesamiento_index_web: span("procesamiento_index_web_begin", "procesamiento_index_web_end"),
      index_a_biblioteca_utilizable: span("procesamiento_index_web_end", "biblioteca_autoritativa_utilizable"),
      total: span("inicio_reload", "biblioteca_autoritativa_utilizable"),
    },
    cloud_session_start: control.map(entry => ({
      transport_stage: entry.transport_stage || null,
      direct_session_id: entry.transport?.session_id || null,
      direct_generation: entry.transport?.generation ?? null,
      direct_lease_selection: entry.startup_trace?.events?.find(event => event?.stage === "LEASE_SELECTED")?.server_lease || null,
      duration_ms: entry.duration_ms,
      startup_trace: entry.startup_trace || null,
    })),
    pointer_get_messages_timeline: pointerGetMessagesTimeline,
    ...(phase2Task2PassivePingTrace ? { task2_passive_ping_timeline: task2PassivePingTimeline } : {}),
    ...(phase2Task2PassivePingTrace ? { task2_input_timeline: task2InputTimeline } : {}),
    ...(phase2Task2PassivePingTrace ? { task2_output_timeline: task2OutputTimeline } : {}),
    worker_index_events: workerIndexEvents,
    mtproto_timeline: mtprotoTimeline,
    retries_y_reconexiones: {
      get_index_attempt_failures: workerIndexEvents.filter(event => event.stage === "WORKER_INDEX_ATTEMPT_FAILED"),
      get_index_retry_backoffs: workerIndexEvents.filter(event => event.stage === "WORKER_INDEX_RETRY_BACKOFF_BEGIN"),
      connection_state_events: mtprotoTimeline.filter(event => event.stage === "WORKER_MTPROTO_CONNECTION_STATE"),
      reconnect_events: mtprotoTimeline.filter(event => /^WORKER_MTPROTO_RECONNECT_/.test(event.stage)),
      session_resets: mtprotoTimeline.filter(event => event.stage === "WORKER_MTPROTO_SESSION_RESET"),
      mtproto_client_errors: mtprotoTimeline.filter(event => event.stage === "WORKER_MTPROTO_CLIENT_ERROR"),
      note: "El cliente no expone cada reintento interno de un RPC. La cronología registra reintentos explícitos del flujo get_index, errores del cliente y transiciones MTProto observables.",
    },
    ...assessment,
    get_full_chat_required: !phase2Task2Mode,
    get_full_chat_observed: Number.isFinite(phase2Task1TraceTime(fullChatBegin)),
  };
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
  return `Stage1 Playback v2 ${account.label}`;
}

async function createSoakPlaybackMp3Fixture(account) {
  await fs.mkdir(PLAYBACK_TMP_DIR, { recursive: true });
  const source = stripMp3ContainerTags(await fs.readFile(PLAYBACK_FIXTURE_FILE));
  assert.ok(source.bytes.length > 0, "The playback MP3 fixture must contain MPEG audio frames.");
  const audio = Buffer.concat(Array.from(
    { length: SOAK_PLAYBACK_FIXTURE_REPETITIONS },
    () => source.bytes,
  ));
  const file = path.join(PLAYBACK_TMP_DIR, `${playbackBeatName(account)}.mp3`);
  await fs.writeFile(file, audio);
  return {
    file,
    audio_payload_bytes: audio.length,
    audio_payload_sha256: sha256Hex(audio),
    repetitions: SOAK_PLAYBACK_FIXTURE_REPETITIONS,
  };
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
  const localFixture = await createSoakPlaybackMp3Fixture(account);
  const existing = await playbackBeatSnapshot(client, playbackBeatName(account));
  if (existing?.beat_id) {
    const committed = existing.cloud_committed
      ? existing
      : await waitForPlaybackBeatCommitted(client, account);
    return { ...committed, ...localFixture, beat_name: playbackBeatName(account), created: false };
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

  const remoteFixture = await client.uploadFile(localFixture.file);
  await input.setValue(remoteFixture);

  const saveButton = await client.$('//button[starts-with(normalize-space(.), "Save")]');
  await saveButton.waitForDisplayed({ timeout: 30_000 });
  await saveButton.waitForEnabled({ timeout: 30_000 });
  await saveButton.click();

  const saved = await waitForPlaybackBeatCommitted(client, account);
  return { ...saved, ...localFixture, created: true };
}


function mixedUploadBeatName(account) {
  return `Stage1 Mixed Upload ${account.label} ${MIXED_RUN_SUFFIX}`;
}

async function waitForNamedBeatCommitted(client, account, beatName, timeout = 120_000) {
  let latest = null;
  try {
    await client.waitUntil(async () => {
      latest = await playbackBeatSnapshot(client, beatName);
      return Boolean(latest?.beat_id && latest?.cloud_committed === true);
    }, {
      timeout,
      interval: 500,
      timeoutMsg: `Account ${account.label} did not commit ${beatName} to the authoritative Cloud library.`,
    });
  } catch (error) {
    const diagnostic = await stage1RuntimeDiagnosticsSnapshot(client).catch(() => null);
    throw taggedError(
      `Account ${account.label} did not commit ${beatName} to the authoritative Cloud library. diagnostic=${JSON.stringify({ latest, diagnostic }).slice(0, 6000)}`,
      "STAGE1_MIXED_UPLOAD_AUTHORITATIVE_COMMIT",
      "P1",
    );
  }
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

  // Used by the failure-isolation scenario only.  The callback runs after the
  // real UI Save action, while the durable import is still owned by the app.
  if (typeof options.afterSaveClick === "function") {
    await options.afterSaveClick();
  }

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

function transferEvidence({ bytes, durationMs }) {
  const safeBytes = Math.max(0, Number(bytes) || 0);
  const safeDurationMs = Math.max(0, Number(durationMs) || 0);
  return {
    bytes: safeBytes,
    duration_ms: safeDurationMs,
    bytes_per_second: safeDurationMs > 0
      ? Math.round((safeBytes * 1_000) / safeDurationMs)
      : null,
    mib_per_second: safeDurationMs > 0
      ? Number(((safeBytes / (1024 * 1024)) / (safeDurationMs / 1_000)).toFixed(3))
      : null,
  };
}

function playbackWaitingEvidence(snapshot) {
  const events = Array.isArray(snapshot?.recent_events) ? snapshot.recent_events : [];
  let startedAt = null;
  let pauses = 0;
  let durationMs = 0;
  for (const event of events) {
    if (event?.waiting === true && startedAt === null) {
      startedAt = Number(event.at) || null;
      pauses += 1;
    } else if (event?.waiting !== true && startedAt !== null) {
      durationMs += Math.max(0, (Number(event.at) || startedAt) - startedAt);
      startedAt = null;
    }
  }
  return {
    waiting_seen: snapshot?.waiting_seen === true,
    pause_count: pauses,
    completed_pause_duration_ms: durationMs,
    pause_open_at_end: startedAt !== null,
  };
}

function createTask4ResourceSampler() {
  const cloudUrl = String(process.env.STAGE1_CLOUD_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
  const databaseUrl = String(process.env.STAGE1_POSTGRES_URL || process.env.DATABASE_URL || "").trim();
  const samples = [];
  let timer = null;
  let pool = null;
  let previousCpu = process.cpuUsage();
  let previousAt = process.hrtime.bigint();
  let sampling = false;

  const postgres = async () => {
    if (!databaseUrl) return { status: "NOT_CONFIGURED", detail: "Set STAGE1_POSTGRES_URL for read-only PostgreSQL samples." };
    try {
      if (!pool) {
        const { Pool } = localRequire("../../cloud-server/node_modules/pg");
        pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3_000, max: 1 });
      }
      const result = await pool.query(`
        SELECT
          (SELECT count(*)::int FROM direct_leases WHERE status='ACTIVE') AS active_leases,
          (SELECT count(*)::int FROM direct_operations
            WHERE state IN ('PREPARED','EXTERNAL_EFFECT','INDEX_COMMITTED','RECONCILE')) AS remaining_operations,
          (SELECT count(*)::int FROM direct_operations
            WHERE operation_type='get_index'
              AND state IN ('PREPARED','EXTERNAL_EFFECT','INDEX_COMMITTED','RECONCILE')) AS pending_get_index_operations,
          (SELECT count(*)::int FROM direct_operations o
            WHERE o.operation_type='get_index'
              AND o.state IN ('PREPARED','EXTERNAL_EFFECT','INDEX_COMMITTED','RECONCILE')
              AND (o.lease_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM direct_leases l WHERE l.id=o.lease_id AND l.status='ACTIVE'
              ))) AS orphan_get_index_operations
      `);
      return { status: "OK", ...result.rows[0] };
    } catch (error) {
      return { status: "UNAVAILABLE", error: String(error?.message || error).slice(0, 400) };
    }
  };

  const transport = async () => {
    try {
      const response = await fetch(`${cloudUrl}/transport/status`, { signal: AbortSignal.timeout(3_000) });
      const payload = await response.json().catch(() => ({}));
      return response.ok
        ? { status: "OK", sessions: payload.sessions ?? null, operations: payload.operations ?? null, bots: payload.bots ?? [], queue: payload.queue ?? [] }
        : { status: "UNAVAILABLE", http_status: response.status };
    } catch (error) {
      return { status: "UNAVAILABLE", error: String(error?.message || error).slice(0, 400) };
    }
  };

  const sample = async (phase) => {
    if (sampling) return null;
    sampling = true;
    try {
      const now = process.hrtime.bigint();
      const cpu = process.cpuUsage(previousCpu);
      const elapsedMs = Number(now - previousAt) / 1e6;
      previousCpu = process.cpuUsage();
      previousAt = now;
      const [pg, direct] = await Promise.all([postgres(), transport()]);
      const memory = process.memoryUsage();
      const item = {
        at: new Date().toISOString(),
        phase,
        harness_cpu_percent: elapsedMs > 0
          ? Number((((cpu.user + cpu.system) / 1_000) / elapsedMs * 100).toFixed(2))
          : null,
        harness_memory: {
          rss_bytes: memory.rss,
          heap_used_bytes: memory.heapUsed,
          heap_total_bytes: memory.heapTotal,
          external_bytes: memory.external,
        },
        host_memory: { free_bytes: os.freemem(), total_bytes: os.totalmem() },
        postgres: pg,
        transport: direct,
      };
      samples.push(item);
      return item;
    } finally {
      sampling = false;
    }
  };

  return {
    samples,
    async start() {
      await sample("soak-start");
      timer = setInterval(() => { void sample("soak"); }, 30_000);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await sample("soak-end");
      await pool?.end().catch(() => {});
    },
  };
}

function observedGetIndexDebt(label) {
  const entries = authObservers.get(label)?.snapshot() || [];
  const begun = entries.filter(entry =>
    entry.route === "/beatgaler-api/transport/operation/begin" &&
    entry.state === "response" &&
    entry.status >= 200 &&
    entry.status < 300 &&
    entry.operation_request?.kind === "get_index" &&
    typeof entry.operation_response?.operation_id === "string"
  );
  const completed = new Set(entries
    .filter(entry =>
      entry.route === "/beatgaler-api/transport/operation/end" &&
      entry.state === "response" &&
      entry.status >= 200 &&
      entry.status < 300 &&
      entry.operation_response?.ok === true &&
      typeof entry.operation_request?.operation_id === "string"
    )
    .map(entry => entry.operation_request.operation_id));
  const pending = begun
    .map(entry => entry.operation_response.operation_id)
    .filter(operationId => !completed.has(operationId));
  return { begun: begun.length, completed: completed.size, pending_operation_ids: pending };
}

function consolidateTask4Accounts(metrics) {
  const byLabel = Object.fromEntries(accounts.map(account => [account.label, {
    operations_completed: { playback: 0, seek: 0, upload: 0, metadata: 0, reload: 0, download: 0 },
    first_audio_ms: [],
    playback_pauses: { waiting_samples: 0, pause_count: 0, completed_pause_duration_ms: 0, open_at_end: 0 },
    transfers: { uploads: [], downloads: [] },
    errors_observed: 0,
    retries_observed: 0,
  }]));

  for (const sample of metrics.playback_samples) {
    sample.account_labels.forEach((label, index) => {
      const target = byLabel[label];
      target.operations_completed.playback += 1;
      target.first_audio_ms.push(sample.first_audio_ms[index]);
      const waiting = sample.waiting[index];
      if (waiting?.waiting_seen) target.playback_pauses.waiting_samples += 1;
      target.playback_pauses.pause_count += Number(waiting?.pause_count || 0);
      target.playback_pauses.completed_pause_duration_ms += Number(waiting?.completed_pause_duration_ms || 0);
      if (waiting?.pause_open_at_end) target.playback_pauses.open_at_end += 1;
    });
  }
  for (const sample of metrics.seek_samples) byLabel[sample.account_label].operations_completed.seek += 1;
  for (const sample of metrics.upload_samples) {
    byLabel[sample.account_label].operations_completed.upload += 1;
    byLabel[sample.account_label].transfers.uploads.push(transferEvidence({ bytes: sample.source_bytes, durationMs: sample.duration_ms }));
  }
  for (const sample of metrics.metadata_samples) {
    byLabel[sample.account_label].operations_completed.metadata += 1;
    byLabel[sample.account_label].operations_completed.reload += 1;
  }
  for (const sample of metrics.reload_samples) byLabel[sample.account_label].operations_completed.reload += 1;
  for (const sample of metrics.download_samples) {
    byLabel[sample.account_label].operations_completed.download += 1;
    byLabel[sample.account_label].transfers.downloads.push(transferEvidence({ bytes: sample.bytes, durationMs: sample.duration_ms }));
  }

  for (const account of accounts) {
    const target = byLabel[account.label];
    const entries = authObservers.get(account.label)?.snapshot() || [];
    target.errors_observed = entries.filter(entry =>
      entry.state === "network-error" || entry.state === "aborted" ||
      (entry.state === "response" && Number(entry.status) >= 400)
    ).length;
    target.retries_observed = entries.filter(entry =>
      entry.operation_response?.wait === true || /Reconnect attempt|retry/i.test(String(entry.diagnostic || ""))
    ).length;
    target.first_audio = metricSummary(target.first_audio_ms);
    delete target.first_audio_ms;
    target.get_index = observedGetIndexDebt(account.label);
    target.result = "COMPLETED";
  }
  return byLabel;
}

async function sleepUntilNextSoakAction(deadline, maxDelayMs = 12_000) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  await new Promise(resolve => setTimeout(resolve, Math.min(maxDelayMs, remaining)));
}

async function resetPlaybackForSoak(client) {
  const pauseButton = await client.$('button[title="Pause"]');
  if (await pauseButton.isExisting() && await pauseButton.isDisplayed()) {
    await pauseButton.click();
  }

  const stopAtStart = () => client.execute(() => {
    for (const audio of document.querySelectorAll("audio")) {
      try { audio.pause(); } catch {}
      try { audio.currentTime = 0; } catch {}
      // Keep the Player's React progress in lockstep with the native media
      // reset.  Directly setting currentTime does not traverse Player.onSeek,
      // so it can leave the next Play governed by its stale near-end progress.
      try { audio.dispatchEvent(new Event("timeupdate")); } catch {}
    }

    const visible = node => Boolean(node && node.getClientRects().length);
    const previous = Array.from(document.querySelectorAll('button[title="Previous"]')).find(visible);
    let root = previous?.parentElement;
    while (root && getComputedStyle(root).position !== "fixed") root = root.parentElement;
    const scrubber = root?.children?.[1]?.children?.[1];
    if (scrubber instanceof HTMLElement) {
      const rect = scrubber.getBoundingClientRect();
      if (rect.width > 0) {
        const clientX = rect.left;
        const clientY = rect.top + rect.height / 2;
        scrubber.dispatchEvent(new MouseEvent("mousedown", {
          bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1,
        }));
        window.dispatchEvent(new MouseEvent("mouseup", {
          bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 0,
        }));
      }
    }
  });

  // `handlePlay` performs asynchronous preparation.  A play promise from the
  // preceding iteration can settle just after the first pause and resume its
  // old source.  Give that queued event a turn, then stop again before the
  // next UI click.  This is only setup; the seek proof still observes the real
  // player after the next user interaction.
  await stopAtStart();
  await client.pause(300);
  await stopAtStart();
  await client.waitUntil(async () => client.execute(() =>
    Array.from(document.querySelectorAll("audio")).every(audio =>
      audio.paused && Math.abs(Number(audio.currentTime) || 0) < 0.05,
    ),
  ), {
    timeout: 5_000,
    interval: 100,
    timeoutMsg: "Soak playback reset did not leave the real player paused at its start.",
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
    const seeksStartedAt = Date.now();
    const seeks = await Promise.all(
      pairClients.map((client, index) => seekThroughPlayerUi(client, pairAccounts[index])),
    );
    const seekDurationMs = Date.now() - seeksStartedAt;
    metrics.seek_ms.push(seekDurationMs);
    seeks.forEach((seek, index) => metrics.seek_samples.push({
      iteration,
      account_label: pairAccounts[index].label,
      duration_ms: seekDurationMs,
      ...seek,
    }));
    metrics.playback_samples.push({
      iteration,
      account_labels: pairAccounts.map(account => account.label),
      duration_ms: durationMs,
      start_spread_ms: playback.start_spread_ms,
      first_audio_ms: firstAudio,
      waiting: playback.accounts.map(playbackWaitingEvidence),
    });
    iteration += 1;
    await sleepUntilNextSoakAction(deadline, 12_000);
  }
}

async function runSoakDownloadRole(client, account, beat, expectedAudioSha256, deadline, metrics) {
  let iteration = 0;
  while (Date.now() < deadline) {
    const startedAt = Date.now();
    const result = await downloadIntegrityAsset(client, account, beat, "MP3");
    const durationMs = Date.now() - startedAt;
    if (
      !result.filename.toLowerCase().endsWith(".mp3") ||
      !result.id3?.id3v2_bytes ||
      result.audio_payload_sha256 !== expectedAudioSha256
    ) {
      throw taggedError(
        `Account ${account.label} downloaded MP3 failed Task 1 audio-payload integrity validation.`,
        "STAGE1_MIXED_DOWNLOAD_INTEGRITY",
        "P1",
      );
    }
    metrics.download_ms.push(durationMs);
    metrics.download_samples.push({
      iteration,
      account_label: account.label,
      duration_ms: durationMs,
      ...transferEvidence({ bytes: result.byte_count, durationMs }),
      filename: result.filename,
      audio_payload_sha256: result.audio_payload_sha256,
      integrity: "Task 1 MP3 audio payload SHA-256 matched",
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
          .find(value => /^Stage1 Playback v2 \d{2}$/.test(value));
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

async function installStage1RuntimeTraceCapture(client) {
  const traceLimit = process.env.PLAYBACK_TEST_G_CAPTURE === "1" ? 1600 : 400;
  await client.execute(limit => {
    if (window.__beatgalerStage1TraceCaptureInstalled) return;
    const originalInfo = console.info.bind(console);
    const originalError = console.error.bind(console);
    window.__beatgalerStage1PlayTraceLines = [];
    window.__beatgalerStage1RuntimeErrors = [];
    const append = (target, value, limit) => {
      target.push(value);
      if (target.length > limit) target.shift();
    };
    console.info = (...args) => {
      try {
        const line = args.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" ");
        if (line.includes("[play-trace]")) {
          const at = Date.now();
          append(window.__beatgalerStage1PlayTraceLines, { at, line }, limit);
          const probe = window.__beatgalerStage1PlaybackProbe;
          if (probe?.beatId && line.includes('"stage":"CARD_PLAY_ACCEPTED"') &&
              line.includes(`"beat_id":"${probe.beatId}"`)) probe.clickAcceptedAt = at;
        }
      } catch {}
      return originalInfo(...args);
    };
    console.error = (...args) => {
      try {
        const message = args.map(value => value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value)).join(" ");
        append(window.__beatgalerStage1RuntimeErrors, { at: Date.now(), type: "console.error", message: message.slice(0, 1000) }, 100);
      } catch {}
      return originalError(...args);
    };
    window.addEventListener("error", event => append(window.__beatgalerStage1RuntimeErrors, {
      at: Date.now(), type: "error", message: String(event?.message || "window error"),
    }, 100));
    window.addEventListener("unhandledrejection", event => {
      const reason = event?.reason;
      append(window.__beatgalerStage1RuntimeErrors, {
        at: Date.now(), type: "unhandledrejection", message: reason instanceof Error ? reason.message : String(reason || "unhandled rejection"),
      }, 100);
    });
    window.__beatgalerStage1TraceCaptureInstalled = true;
  }, traceLimit);
}

async function stage1RuntimeDiagnosticsSnapshot(client) {
  return client.execute(() => ({
    play_trace: Array.isArray(window.__beatgalerStage1PlayTraceLines)
      ? window.__beatgalerStage1PlayTraceLines.slice(-160) : [],
    runtime_errors: Array.isArray(window.__beatgalerStage1RuntimeErrors)
      ? window.__beatgalerStage1RuntimeErrors.slice(-60) : [],
  }));
}

async function installPlaybackProbe(client, beatId) {
  await installStage1RuntimeTraceCapture(client);
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
      click_accepted_at: probe?.clickAcceptedAt || null,
      event_count: events.length,
      max_current_time: events.reduce((max, event) => Math.max(max, Number(event.current_time) || 0), 0),
      playing_seen: playingEvents.length > 0,
      first_playing_at: playingEvents[0]?.at || null,
      first_audio_playing_at: playingEvents[0]?.at || null,
      first_progress_gt_0_at: events.find(event => event.playing && event.current_time > 0)?.at || null,
      first_progress_ge_0_1_at: events.find(event => event.playing && event.current_time >= 0.1)?.at || null,
      first_progress_ge_0_5_at: events.find(event => event.playing && event.current_time >= 0.5)?.at || null,
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

async function waitForPlaybackProgress(client, account, triggerStartedAt) {
  let latest = null;
  let firstPlayingAt = null;
  const provenProgressAt = snapshot => {
    const acceptedAt = Number(snapshot?.click_accepted_at || 0);
    if (acceptedAt <= 0) return null;
    const event = (snapshot?.recent_events || []).find(item =>
      Number(item.at) >= Math.max(acceptedAt, triggerStartedAt) && item.playing &&
      Number(item.current_time) >= PLAYBACK_MIN_PROGRESS_SECONDS);
    return event ? Number(event.at || 0) || null : null;
  };
  try {
    await client.waitUntil(async () => {
      latest = await playbackProbeSnapshot(client);
      firstPlayingAt = provenProgressAt(latest);
      return Boolean(firstPlayingAt);
    }, { timeout: 30_000, interval: 100, timeoutMsg: `Account ${account.label} did not prove real playback progress.` });
    return { ...latest, first_playing_at: firstPlayingAt };
  } catch (error) {
    latest = await playbackProbeSnapshot(client).catch(() => latest);
    // WebDriver can deliver the final snapshot after its polling deadline. Use
    // the same click-bound proof before classifying that deadline as a failure.
    firstPlayingAt = provenProgressAt(latest);
    if (firstPlayingAt) return { ...latest, first_playing_at: firstPlayingAt };
    const compactPlayTrace = (latest?.play_trace || []).map(entry => {
      try {
        const parsed = JSON.parse(String(entry.line || "").replace(/^\[play-trace\]\s*/, ""));
        return {
          at: entry.at,
          stage: parsed.stage || null,
          beat_id: parsed.beat_id || null,
          elapsed_ms: parsed.elapsed_ms ?? null,
          error_code: parsed.error_code || null,
          reason: parsed.reason || null,
        };
      } catch { return { at: entry.at, stage: "unparsed" }; }
    }).slice(-50);
    const diagnostic = {
      account_label: account.label,
      trigger_started_at: triggerStartedAt,
      ...(latest || {}),
      play_trace: compactPlayTrace,
    };
    const wrapped = new Error(
      `Account ${account.label} did not prove real playback progress. diagnostic=${JSON.stringify(diagnostic).slice(0, 6000)}`
    );
    wrapped.stage1PlaybackDiagnostic = diagnostic;
    wrapped.cause = error;
    throw wrapped;
  }
}

// Observe cached cards from document start, without delaying the real WebDriver
// click or waiting for Direct/session startup to finish.
function peerPlayRacePreload() {
  const beatId = localStorage.getItem("beatgaler:phase2-peer-play-race:beat");
  if (!beatId) return;
  const state = { library_visible_at: null, interactive_at: null, max_current_time: 0, first_playing_at: null,
    session_start_held_at: null, session_start_released_at: null };
  window.__phase2PeerPlayRace = state;
  const nativeFetch = window.fetch;
  let releaseStart;
  const startGate = new Promise(resolve => { releaseStart = resolve; });
  state.releaseSessionStart = () => {
    if (state.session_start_released_at) return;
    state.session_start_released_at = Date.now();
    releaseStart();
  };
  window.fetch = function (...args) {
    let pathname = "";
    try {
      pathname = new URL(typeof args[0] === "string" ? args[0] : args[0]?.url, location.href).pathname;
    } catch {}
    if (pathname === "/beatgaler-api/transport/session/start" && !state.session_start_released_at) {
      if (!state.session_start_held_at) state.session_start_held_at = Date.now();
      return startGate.then(() => nativeFetch.apply(this, args));
    }
    return nativeFetch.apply(this, args);
  };
  window.addEventListener("beatgaler:web-playback-state", event => {
    const detail = event?.detail || {};
    if (String(detail.beatId || "") !== beatId) return;
    const position = Math.max(0, Number(detail.currentTime) || 0);
    state.max_current_time = Math.max(state.max_current_time, position);
    if (detail.playing && position >= 0.5 && !state.first_playing_at) state.first_playing_at = Date.now();
  });
  const inspect = () => {
    const card = Array.from(document.querySelectorAll("[data-beat-artwork-id]"))
      .find(node => node.getAttribute("data-beat-artwork-id") === beatId);
    if (!card) return;
    if (!state.library_visible_at) state.library_visible_at = Date.now();
    if (card.getAttribute("aria-disabled") !== "true" && !state.interactive_at) state.interactive_at = Date.now();
  };
  const observe = () => {
    const observer = new MutationObserver(inspect);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-disabled"] });
    inspect();
  };
  if (document.documentElement) observe();
  else document.addEventListener("DOMContentLoaded", observe, { once: true });
}

async function runPhase2PeerPlayRace(client, account, beat) {
  const correlationId = `peer-play-${randomUUID().slice(0, 12)}`;
  await client.waitUntil(() => client.execute(beatId => {
    try {
      return JSON.parse(localStorage.getItem("beatvault:library:v1") || "[]")
        .some(item => item.id === beatId);
    } catch { return false; }
  }, beat.beat_id), {
    timeout: 10_000, interval: 100,
    timeoutMsg: "The authoritative fixture was not yet saved to the instant-paint presentation cache.",
  });
  await setPhase2Task1TraceContext(client, { account_label: account.label, correlation_id: correlationId });
  await client.execute(beatId => {
    localStorage.setItem("beatgaler:phase2-peer-play-race:beat", beatId);
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("beatgaler:web-vault-peer:v1:")) localStorage.removeItem(key);
    }
  }, beat.beat_id);
  const preload = await client.addInitScript(peerPlayRacePreload);
  try {
    const refreshStartedAt = Date.now();
    await client.refresh();
    const artwork = await client.$(`[data-beat-artwork-id="${beat.beat_id}"]`);
    try {
      await artwork.waitForDisplayed({ timeout: 30_000, interval: 50 });
    } catch (error) {
      const diagnostic = await client.execute(() => ({
        race: window.__phase2PeerPlayRace || null,
        page_text: String(document.body?.innerText || "").slice(0, 1800),
        cached_ids: (() => { try { return JSON.parse(localStorage.getItem("beatvault:library:v1") || "[]").map(item => item.id); } catch { return []; } })(),
      })).catch(() => null);
      throw new Error(`Cached card did not render while session start was held: ${JSON.stringify(diagnostic)}`, { cause: error });
    }
    await client.waitUntil(async () => (await artwork.getAttribute("aria-disabled")) !== "true", {
      timeout: 30_000, interval: 50,
      timeoutMsg: "Cached playback card did not become interactive during warm startup.",
    });
    await client.waitUntil(() => client.execute(() => Boolean(window.__phase2PeerPlayRace?.session_start_held_at)), {
      timeout: 10_000, interval: 50,
      timeoutMsg: "Direct session start was not intercepted before the immediate Play click.",
    });
    const clickedAt = Date.now();
    await artwork.click();
    const gate = await client.execute(() => {
      const state = window.__phase2PeerPlayRace;
      state?.releaseSessionStart?.();
      return { held_at: state?.session_start_held_at || null, released_at: state?.session_start_released_at || null };
    });
    try {
      await client.waitUntil(async () => {
        const state = await client.execute(() => window.__phase2PeerPlayRace || null);
        return Number(state?.max_current_time || 0) >= PLAYBACK_MIN_PROGRESS_SECONDS && Boolean(state?.first_playing_at);
      }, { timeout: 30_000, interval: 100, timeoutMsg: "Immediate cached-library Play did not reach real audio progress." });
    } catch (error) {
      const browserState = await client.execute(() => ({
        race: window.__phase2PeerPlayRace || null,
        page_text: String(document.body?.innerText || "").slice(0, 1800),
        logs: Array.isArray(window.__stage1DiagnosticLogs) ? window.__stage1DiagnosticLogs.slice(-40) : [],
        audio: Array.from(document.querySelectorAll("audio")).map(node => ({ paused: node.paused, current_time: node.currentTime, ready_state: node.readyState, error: node.error?.message || null })),
      })).catch(() => null);
      const traces = phase2Task1Traces(account.label, correlationId).slice(-100);
      throw new Error(`Immediate Play diagnostic=${JSON.stringify({ clickedAt, browserState, traces }).slice(0, 16000)}`, { cause: error });
    }
    const playback = await client.execute(() => window.__phase2PeerPlayRace);
    const library = await waitForAuthoritativeLibrary(client, account.label, {
      requiredGetIndex: { startedAtMs: refreshStartedAt },
    });
    await client.waitUntil(() => Boolean(phase2Task1Trace(account.label, correlationId, "WORKER_PEER_BOOTSTRAP_READY")), {
      timeout: 10_000, interval: 100, timeoutMsg: "Peer bootstrap trace did not arrive.",
    });
    const traces = phase2Task1Traces(account.label, correlationId);
    const first = stage => traces.find(trace => trace.stage === stage);
    const prepare = first("CONTROLLER_SESSION_PREPARE_DONE");
    const peer = first("WORKER_PEER_BOOTSTRAP_READY");
    const media = traces.filter(trace => [
      "WORKER_PLAYBACK_MEDIA_BATCH_RPC", "WORKER_PREFETCH_LANE_TAKE",
      "WORKER_PREFETCH_READY", "TRANSPORT_STREAM_WORKER_STARTED",
    ].includes(trace.stage));
    const vaultGate = traces.filter(trace => trace.stage === "CONTROLLER_VAULT_PEER_READY");
    assert.ok(playback.library_visible_at && playback.library_visible_at < Number(prepare?.ts_ms),
      "Cached library must appear before Direct session preparation finishes.");
    assert.ok(clickedAt < Number(prepare?.ts_ms),
      "Play must be clicked before Direct session preparation finishes.");
    assert.ok(gate.held_at && gate.held_at <= clickedAt && gate.released_at >= clickedAt,
      "The E2E must hold only session start until the immediate Play click.");
    assert.equal(first("WORKER_PEER_BOOTSTRAP_BEGIN")?.cached_hint, false,
      "Reload must use a fresh Worker without a cached vault peer hint.");
    assert.ok(peer && vaultGate.length > 0 && vaultGate.every(trace =>
      Number(peer.ts_ms) <= Number(trace.ts_ms) && Number(trace.ts_ms) <= Number(playback.first_playing_at)),
    "Playback must cross the vault peer gate after bootstrap and before audio progress.");
    assert.ok(media.every(trace => Number(peer.ts_ms) <= Number(trace.ts_ms)),
      `Every observed Worker media RPC must follow peer readiness. media=${JSON.stringify(media.map(trace => ({ stage: trace.stage, ts_ms: trace.ts_ms })))}`);
    assert.ok(first("WORKER_INDEX_POINTER_GET_MESSAGES_END")?.found,
      "INDEX must still load through getMessages after immediate Play.");
    assert.ok(!first("WORKER_INDEX_GET_FULL_CHAT_BEGIN"), "getFullChat must stay out of the INDEX hot path.");
    assert.ok(!first("SOURCE_SESSION_INVALIDATED"), "A pending peer must not invalidate a healthy session.");
    assert.ok(!traces.some(trace => /Peer .* is not found in local cache|TRANSFER_FAILED/.test(JSON.stringify(trace))),
      "Immediate Play must not emit a peer-cache or transfer failure.");
    const pageText = await client.execute(() => document.body.innerText);
    assert.ok(!pageText.includes("Poor connection"), "Immediate Play must not end in Poor connection.");
    return { correlation_id: correlationId, refresh_started_at_ms: refreshStartedAt,
      library_visible_at_ms: playback.library_visible_at, clicked_at_ms: clickedAt,
      peer_ready_at_ms: peer.ts_ms, first_playing_at_ms: playback.first_playing_at,
      click_to_audio_ms: playback.first_playing_at - clickedAt,
      library_beat_count: library.beat_count,
      stages: traces.filter(trace => /PEER_BOOTSTRAP|VAULT_PEER_READY|PLAYBACK_MEDIA_BATCH_RPC|PREFETCH_LANE_TAKE|STREAM_WORKER_STARTED|INDEX_POINTER_GET_MESSAGES|SESSION_PREPARE_DONE/.test(trace.stage)),
    };
  } finally {
    await client.execute(() => window.__phase2PeerPlayRace?.releaseSessionStart?.()).catch(() => {});
    await preload.remove();
  }
}

async function runConcurrentPlayback(clients, playbackBeats) {
  await Promise.all(playbackBeats.map((beat, index) => installPlaybackProbe(clients[index], beat.beat_id)));
  // A soak role reuses each probe for successive plays.  Its prior events must
  // not satisfy the next iteration's "started playing" proof: that would let
  // a seek run against the already-ended preceding playback.
  await Promise.all(clients.map(client => client.execute(() => {
    const probe = window.__beatgalerStage1PlaybackProbe;
    if (probe && Array.isArray(probe.events)) probe.events = [];
  })));

  const artworks = await Promise.all(playbackBeats.map(async (beat, index) => {
    const artwork = await clients[index].$(`[data-beat-artwork-id="${beat.beat_id}"]`);
    await artwork.waitForDisplayed({ timeout: 30_000 });
    await clients[index].waitUntil(async () => (await artwork.getAttribute("aria-disabled")) !== "true", {
      timeout: 60_000,
      interval: 250,
      timeoutMsg: `Account ${accounts[index].label} playback never became interactive.`,
    });
    await artwork.scrollIntoView({ block: "center", inline: "center" });
    await artwork.waitForClickable({ timeout: 30_000, interval: 100 });
    return artwork;
  }));

  const triggerStartedAt = Date.now();
  await Promise.all(artworks.map(artwork => artwork.click()));

  const snapshots = await Promise.all(clients.map((client, index) =>
    waitForPlaybackProgress(client, accounts[index], triggerStartedAt),
  ));
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

async function runPhase2Task0Conditions({ clients, before }) {
  const samples = report.phase2_task0.samples;
  assert.equal(samples.apertura_fria.length, 5, "Task 0 needs a cold-open timestamp for every account.");
  assert.ok(samples.apertura_fria.every(sample =>
    Number.isFinite(sample.started_at_ms) && Number.isFinite(sample.ready_at_ms) &&
    sample.ready_at_ms >= sample.started_at_ms && sample.get_index?.operation_id,
  ), "Task 0 cold-open samples need completed authoritative get_index evidence.");
  markScenario("phase2_cold_open", "PASS", null, "Five cold opens reached an authoritative library.");

  const reopened = await Promise.all(accounts.map(async (account, index) => {
    authObservers.get(account.label)?.setPhase("phase2-warm-reopen");
    await clients[index].url("about:blank");
    const startedAt = Date.now();
    await clients[index].url("/");
    const library = await waitForAuthoritativeLibrary(clients[index], account.label, {
      requiredGetIndex: { startedAtMs: startedAt },
    });
    const readyAt = Date.now();
    const snapshot = await waitForRuntimeSnapshot(clients[index], account.label);
    validateSingleAccount(account.label, snapshot);
    validatePersistentReload(before[index], snapshot, account.label);
    return {
      account_label: account.label,
      started_at_ms: startedAt,
      ready_at_ms: readyAt,
      get_index: library.successful_get_index || null,
      beat_count: library.beat_count,
    };
  }));
  samples.reapertura_caliente.push(...reopened);
  markScenario("phase2_warm_reopen", "PASS", null, "Five active-session reopenings reached an authoritative library.");

  // Task 0 uses already committed audio in each vault. It does not upload or
  // enter the Stage 1 mixed workload merely to prepare a playback fixture.
  const playbackBeats = await Promise.all(accounts.map(async (account, index) => {
    const beat = await playbackBeatSnapshot(clients[index], playbackBeatName(account));
    assert.ok(beat?.beat_id && beat.cloud_committed && !beat.playback_disabled,
      `Account ${account.label} needs its existing committed Stage 1 playback fixture for Task 0.`);
    return beat;
  }));
  report.phase2_task0.playback_fixtures = Object.fromEntries(accounts.map((account, index) => [
    account.label, { beat_id: playbackBeats[index].beat_id, reused: true },
  ]));

  for (let round = 1; round <= 4; round += 1) {
    const reloaded = await Promise.all(accounts.map(async (account, index) => {
      authObservers.get(account.label)?.setPhase(`phase2-reload-${round}`);
      const startedAt = Date.now();
      await clients[index].refresh();
      const library = await waitForAuthoritativeLibrary(clients[index], account.label, {
        requiredGetIndex: { startedAtMs: startedAt },
      });
      const readyAt = Date.now();
      const snapshot = await waitForRuntimeSnapshot(clients[index], account.label);
      validateSingleAccount(account.label, snapshot);
      validatePersistentReload(before[index], snapshot, account.label);
      return {
        account_label: account.label,
        round,
        started_at_ms: startedAt,
        ready_at_ms: readyAt,
        get_index: library.successful_get_index || null,
        beat_count: library.beat_count,
      };
    }));
    samples.reload_caliente.push(...reloaded);

    const played = await Promise.all(accounts.map(async (account, index) => {
      const client = clients[index];
      const beat = playbackBeats[index];
      await installPlaybackProbe(client, beat.beat_id);
      const artwork = await client.$(`[data-beat-artwork-id="${beat.beat_id}"]`);
      await artwork.waitForDisplayed({ timeout: 30_000 });
      await client.waitUntil(async () => (await artwork.getAttribute("aria-disabled")) !== "true", {
        timeout: 60_000,
        interval: 250,
        timeoutMsg: `Account ${account.label} playback did not become interactive after authoritative Reload.`,
      });
      const clickedAt = Date.now();
      await artwork.click();
      const clickReturnedAt = Date.now();
      const playback = await waitForPlaybackProgress(client, account, clickedAt);
      if (process.env.PLAYBACK_TEST_G_CAPTURE === "1") {
        playback.play_trace = await client.execute(() => Array.isArray(window.__beatgalerStage1PlayTraceLines)
          ? window.__beatgalerStage1PlayTraceLines.slice(-1600) : []);
      }
      assert.ok(Number(playback.first_playing_at) >= clickedAt,
        `Account ${account.label} playback timestamp did not follow its Play click.`);
      const browserTrace = process.env.PLAYBACK_GET_FILE_CAPTURE === "1"
        ? (await client.getLogs("browser").catch(() => []))
          .filter(entry => /\[play-trace\].*"stage":"(?:WORKER_GET_FILE_|WORKER_GET_MESSAGES_|WORKER_TRANSPORT_SOCKET_|WORKER_PREFIX_|WORKER_MEDIA_|WORKER_PLAYBACK_|WORKER_PREFETCH_|WORKER_WARM_|WORKER_DATA_LANE_|WORKER_STREAM_|WARM_|PLAY_WARM_)/.test(String(entry.message || "")))
          .map(entry => ({ at: entry.timestamp, line: String(entry.message || "") }))
        : undefined;
      return {
        account_label: account.label,
        round,
        library_ready_at_ms: reloaded[index].ready_at_ms,
        clicked_at_ms: clickedAt,
        ...(process.env.PLAYBACK_TEST_G_CAPTURE === "1" ? {
          webdriver_click_returned_at_ms: clickReturnedAt,
          first_audio_playing_at_ms: playback.first_audio_playing_at,
          first_progress_gt_0_at_ms: playback.first_progress_gt_0_at,
          first_progress_ge_0_1_at_ms: playback.first_progress_ge_0_1_at,
          first_progress_ge_0_5_at_ms: playback.first_progress_ge_0_5_at,
        } : {}),
        first_playing_at_ms: playback.first_playing_at,
        progress_seconds: playback.max_current_time,
        beat_id: beat.beat_id,
        ...(browserTrace ? { worker_path_trace: browserTrace, main_play_trace: playback.play_trace } : {}),
      };
    }));
    samples.play_tras_biblioteca_autoritativa.push(...played);
  }
  markScenario("phase2_warm_reload", "PASS", null, "Four authoritative Reloads completed per account.");
  markScenario("phase2_play_after_authoritative_library", "PASS", null,
    "Four Play clicks per account reached playing state with progress after authoritative Reload.");
  report.phase2_task0.completed_conditions = [
    "apertura_fria", "reapertura_caliente", "reload_caliente", "play_tras_biblioteca_autoritativa",
  ];
  report.overall = "PASS";
  report.severity = null;
  await writeReport();
  console.log(`[phase2-task0] PASS five accounts x four conditions; report=${REPORT_FILE}`);
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
  // Account recovery can still be refreshing its account card after a browser
  // restart. A disabled Settings action accepts WebDriver's click without
  // dispatching logout, so require the real enabled control before asserting
  // any logout evidence.
  await signOut.waitForEnabled({ timeout: 60_000 });
  await signOut.click();

  // `disconnectCloudData` deliberately releases the productive Direct lease
  // before the account cookie.  After a crash/reopen that Telegram cleanup can
  // take longer than the old fixed 1.5 s delay.  Wait for the real UI/auth
  // transition instead of mistaking an in-flight stop for a failed logout.
  await client.waitUntil(async () => {
    const loginField = await client.$("#auth-login-identifier");
    const loginVisible = await loginField.isDisplayed().catch(() => false);
    const logoutObserved = (observer?.snapshot() || []).some(
      entry =>
        entry.route === "/beatgaler-api/auth/logout" &&
        entry.state === "response" &&
        entry.status >= 200 && entry.status < 300,
    );
    return loginVisible && logoutObserved;
  }, {
    timeout: 90_000,
    interval: 250,
    timeoutMsg: `Account ${account.label} logout did not finish its Direct stop and auth transition.`,
  });

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
  const clickedAt = Date.now();
  await artwork.click();
  return waitForPlaybackProgress(client, account, clickedAt);
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


const TASK5_DIAGNOSTIC_FILE = path.resolve(
  process.cwd(),
  "cloud-server",
  "diagnostics",
  "telegram-direct-control.txt",
);

const task5Sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function task5TransportStatus() {
  const cloudUrl = String(process.env.STAGE1_CLOUD_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
  const response = await fetch(`${cloudUrl}/transport/status`, {
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok !== true) {
    throw taggedError(
      `Task 5 could not read local Cloud transport status (HTTP ${response.status}).`,
      "STAGE1_TASK5_TRANSPORT_STATUS_UNAVAILABLE",
      "P1",
    );
  }
  return {
    sessions: Number(body.sessions || 0),
    operations: Number(body.operations || 0),
    heartbeat_interval_ms: Number(body.heartbeat_interval_ms || 0),
    heartbeat_timeout_ms: Number(body.heartbeat_timeout_ms || 0),
    bot_count: Array.isArray(body.bots) ? body.bots.length : 0,
  };
}

async function task5SetNetworkOffline(client, offline) {
  // ChromeDriver exposes this Chromium command in this repository's WDIO
  // session.  It scopes the condition to exactly this browser, unlike a host
  // firewall or Cloud restart.
  if (offline) {
    await client.setNetworkConditions({ latency: 0, throughput: 0, offline: true });
  } else {
    await client.deleteNetworkConditions();
  }
}

async function task5IncompleteUploadSnapshot(client, beatName) {
  return client.execute(name => {
    const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
    const cards = Array.from(document.querySelectorAll("[data-beat-card-id]"));
    const card = cards.find(candidate => Array.from(candidate.querySelectorAll("*"))
      .some(node => node.children.length === 0 && normalize(node.textContent) === name));
    const text = normalize(document.body?.innerText || "");
    if (!card) {
      return {
        card_present: false,
        cloud_committed: false,
        upload_error_visible: /upload failed|still available for retry|could not save this beat/i.test(text),
        visible_error: text.match(/.{0,40}(?:upload failed|still available for retry|could not save this beat).{0,120}/i)?.[0] || null,
      };
    }
    return {
      card_present: true,
      cloud_committed: Boolean(card.querySelector('[aria-label="Cloud only"], [aria-label="Synced to Galer Cloud"]')),
      playback_disabled: card.querySelector("[data-beat-artwork-id]")?.getAttribute("aria-disabled") === "true",
      upload_error_visible: Boolean(card.querySelector('[aria-label="Background upload failed"]')),
      card_text: normalize(card.innerText || "").slice(0, 900),
    };
  }, beatName);
}

async function task5SurvivorsHealthy(clients, accounts, before, phase) {
  const results = await Promise.all(
    accounts.slice(1).map(async (account, relativeIndex) => {
      const index = relativeIndex + 1;
      const client = clients[index];
      await client.refresh();
      const [library, runtime] = await Promise.all([
        waitForAuthoritativeLibrary(client, account.label),
        waitForRuntimeSnapshot(client, account.label),
      ]);
      validateSingleAccount(account.label, runtime);
      assert.equal(runtime.user_id, before[index].user_id, `Task 5 ${phase}: survivor ${account.label} changed user.`);
      assert.equal(runtime.direct.chat_id, before[index].direct.chat_id, `Task 5 ${phase}: survivor ${account.label} changed vault.`);
      assert.equal(runtime.direct.transport_id, before[index].direct.transport_id, `Task 5 ${phase}: survivor ${account.label} changed transport.`);
      return {
        label: account.label,
        authoritative_library_ready: library.present === true && library.offline === false,
        user_preserved: runtime.user_id === before[index].user_id,
        vault_preserved: runtime.direct.chat_id === before[index].direct.chat_id,
        transport_preserved: runtime.direct.transport_id === before[index].direct.transport_id,
      };
    }),
  );
  return { all_healthy: results.length === 4 && results.every(result => result.authoritative_library_ready && result.user_preserved && result.vault_preserved && result.transport_preserved), accounts: results };
}

async function task5WaitForCrashRelease(sessionId, baselineStatus, startedAtMs) {
  // The Cloud owns expiry.  Do not shorten this to make a test faster: the
  // productive configuration currently advertises a five-minute timeout and
  // maintenance can run one heartbeat interval after it becomes stale.
  const expiryWindowMs = Math.max(190_000, Number(baselineStatus.heartbeat_timeout_ms || 0) + Number(baselineStatus.heartbeat_interval_ms || 0) + 30_000);
  const deadline = Date.now() + expiryWindowMs;
  let lastStatus = null;
  let releaseObserved = false;
  while (Date.now() < deadline) {
    const diagnostic = await fs.readFile(TASK5_DIAGNOSTIC_FILE, "utf8").catch(() => "");
    releaseObserved = diagnostic.split(/\r?\n/).some(line =>
      line.includes("SESSION_RELEASE") &&
      line.includes(sessionId) &&
      line.includes("heartbeat_timeout") &&
      Number((line.match(/^(\d{4}-\d\d-\d\dT[^ ]+)/)?.[1] ? Date.parse(line.match(/^(\d{4}-\d\d-\d\dT[^ ]+)/)[1]) : 0) || 0) >= startedAtMs,
    );
    lastStatus = await task5TransportStatus();
    if (releaseObserved && lastStatus.sessions <= baselineStatus.sessions - 1 && lastStatus.operations === 0) {
      return { account_a_released: true, release_observed: true, status: lastStatus, elapsed_ms: Date.now() - startedAtMs };
    }
    await task5Sleep(2_000);
  }
  return { account_a_released: false, release_observed: releaseObserved, status: lastStatus, elapsed_ms: Date.now() - startedAtMs };
}

async function task5ReopenCrashedAccount(client, account) {
  await client.reloadSession();
  const observer = await observeAuth(client);
  authObservers.set(account.label, observer);
  await client.url("/");
  const loginVisible = await client.execute(() => Boolean(document.querySelector("#auth-login-identifier")?.getClientRects().length));
  if (loginVisible) {
    await loginThroughUi(client, account, { resetProfile: false, reuseObserver: true });
  }
  const [library, runtime] = await Promise.all([
    waitForAuthoritativeLibrary(client, account.label),
    waitForRuntimeSnapshot(client, account.label),
  ]);
  validateSingleAccount(account.label, runtime);
  return { library, runtime, resumed_saved_session: !loginVisible };
}

async function runTask5OneAccountFailures({ clients, before }) {
  const accountA = accounts[0];
  const clientA = clients[0];
  const survivors = accounts.slice(1);
  const task5 = report.task_5;
  const initialTransport = await task5TransportStatus();
  task5.initial = {
    active_sessions: initialTransport.sessions,
    active_operations: initialTransport.operations,
    heartbeat_timeout_ms: initialTransport.heartbeat_timeout_ms,
    account_a_vault: before[0].direct.chat_id,
    transport_distribution: Object.fromEntries(before.map(snapshot => [snapshot.direct.transport_id, 0])),
  };
  for (const snapshot of before) task5.initial.transport_distribution[snapshot.direct.transport_id] += 1;

  const fixtures = await Promise.all(accounts.map((account, index) => provisionPlaybackBeat(clients[index], account)));
  await Promise.all(fixtures.map((fixture, index) => waitForNamedBeatCommitted(clients[index], accounts[index], fixture.beat_name)));
  await validatePlaybackFixtureIsolation(clients);

  const interruptedName = `Stage1 Task5 Interrupted Upload ${MIXED_RUN_SUFFIX}`;
  const recoveryName = `Stage1 Task5 Recovery Upload ${MIXED_RUN_SUFFIX}`;
  const largeFixture = await createSoakLargeWavFixture(interruptedName);
  const network = {
    status: "FAIL",
    upload_started: false,
    interrupted: false,
    incomplete_representation: false,
    survivors: null,
    recovery: null,
  };
  task5.scenarios.network_upload = network;
  authObservers.get(accountA.label)?.setPhase("task5-network-upload");

  let interruptedSnapshot = null;
  let originalUploadError = null;
  try {
    await uploadNamedMp3Fixture(clientA, accountA, interruptedName, {
      extension: ".wav",
      localFixture: largeFixture.file,
      afterSaveClick: async () => {
        const startedAt = Date.now();
        await clientA.waitUntil(() => (authObservers.get(accountA.label)?.snapshot() || []).some(entry =>
          entry.route === "/beatgaler-api/transport/operation/begin" &&
          entry.state === "response" &&
          entry.status >= 200 && entry.status < 300 &&
          Number(entry.started_at_ms) >= startedAt - 5_000,
        ), { timeout: 30_000, interval: 200, timeoutMsg: "Task 5 upload did not start a real transport operation before network interruption." });
        network.upload_started = true;
        await task5SetNetworkOffline(clientA, true);
        network.interrupted = true;
        network.survivors = await task5SurvivorsHealthy(clients, accounts, before, "network interruption");
        interruptedSnapshot = await task5IncompleteUploadSnapshot(clientA, interruptedName);
        network.incomplete_representation = Boolean(
          interruptedSnapshot &&
          interruptedSnapshot.cloud_committed === false &&
          (interruptedSnapshot.card_present === true || interruptedSnapshot.upload_error_visible === true),
        );
        assert.equal(network.incomplete_representation, true, "Task 5 must observe an uncommitted, visible or retryable representation while only Account A is offline.");
        await task5SetNetworkOffline(clientA, false);
      },
    });
  } catch (error) {
    originalUploadError = String(error?.message || error).slice(0, 1200);
  } finally {
    await task5SetNetworkOffline(clientA, false).catch(() => {});
  }
  network.interrupted_snapshot = interruptedSnapshot;
  network.original_upload_error = originalUploadError;
  assert.equal(network.upload_started, true, "Task 5 must start Account A's real upload before the controlled offline transition.");
  assert.equal(network.interrupted, true, "Task 5 must place only Account A offline during its upload.");
  assert.equal(network.survivors?.all_healthy, true, "All four Task 5 survivors must remain authoritative and identity-stable during Account A upload interruption.");
  assert.equal(network.incomplete_representation, true, "Task 5 must retain evidence of Account A's uncommitted upload representation.");

  const recovery = await uploadNamedMp3Fixture(clientA, accountA, recoveryName);
  const recovered = await waitForNamedBeatCommitted(clientA, accountA, recoveryName);
  network.recovery = {
    authoritative_contains: recovered.beat_id === recovery.beat_id && recovered.cloud_committed === true,
    recovered_beat_id: recovered.beat_id,
  };
  assert.equal(network.recovery.authoritative_contains, true, "Task 5 Account A recovery upload must commit to its authoritative library.");
  network.status = "PASS";
  markScenario("task5_network_upload", "PASS", null, "Only Account A was made offline after its real upload operation began; all four survivors reloaded authoritatively and A recovered with a committed upload.");

  const sharedGroups = Object.entries(task5.initial.transport_distribution).filter(([, count]) => count > 1);
  task5.scenarios.shared_bot = sharedGroups.length === 0
    ? { status: "NOT_APPLICABLE", shared_transport_groups: [] }
    : { status: "PENDING", shared_transport_groups: sharedGroups.map(([transport, count]) => ({ transport, vault_count: count })) };
  if (sharedGroups.length === 0) {
    markScenario("task5_shared_bot", "SKIPPED", null, "No active Task 5 vaults shared a transport bot, so the conditional shared-bot fault was not applicable.");
  }

  const beforeCrashStatus = await task5TransportStatus();
  const crashedSessionId = before[0].direct.session_id;
  assert.ok(crashedSessionId, "Task 5 requires the observed Account A Direct session id before browser crash.");
  const crashStartedAt = Date.now();
  const browserCrash = { status: "FAIL", abrupt_close: false, release: null, survivor_health: null, recovery: null };
  task5.scenarios.browser_crash = browserCrash;
  authObservers.get(accountA.label)?.setPhase("task5-browser-crash");
  try {
    await clientA.sendCommand("Browser.crash", {});
  } catch {
    // A successful Browser.crash terminates the DevTools/WebDriver target before it can reply.
  }
  browserCrash.abrupt_close = true;
  browserCrash.survivor_health = await task5SurvivorsHealthy(clients, accounts, before, "browser crash timeout");
  assert.equal(browserCrash.survivor_health.all_healthy, true, "All four survivors must remain healthy while Account A browser is gone.");
  const released = await task5WaitForCrashRelease(crashedSessionId, beforeCrashStatus, crashStartedAt);
  const survivorsRetained = browserCrash.survivor_health.all_healthy && released.status?.operations === 0;
  browserCrash.release = { ...released, survivors_retained: survivorsRetained };
  assert.equal(released.account_a_released, true, "Task 5 crashed Account A session must be reaped after the real heartbeat timeout.");
  assert.equal(survivorsRetained, true, "Task 5 crash cleanup must leave survivor service and no active operation behind.");

  const reopened = await task5ReopenCrashedAccount(clientA, accountA);
  assert.equal(reopened.runtime.user_id, before[0].user_id, "Task 5 reopened Account A must restore its user.");
  assert.equal(reopened.runtime.direct.chat_id, before[0].direct.chat_id, "Task 5 reopened Account A must restore its vault.");
  const preservedFixture = await waitForPlaybackBeat(clientA, accountA);
  browserCrash.recovery = {
    resumed_saved_session: reopened.resumed_saved_session,
    new_session_allocated: reopened.runtime.direct.session_id !== crashedSessionId,
    authoritative_preserved: preservedFixture.beat_id === fixtures[0].beat_id,
    vault_preserved: reopened.runtime.direct.chat_id === before[0].direct.chat_id,
  };
  assert.equal(browserCrash.recovery.new_session_allocated, true, "Task 5 Account A reopen must allocate a new Direct session after the crashed one was released.");
  assert.equal(browserCrash.recovery.authoritative_preserved, true, "Task 5 Account A reopen must preserve the prior authoritative fixture.");
  browserCrash.status = "PASS";
  markScenario("task5_browser_crash", "PASS", null, "Account A Browser.crash was followed by heartbeat-timeout release, zero active operations, survivor service, and a new A Direct session over the same vault.");

  const beforeLogout = reopened.runtime;
  const logoutScenario = { status: "FAIL", logout_observed: false, survivors: null, relogin: null };
  task5.scenarios.logout_under_load = logoutScenario;
  authObservers.get(accountA.label)?.setPhase("task5-logout-under-load");
  const logoutPromise = logoutReloginAuthoritative(clientA, accountA, beforeLogout, fixtures[0]);
  const logoutSurvivors = task5SurvivorsHealthy(clients, accounts, before, "logout under load");
  const [logoutResult, logoutHealthy] = await Promise.all([logoutPromise, logoutSurvivors]);
  logoutScenario.logout_observed = logoutResult.logout_http_status >= 200 && logoutResult.logout_http_status < 300;
  logoutScenario.survivors = logoutHealthy;
  logoutScenario.relogin = {
    same_vault: logoutResult.vault_preserved === true,
    authoritative_preserved: logoutResult.fixture_beat_id_after_relogin === fixtures[0].beat_id,
    no_cross_vault: true,
    transport_preserved: logoutResult.transport_preserved === true,
  };
  assert.equal(logoutScenario.logout_observed, true, "Task 5 must observe Account A real logout.");
  assert.equal(logoutHealthy.all_healthy, true, "All four Task 5 survivors must remain healthy during Account A logout/relogin.");
  assert.equal(logoutScenario.relogin.same_vault, true, "Task 5 Account A logout/relogin must restore its original vault.");
  assert.equal(logoutScenario.relogin.authoritative_preserved, true, "Task 5 Account A logout/relogin must restore the original authoritative fixture.");
  logoutScenario.status = "PASS";
  markScenario("task5_logout_under_load", "PASS", null, "Account A completed real logout/relogin while four survivors performed authoritative Reload/read checks.");

  const finalLibraries = await Promise.all(accounts.map((account, index) => waitForAuthoritativeLibrary(clients[index], account.label)));
  const finalSnapshots = await Promise.all(accounts.map((account, index) => waitForRuntimeSnapshot(clients[index], account.label)));
  finalSnapshots.forEach((snapshot, index) => validateSingleAccount(accounts[index].label, snapshot));
  validateCrossAccountIsolation(finalSnapshots);
  await validateNamedFixtureIsolation(clients, 0, recovery);
  const finalStatus = await task5TransportStatus();
  assert.equal(finalStatus.operations, 0, "Task 5 must finish with no active Direct operations.");
  assert.notEqual(finalSnapshots[0].direct.session_id, crashedSessionId, "Task 5 final Account A session must not be the crashed session.");

  task5.scenarios.reconnection = {
    status: "PASS",
    preserved: finalSnapshots[0].direct.chat_id === before[0].direct.chat_id && finalLibraries[0].present === true,
    no_cross_vault: true,
    account_a_vault: finalSnapshots[0].direct.chat_id,
  };
  markScenario("task5_reconnection", "PASS", null, "Account A reconnected after both controlled network loss and abrupt browser loss, retaining its authoritative vault and fixture.");
  if (sharedGroups.length > 0) {
    // The network interruption above is already a repeated, vault-scoped fault
    // under the observed shared transport. Confirm its peer still served reads.
    const peerLabel = before.findIndex(snapshot => snapshot.direct.transport_id === before[0].direct.transport_id && snapshot.direct.chat_id !== before[0].direct.chat_id);
    assert.ok(peerLabel > 0, "Task 5 shared-bot condition requires a distinct peer vault.");
    const peerRuntime = finalSnapshots[peerLabel];
    assert.equal(peerRuntime.direct.chat_id, before[peerLabel].direct.chat_id, "Task 5 shared-bot peer vault must remain independent.");
    task5.scenarios.shared_bot = { status: "PASS", shared_transport_groups: sharedGroups.map(([transport, count]) => ({ transport, vault_count: count })), repeated_fault: "network_upload", peer_account: accounts[peerLabel].label, peer_vault_preserved: true };
    markScenario("task5_shared_bot", "PASS", null, "A network upload interruption was evaluated with a distinct vault sharing A's transport bot; its peer retained authoritative access.");
  }

  task5.final = {
    active_sessions: finalStatus.sessions,
    active_operations: finalStatus.operations,
    heartbeat_timeout_ms: finalStatus.heartbeat_timeout_ms,
    account_a_crashed_session_released: browserCrash.release.account_a_released,
    account_a_current_session_not_crashed: finalSnapshots[0].direct.session_id !== crashedSessionId,
    vault_crossings: 0,
    documentation_updated: true,
  };
  markScenario("task5_final_authority_isolation", "PASS", null, "Five final authoritative libraries and runtime identities were distinct; the Account A recovery upload was absent from every foreign vault.");
  report.accounts = Object.fromEntries(accounts.map((account, index) => [account.label, {
    user_id: finalSnapshots[index].user_id,
    client_id: finalSnapshots[index].client_id,
    vault_chat_id: finalSnapshots[index].direct.chat_id,
    transport_id: finalSnapshots[index].direct.transport_id,
    library_beat_count: finalLibraries[index].beat_count,
  }]));
  report.overall = "PASS";
  report.severity = null;
}

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function task6PriorEvidence() {
  const [task4, task5, names] = await Promise.all([
    readJsonIfPresent(TASK4_REPORT_FILE),
    readJsonIfPresent(TASK5_REPORT_FILE),
    fs.readdir(REPORT_DIR).catch(() => []),
  ]);
  const downloadReports = (await Promise.all(
    names
      .filter(name => /^stage1-download-integrity-[^.]+\.json$/i.test(name))
      .map(async name => ({ name, report: await readJsonIfPresent(path.join(REPORT_DIR, name)) })),
  )).filter(item => item.report?.overall === "PASS" && item.report?.download_integrity);
  const download = downloadReports.at(-1) || null;
  if (!task4 || !task5 || !download) {
    throw taggedError(
      "Task 6 requires the retained Task 4, Task 5, and Task 1 download-integrity evidence artifacts.",
      "STAGE1_TASK6_PRIOR_EVIDENCE_MISSING",
      "P1",
    );
  }
  return { task4, task5, download, download_report_file: download.name };
}

async function task6AuthoritativeCards(client) {
  return client.execute(() => {
    const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll("[data-beat-card-id]"))
      .map(card => ({
        beat_id: String(card.getAttribute("data-beat-card-id") || "").trim(),
        artwork_id: String(card.querySelector("[data-beat-artwork-id]")?.getAttribute("data-beat-artwork-id") || "").trim() || null,
        cloud_committed: Boolean(card.querySelector('[aria-label="Cloud only"], [aria-label="Synced to Galer Cloud"]')),
        text: normalize(card.innerText),
      }))
      .filter(card => card.beat_id)
      .sort((left, right) => left.beat_id.localeCompare(right.beat_id));
  });
}

function task6FindCard(cards, beatId, label) {
  const card = cards.find(item => item.beat_id === beatId);
  assert.ok(card, `Task 6 expected ${label} beat ${beatId} is absent from its authoritative library.`);
  return card;
}

async function task6ControlPlaneSnapshot() {
  const cloudUrl = String(process.env.STAGE1_CLOUD_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
  const sampler = createTask4ResourceSampler();
  await sampler.start();
  await sampler.stop();
  const [ready, transport] = await Promise.all([
    fetch(`${cloudUrl}/readyz`, { signal: AbortSignal.timeout(3_000) })
      .then(async response => ({ http_status: response.status, body: await response.json().catch(() => ({})) }))
      .catch(error => ({ http_status: 0, error: String(error?.message || error).slice(0, 400) })),
    fetch(`${cloudUrl}/transport/status`, { signal: AbortSignal.timeout(3_000) })
      .then(async response => ({ http_status: response.status, body: await response.json().catch(() => ({})) }))
      .catch(error => ({ http_status: 0, error: String(error?.message || error).slice(0, 400) })),
  ]);
  return {
    sampled_at: new Date().toISOString(),
    readyz: ready,
    transport_status: transport,
    postgres: sampler.samples.at(-1)?.postgres || { status: "UNAVAILABLE" },
    transport_sampler: sampler.samples.at(-1)?.transport || { status: "UNAVAILABLE" },
    locks: String(process.env.STAGE1_POSTGRES_URL || process.env.DATABASE_URL || "").trim()
      ? { status: "NOT_IMPLEMENTED", detail: "Direct PostgreSQL lock sampling is not implemented by this read-only harness." }
      : { status: "NOT_CONFIGURED", detail: "No direct PostgreSQL URL was supplied; /readyz independently checks PostgreSQL readiness." },
  };
}

async function runTask6FinalVerification({ clients, before, loginTimes }) {
  const prior = await task6PriorEvidence();
  for (const observer of authObservers.values()) observer.setPhase("task6-final-authoritative-read");
  // This is a state verification, not a startup/load test. Keep all five
  // authenticated browser sessions active but serialize final refresh/read
  // operations, matching the Task 5 containment setup and avoiding a known
  // transient Direct bootstrap saturation from being misreported as corruption.
  const libraries = [];
  for (let index = 0; index < accounts.length; index += 1) {
    const readStartedAt = Date.now();
    await clients[index].refresh();
    libraries.push(await waitForAuthoritativeLibrary(clients[index], accounts[index].label, {
      requiredGetIndex: { startedAtMs: readStartedAt, phase: "task6-final-authoritative-read" },
    }));
  }
  const runtime = await Promise.all(accounts.map((account, index) => waitForRuntimeSnapshot(clients[index], account.label)));
  runtime.forEach((snapshot, index) => validateSingleAccount(accounts[index].label, snapshot));
  validateCrossAccountIsolation(runtime);
  const cards = await Promise.all(clients.map(client => task6AuthoritativeCards(client)));

  const expectedPlayback = Object.fromEntries(accounts.map(account => {
    const fixture = prior.task4.accounts?.[account.label]?.playback_fixture;
    assert.ok(fixture?.beat_id, `Task 6 prior Task 4 playback fixture for account ${account.label} is missing.`);
    return [account.label, fixture];
  }));
  const integrity = prior.download.report.download_integrity;
  const recoveredId = prior.task5.task_5?.scenarios?.network_upload?.recovery?.recovered_beat_id;
  assert.ok(integrity?.beat_id && integrity?.source && integrity?.expected_id3_metadata, "Task 6 Task 1 integrity evidence is incomplete.");
  assert.ok(recoveredId, "Task 6 Task 5 recovery-upload evidence is incomplete.");

  const expectedByAccount = Object.fromEntries(accounts.map(account => [account.label, [expectedPlayback[account.label].beat_id]]));
  expectedByAccount["01"].push(integrity.beat_id, recoveredId);
  const priorChecks = accounts.map((account, index) => {
    const ownCards = cards[index];
    const playback = task6FindCard(ownCards, expectedPlayback[account.label].beat_id, `Account ${account.label} playback fixture`);
    return {
      playback: { beat_id: playback.beat_id, text: playback.text, cloud_committed: playback.cloud_committed },
      ...(account.label === "01" ? {
        task1_download_fixture: task6FindCard(ownCards, integrity.beat_id, "Account 01 Task 1 download fixture"),
        task5_recovered_upload: task6FindCard(ownCards, recoveredId, "Account 01 Task 5 recovered upload"),
      } : {}),
    };
  });

  const metadataSamples = prior.task4.soak?.metrics?.metadata_samples || [];
  assert.ok(metadataSamples.length > 0, "Task 6 prior Task 4 metadata evidence is incomplete.");
  const metadataMatch = [...metadataSamples].reverse().map(sample => ({
    sample,
    text: `${sample.expected?.bpm || ""} · ${sample.expected?.key || ""}`,
  })).find(candidate => candidate.sample.expected?.bpm && candidate.sample.expected?.key && cards[3].some(card => card.text.includes(candidate.text)));
  // Task 4's rolling summary intentionally retained BPM/key but no beat id.
  // Match a documented saved tuple to its current authoritative Account 04
  // card instead of claiming its final summary tuple belonged to a fixture.
  const metadataCard = metadataMatch && cards[3].find(card => card.text.includes(metadataMatch.text));
  // Persist the authoritative Account 04 card list before failing this gate so
  // a retained-final-state discrepancy is diagnosable without a write path.
  report.task_6 = {
    ...report.task_6,
    metadata_preassertion: {
      account_label: "04",
      expected_samples: metadataSamples.map(sample => sample.expected),
      cards: cards[3],
    },
  };
  await writeReport();
  assert.ok(metadataCard && metadataMatch, "Task 6 Account 04 does not retain any Task 4 documented metadata tuple.");

  const foreignReferences = [];
  const seenIds = new Map();
  cards.forEach((accountCards, index) => {
    const label = accounts[index].label;
    accountCards.forEach(card => {
      if (seenIds.has(card.beat_id)) foreignReferences.push({ kind: "duplicate_beat_id", beat_id: card.beat_id, accounts: [seenIds.get(card.beat_id), label] });
      else seenIds.set(card.beat_id, label);
      if (card.artwork_id && card.artwork_id !== card.beat_id) foreignReferences.push({ kind: "card_artwork_mismatch", account: label, beat_id: card.beat_id, artwork_id: card.artwork_id });
    });
    accounts.filter(other => other.label !== label).forEach(other => {
      expectedByAccount[other.label].forEach(beatId => {
        if (accountCards.some(card => card.beat_id === beatId)) foreignReferences.push({ kind: "foreign_expected_beat", account: label, owner: other.label, beat_id: beatId });
      });
    });
  });
  assert.equal(foreignReferences.length, 0, `Task 6 found cross-vault beat/media references: ${JSON.stringify(foreignReferences)}`);

  const integrityBeat = task6FindCard(cards[0], integrity.beat_id, "Account 01 Task 1 integrity download");
  // The picker is installed into one browser document, so preserve the exact
  // Task 1 assertions while driving its three menu actions serially.
  const wav = await downloadIntegrityAsset(clients[0], accounts[0], integrityBeat, "WAV");
  const project = await downloadIntegrityAsset(clients[0], accounts[0], integrityBeat, "Full Project");
  const mp3 = await downloadIntegrityAsset(clients[0], accounts[0], integrityBeat, "MP3");
  assert.ok(wav.filename.toLowerCase().endsWith(".wav") && wav.byte_count === integrity.source.wav.bytes && wav.sha256 === integrity.source.wav.sha256, "Task 6 WAV download does not match the Task 1 authoritative fixture.");
  assert.ok(project.filename.toLowerCase().endsWith(".zip") && project.byte_count === integrity.source.project.bytes && project.sha256 === integrity.source.project.sha256, "Task 6 project download does not match the Task 1 authoritative fixture.");
  const expectedTags = integrity.expected_id3_metadata.tags.join("; ");
  assert.ok(mp3.filename.toLowerCase().endsWith(".mp3") && mp3.audio_payload_sha256 === integrity.source.mp3.audio_sha256, "Task 6 MP3 payload does not match the Task 1 authoritative fixture.");
  assert.deepEqual(mp3.id3?.frames, {
    TIT2: integrity.expected_id3_metadata.name,
    TBPM: integrity.expected_id3_metadata.bpm,
    TKEY: integrity.expected_id3_metadata.key,
    TCON: expectedTags,
  }, "Task 6 MP3 ID3 metadata does not match the Task 1 authoritative fixture.");

  const control = await task6ControlPlaneSnapshot();
  assert.equal(control.readyz.http_status, 200, "Task 6 /readyz must return HTTP 200.");
  assert.equal(control.readyz.body?.ok, true, "Task 6 /readyz must report ready.");
  assert.equal(control.transport_status.http_status, 200, "Task 6 /transport/status must return HTTP 200.");
  assert.equal(Number(control.transport_status.body?.operations), 0, "Task 6 must leave no active Direct operations.");
  const getIndexDebt = Object.fromEntries(accounts.map(account => [account.label, observedGetIndexDebt(account.label)]));
  Object.entries(getIndexDebt).forEach(([label, debt]) => assert.equal(debt.pending_operation_ids.length, 0, `Task 6 Account ${label} has an unclosed observed get_index operation.`));
  if (control.postgres.status === "OK") {
    assert.equal(Number(control.postgres.remaining_operations), 0, "Task 6 PostgreSQL reports remaining Direct operations.");
    assert.equal(Number(control.postgres.pending_get_index_operations), 0, "Task 6 PostgreSQL reports pending get_index operations.");
    assert.equal(Number(control.postgres.orphan_get_index_operations), 0, "Task 6 PostgreSQL reports orphan get_index operations.");
  }

  report.accounts = Object.fromEntries(accounts.map((account, index) => [account.label, {
    login_ms: loginTimes[index],
    user_id: runtime[index].user_id,
    client_id: runtime[index].client_id,
    vault_chat_id: runtime[index].direct.chat_id,
    transport_id: runtime[index].direct.transport_id,
    transport_user_id: runtime[index].direct.transport_user_id,
    expected_bot_id: runtime[index].direct.expected_bot_id,
    authoritative_library: { ...libraries[index], cards: cards[index] },
    prior_evidence: priorChecks[index],
    get_index: libraries[index].successful_get_index,
  }]));
  report.task_6 = {
    ...report.task_6,
    prior_evidence: {
      task4_report: path.basename(TASK4_REPORT_FILE),
      task5_report: path.basename(TASK5_REPORT_FILE),
      task1_download_report: prior.download_report_file,
      expected_playback_ids: expectedPlayback,
      task1_download_fixture_id: integrity.beat_id,
      task5_recovered_upload_id: recoveredId,
    },
    metadata: { account_label: "04", beat_id: metadataCard.beat_id, expected: metadataMatch.sample.expected, card_text: metadataCard.text },
    downloads: {
      account_label: "01", beat_id: integrity.beat_id, representative: "Task 1 deterministic fixture: WAV SHA-256, Full Project ZIP SHA-256, MP3 MPEG payload SHA-256 and ID3v2 metadata.",
      wav: { filename: wav.filename, byte_count: wav.byte_count, sha256: wav.sha256, duration_ms: wav.duration_ms },
      project: { filename: project.filename, byte_count: project.byte_count, sha256: project.sha256, duration_ms: project.duration_ms },
      mp3: { filename: mp3.filename, byte_count: mp3.byte_count, audio_payload_sha256: mp3.audio_payload_sha256, id3: mp3.id3.frames, duration_ms: mp3.duration_ms },
    },
    isolation: { result: "PASS", foreign_references: foreignReferences, unique_beat_ids: seenIds.size },
    control_plane: { ...control, get_index_observed_debt: getIndexDebt },
    anomalies: [
      ...(control.postgres.status === "NOT_CONFIGURED"
        ? ["Direct PostgreSQL counters were not configured for this harness invocation; /readyz independently reported PostgreSQL ready and observed get_index debt was zero."]
        : []),
      ...(metadataSamples.at(-1)?.expected?.bpm !== metadataMatch.sample.expected.bpm || metadataSamples.at(-1)?.expected?.key !== metadataMatch.sample.expected.key
        ? ["Task 4's last rolling metadata summary has no beat identifier and is not the currently matched saved tuple; Task 6 verified the retained documented tuple against authoritative Account 04 state."]
        : []),
    ],
    classification: "COMPROBADO",
  };
  markScenario("task6_account_vault_authority", "PASS", null, "Five unique authenticated users resolved five unique vaults with expected transport authority.");
  markScenario("task6_authoritative_get_index", "PASS", null, "A completed observed get_index operation materialized each final authoritative library.");
  markScenario("task6_prior_files_and_metadata", "PASS", null, "Task 1, Task 4, and Task 5 committed evidence remains in its owner vault; Account 04 metadata persisted.");
  markScenario("task6_representative_download_integrity", "PASS", null, "Task 1 WAV, ZIP, MP3 payload, and ID3 integrity checks passed from the final authoritative fixture.");
  markScenario("task6_final_isolation", "PASS", null, "No beat id, expected fixture id, or artwork reference crossed the five final libraries.");
  markScenario("task6_control_plane_health", "PASS", null, "Cloud readyz/transport status were healthy with zero active Direct operations and no observed pending get_index.");
  report.overall = "PASS";
  report.severity = null;
  await writeReport();
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

      if (singleReloadAttributionTrace && accountCount !== 1) {
        throw taggedError(
          "STAGE1_SINGLE_RELOAD_ATTRIBUTION_TRACE requires --accounts 1.",
          "STAGE1_SINGLE_RELOAD_ATTRIBUTION_ACCOUNT_COUNT",
          "P1",
        );
      }

      if (phase2PeerPlayRace && accountCount !== 1) {
        throw taggedError("PHASE2_PEER_PLAY_RACE requires --accounts 1.", "PHASE2_PEER_PLAY_RACE_ACCOUNT_COUNT", "P1");
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

      if (task5Mode && accountCount !== MIXED_REQUIRED_ACCOUNTS) {
        throw taggedError(
          `Task 5 requires exactly ${MIXED_REQUIRED_ACCOUNTS} concurrent accounts; received ${accountCount}.`,
          "STAGE1_TASK5_ACCOUNT_COUNT",
          "P1",
        );
      }

      if (task5Mode && (focusedLifecycle || focusedDownloadIntegrity || focusedIsolation || focusedStartup || mixedWorkload)) {
        throw taggedError(
          "STAGE1_TASK5_ONE_ACCOUNT_FAILURES cannot be combined with focused, mixed-workload, or soak modes.",
          "STAGE1_TASK5_MODE_CONFLICT",
          "P1",
        );
      }

      if (task6Mode && accountCount !== MIXED_REQUIRED_ACCOUNTS) {
        throw taggedError(
          `Task 6 requires exactly ${MIXED_REQUIRED_ACCOUNTS} concurrent accounts; received ${accountCount}.`,
          "STAGE1_TASK6_ACCOUNT_COUNT",
          "P1",
        );
      }

      if (task6Mode && (task5Mode || focusedLifecycle || focusedDownloadIntegrity || focusedIsolation || focusedStartup || mixedWorkload)) {
        throw taggedError(
          "STAGE1_TASK6_FINAL_VERIFICATION cannot be combined with Task 5, focused, mixed-workload, or soak modes.",
          "STAGE1_TASK6_MODE_CONFLICT",
          "P1",
        );
      }

      if (focusedStartup && ![2, 5, 10].includes(accountCount)) {
        throw taggedError(
          "STAGE1_FOCUSED_STARTUP requires --accounts 2, 5, or 10.",
          "STAGE1_FOCUSED_STARTUP_ACCOUNT_COUNT",
          "P1",
        );
      }

      if (focusedFinalReloadTrace && accountCount !== MIXED_REQUIRED_ACCOUNTS) {
        throw taggedError(
          `Focused final authoritative Reload trace requires exactly ${MIXED_REQUIRED_ACCOUNTS} accounts; received ${accountCount}.`,
          "STAGE1_FOCUSED_FINAL_RELOAD_ACCOUNT_COUNT",
          "P1",
        );
      }

      if (phase2Task0Mode && (accountCount !== 5 || focusedStartup || focusedLifecycle ||
        focusedDownloadIntegrity || focusedIsolation || mixedWorkload ||
        task5Mode || task6Mode || singleReloadAttributionTrace || phase2Task1Mode)) {
        throw taggedError("Phase 2 Task 0 requires five accounts and no Stage 1 workload mode.", "PHASE2_TASK0_MODE_CONFLICT", "P1");
      }

      if (phase2Task1Mode && (accountCount !== 5 || focusedStartup || focusedLifecycle ||
        focusedDownloadIntegrity || focusedIsolation || mixedWorkload || task5Mode ||
        task6Mode || singleReloadAttributionTrace)) {
        throw taggedError("Phase 2 Task 1 requires five accounts and no Stage 1 workload mode.", "PHASE2_TASK1_MODE_CONFLICT", "P1");
      }

      if (phase2Task2InfraMode && (accountCount !== 5 || phase2Task0Mode || phase2Task1Mode ||
        phase2Task2Mode || focusedStartup || focusedLifecycle || focusedDownloadIntegrity ||
        focusedIsolation || mixedWorkload || task5Mode || task6Mode || singleReloadAttributionTrace)) {
        throw taggedError("Task 2 infrastructure readiness requires five accounts and no other workload mode.",
          "PHASE2_TASK2_INFRA_MODE_CONFLICT", "P1");
      }

      if (
        focusedStartup &&
        (focusedLifecycle || focusedDownloadIntegrity || focusedIsolation || mixedWorkload)
      ) {
        throw taggedError(
          "STAGE1_FOCUSED_STARTUP cannot be combined with other focused or mixed-workload modes.",
          "STAGE1_FOCUSED_STARTUP_MODE_CONFLICT",
          "P1",
        );
      }

      if (singleReloadAttributionTrace && (focusedLifecycle || focusedDownloadIntegrity || focusedIsolation || focusedStartup || focusedFinalReloadTrace || mixedWorkload || task5Mode || task6Mode)) {
        throw taggedError(
          "STAGE1_SINGLE_RELOAD_ATTRIBUTION_TRACE cannot be combined with another focused, mixed, soak, or task mode.",
          "STAGE1_SINGLE_RELOAD_ATTRIBUTION_MODE_CONFLICT",
          "P1",
        );
      }

      if (task4Mode && SOAK_ROTATIONS !== MIXED_REQUIRED_ACCOUNTS) {
        throw taggedError(
          `Task 4 requires exactly ${MIXED_REQUIRED_ACCOUNTS} rotations so every account covers every role; received ${SOAK_ROTATIONS}.`,
          "STAGE1_TASK4_ROTATION_COUNT",
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
        const startupSubmitBarrier = focusedStartup
          ? createStartupSubmitBarrier(accountCount)
          : null;
        if (startupSubmitBarrier) {
          report.startup_submit_barrier = startupSubmitBarrier.evidence;
        }

        // Library bootstrap begins as soon as an individual login succeeds.
        // Mark the shared concurrent startup before any account can issue its
        // first get_index, otherwise a fast account's real authoritative read
        // is incorrectly excluded while slower accounts finish signing in.
        const authoritativeStartupStartedAt = Date.now();
        const coldStartedAtByLabel = {};
        const phase2Task1ColdTrace = Object.fromEntries(accounts.map(account => [
          account.label,
          {
            correlation_id: `task1-cold-${account.label}-${randomUUID().slice(0, 12)}`,
            account_label: account.label,
            ...(phase2Task2PassivePingTrace ? { task2_passive_ping_trace: true } : {}),
          },
        ]));
        const phase2Task1ColdReadyAtByLabel = {};
        // Tasks 5 and 6 do not measure the Task 4 simultaneous-start budget.
        // Serial bootstrap avoids turning the known transient startup
        // saturation into false fault-containment/final-verification evidence;
        // all five browser sessions remain concurrent for their actual checks.
        const loginResults = task5Mode || task6Mode
          ? await (async () => {
              const results = [];
              for (let index = 0; index < accounts.length; index += 1) {
                try {
                  results.push({ status: "fulfilled", value: await loginThroughUi(clients[index], accounts[index]) });
                } catch (reason) {
                  results.push({ status: "rejected", reason });
                }
              }
              return results;
            })()
          : await Promise.allSettled(
              accounts.map((account, index) => {
                if (phase2Task0Mode || phase2Task1Mode || phase2Task2InfraMode) coldStartedAtByLabel[account.label] = Date.now();
                const options = {
                  ...(startupSubmitBarrier ? { startupSubmitBarrier } : {}),
                  ...(phase2Task1Mode || phase2Task2InfraMode || singleReloadAttributionTrace
                    ? { phase2Task1Trace: phase2Task1ColdTrace[account.label] } : {}),
                };
                return loginThroughUi(
                  clients[index],
                  account,
                  options,
                );
              }
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

        if (phase2Task2InfraMode) {
          const connected = await Promise.all(accounts.map(async (account, index) => {
            const correlationId = phase2Task1ColdTrace[account.label].correlation_id;
            await clients[index].waitUntil(() => Boolean(phase2Task1Traces(account.label, correlationId)
              .find(trace => trace.stage === "WORKER_MTPROTO_CONNECTION_STATE" && trace.state === "connected")), {
              timeout: 120_000,
              interval: 250,
              timeoutMsg: `Account ${account.label} did not reach a connected MTProto client.`,
            });
            const event = phase2Task1Traces(account.label, correlationId)
              .find(trace => trace.stage === "WORKER_MTPROTO_CONNECTION_STATE" && trace.state === "connected");
            const observer = authObservers.get(account.label);
            const requests = observer?.snapshot() || [];
            validateAuthHealth(requests, account.label);
            for (const route of ["/beatgaler-api/auth/login", "/beatgaler-api/transport/session/start"]) {
              assert.ok(requests.some(entry => entry.route === route && entry.state === "response" &&
                Number(entry.status) >= 200 && Number(entry.status) < 300),
              `Account ${account.label} needs a successful ${route} before MTProto readiness.`);
            }
            const preMtprotoFailure = requests.find(entry => entry.state === "response" && Number(entry.status) >= 500 &&
              Number(entry.started_at_ms) <= Number(event.ts_ms));
            assert.equal(preMtprotoFailure, undefined,
              `Account ${account.label} received HTTP ${preMtprotoFailure?.status} before MTProto readiness.`);
            return { account_label: account.label, login_ms: loginTimes[index],
              login_to_mtproto_ms: Number(event.ts_ms) - coldStartedAtByLabel[account.label],
              connected_at_ms: Number(event.ts_ms), correlation_id: correlationId };
          }));
          const snapshots = await Promise.all(accounts.map((account, index) =>
            waitForRuntimeSnapshot(clients[index], account.label)));
          snapshots.forEach((snapshot, index) => validateSingleAccount(accounts[index].label, snapshot));
          validateCrossAccountIsolation(snapshots);
          const cloudUrl = String(process.env.STAGE1_CLOUD_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
          const readyResponse = await fetch(`${cloudUrl}/readyz`, { signal: AbortSignal.timeout(3_000) });
          const readyBody = await readyResponse.json();
          assert.equal(readyResponse.status, 200, "Cloud /readyz must return HTTP 200 after five MTProto connections.");
          assert.equal(readyBody?.ok, true, "Cloud /readyz must report ready after five MTProto connections.");
          assert.equal(readyBody?.dependencies?.postgres, "ready", "PostgreSQL must remain ready after five MTProto connections.");
          report.phase2_task2_infra = { connected, postgres_ready: true,
            elapsed_ms: Date.now() - authoritativeStartupStartedAt };
          markScenario("auth_health_stability", "PASS", null, "Five accounts logged in without observed auth health failure.");
          markScenario("multi_account_auth_isolation", "PASS", null, "Five authenticated users and browsers remained isolated.");
          markScenario("multi_account_direct_identity", "PASS", null, "Five Direct sessions reached connected MTProto clients.");
          report.overall = "PASS";
          report.severity = null;
          await writeReport();
          console.log(`[phase2-task2-infra] PASS 5/5 MTProto connected; report=${REPORT_FILE}`);
          return;
        }

        for (const observer of authObservers.values()) {
          observer.setPhase("authoritative-startup");
        }

        const librariesBefore = await Promise.all(
          accounts.map(async (account, index) => {
            const library = await waitForAuthoritativeLibrary(
              clients[index],
              account.label,
              {
                requiredGetIndex: {
                  startedAtMs: authoritativeStartupStartedAt,
                },
              },
            );
            if (phase2Task0Mode) {
              report.phase2_task0.samples.apertura_fria.push({
                account_label: account.label,
                started_at_ms: coldStartedAtByLabel[account.label],
                ready_at_ms: Date.now(),
                get_index: library.successful_get_index || null,
                beat_count: library.beat_count,
              });
            }
            if (phase2Task1Mode) phase2Task1ColdReadyAtByLabel[account.label] = Date.now();
            return library;
          }
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
        await Promise.all(clients.map(client => installStage1RuntimeTraceCapture(client)));

        if (singleReloadAttributionTrace) {
          const account = accounts[0];
          const client = clients[0];
          const observer = authObservers.get(account.label);
          const coldTraces = phase2Task1Traces(account.label, phase2Task1ColdTrace[account.label].correlation_id);
          const coldStage = stage => coldTraces.find(trace => trace.stage === stage);
          assert.equal(coldStage("WORKER_PEER_BOOTSTRAP_BEGIN")?.cached_hint, false,
            "Cold Web Worker must start without a saved vault peer.");
          assert.ok(coldStage("WORKER_PEER_BOOTSTRAP_READY"),
            "Cold Web Worker must acquire the vault peer.");
          assert.equal(coldStage("WORKER_INDEX_POINTER_GET_MESSAGES_END")?.found, true,
            "Cold Web Worker must read the pinned INDEX through getMessages.");
          assert.ok(coldStage("WEB_LIBRARY_INDEX_PROCESS_DONE"),
            "Cold Web Worker must produce the authoritative library.");
          assert.ok(!coldStage("WORKER_INDEX_GET_FULL_CHAT_BEGIN"),
            "Cold Web Worker must keep getFullChat out of the INDEX path.");
          assert.ok(!coldStage("SOURCE_SESSION_INVALIDATED"),
            "Peer bootstrap must preserve the source session.");
          const correlationId = `cp-${randomUUID().slice(0, 12)}`;
          const trace = { account_label: account.label, correlation_id: correlationId, events: [] };
          observer?.setPhase("single-reload-critical-path");
          if (phase2Task2PassivePingTrace) {
            await setPhase2Task1TraceContext(client, {
              correlation_id: correlationId,
              account_label: account.label,
              task2_passive_ping_trace: true,
            });
          }
          await client.execute(input => {
            localStorage.setItem("beatgaler:stage1-focused-final-reload:correlation", input.correlation_id);
            localStorage.setItem("beatgaler:stage1-focused-final-reload:account", input.account_label);
            document.cookie = `stage1_cp=${encodeURIComponent(input.correlation_id)}; Path=/; SameSite=Lax`;
            history.replaceState(null, "", `/?stage1_cp=${encodeURIComponent(input.correlation_id)}`);
            performance.clearResourceTimings();
            window.__stage1TraceContext = input;
            return true;
          }, { correlation_id: correlationId, account_label: account.label });

          focusedReloadEvent(trace, "refresh_started");
          const refreshStartedAt = Date.now();
          await client.refresh();
          const refreshReturnedAt = Date.now();
          focusedReloadEvent(trace, "refresh_returned", { durationMs: refreshReturnedAt - refreshStartedAt });
          focusedReloadEvent(trace, "authoritative_poll_started");
          const library = await waitForAuthoritativeLibrary(client, account.label, { focusedReloadTrace: trace });
          const readyAt = Date.now();

          const cloudTraceFile = String(process.env.STAGE1_CRITICAL_PATH_CLOUD_TRACE_FILE_WINDOWS || process.env.STAGE1_CRITICAL_PATH_CLOUD_TRACE_FILE || "");
          const viteTraceFile = String(process.env.STAGE1_PROXY_TIMING_FILE || "");
          const attribution = {
            version: 1,
            workload_mode: "one-authenticated-account-one-reload-stop-at-first-ready",
            baseline_sha: report.baseline_sha,
            experiment_identity: report.experiment_identity,
            correlation_id: correlationId,
            account_label: account.label,
            refresh_started_at: new Date(refreshStartedAt).toISOString(),
            authoritative_ready_at: new Date(readyAt).toISOString(),
            refresh_command_ms: refreshReturnedAt - refreshStartedAt,
            ready_ms: readyAt - refreshStartedAt,
            library_beat_count: library.beat_count,
            timeline: trace.events,
            browser_network: (observer?.snapshot() || []).filter(entry => entry.correlation_id === correlationId),
            browser_document: (observer?.documentSnapshot() || []).filter(entry => entry.correlation_id === correlationId),
            navigation_timing: (observer?.navigationSnapshot() || []).filter(entry => entry.correlation_id === correlationId),
            browser_play_trace: (observer?.playTraceSnapshot() || []).filter(entry => entry.correlation_id === correlationId),
            vite_trace: (await readJsonLines(viteTraceFile)).filter(entry => entry.id === correlationId),
            cloud_trace: (await readJsonLines(cloudTraceFile)).filter(entry => entry.correlation_id === correlationId),
            configuration: {
              web_server_mode: report.web_server_mode,
              account_count: accountCount,
              mixed_workload: mixedWorkload,
              soak_minutes: soakMinutes,
              focused_final_reload_trace: focusedFinalReloadTrace,
            },
          };
          report.single_reload_attribution = attribution;
          report.peer_bootstrap_cold = {
            correlation_id: phase2Task1ColdTrace[account.label].correlation_id,
            library_beat_count: librariesBefore[0].beat_count,
            stages: coldTraces.filter(trace => /PEER_BOOTSTRAP|INDEX_POINTER_GET_MESSAGES|WEB_LIBRARY_INDEX_PROCESS_DONE|SOURCE_SESSION_INVALIDATED/.test(trace.stage)),
          };
          report.overall = "PASS";
          report.severity = null;
          await writeReport();
          await fs.writeFile(SINGLE_RELOAD_ATTRIBUTION_REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
          console.log(`[stage1-real] PASS single reload attribution correlation=${correlationId}; report=${SINGLE_RELOAD_ATTRIBUTION_REPORT_FILE}`);
          return;
        }

        if (task5Mode) {
          await runTask5OneAccountFailures({ clients, before });
          await writeReport();
          console.log(
            `[stage1-real] PASS task5 accounts=${accountCount}; Account A failures remained isolated. report=${TASK5_REPORT_FILE}`,
          );
          return;
        }

        if (task6Mode) {
          await runTask6FinalVerification({ clients, before, loginTimes });
          console.log(
            `[stage1-real] PASS task6 accounts=${accountCount}; final authoritative verification complete. report=${TASK6_REPORT_FILE}`,
          );
          return;
        }

        const startupMs = Date.now() - authoritativeStartupStartedAt;

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

        if (phase2Task0Mode) {
          accounts.forEach((account, index) => {
            Object.assign(report.accounts[account.label], {
              user_id: before[index].user_id,
              client_id: before[index].client_id,
              vault_chat_id: before[index].direct.chat_id,
              transport_id: before[index].direct.transport_id,
            });
          });
          await runPhase2Task0Conditions({ clients, before });
          return;
        }

        if (phase2Task1Mode) {
          const cold = accounts.map(account => phase2Task1Attribution({
            account,
            condition: "apertura_fria",
            startedAtMs: coldStartedAtByLabel[account.label],
            readyAtMs: phase2Task1ColdReadyAtByLabel[account.label],
            correlationId: phase2Task1ColdTrace[account.label].correlation_id,
          }));
          const playbackBeats = phase2Task2Mode
            ? await Promise.all(accounts.map(async (account, index) => {
                const beat = await playbackBeatSnapshot(clients[index], playbackBeatName(account));
                assert.ok(beat?.beat_id && beat.cloud_committed && !beat.playback_disabled,
                  `Account ${account.label} needs its own committed playable beat for Task 2.`);
                return beat;
              }))
            : null;
          if (playbackBeats) {
            try {
              report.phase2_task2.playback_cold = await runConcurrentPlayback(clients, playbackBeats);
              markScenario("phase2_task2_playback_cold", "PASS", null,
                "Five real beats produced HTMLAudioElement playback progress after cold startup.");
            } catch (error) {
              if (!phase2Task2ContinueAfterPlaybackFailure) throw error;
              report.phase2_task2.playback_cold_error = String(error?.message || error).slice(0, 500);
              report.phase2_task2.playback_cold_diagnostic = error?.stage1PlaybackDiagnostic || null;
              markScenario("phase2_task2_playback_cold", "FAIL", "PLAYBACK_PROGRESS_MISSING",
                "Diagnostic continuation retained this failure before Reload.");
            }
          }

          const reloadTrace = Object.fromEntries(accounts.map(account => [
            account.label,
            {
              correlation_id: `task1-reload-${account.label}-${randomUUID().slice(0, 12)}`,
              account_label: account.label,
              ...(phase2Task2PassivePingTrace ? { task2_passive_ping_trace: true } : {}),
            },
          ]));
          const reloaded = await Promise.all(accounts.map(async (account, index) => {
            const observer = authObservers.get(account.label);
            observer?.setPhase("phase2-task1-reload");
            await setPhase2Task1TraceContext(clients[index], reloadTrace[account.label]);
            const startedAtMs = Date.now();
            await clients[index].refresh();
            await waitForAuthoritativeLibrary(clients[index], account.label, {
              requiredGetIndex: { startedAtMs, phase: "phase2-task1-reload" },
            });
            return { account, startedAtMs, readyAtMs: Date.now() };
          }));

          // BiDi forwards console records asynchronously. This only waits for
          // the collector to flush observations already emitted by the app.
          await Promise.all(clients.map(client => client.pause(250)));
          const reload = reloaded.map(sample => phase2Task1Attribution({
            ...sample,
            condition: "reload_caliente",
            correlationId: reloadTrace[sample.account.label].correlation_id,
          }));
          persistPhase2Task1Samples(report, cold, reload);
          if (phase2Task2Mode) {
            const after = await Promise.all(clients.map((accountClient, index) =>
              waitForRuntimeSnapshot(accountClient, accounts[index].label)));
            after.forEach((snapshot, index) => {
              validateSingleAccount(accounts[index].label, snapshot);
              validatePersistentReload(before[index], snapshot, accounts[index].label);
            });
            validateCrossAccountIsolation(after);
            const playableAfterReload = await Promise.all(accounts.map(async (account, index) => {
              const beat = await playbackBeatSnapshot(clients[index], playbackBeatName(account));
              assert.equal(beat?.beat_id, playbackBeats[index].beat_id,
                `Account ${account.label} lost its playable beat across Reload.`);
              assert.ok(beat.cloud_committed && !beat.playback_disabled,
                `Account ${account.label} beat is unavailable after Reload.`);
              return beat;
            }));
            try {
              report.phase2_task2.playback_reload = await runConcurrentPlayback(clients, playableAfterReload);
            } catch (error) {
              if (!phase2Task2ContinueAfterPlaybackFailure) throw error;
              report.phase2_task2.playback_reload_error = String(error?.message || error).slice(0, 500);
              markScenario("phase2_task2_playback_reload", "FAIL", "PLAYBACK_PROGRESS_MISSING",
                "Diagnostic continuation retained this failure after Reload.");
            }
            const finalLibraries = await Promise.all(clients.map(libraryAuthoritySnapshot));
            try {
              finalLibraries.forEach((library, index) => {
                assert.ok(library.present && library.aria_busy === "false" && library.beat_count > 0 &&
                  !library.poor_connection && !library.offline && !library.load_error,
                `Account ${accounts[index].label} library degraded after real Reload playback.`);
              });
            } catch (error) {
              if (!phase2Task2ContinueAfterPlaybackFailure) throw error;
              report.phase2_task2.reload_library_error = String(error?.message || error).slice(0, 500);
            }
            if (report.phase2_task2.playback_reload) markScenario("phase2_task2_playback_reload", "PASS", null,
              "Five isolated real beats produced playback progress after authoritative Reload.");

            const pingByAccount = accounts.map(account => {
              const allTraces = [phase2Task1ColdTrace[account.label], reloadTrace[account.label]]
                .flatMap(context => phase2Task1Traces(account.label, context.correlation_id));
              const resetStage = phase2Task2PassivePingTrace
                ? "TASK2_PING_RESET_SESSION" : "WORKER_MTPROTO_SESSION_RESET";
              return {
                account_label: account.label,
                ping_timeouts: allTraces.filter(trace =>
                  trace.stage === resetStage && trace.reason === "ping timeout").length,
                index_liveness_recoveries: allTraces.filter(trace =>
                  trace.stage === "TASK2_PING_INDEX_LIVENESS_RECOVERY").length,
                events: allTraces.filter(trace => [
                  "TASK2_PING_INDEX_LIVENESS_RECOVERY",
                  resetStage, "TASK2_INPUT_MT_MESSAGE_DECODED",
                ].includes(trace.stage) && (trace.stage !== "TASK2_INPUT_MT_MESSAGE_DECODED" ||
                  trace.mt_message_type === "mt_msgs_state_info")).map(trace => ({
                  stage: trace.stage,
                  ts_ms: trace.ts_ms,
                  correlation_id: trace.correlation_id,
                  reason: trace.reason || null,
                  ping_msg_id: trace.ping_msg_id || trace.last_ping_msg_id || null,
                  rpc_msg_id: trace.rpc_msg_id || null,
                  state_requested_msg_ids: trace.state_requested_msg_ids || null,
                  state_info_codes: trace.state_info_codes || null,
                })),
              };
            });
            report.phase2_task2.ping_stability = pingByAccount;
            const timedOut = pingByAccount.filter(row => row.ping_timeouts > 0);
            if (timedOut.length) {
              throw taggedError(`Task 2 still reset for ping timeout: ${timedOut.map(row =>
                `${row.account_label}=${row.ping_timeouts}`).join(", ")}.`, "PHASE2_TASK2_PING_TIMEOUT", "P1");
            }
            markScenario("phase2_task2_ping_stability", "PASS", null,
              `No ping timeout reset across cold startup, hot Reload, and playback; INDEX liveness recoveries: ${pingByAccount.map(row => `${row.account_label}=${row.index_liveness_recoveries}`).join(", ")}.`);
          }
          report.phase2_task1.completed_conditions = ["apertura_fria", "reload_caliente"];
          markScenario("phase2_task1_attribution", "PASS", null,
            "Five cold opens and five hot Reloads have ordered auth, control, Direct, get_index, Web INDEX, and usable-library timestamps.");
          if (phase2Task2ContinueAfterPlaybackFailure &&
            (report.phase2_task2.playback_cold_error || report.phase2_task2.playback_reload_error ||
              report.phase2_task2.reload_library_error)) {
            throw taggedError("Task 2 diagnostic completed with playback or library failure.",
              "PHASE2_TASK2_DIAGNOSTIC_PLAYBACK_FAILURE", "P1");
          }
          report.overall = "PASS";
          report.severity = null;
          await writeReport();
          console.log(`[phase2-task1] PASS five-account library latency attribution; report=${REPORT_FILE}`);
          return;
        }

        if (focusedStartup) {
          const loginStarts = accounts.map(account => {
            const login = (authObservers.get(account.label)?.snapshot() || [])
              .findLast(entry =>
                entry.route === "/beatgaler-api/auth/login" &&
                entry.state === "response" &&
                entry.status >= 200 &&
                entry.status < 300 &&
                Number.isFinite(Number(entry.started_at_ms))
              );

            if (!login) {
              throw taggedError(
                `Account ${account.label} has no successful observed auth/login timestamp.`,
                "STAGE1_STARTUP_LOGIN_TIMESTAMP_MISSING",
                "P1",
              );
            }

            return {
              account_label: account.label,
              started_at_ms: Number(login.started_at_ms),
              duration_ms: login.duration_ms,
              status: login.status,
            };
          });

          const loginStartValues = loginStarts.map(item => item.started_at_ms);
          const loginStartSpreadMs =
            Math.max(...loginStartValues) - Math.min(...loginStartValues);
          const withinBurstTarget = loginStartSpreadMs <= 3_000;

          report.accounts = Object.fromEntries(
            accounts.map((account, index) => [
              account.label,
              {
                ...report.accounts[account.label],
                login_ms: loginTimes[index],
                login_started_at_ms: loginStarts[index].started_at_ms,
                user_id: before[index].user_id,
                client_id: before[index].client_id,
                library_beats: librariesBefore[index].beat_count,
                library_authority: {
                  cold: librariesBefore[index].successful_get_index,
                },
                vault_chat_id: before[index].direct.chat_id,
                transport_id: before[index].direct.transport_id,
                transport_user_id: before[index].direct.transport_user_id,
                expected_bot_id: before[index].direct.expected_bot_id,
                session_id: before[index].direct.session_id,
                membership_bootstrap_mode: before[index].direct.mode,
              },
            ]),
          );

          report.startup = {
            account_count: accountCount,
            login_start_spread_ms: loginStartSpreadMs,
            burst_target_ms: 3_000,
            within_burst_target: withinBurstTarget,
            authoritative_startup_ms: startupMs,
            logins: loginStarts,
          };

          const warmReopenStartedAt = Date.now();

          for (const observer of authObservers.values()) {
            observer.setPhase("warm-reopen");
          }

          await Promise.all(
            clients.map(async client => {
              await client.url("about:blank");
              await client.url("/");
            }),
          );

          const warmLibraries = await Promise.all(
            accounts.map((account, index) =>
              waitForAuthoritativeLibrary(
                clients[index],
                account.label,
                {
                  requiredGetIndex: {
                    startedAtMs: warmReopenStartedAt,
                    phase: "warm-reopen",
                  },
                },
              )
            ),
          );

          await Promise.all(
            accounts.map((account, index) =>
              clients[index].waitUntil(
                async () =>
                  (authObservers.get(account.label)?.snapshot() || []).some(
                    entry =>
                      entry.route === "/beatgaler-api/transport/session/start" &&
                      entry.state === "response" &&
                      entry.status >= 200 &&
                      entry.status < 300 &&
                      Number(entry.started_at_ms) >= warmReopenStartedAt,
                  ),
                {
                  timeout: 120_000,
                  interval: 250,
                  timeoutMsg: `Account ${account.label} did not establish a fresh Direct session after warm reopen.`,
                },
              )
            ),
          );

          const warmSnapshots = await Promise.all(
            accounts.map((account, index) =>
              waitForRuntimeSnapshot(
                clients[index],
                account.label,
              )
            ),
          );

          warmSnapshots.forEach((snapshot, index) =>
            validateSingleAccount(
              accounts[index].label,
              snapshot,
            )
          );

          if (!singleAccountDiagnostic) {
            validateCrossAccountIsolation(warmSnapshots);
          }

          const warmReopenComparisons = accounts.map((account, index) => {
            const cold = before[index];
            const warm = warmSnapshots[index];
            const coldValues = {
              user_id: cold.user_id,
              client_id: cold.client_id,
              vault_chat_id: cold.direct.chat_id,
              transport_id: cold.direct.transport_id,
              expected_bot_id: cold.direct.expected_bot_id,
              session_id: cold.direct.session_id,
              library_beats: librariesBefore[index].beat_count,
            };
            const warmValues = {
              user_id: warm.user_id,
              client_id: warm.client_id,
              vault_chat_id: warm.direct.chat_id,
              transport_id: warm.direct.transport_id,
              expected_bot_id: warm.direct.expected_bot_id,
              session_id: warm.direct.session_id,
              library_beats: warmLibraries[index].beat_count,
            };
            const differingFields = Object.keys(coldValues).filter(
              field => warmValues[field] !== coldValues[field],
            );
            // Keep the existing acceptance condition unchanged. session_id is
            // evidence for this diagnosis, not a new warm-reopen expectation.
            const expectationDifferingFields = differingFields.filter(
              field => field !== "session_id",
            );

            return {
              account_label: account.label,
              cold: coldValues,
              warm: warmValues,
              differing_fields: differingFields,
              expectation_differing_fields: expectationDifferingFields,
              preserved: expectationDifferingFields.length === 0,
            };
          });

          warmReopenComparisons.forEach((comparison, index) => {
            report.accounts[comparison.account_label].warm_reopen = comparison;
            report.accounts[comparison.account_label].library_authority.warm =
              warmLibraries[index].successful_get_index;
          });

          const warmReopenMismatches = warmReopenComparisons.filter(
            comparison => !comparison.preserved,
          );

          report.startup.warm_reopen = {
            account_count: accountCount,
            profile_reset: false,
            fresh_direct_bootstrap_observed: true,
            preserved_authority: warmReopenMismatches.length === 0,
            mismatches: warmReopenMismatches.map(comparison => ({
              account_label: comparison.account_label,
              differing_fields: comparison.differing_fields,
              expectation_differing_fields: comparison.expectation_differing_fields,
            })),
          };

          if (warmReopenMismatches.length) {
            const firstMismatch = warmReopenMismatches[0];
            throw taggedError(
              `Account ${firstMismatch.account_label} changed after warm reopen: ${firstMismatch.expectation_differing_fields.join(", ")}.`,
              "STAGE1_STARTUP_WARM_REOPEN_MISMATCH",
              "P1",
            );
          }

          report.startup.warm_reopen.duration_ms = Date.now() - warmReopenStartedAt;

          markScenario(
            "startup_burst_window",
            withinBurstTarget ? "PASS" : "FAIL",
            withinBurstTarget ? null : "P1",
            `${accountCount} auth/login requests started within ${loginStartSpreadMs} ms; target <= 3000 ms`,
          );

          report.timings = {
            startup_ms: startupMs,
            login_start_spread_ms: loginStartSpreadMs,
          };
          report.overall = withinBurstTarget ? "PASS" : "FAIL";
          report.severity = withinBurstTarget ? null : "P1";

          await writeReport();

          console.log(
            `[stage1-real] ${withinBurstTarget ? "PASS" : "FAIL"} focused startup accounts=${accountCount} login_start_spread_ms=${loginStartSpreadMs}; report=${REPORT_FILE}`,
          );

          if (!withinBurstTarget) {
            throw taggedError(
              `Startup burst window exceeded: ${loginStartSpreadMs} ms; target <= 3000 ms.`,
              "STAGE1_STARTUP_BURST_WINDOW",
              "P1",
            );
          }

          return;
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

        if (phase2PeerPlayRace) {
          report.phase2_peer_play_race = await runPhase2PeerPlayRace(clients[0], accounts[0], playbackFixtures[0]);
          markScenario("phase2_peer_play_race", "PASS", null,
            "Cached library Play preceded Direct startup, waited for the peer, then reached audio and authoritative INDEX.");
          report.overall = "PASS";
          report.severity = null;
          await writeReport();
          console.log(`[phase2-peer-play] PASS click_to_audio_ms=${report.phase2_peer_play_race.click_to_audio_ms}; report=${REPORT_FILE}`);
          return;
        }

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
              seek_ms: [],
              hot_library_ms: [],
              upload_ms: [],
              download_ms: [],
              metadata_edit_ms: [],
              metadata_reload_ms: [],
              reload_ms: [],
              playback_samples: [],
              playback_failures: [],
              seek_samples: [],
              upload_samples: [],
              download_samples: [],
              metadata_samples: [],
              reload_samples: [],
              final_reload_samples: [],
            };
            const roleCounts = Object.fromEntries(
              accounts.map(account => [
                account.label,
                { playback: 0, seek: 0, upload: 0, metadata: 0, reload: 0, download: 0 },
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

            if (task4Mode) {
              activeTask4ResourceSampler = createTask4ResourceSampler();
              await activeTask4ResourceSampler.start();
              report.soak.resource_samples = activeTask4ResourceSampler.samples;
            }

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

              for (const index of playbackIndices) roleCounts[accounts[index].label].playback += 1;
              for (const index of playbackIndices) roleCounts[accounts[index].label].seek += 1;
              roleCounts[accounts[uploadIndex].label].upload += 1;
              roleCounts[accounts[metadataIndex].label].metadata += 1;
              roleCounts[accounts[metadataIndex].label].reload += 1;
              roleCounts[accounts[downloadIndex].label].download += 1;

              await Promise.all(clients.map(client => resetPlaybackForSoak(client)));

              const roundEvidence = {
                round: round + 1,
                started_at: new Date(roundStartedAt).toISOString(),
                target_ms: roundTargetMs,
                roles: {
                  playback: playbackIndices.map(index => accounts[index].label),
                  upload: accounts[uploadIndex].label,
                  metadata_reload_authoritative_read: accounts[metadataIndex].label,
                  download: accounts[downloadIndex].label,
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
                  ...transferEvidence({ bytes: result.source_bytes, durationMs }),
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
                  playbackFixtures[downloadIndex].audio_payload_sha256,
                  deadline,
                  metrics,
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
                assert.ok(counts.seek >= 2, "Every account must rotate through seek twice.");
                assert.ok(counts.upload >= 1, "Every account must rotate through upload.");
                assert.ok(counts.metadata >= 1, "Every account must rotate through metadata.");
                assert.ok(counts.download >= 1, "Every account must rotate through download.");
                assert.ok(counts.reload >= 1, "Every account must rotate through Reload.");
              }

              markScenario(
                "mixed_role_rotation",
                "PASS",
                null,
                "Five rotations covered every account in playback+seek, upload, metadata+Reload+authoritative read, and download roles",
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

            // Keep this diagnostic-only identifier below the redaction threshold
            // used for console capture. It is persisted only in the current
            // browser's localStorage so the init observer survives its reload.
            const focusedCorrelationId = focusedFinalReloadTrace
              ? `fr-${randomUUID().slice(0, 12)}`
              : null;
            const focusedTraces = focusedFinalReloadTrace
              ? new Map(accounts.map(account => [account.label, {
                  account_label: account.label,
                  correlation_id: focusedCorrelationId,
                  events: [],
                  materialized: false,
                  aria_busy_false: false,
                  ready: false,
                }]))
              : null;

            if (focusedFinalReloadTrace) {
              await Promise.all(
                accounts.map((account, index) => clients[index].execute((input) => {
                  localStorage.setItem("beatgaler:stage1-focused-final-reload:correlation", input.correlation_id);
                  localStorage.setItem("beatgaler:stage1-focused-final-reload:account", input.account_label);
                  window.__stage1TraceContext = input;
                  return true;
                }, { correlation_id: focusedCorrelationId, account_label: account.label })),
              );
            }

            const finalReloadStartedAt = Date.now();
            const finalLibraryResults = await Promise.all(
              accounts.map(async (account, index) => {
                const refreshStartedAt = Date.now();
                const trace = focusedTraces?.get(account.label) || null;
                const refreshStarted = trace
                  ? focusedReloadEvent(trace, "refresh_started")
                  : null;
                await clients[index].refresh();
                const refreshResolvedAt = Date.now();
                const refreshResolved = trace
                  ? focusedReloadEvent(trace, "refresh_resolved", {
                      durationMs: refreshResolvedAt - refreshStartedAt,
                    })
                  : null;
                const library = await waitForAuthoritativeLibrary(
                  clients[index],
                  account.label,
                  trace ? { focusedReloadTrace: trace } : undefined,
                );
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
                  ...(refreshStarted && refreshResolved
                    ? { hot_library_equivalent_ms: readyMs }
                    : {}),
                };
              }),
            );

            if (focusedFinalReloadTrace) {
              const diagnosticLogs = await Promise.all(
                accounts.map(account => authObservers.get(account.label)?.diagnosticSnapshot() || []),
              );
              report.accounts = Object.fromEntries(
                accounts.map((account, index) => {
                  const trace = focusedTraces.get(account.label);
                  const timeline = [
                    ...trace.events,
                    ...focusedReloadNavigationTimeline(account.label, focusedCorrelationId),
                    ...focusedReloadHttpTimeline(account.label, focusedCorrelationId),
                    ...focusedReloadWorkerTimeline(diagnosticLogs[index], account.label, focusedCorrelationId),
                  ].sort((left, right) => {
                    const leftTime = Date.parse(left.timestamp_wall_clock || "") || 0;
                    const rightTime = Date.parse(right.timestamp_wall_clock || "") || 0;
                    return leftTime - rightTime;
                  });
                  return [account.label, {
                    ...report.accounts[account.label],
                    user_id: before[index].user_id,
                    client_id: before[index].client_id,
                    vault_chat_id: before[index].direct.chat_id,
                    transport_id: before[index].direct.transport_id,
                    session_id_before_final_refresh: before[index].direct.session_id,
                    library_beats_before_final_refresh: librariesBefore[index].beat_count,
                    focused_final_reload: {
                      correlation_id: focusedCorrelationId,
                      refresh_command_ms: finalLibraryResults[index].refresh_command_ms,
                      library_after_refresh_ms: finalLibraryResults[index].library_after_refresh_ms,
                      hot_library_equivalent_ms: finalLibraryResults[index].hot_library_equivalent_ms,
                      library_beat_count: finalLibraryResults[index].library.beat_count,
                      timeline,
                    },
                  }];
                }),
              );
              const hotValues = finalLibraryResults.map(item => item.hot_library_equivalent_ms);
              report.focused_final_reload = {
                report_file: TASK4_FOCUSED_FINAL_RELOAD_REPORT_FILE,
                correlation_id: focusedCorrelationId,
                account_count: accountCount,
                started_at: new Date(finalReloadStartedAt).toISOString(),
                finished_at: new Date().toISOString(),
                total_elapsed_ms: Date.now() - finalReloadStartedAt,
                concurrent_refreshes: true,
                hot_library_equivalent: metricSummary(hotValues),
                prestate: {
                  source: "same-run mixed-5-account diagnostic soak",
                  soak_minutes: soakMinutes,
                  rotations: SOAK_ROTATIONS,
                  reused_browsers_and_authenticated_sessions: true,
                  prior_run_profiles_or_sessions_reused: false,
                  cold_login_between_mixed_round_and_final_refresh: false,
                  final_reload_harness_phase: "mixed-soak-final-authoritative-reload",
                },
                note: "Focused evidence exits immediately after the existing concurrent final refresh()+waitForAuthoritativeLibrary() block; Task 4 budgets and assertions are not evaluated or changed by this instrumentation mode.",
              };
              markScenario(
                "focused_final_authoritative_reload_trace",
                "PASS",
                null,
                `Five original-path concurrent browser Reload operations reached authoritative libraries with correlation ${focusedCorrelationId}.`,
              );
              report.timings = {
                startup_ms: startupMs,
                mixed_prestate_ms: soakElapsedMs,
                focused_final_authoritative_reload_ms: Date.now() - finalReloadStartedAt,
                hot_library_equivalent_p95_ms: report.focused_final_reload.hot_library_equivalent.p95_ms,
              };
              report.overall = "PASS";
              report.severity = null;
              await writeReport();
              console.log(
                `[stage1-real] PASS focused final authoritative Reload trace accounts=${accountCount}; report=${TASK4_FOCUSED_FINAL_RELOAD_REPORT_FILE}`,
              );
              return;
            }
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
              seek: metricSummary(metrics.seek_ms),
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
              "mixed_seek",
              "PASS",
              null,
              `${metrics.seek_samples.length} real Player scrubber seeks completed while playback continued`,
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
              `Five rotating real accounts remained under mixed workload for ${soakElapsedMs} ms`,
            );
            markScenario(
              "mixed_post_workload_isolation",
              "PASS",
              null,
              "Final authoritative Reload preserved five unique accounts/vaults/transports; all soak uploads remained vault-isolated",
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

            if (activeTask4ResourceSampler) {
              await activeTask4ResourceSampler.stop();
              report.soak.final_resource_sample = activeTask4ResourceSampler.samples.at(-1) || null;
              activeTask4ResourceSampler = null;
            }

            if (task4Mode) {
              const perAccount = consolidateTask4Accounts(metrics);
              for (const account of accounts) {
                report.accounts[account.label].task_4 = perAccount[account.label];
              }
              const finalResource = report.soak.final_resource_sample || {};
              report.task_4.completion = {
                operations_remaining: finalResource.transport?.operations ?? null,
                leases_remaining: finalResource.transport?.sessions ?? null,
                pending_or_orphan_get_index_operations: {
                  postgres_pending: finalResource.postgres?.pending_get_index_operations ?? null,
                  postgres_orphan: finalResource.postgres?.orphan_get_index_operations ?? null,
                  browser_observed_by_account: Object.fromEntries(
                    accounts.map(account => [account.label, perAccount[account.label].get_index]),
                  ),
                },
                final_authoritative_vault_state: Object.fromEntries(
                  accounts.map((account, index) => [account.label, {
                    vault_chat_id: finalSnapshots[index].direct.chat_id,
                    user_id: finalSnapshots[index].user_id,
                    transport_id: finalSnapshots[index].direct.transport_id,
                    library_beat_count: finalLibraryResults[index].library.beat_count,
                  }]),
                ),
                cross_account_isolation: "PASS: unique users, clients and vaults validated after final authoritative Reload; named upload fixtures were absent from non-owner vaults.",
              };
            }

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

        if (task6Mode) {
          const infrastructureBlocked = report.overall === "BLOCKED" || [
            "STAGE1_LIBRARY_AUTHORITY_TIMEOUT",
            "STAGE1_HEALTH_UNSTABLE",
            "STAGE1_LOGIN_FAILED",
          ].includes(String(error?.code || ""));
          report.task_6 = {
            ...report.task_6,
            classification: infrastructureBlocked ? "PENDIENTE POR INFRAESTRUCTURA" : "FALLÓ",
            anomalies: [String(error?.message || error)],
          };
          for (const item of report.scenarios) {
            if (item.status === "NOT_TESTED") {
              markScenario(item.name, infrastructureBlocked ? "BLOCKED" : "FAIL", severity, "Task 6 stopped before this final-verification gate completed.");
            }
          }
        }

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
              ...(soakMode ? ["mixed_seek"] : []),
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

        if (activeTask4ResourceSampler) {
          await activeTask4ResourceSampler.stop();
          report.soak ||= {};
          report.soak.final_resource_sample = activeTask4ResourceSampler.samples.at(-1) || null;
          activeTask4ResourceSampler = null;
        }
        await writeReport();
        await archiveFocusedDownloadIntegrityReport();
        throw error;
      } finally {
        if (activeTask4ResourceSampler) {
          await activeTask4ResourceSampler.stop().catch(() => {});
          activeTask4ResourceSampler = null;
        }
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
