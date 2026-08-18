export type ValidationResult = { valid: true; normalized: string } | { valid: false; normalized: string; reason: string };

export function normalizeTag(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function validateTag(value: string): ValidationResult {
  const normalized = normalizeTag(value);
  if (!normalized) return { valid: false, normalized, reason: "Tag cannot be empty." };
  if (normalized.length > 40) return { valid: false, normalized, reason: "Maximum length is 40 characters." };
  if (!/^[a-z0-9]+(?:[ _-][a-z0-9]+)*$/.test(normalized)) {
    return {
      valid: false,
      normalized,
      reason: "Use only letters, numbers, spaces, hyphens (-), or underscores (_). Symbols such as (), ;, commas, slashes, quotes, and colons are not allowed.",
    };
  }
  return { valid: true, normalized };
}

export function cleanTags(values: string[]): { tags: string[]; removed: Array<{ tag: string; reason: string }> } {
  const tags: string[] = [];
  const removed: Array<{ tag: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const raw of values || []) {
    const result = validateTag(String(raw ?? ""));
    if (result.valid === false) {
      if (String(raw ?? "").trim()) removed.push({ tag: String(raw), reason: result.reason });
      continue;
    }
    if (seen.has(result.normalized)) continue;
    seen.add(result.normalized);
    tags.push(result.normalized);
    if (tags.length >= 30) break;
  }

  return { tags, removed };
}

export function validateBpm(value: string): ValidationResult {
  const normalized = String(value ?? "").trim();
  if (!normalized) return { valid: true, normalized: "" };
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(normalized)) {
    return { valid: false, normalized, reason: "BPM must be a number from 60 to 300." };
  }
  const bpm = Number(normalized);
  if (!Number.isFinite(bpm) || bpm < 60 || bpm > 300) {
    return { valid: false, normalized, reason: "BPM must be between 60 and 300." };
  }
  return { valid: true, normalized: String(bpm) };
}

function compactKey(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/♯/g, "#")
    .replace(/♭/g, "b")
    .replace(/\s+/g, " ");
}

export function validateMusicKey(value: string): ValidationResult {
  const raw = compactKey(value);
  if (!raw) return { valid: true, normalized: "" };

  let candidate = raw;
  const longMatch = candidate.match(/^([a-gA-G])([#b]?)[ ]*(major|maj|minor|min)$/i);
  if (longMatch) {
    candidate = `${longMatch[1]}${longMatch[2] || ""}${/^min/i.test(longMatch[3]) ? "m" : ""}`;
  }

  const match = candidate.match(/^([a-gA-G])([#b]?)(m)?$/i);
  if (!match) {
    return {
      valid: false,
      normalized: raw,
      reason: "Use A–G with optional # or b. For minor keys add m, for example C#, Ab, cm, c#m, or abm.",
    };
  }

  const isMinor = !!match[3];
  const root = isMinor ? match[1].toLowerCase() : match[1].toUpperCase();
  const accidental = (match[2] || "").toLowerCase();
  const normalized = `${root}${accidental}${isMinor ? "m" : ""}`;
  return { valid: true, normalized };
}

export function normalizeBeatMetadata<T extends { tags: string[]; bpm: string; key: string }>(beat: T): T {
  const cleaned = cleanTags(beat.tags || []);
  const bpm = validateBpm(beat.bpm);
  const key = validateMusicKey(beat.key);
  return {
    ...beat,
    tags: cleaned.tags,
    bpm: bpm.valid ? bpm.normalized : beat.bpm,
    key: key.valid ? key.normalized : beat.key,
  };
}
