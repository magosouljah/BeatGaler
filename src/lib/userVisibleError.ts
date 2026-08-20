/**
 * Last-resort UI boundary for internal storage/transport terminology.
 *
 * Diagnostics and developer logs keep the original error. Anything rendered to
 * an end user goes through this helper so implementation names, local transport
 * details and token-looking credentials cannot leak through a raw exception.
 */
export function sanitizeUserVisibleText(value: unknown, fallback = "Something went wrong."): string {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  const trimmed = raw.trim();
  if (!trimmed) return fallback;

  return trimmed
    .replace(/telegram[- ]bot[- ]api/gi, "Galer Storage")
    .replace(/\bbot api\b/gi, "Galer Storage")
    .replace(/\btdlib\b/gi, "Galer Storage")
    .replace(/\b001beatgaler\b/gi, "Galer Cloud")
    .replace(/\bleased transport bot\b/gi, "Galer Cloud storage session")
    .replace(/\btransport bot\b/gi, "Galer Cloud storage session")
    .replace(/\bdirect transport\b/gi, "Galer Storage")
    .replace(/\btransport helper\b/gi, "local storage runtime")
    .replace(/\bbot token\b/gi, "storage credential")
    .replace(/\btelegram\b/gi, "Galer Cloud")
    .replace(/\bdirect:\d+\b/gi, "cloud reference")
    // Telegram-style bot tokens are credentials. Redact them even if an
    // upstream/native error accidentally includes one without naming Telegram.
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted credential]");
}
