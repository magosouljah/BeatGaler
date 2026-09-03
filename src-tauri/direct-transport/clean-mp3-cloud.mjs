import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function id3v2PrefixLength(header, fileSize) {
  if (header.length < 10 || header[0] !== 0x49 || header[1] !== 0x44 || header[2] !== 0x33) return 0;
  const major = header[3];
  if (major < 2 || major > 4) return 0;
  const sizeBytes = [header[6], header[7], header[8], header[9]];
  if (sizeBytes.some(value => value >= 0x80)) return 0;
  const bodySize = (sizeBytes[0] << 21) | (sizeBytes[1] << 14) | (sizeBytes[2] << 7) | sizeBytes[3];
  const footerSize = major === 4 && (header[5] & 0x10) !== 0 ? 10 : 0;
  const total = 10 + bodySize + footerSize;
  return total > 0 && total < fileSize ? total : 0;
}

function copyRange(sourcePath, destinationPath, start, endExclusive) {
  const input = fs.openSync(sourcePath, "r");
  const output = fs.openSync(destinationPath, "wx", 0o600);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = start;
  try {
    while (offset < endExclusive) {
      const wanted = Math.min(buffer.byteLength, endExclusive - offset);
      const read = fs.readSync(input, buffer, 0, wanted, offset);
      if (read <= 0) throw new Error("Unexpected end of MP3 while creating clean Cloud payload.");
      let written = 0;
      while (written < read) written += fs.writeSync(output, buffer, written, read - written);
      offset += read;
    }
  } finally {
    fs.closeSync(output);
    fs.closeSync(input);
  }
}

/**
 * Creates a temporary metadata-free MP3 only when the upload contains ID3v2/ID3v1.
 * MPEG bytes are copied unchanged, so Xing/VBRI/LAME and audio frames remain intact.
 */
export function prepareCleanMp3CloudUpload(filePath, filename) {
  const originalPath = path.resolve(filePath);
  const stat = fs.statSync(originalPath);
  if (!stat.isFile() || stat.size <= 0 || !/\.mp3$/i.test(String(filename || originalPath))) {
    return { path: originalPath, bytes: stat.size, removedBytes: 0, cleanup() {} };
  }

  const fd = fs.openSync(originalPath, "r");
  let prefix = 0;
  let suffix = 0;
  try {
    const head = Buffer.alloc(10);
    const headRead = fs.readSync(fd, head, 0, head.length, 0);
    prefix = id3v2PrefixLength(head.subarray(0, headRead), stat.size);
    if (stat.size - prefix > 128) {
      const tail = Buffer.alloc(128);
      const tailRead = fs.readSync(fd, tail, 0, tail.length, stat.size - 128);
      if (tailRead === 128 && tail[0] === 0x54 && tail[1] === 0x41 && tail[2] === 0x47) suffix = 128;
    }
  } finally {
    fs.closeSync(fd);
  }

  const end = stat.size - suffix;
  if ((prefix === 0 && suffix === 0) || prefix >= end) {
    return { path: originalPath, bytes: stat.size, removedBytes: 0, cleanup() {} };
  }

  const tempPath = path.join(os.tmpdir(), `beatgaler-clean-mp3-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  try {
    copyRange(originalPath, tempPath, prefix, end);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
  const cleanBytes = end - prefix;
  return {
    path: tempPath,
    bytes: cleanBytes,
    removedBytes: stat.size - cleanBytes,
    cleanup() { try { fs.unlinkSync(tempPath); } catch {} },
  };
}
