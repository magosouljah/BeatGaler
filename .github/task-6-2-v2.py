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


def replace_span(text: str, start_marker: str, end_marker: str, replacement: str, label: str) -> str:
    start = text.find(start_marker)
    if start < 0:
        raise SystemExit(f"{label}: start marker not found")
    end = text.find(end_marker, start + len(start_marker))
    if end < 0:
        raise SystemExit(f"{label}: end marker not found")
    return text[:start] + replacement + text[end:]


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
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return response(true);
    }) as typeof fetch;
    const purgeLocal = vi.fn(async () => undefined);

    const rolledBack = await rollbackInterruptedCloudUploads({
      beatgalerUserId: "user-1",
      authoritativeBeatIds: new Set([durable.beatId]),
      cloudApiBase: "https://cloud.example.test",
      authToken: "token",
      purgeLocal,
      fetchImpl,
    });

    expect(rolledBack).toEqual([interrupted.beatName]);
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe("https://cloud.example.test/beats/delete-topic");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ beatgalerUserId: "user-1", beatId: interrupted.beatId });
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


def main() -> None:
    app_path = "src/App.tsx"
    app = read(app_path)

    app = replace_once(
        app,
        'import { clearCloudUploadActive, markCloudUploadActive, readActiveCloudUploads, writeActiveCloudUploads, type ActiveCloudUpload } from "./features/cloud/interruptedUploadJournal";',
        'import { clearCloudUploadActive, markCloudUploadActive, rollbackInterruptedCloudUploads } from "./features/cloud/interruptedUploadJournal";\nimport { buildCloudSessionUnavailableDetail, buildPlaybackPreparationFailureDetail, buildUploadFailureDetail } from "./features/cloud/uploadErrorDetails";',
        "App recovery imports",
    )

    app = replace_span(
        app,
        "async function rollbackInterruptedCloudUploads",
        "function BeatGalerApp()",
        "function BeatGalerApp()",
        "remove local interrupted-upload rollback",
    )

    app = replace_once(
        app,
        '''          const rolledBackNames = await rollbackInterruptedCloudUploads(\n            local.beatgaler_user_id,\n            recoveryAuthorityIds,\n          );''',
        '''          const rolledBackNames = await rollbackInterruptedCloudUploads({\n            beatgalerUserId: local.beatgaler_user_id,\n            authoritativeBeatIds: recoveryAuthorityIds,\n            cloudApiBase: getResolvedCloudApiBase(),\n            authToken: getBeatGalerAuthToken(),\n            purgeLocal: purgeInterruptedUploadLocal,\n          });''',
        "recovery call",
    )

    app = replace_span(
        app,
        "            const raw = sessionCheckError instanceof Error",
        "\n\n            setBackgroundUploadErrors",
        "            const { raw, detail } = buildCloudSessionUnavailableDetail(sessionCheckError);",
        "session error detail extraction",
    )

    playback_start = app.find("              const playbackReady = await waitForUploadedBeatPlaybackReady(detached);")
    if playback_start < 0:
        raise SystemExit("playback marker not found")
    detail_start = app.find("                const detail = [", playback_start)
    detail_end = app.find("\n                setBackgroundUploadErrors", detail_start)
    if detail_start < 0 or detail_end < 0:
        raise SystemExit("playback detail span not found")
    app = app[:detail_start] + "                const detail = buildPlaybackPreparationFailureDetail(detached.name);" + app[detail_end:]

    failure_start = app.find("              const raw = error instanceof Error", app.find("Background Telegram upload failed"))
    failure_end = app.find("\n\n              if (!syncCommitted)", failure_start)
    if failure_start < 0 or failure_end < 0:
        raise SystemExit("upload failure detail span not found")
    app = app[:failure_start] + '''              const detail = buildUploadFailureDetail({\n                beatName: original.name,\n                stage: uploadStage,\n                platform: navigator.platform || "unknown",\n                error,\n              });''' + app[failure_end:]

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
    regressions = replace_once(
        regressions,
        '  if (!app.includes("authoritativeBeatIds?.has(item.beatId)")) fail("Upload recovery can no longer preserve a beat already committed to the authoritative INDEX.");',
        '  if (!interruptedUploadJournal.includes("authoritativeBeatIds?.has(item.beatId)")) fail("Upload recovery can no longer preserve a beat already committed to the authoritative INDEX.");',
        "regression durable authority owner",
    )
    regressions = replace_once(
        regressions,
        '  if (!app.includes("authoritativeBeatIds === null")) fail("Upload recovery no longer fails closed when the authoritative INDEX cannot be verified.");',
        '  if (!interruptedUploadJournal.includes("authoritativeBeatIds === null")) fail("Upload recovery no longer fails closed when the authoritative INDEX cannot be verified.");',
        "regression fail-closed owner",
    )
    regressions = replace_once(
        regressions,
        '  if (!app.includes("remaining.push(item)")) fail("Failed upload rollback no longer keeps its recovery marker for a later launch.");',
        '  if (!interruptedUploadJournal.includes("remaining.push(item)")) fail("Failed upload rollback no longer keeps its recovery marker for a later launch.");\n  if (!uploadErrorDetails.includes("buildUploadFailureDetail") || !uploadErrorDetails.includes(\'sanitizeUserVisibleText(raw, "Unknown error")\')) fail("Upload error detail ownership or user-visible sanitization disappeared.");',
        "regression recovery/error ownership",
    )
    write(regressions_path, regressions)

    print("Task 6.2 implementation and tests applied in runner workspace.")


if __name__ == "__main__":
    main()
