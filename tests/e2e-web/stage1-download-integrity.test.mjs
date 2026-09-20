import assert from "node:assert/strict";
import test from "node:test";
import { id3v2Length, parseId3v23Frames, sha256Hex, stripMp3ContainerTags } from "./stage1-download-integrity.mjs";

function tag(body) {
  return Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, (body.length >>> 21) & 0x7f, (body.length >>> 14) & 0x7f, (body.length >>> 7) & 0x7f, body.length & 0x7f, ...body]);
}

test("strips only ID3v2 and ID3v1 while retaining MPEG technical bytes", () => {
  const mpeg = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0x58, 0x69, 0x6e, 0x67, 0x4c, 0x41, 0x4d, 0x45, 7]);
  const source = Uint8Array.from([...tag(Uint8Array.from([1, 2, 3, 4])), ...mpeg, ...new Uint8Array([0x54, 0x41, 0x47, ...new Uint8Array(125)])]);
  const stripped = stripMp3ContainerTags(source);
  assert.equal(id3v2Length(source), 14);
  assert.equal(stripped.prefixBytesRemoved, 14);
  assert.equal(stripped.suffixBytesRemoved, 128);
  assert.deepEqual(stripped.bytes, mpeg);
  assert.equal(sha256Hex(stripped.bytes), sha256Hex(mpeg));
});

test("parses v2.3 UTF-16 text frames and POPM", () => {
  const utf16 = value => Uint8Array.from([1, 0xff, 0xfe, ...Array.from(value).flatMap(char => [char.charCodeAt(0), 0]), 0, 0]);
  const frame = (id, payload) => Uint8Array.from([...id].map(char => char.charCodeAt(0)).concat([0, 0, 0, payload.length, 0, 0], [...payload]));
  const body = Uint8Array.from([
    ...frame("TIT2", utf16("Integrity Beat")),
    ...frame("TBPM", utf16("128")),
    ...frame("TKEY", utf16("c#m")),
    ...frame("TCON", utf16("tag-a; tag-b")),
    ...frame("POPM", Uint8Array.from([..."beatgaler@local"].map(char => char.charCodeAt(0)).concat([0, 255, 0, 0, 0, 0]))),
  ]);
  const parsed = parseId3v23Frames(tag(body));
  assert.equal(parsed.text.TIT2, "Integrity Beat");
  assert.equal(parsed.text.TBPM, "128");
  assert.equal(parsed.text.TKEY, "c#m");
  assert.equal(parsed.text.TCON, "tag-a; tag-b");
  assert.deepEqual(parsed.popm, { email: "beatgaler@local", rating: 255 });
});
