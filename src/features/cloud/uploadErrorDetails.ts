import { sanitizeUserVisibleText } from "../../lib/userVisibleError";

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
    ].join("\n"),
  };
}

export function buildPlaybackPreparationFailureDetail(beatName: string): string {
  return [
    "PLAYBACK PREPARATION FAILED",
    `Beat: ${beatName}`,
    "",
    "The media upload and Galer Library index are already committed, but BeatGaler could not warm the new MASTER for playback within 15 seconds.",
    "The beat was left in Cloud safely; retrying later should not require re-uploading the file.",
  ].join("\n");
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
  ].join("\n");
}
