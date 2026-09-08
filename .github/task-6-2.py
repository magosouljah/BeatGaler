from __future__ import annotations

import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def regex_replace_once(text: str, pattern: str, replacement: str, label: str) -> str:
    next_text, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one regex match, found {count}")
    return next_text


JOURNAL = '''import type { Beat } from "../../types";

const INTERRUPTED_UPLOADS_KEY = "beatgaler:active-cloud-uploads:v1";

export type ActiveCloudUpload = {
  beatId: string;
  beatName: string;
  stagingPaths: string[];
};

export type InterruptedUploadRecoveryOptions = {
  beatgalerUserId: string;
  authoritativeBeatIds: Set<string> | null;
  cloudApiBase: string;
  authToken: string | null;
  purgeLocal: (beatId: string, stagingPaths: string[]) => Promise<unknown>;
  fetchImpl?: typeof fetch;
};

function activeUploadStagingPaths(beat: Beat): string[] {
  return [
    beat.mp3_path, beat.wav_path, beat.playback_path, beat.folder_path,
    beat.samples_path, beat.stems_path, beat.flp_path, beat.als_path,
    beat.loop_path, ...(beat.other_files ?? []),
  ].filter((value): value is string => !!value);
}

export function readActiveCloudUploads(): ActiveCloudUpload[] {
  try {
    const raw = localStorage.getItem(INTERRUPTED_UPLOADS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(item => item?.beatId && item?.beatName) : [];
  } catch {
    return [];
  }
}

export function writeActiveCloudUploads(items: ActiveCloudUpload[]): void {
  try {
    if (items.length === 0) localStorage.removeItem(INTERRUPTED_UPLOADS_KEY);
    else localStorage.setItem(INTERRUPTED_UPLOADS_KEY, JSON.stringify(items));
  } catch {}
}

export function markCloudUploadActive(beat: Beat): void {
  const current = readActiveCloudUploads().filter(item => item.beatId !== beat.id);
  current.push({ beatId: beat.id, beatName: beat.name, stagingPaths: activeUploadStagingPaths(beat) });
  writeActiveCloudUploads(current);
}

export function clearCloudUploadActive(beatId: string): void {
  writeActiveCloudUploads(readActiveCloudUploads().filter(item => item.beatId !== beatId));
}

export async function rollbackInterruptedCloudUploads({
  beatgalerUserId,
  authoritativeBeatIds,
  cloudApiBase,
  authToken,
  purgeLocal,
  fetchImpl = fetch,
}: InterruptedUploadRecoveryOptions): Promise<string[]> {
  const pending = readActiveCloudUploads();
  if (pending.length === 0) return [];

  const rolledBack: string[] = [];
  const remaining: ActiveCloudUpload[] = [];

  for (const item of pending) {
    // A recovery marker only proves that the process died mid-flow. The cloud
    // INDEX remains authoritative: a committed beat must never be purged.
    if (authoritativeBeatIds?.has(item.beatId)) {
      console.info(`[upload-recovery] marker cleared for durable beat ${item.beatId}`);
      continue;
    }

    // If authority could not be verified, fail closed. Keep every marker so a
    // later launch can retry recovery without risking durable media.
    if (authoritativeBeatIds === null) {
      remaining.push(item);
      continue;
    }

    try {
      const response = await fetchImpl(`${cloudApiBase}/beats/delete-topic`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({ beatgalerUserId, beatId: item.beatId }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(text || `HTTP ${response.status}`);
      }

      await purgeLocal(item.beatId, item.stagingPaths);
      rolledBack.push(item.beatName);
    } catch (error) {
      console.warn(`Could not roll back interrupted upload ${item.beatName}:`, error);
      remaining.push(item);
    }
  }

  writeActiveCloudUploads(remaining);
  return rolledBack;
}
'''


ERROR_DETAILS = '''import { sanitizeUserVisibleText } from "../../lib/userVisibleError";

function stringifyUploadError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    const encoded = JSON.stringify(error);
    return encoded === undefined ? String(error) : encoded;
  } catch {
    return String(error);
  }
}

export function buildCloudSessionUnavailableDetail(error: unknown): { raw: string; detail: string } {
  const raw = error instanceof Error
    ? error.message
    : error != null
      ? String(error)
      : "BeatGaler could not verify cloud access for this installation.";

  return {
    raw,
    detail: [
      "UPLOAD FAILED",
      "Stage: Verify cloud session",
      "",
      raw,
      "",
      "Checks:",
      "• Confirm the Windows cloud-server and Tailscale Funnel are running.",
      "• Confirm this BeatGaler installation is signed in to the intended account.",
      "• Sign out and back in if this installation is attached to the wrong account.",
    ].join("\\n"),
  };
}

export function buildPlaybackPreparationFailureDetail(beatName: string): string {
  return [
    "PLAYBACK PREPARATION FAILED",
    `Beat: ${beatName}`,
    "",
    "The media upload and Galer Library index are already committed, but BeatGaler could not warm the new MASTER for playback within 15 seconds.",
    "The beat was left in Cloud safely; retrying later should not require re-uploading the file.",
  ].join("\\n");
}

export function buildUploadFailureDetail(input: {
  beatName: string;
  stage: string;
  platform: string;
  error: unknown;
}): string {
  const raw = stringifyUploadError(input.error);
  const lower = raw.toLowerCase();
  let hint = "Unexpected failure. The exact raw error is included below.";

  if (lower.includes("encoder unavailable") || lower.includes("bundled ffmpeg") || lower.includes("could not start wav -> mp3")) {
    hint = "This WAV needs a MASTER MP3, but BeatGaler could not start its bundled MP3 encoder. The installer/build must include ffmpeg; the user should not need to install it manually.";
  } else if (lower.includes("wav -> mp3") || lower.includes("master generation") || lower.includes("conversion failed")) {
    hint = "BeatGaler found the WAV but could not create the temporary 320 kbps MASTER MP3. The raw converter error is shown below.";
  } else if (
    lower.includes("wav source could not be read") ||
    lower.includes("os error 3") ||
    lower.includes("file not found") ||
    lower.includes("no usable audio source") ||
    lower.includes("no longer exists")
  ) {
    hint = "The local source audio disappeared before BeatGaler could upload it. For drag/drop batches this means the temporary drop-staging source is missing; BeatGaler now keeps shared staging alive until every pending/review beat is finished.";
  } else if (lower.includes("temp") || lower.includes("prepare cloud audio copy") || lower.includes("metadata") || lower.includes("id3")) {
    hint = "BeatGaler failed while creating its temporary upload copy or embedding metadata. Check file permissions, free disk space, and whether the source audio is a valid MP3/WAV.";
  } else if (lower.includes("failed to start curl")) {
    hint = "BeatGaler could not start the system HTTP client. On macOS the app now explicitly uses /usr/bin/curl; if this still appears, the system curl executable is unavailable.";
  } else if (lower.includes("could not reach") || lower.includes("timed out") || lower.includes("couldn't connect") || lower.includes("connection")) {
    hint = "BeatGaler could not complete the request to the Cloud server. Check Internet connectivity and that the BeatGaler Cloud server is running.";
  } else if (lower.includes("http 400") || lower.includes("not connected for this beatgaler installation")) {
    hint = "The server received the request but could not verify cloud access for this BeatGaler installation. Sign out and back in, then retry.";
  } else if (lower.includes("413") || lower.includes("too large")) {
    hint = "The server rejected the file because it exceeded the configured upload limit.";
  } else if (lower.includes("invalid json") || lower.includes("<!doctype") || lower.includes("<html")) {
    hint = "The endpoint returned something other than BeatGaler JSON. This can indicate a tunnel/proxy error page or an unexpected server response.";
  } else if (lower.includes("telegram")) {
    hint = "The request reached the cloud portion of the flow. Read the server error below for the exact rejection.";
  }

  return [
    "UPLOAD FAILED",
    `Beat: ${input.beatName}`,
    `Stage: ${input.stage}`,
    `Platform: ${input.platform}`,
    "",
    hint,
    "",
    `Error detail: ${sanitizeUserVisibleText(raw, "Unknown error")}`,
  ].join("\\n");
}
'''


INTEGRATION_TEST = '''import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readActiveCloudUploads,
  rollbackInterruptedCloudUploads,
  writeActiveCloudUploads,
} from "../../src/features/cloud/interruptedUploadJournal";
import {
  buildCloudSessionUnavailableDetail,
  buildPlaybackPreparationFailureDetail,
  buildUploadFailureDetail,
} from "../../src/features/cloud/uploadErrorDetails";

const durable = { beatId: "durable", beatName: "Durable Beat", stagingPaths: ["durable.mp3"] };
const interrupted = { beatId: "interrupted", beatName: "Interrupted Beat", stagingPaths: ["interrupted.mp3", "project.zip"] };

function response(ok: boolean, status = 200, text = ""): Response {
  return { ok, status, text: async () => text } as Response;
}

describe("task 6.2 upload recovery extraction", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("preserves a beat already confirmed by the authoritative INDEX and only rolls back the incomplete beat", async () => {
    writeActiveCloudUploads([durable, interrupted]);
    const fetchImpl = vi.fn(async () => response(true));
    const purgeLocal = vi.fn(async () => undefined);

    const rolledBack = await rollbackInterruptedCloudUploads({
      beatgalerUserId: "user-1",
      authoritativeBeatIds: new Set([durable.beatId]),
      cloudApiBase: "https://cloud.example.test",
      authToken: "token",
      purgeLocal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(rolledBack).toEqual([interrupted.beatName]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://cloud.example.test/beats/delete-topic");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ beatgalerUserId: "user-1", beatId: interrupted.beatId });
    expect(purgeLocal).toHaveBeenCalledTimes(1);
    expect(purgeLocal).toHaveBeenCalledWith(interrupted.beatId, interrupted.stagingPaths);
    expect(purgeLocal).not.toHaveBeenCalledWith(durable.beatId, durable.stagingPaths);
    expect(readActiveCloudUploads()).toEqual([]);
  });

  it("fails closed when the authoritative INDEX cannot be verified", async () => {
    writeActiveCloudUploads([durable, interrupted]);
    const fetchImpl = vi.fn(async () => response(true));
    const purgeLocal = vi.fn(async () => undefined);

    const rolledBack = await rollbackInterruptedCloudUploads({
      beatgalerUserId: "user-1",
      authoritativeBeatIds: null,
      cloudApiBase: "https://cloud.example.test",
      authToken: null,
      purgeLocal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(rolledBack).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(purgeLocal).not.toHaveBeenCalled();
    expect(readActiveCloudUploads()).toEqual([durable, interrupted]);
  });

  it("keeps the recovery marker when remote rollback fails", async () => {
    writeActiveCloudUploads([interrupted]);
    const fetchImpl = vi.fn(async () => response(false, 503, "temporary failure"));
    const purgeLocal = vi.fn(async () => undefined);

    const rolledBack = await rollbackInterruptedCloudUploads({
      beatgalerUserId: "user-1",
      authoritativeBeatIds: new Set(),
      cloudApiBase: "https://cloud.example.test",
      authToken: null,
      purgeLocal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(rolledBack).toEqual([]);
    expect(purgeLocal).not.toHaveBeenCalled();
    expect(readActiveCloudUploads()).toEqual([interrupted]);
  });

  it("keeps useful upload stage, platform, hints and sanitized raw detail", () => {
    const session = buildCloudSessionUnavailableDetail(new Error("network down"));
    expect(session.raw).toBe("network down");
    expect(session.detail).toContain("Stage: Verify cloud session");
    expect(session.detail).toContain("Confirm this BeatGaler installation is signed in");

    const detail = buildUploadFailureDetail({
      beatName: "Night Drive",
      stage: "Upload MASTER audio",
      platform: "Win32",
      error: new Error("Telegram connection timed out"),
    });
    expect(detail).toContain("Beat: Night Drive");
    expect(detail).toContain("Stage: Upload MASTER audio");
    expect(detail).toContain("Platform: Win32");
    expect(detail).toContain("Check Internet connectivity");
    expect(detail).toContain("Error detail: Galer Cloud connection timed out");

    const playback = buildPlaybackPreparationFailureDetail("Night Drive");
    expect(playback).toContain("PLAYBACK PREPARATION FAILED");
    expect(playback).toContain("Galer Library index are already committed");
    expect(playback).toContain("left in Cloud safely");
  });
});
'''


def apply() -> None:
    app_path = "src/App.tsx"
    app = read(app_path)

    app = replace_once(
        app,
        'import { clearCloudUploadActive, markCloudUploadActive, readActiveCloudUploads, writeActiveCloudUploads, type ActiveCloudUpload } from "./features/cloud/interruptedUploadJournal";',
        'import { clearCloudUploadActive, markCloudUploadActive, rollbackInterruptedCloudUploads } from "./features/cloud/interruptedUploadJournal";\nimport { buildCloudSessionUnavailableDetail, buildPlaybackPreparationFailureDetail, buildUploadFailureDetail } from "./features/cloud/uploadErrorDetails";',
        "App recovery imports",
    )

    app = regex_replace_once(
        app,
        r'\nasync function rollbackInterruptedCloudUploads\(beatgalerUserId: string, authoritativeBeatIds: Set<string> \| null\): Promise<string\[\]> \{.*?\n\}\n\n(?=function BeatGalerApp\(\))',
        '\n',
        "remove local interrupted-upload rollback",
    )

    app = replace_once(
        app,
        '''          const rolledBackNames = await rollbackInterruptedCloudUploads(\n            local.beatgaler_user_id,\n            recoveryAuthorityIds,\n          );''',
        '''          const rolledBackNames = await rollbackInterruptedCloudUploads({\n            beatgalerUserId: local.beatgaler_user_id,\n            authoritativeBeatIds: recoveryAuthorityIds,\n            cloudApiBase: getResolvedCloudApiBase(),\n            authToken: getBeatGalerAuthToken(),\n            purgeLocal: purgeInterruptedUploadLocal,\n          });''',
        "recovery call",
    )

    app = regex_replace_once(
        app,
        r'''            const raw = sessionCheckError instanceof Error\n              \? sessionCheckError\.message\n              : sessionCheckError != null\n                \? String\(sessionCheckError\)\n                : "BeatGaler could not verify cloud access for this installation\.";\n\n            const detail = \[\n              "UPLOAD FAILED",\n              "Stage: Verify cloud session",\n              "",\n              raw,\n              "",\n              "Checks:",\n              "• Confirm the Windows cloud-server and Tailscale Funnel are running\.",\n              "• Confirm this BeatGaler installation is signed in to the intended account\.",\n              "• Sign out and back in if this installation is attached to the wrong account\.",\n            \]\.join\("\\\\n"\);''',
        '            const { raw, detail } = buildCloudSessionUnavailableDetail(sessionCheckError);',
        "session error detail extraction",
    )

    app = regex_replace_once(
        app,
        r'''                const detail = \[\n                  "PLAYBACK PREPARATION FAILED",\n                  `Beat: \$\{detached\.name\}`,\n                  "",\n                  "The media upload and Galer Library index are already committed, but BeatGaler could not warm the new MASTER for playback within 15 seconds\.",\n                  "The beat was left in Cloud safely; retrying later should not require re-uploading the file\.",\n                \]\.join\("\\\\n"\);''',
        '                const detail = buildPlaybackPreparationFailureDetail(detached.name);',
        "playback upload error detail extraction",
    )

    app = regex_replace_once(
        app,
        r'''              const raw = error instanceof Error\n                \? error\.message\n                : typeof error === "string"\n                  \? error\n                  : \(\(\) => \{\n                      try \{ return JSON\.stringify\(error\); \}\n                      catch \{ return String\(error\); \}\n                    \}\)\(\);\n\n              const lower = raw\.toLowerCase\(\);\n              let hint = "Unexpected failure\. The exact raw error is included below\.";.*?              const detail = \[\n                "UPLOAD FAILED",\n                `Beat: \$\{original\.name\}`,\n                `Stage: \$\{uploadStage\}`,\n                `Platform: \$\{navigator\.platform \|\| "unknown"\}`,\n                "",\n                hint,\n                "",\n                `Error detail: \$\{sanitizeUserVisibleText\(raw, "Unknown error"\)\}`,\n              \]\.join\("\\\\n"\);''',
        '''              const detail = buildUploadFailureDetail({\n                beatName: original.name,\n                stage: uploadStage,\n                platform: navigator.platform || "unknown",\n                error,\n              });''',
        "upload error detail extraction",
    )

    write(app_path, app)
    write("src/features/cloud/interruptedUploadJournal.ts", JOURNAL)
    write("src/features/cloud/uploadErrorDetails.ts", ERROR_DETAILS)
    write("tests/integration/appUploadRecoveryExtraction.test.ts", INTEGRATION_TEST)

    characterization_path = "tests/integration/appMigrationCharacterization.test.ts"
    characterization = read(characterization_path)
    characterization = replace_once(
        characterization,
        'const playbackController = readFileSync(resolve(process.cwd(), "src/features/playback/usePlaybackController.ts"), "utf8");',
        'const playbackController = readFileSync(resolve(process.cwd(), "src/features/playback/usePlaybackController.ts"), "utf8");\nconst interruptedUploadJournal = readFileSync(resolve(process.cwd(), "src/features/cloud/interruptedUploadJournal.ts"), "utf8");\nconst uploadErrorDetails = readFileSync(resolve(process.cwd(), "src/features/cloud/uploadErrorDetails.ts"), "utf8");',
        "characterization owner reads",
    )
    characterization = replace_once(
        characterization,
        'uploads: { tasks: ["6.2", "6.3", "6.4"], owners: ["src/features/cloud/interruptedUploadJournal.ts", "src/features/cloud/desktopBeatUploadPipeline.ts", "src/features/cloud/useCloudUploadQueue.ts"] },',
        'uploads: { tasks: ["6.2", "6.3", "6.4"], owners: ["src/features/cloud/interruptedUploadJournal.ts", "src/features/cloud/uploadErrorDetails.ts", "src/features/cloud/desktopBeatUploadPipeline.ts", "src/features/cloud/useCloudUploadQueue.ts"] },',
        "characterization upload owner list",
    )
    old_recovery = '''  it("fails closed during interrupted-upload recovery until cloud authority is known", () => {\n    const recovery = section("async function rollbackInterruptedCloudUploads", "function BeatGalerApp");\n    expectOrdered(recovery, [\n      "if (authoritativeBeatIds?.has(item.beatId))",\n      "if (authoritativeBeatIds === null)",\n      "const response = await fetch(`${base}/beats/delete-topic`",\n      "await purgeInterruptedUploadLocal(item.beatId, item.stagingPaths)",\n      "writeActiveCloudUploads(remaining)",\n    ]);\n    expect(recovery).toContain("remaining.push(item)");\n  });'''
    new_recovery = '''  it("fails closed during interrupted-upload recovery until cloud authority is known", () => {\n    expectOrdered(interruptedUploadJournal, [\n      "if (authoritativeBeatIds?.has(item.beatId))",\n      "if (authoritativeBeatIds === null)",\n      "const response = await fetchImpl(`${cloudApiBase}/beats/delete-topic`",\n      "await purgeLocal(item.beatId, item.stagingPaths)",\n      "writeActiveCloudUploads(remaining)",\n    ]);\n    expect(interruptedUploadJournal).toContain("remaining.push(item)");\n    expect(app).toContain("rollbackInterruptedCloudUploads({");\n    expect(app).not.toContain("async function rollbackInterruptedCloudUploads");\n    expect(uploadErrorDetails).toContain("buildUploadFailureDetail");\n    expect(uploadErrorDetails).toContain("buildPlaybackPreparationFailureDetail");\n  });'''
    characterization = replace_once(characterization, old_recovery, new_recovery, "characterization recovery contract")
    write(characterization_path, characterization)

    regressions_path = "scripts/run-regressions.mjs"
    regressions = read(regressions_path)
    regressions = replace_once(
        regressions,
        '  const interruptedUploadJournal = readFileSync(path.join(root, "src", "features", "cloud", "interruptedUploadJournal.ts"), "utf8");',
        '  const interruptedUploadJournal = readFileSync(path.join(root, "src", "features", "cloud", "interruptedUploadJournal.ts"), "utf8");\n  const uploadErrorDetails = readFileSync(path.join(root, "src", "features", "cloud", "uploadErrorDetails.ts"), "utf8");',
        "regression owner read",
    )
    regressions = replace_once(regressions, '  if (!app.includes("authoritativeBeatIds?.has(item.beatId)")) fail("Upload recovery can no longer preserve a beat already committed to the authoritative INDEX.");', '  if (!interruptedUploadJournal.includes("authoritativeBeatIds?.has(item.beatId)")) fail("Upload recovery can no longer preserve a beat already committed to the authoritative INDEX.");', "regression durable authority owner")
    regressions = replace_once(regressions, '  if (!app.includes("authoritativeBeatIds === null")) fail("Upload recovery no longer fails closed when the authoritative INDEX cannot be verified.");', '  if (!interruptedUploadJournal.includes("authoritativeBeatIds === null")) fail("Upload recovery no longer fails closed when the authoritative INDEX cannot be verified.");', "regression fail-closed owner")
    regressions = replace_once(regressions, '  if (!app.includes("remaining.push(item)")) fail("Failed upload rollback no longer keeps its recovery marker for a later launch.");', '  if (!interruptedUploadJournal.includes("remaining.push(item)")) fail("Failed upload rollback no longer keeps its recovery marker for a later launch.");\n  if (!uploadErrorDetails.includes("buildUploadFailureDetail") || !uploadErrorDetails.includes("sanitizeUserVisibleText(raw, \\"Unknown error\\")")) fail("Upload error detail ownership or user-visible sanitization disappeared.");', "regression recovery/error ownership")
    write(regressions_path, regressions)

    print("Task 6.2 implementation and tests applied in runner workspace.")


def finalize() -> None:
    if len(sys.argv) != 5:
        raise SystemExit("finalize requires INITIAL_SHA IMPLEMENTATION_SHA RUN_ID")
    initial_sha, implementation_sha, run_id = sys.argv[2:5]

    roadmap_path = "migration/BeatGaler-roadmap-para-trabajar-con-IAs.md"
    roadmap = read(roadmap_path)
    roadmap = replace_once(
        roadmap,
        "### [ ] 6.2 — Separar recuperación y errores de uploads",
        "### [x] 6.2 — Separar recuperación y errores de uploads",
        "roadmap task 6.2",
    )
    write(roadmap_path, roadmap)

    register_path = "migration/Registro-de-avance.md"
    register = read(register_path)
    if "### Registro — 6.2" in register:
        raise SystemExit("Registro 6.2 already exists")
    entry = f'''\n\n### Registro — 6.2\n\n```\nTarea: 6.2 — Separar recuperación y errores de uploads\nEstado: Terminada\nFecha: 2026-09-08\n\nBase\n\n- Rama: v0.9.0-test-noche\n- SHA inicial de esta ejecución: {initial_sha}\n- Última tarea verificada: 6.1 — Separar las descargas de exportación\n\nCambio realizado\n\n- `src/features/cloud/interruptedUploadJournal.ts` pasó de poseer solo el marcador local a poseer también la reconciliación de una subida interrumpida contra el INDEX autoritativo.\n- La recuperación conserva la semántica fail-closed: un beat ya presente en el INDEX solo pierde el marcador local; si el INDEX no puede verificarse no se borra nada; si el rollback remoto/local falla el marcador permanece para un lanzamiento posterior.\n- `App.tsx` conserva el punto de llamada de startup y le entrega al módulo las dependencias concretas de sesión, base Cloud y purga local; dejó de contener la implementación de rollback.\n- Se creó `src/features/cloud/uploadErrorDetails.ts` como dueño de los detalles de error de sesión, fallo por etapa y preparación de playback posterior al upload, conservando mensajes, hints, etapa, plataforma y sanitización visible.\n- El estado `backgroundUploadErrors` y el pipeline siguen en App porque su extracción completa pertenece a 6.3/6.4; 6.2 solo mueve recuperación y construcción de detalles.\n- No se inició 6.3.\n\nAdaptación de pruebas\n\n- `tests/integration/appUploadRecoveryExtraction.test.ts` verifica con comportamiento ejecutable que un beat durable no se purga, autoridad desconocida difiere toda limpieza, un rollback fallido conserva el marcador y los detalles de error mantienen contexto útil/sanitizado.\n- `tests/integration/appMigrationCharacterization.test.ts` sigue protegiendo la recuperación fail-closed pero ahora apunta al owner real en `interruptedUploadJournal.ts` y reconoce `uploadErrorDetails.ts`.\n- `scripts/run-regressions.mjs` movió únicamente los guards de recovery al owner nuevo y añadió un guard del owner/sanitización de errores; no se debilitaron invariantes.\n\nArchivos afectados\n\n- src/App.tsx\n- src/features/cloud/interruptedUploadJournal.ts\n- src/features/cloud/uploadErrorDetails.ts\n- tests/integration/appUploadRecoveryExtraction.test.ts\n- tests/integration/appMigrationCharacterization.test.ts\n- scripts/run-regressions.mjs\n- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md\n- migration/Registro-de-avance.md\n- migration/BeatGaler-agent-state.md\n\nComprobaciones ejecutadas\n\n- GitHub Actions `Task 6.2 Apply`, run {run_id} — SUCCESS.\n- Artifact `migration-check-logs-task-6-2-{run_id}` — matriz completa publicada.\n- `npm ci` — PASS.\n- `git diff --check` — PASS.\n- `npm run test:typecheck` — PASS.\n- `npm run test:unit:ts` — PASS.\n- `npm run test:component:dom` — PASS.\n- `npm run test:integration` — PASS.\n- `npm run test:regressions` — PASS.\n- `npm run build:web` — PASS.\n- `npm run build` — PASS.\n- SHA de implementación verificada: {implementation_sha}.\n\nComprobaciones no ejecutadas\n\n- `npm run check` — no ejecutado como wrapper; sus checks relevantes fueron ejecutados individualmente, incluyendo tests y build.\n- `npm run test:e2e:recovery` — no valida esta extracción productiva: `BEATGALER_E2E_RECOVERY=1` reemplaza `<App />` por `E2ERecoveryHarness`, un harness genérico que no importa `interruptedUploadJournal.ts` ni `uploadErrorDetails.ts`.\n- Prueba física Desktop Windows/macOS — no ejecutada; esta ronda trabaja directamente en GitHub Actions y no dispone de una app física interactiva.\n\nPrueba manual\n\n- No ejecutada ni inventada.\n- Desktop: iniciar un import/upload, interrumpir el proceso antes del commit del INDEX y reiniciar; con autoridad Cloud disponible el beat incompleto debe limpiarse y mostrarse el aviso.\n- Desktop, caso durable: interrumpir después de que el INDEX ya contenga el beat pero antes de limpiar el marcador; al reiniciar no debe purgar media local/Cloud del beat confirmado.\n- Desktop, sin autoridad: iniciar con Cloud no verificable; el marcador debe conservarse y no debe borrarse el beat hasta un lanzamiento donde el INDEX pueda comprobarse.\n- Resultado esperado: ninguna subida confirmada se elimina por un marcador viejo y los errores siguen mostrando beat/etapa/plataforma/hint útil.\n\nPendientes / fuera de alcance\n\n- 6.3 — Separar el proceso de subida de un beat queda pendiente y no fue iniciado.\n- El estado/cola completa de background uploads sigue en App y corresponde a 6.3/6.4.\n- El riesgo previo de `handleRemoveBulk` con el snapshot `beats` capturado permanece sin cambios y fuera del alcance de 6.2.\n- El workflow histórico `probe-task-5.1-productive-temp-auth-compile.yml` permanece fuera de alcance.\n\nRiesgos previos relevantes\n\n- Ningún riesgo nuevo de integridad quedó abierto por 6.2; la limpieza destructiva sigue condicionada a autoridad conocida.\n\nHerramientas temporales restantes\n\n- Ninguna creada por 6.2 debe permanecer en el árbol final; el applier y workflow temporales se eliminan en el commit de cierre.\n\nFallos encontrados y causa\n\n- Ninguno en el run final {run_id}; la matriz aplicable quedó verde.\n\nVeredicto\n\nTerminada.\n\nLa recuperación de uploads y sus detalles de error quedaron fuera de App sin cambiar la frontera de autoridad: INDEX confirmado preserva el beat, autoridad desconocida difiere limpieza y un rollback fallido conserva el marcador.\n\nSiguiente tarea\n\n6.3 — Separar el proceso de subida de un beat.\n\nNo iniciada.\n```\n'''
    write(register_path, register.rstrip() + entry)

    state = f'''# BeatGaler — Agent State\n\nFecha de ejecución: 2026-09-08\nRama de trabajo obligatoria: `v0.9.0-test-noche`\n\n## Estado actual\n\n- Tarea trabajada: **6.2 — Separar recuperación y errores de uploads**\n- Estado: **Terminada**\n- Última tarea terminada: **6.2 — Separar recuperación y errores de uploads**\n- SHA inicial de esta ejecución: `{initial_sha}`\n- SHA final de implementación verificada: `{implementation_sha}`\n- Run de verificación principal: **{run_id} — SUCCESS**\n- Comprobaciones pendientes para 6.2: **ninguna automatizada necesaria**\n\n## Resultado verificado\n\n- `interruptedUploadJournal.ts` posee marcador y reconciliación de recovery contra autoridad Cloud.\n- Un beat presente en el INDEX autoritativo nunca pasa por purga; un INDEX desconocido conserva todos los marcadores; un rollback fallido conserva el suyo.\n- `uploadErrorDetails.ts` posee los detalles de sesión, fallo por etapa y preparación de playback manteniendo información útil y sanitización visible.\n- App conserva los puntos de llamada actuales; pipeline/cola no se extrajeron en esta ronda.\n- Run {run_id} terminó PASS en npm ci, diff-check, typecheck, unit TS, component DOM, integration, regressions, build:web y build.\n\n## Pendientes concretos / fuera de alcance\n\n- 6.3 — Separar el proceso de subida de un beat queda pendiente y no fue iniciado.\n- 6.4 — Separar la cola de uploads sigue después de 6.3.\n- El riesgo previo de `handleRemoveBulk` con el snapshot `beats` capturado permanece sin cambios y fuera del alcance de 6.2.\n- No deben quedar herramientas temporales creadas por 6.2 en el árbol final.\n\n## Siguiente tarea\n\n- **6.3 — Separar el proceso de subida de un beat**\n- Estado: **Pendiente**\n- No iniciarla hasta la próxima ronda.\n'''
    write("migration/BeatGaler-agent-state.md", state)
    print("Task 6.2 roadmap/register/agent-state finalized.")


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in {"apply", "finalize"}:
        raise SystemExit("Usage: task-6-2.py apply | finalize INITIAL_SHA IMPLEMENTATION_SHA RUN_ID")
    if sys.argv[1] == "apply":
        apply()
    else:
        finalize()
