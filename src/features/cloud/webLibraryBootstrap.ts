export interface WebLibraryBootstrapResult {
  status: "created" | "existing";
  messageId: number;
  manifest: unknown;
}

export function isMissingWebLibraryIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /library index (?:is still synchronizing|is not available)/i.test(message);
}

export async function ensureWebLibraryIndex(transport: {
  ensureLibraryIndex?: () => Promise<WebLibraryBootstrapResult>;
}): Promise<WebLibraryBootstrapResult> {
  // Bootstrap uses the same temporary-authorized transport and serialized INDEX
  // operation as later writes. Cloud never creates or transfers the document.
  if (!transport.ensureLibraryIndex) throw new Error("Direct library bootstrap is unavailable.");
  return transport.ensureLibraryIndex();
}
