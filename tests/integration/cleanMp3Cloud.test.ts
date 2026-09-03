import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCleanMp3CloudUpload } from "../../src-tauri/direct-transport/clean-mp3-cloud.mjs";

const tempDirs = new Set<string>();

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beatgaler-clean-mp3-test-"));
  tempDirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe("Desktop clean Cloud MP3 payload", () => {
  it("removes only ID3v2/ID3v1 and preserves MPEG technical/audio bytes byte-for-byte", () => {
    const dir = tempDir();
    const source = path.join(dir, "Tagged.mp3");
    const id3v2 = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 4, 0x4d, 0x45, 0x54, 0x41]);
    // Representative MPEG header + Xing/LAME-ish payload bytes. The cleaner must not parse/rewrite them.
    const mpeg = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x58, 0x69, 0x6e, 0x67, 0x4c, 0x41, 0x4d, 0x45, 1, 2, 3, 4]);
    const id3v1 = Buffer.alloc(128);
    id3v1.set(Buffer.from("TAG"), 0);
    const original = Buffer.concat([id3v2, mpeg, id3v1]);
    fs.writeFileSync(source, original);

    const clean = prepareCleanMp3CloudUpload(source, "Tagged.mp3");

    expect(clean.path).not.toBe(source);
    expect(clean.bytes).toBe(mpeg.byteLength);
    expect(clean.removedBytes).toBe(id3v2.byteLength + id3v1.byteLength);
    expect(fs.readFileSync(clean.path)).toEqual(mpeg);
    expect(fs.readFileSync(source)).toEqual(original);
    const cleanPath = clean.path;
    clean.cleanup();
    expect(fs.existsSync(cleanPath)).toBe(false);
  });

  it("leaves an already-clean MP3 in place", () => {
    const dir = tempDir();
    const source = path.join(dir, "Clean.mp3");
    const mpeg = Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4]);
    fs.writeFileSync(source, mpeg);

    const clean = prepareCleanMp3CloudUpload(source, "Clean.mp3");

    expect(clean.path).toBe(source);
    expect(clean.bytes).toBe(mpeg.byteLength);
    expect(clean.removedBytes).toBe(0);
    clean.cleanup();
    expect(fs.readFileSync(source)).toEqual(mpeg);
  });

  it("keeps the packaged Bot API helper wired to the same clean-MP3 seam", () => {
    const helper = fs.readFileSync(path.resolve("src-tauri/direct-transport/transport-helper.cjs"), "utf8");
    expect(helper).toContain("prepareCleanMp3Upload");
    expect(helper).toContain("id3v2PrefixLength");
    expect(helper).toContain("stripped_id3_bytes");
    expect(helper).toContain("clean.cleanup()");
  });
});
