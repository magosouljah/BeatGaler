export const WEB_DIRECT_PART_BYTES = 19 * 1024 * 1024;
export const WEB_DIRECT_MAX_FILE_BYTES = 1900 * 1024 * 1024;

export interface WebUploadPartPlan {
  index: number;
  offset: number;
  size: number;
  filename: string;
}

function safeFilename(filename: string): string {
  const normalized = filename.trim().replace(/[\\/\0]/g, "_");
  return normalized || "beatgaler-file";
}

export function planWebUploadParts(size: number, filename: string): WebUploadPartPlan[] {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Upload source is missing or empty.");
  if (size > WEB_DIRECT_MAX_FILE_BYTES) {
    throw new Error("This file exceeds the 1.9 GB Galer Cloud Web limit.");
  }
  const count = Math.ceil(size / WEB_DIRECT_PART_BYTES);
  const name = safeFilename(filename);
  return Array.from({ length: count }, (_, index) => {
    const offset = index * WEB_DIRECT_PART_BYTES;
    const partSize = Math.min(WEB_DIRECT_PART_BYTES, size - offset);
    return {
      index,
      offset,
      size: partSize,
      filename: count === 1 ? name : `${name}.beatgaler-part-${String(index + 1).padStart(4, "0")}-of-${String(count).padStart(4, "0")}`,
    };
  });
}
