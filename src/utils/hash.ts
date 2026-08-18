import { filePathToUrl } from "../lib/tauri";

// Compute SHA-1 hex of a file given its local path (file:// via Tauri helper)
export async function hashFilePath(path: string): Promise<string> {
  const url = filePathToUrl(path);
  const resp = await fetch(url);
  const ab = await resp.arrayBuffer();
  // Use SubtleCrypto
  const hashBuf = await crypto.subtle.digest("SHA-1", ab);
  const hashArray = Array.from(new Uint8Array(hashBuf));
  const hex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  return hex;
}
