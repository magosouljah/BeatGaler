import assert from 'node:assert/strict';
import test from 'node:test';
import { FramedWriter, write } from '@fuman/io';

// The fake writable has the same send boundary as the WebSocket adapter.
// Both encodes enter before either resolves, as in the old shared-buffer race.
for (const later of ['A', 'B']) {
  test(`concurrent packets keep separate send buffers when ${later} encodes last`, async () => {
    const sent = [];
    const socket = { send(bytes) { sent.push(bytes); } };
    const writable = { async write(bytes) { socket.send(bytes); } };
    let active = 0;
    let maxActive = 0;
    const encoder = {
      async encode(frame, into) {
        active++;
        maxActive = Math.max(maxActive, active);
        write.bytes(into, frame);
        await Promise.resolve();
        if (frame[0] === (later === 'A' ? 0xaa : 0xbb)) await Promise.resolve();
        active--;
      },
    };
    const writer = new FramedWriter(writable, encoder);
    const a = Uint8Array.of(0xaa, 0xaa, 0xaa);
    const b = Uint8Array.of(0xbb, 0xbb);
    await Promise.all([writer.write(a), writer.write(b)]);

    assert.equal(maxActive, 2, 'encoding must overlap');
    assert.equal(sent.length, 2, 'one WebSocket send per logical packet');
    const byFirstByte = new Map(sent.map(bytes => [bytes[0], bytes]));
    assert.deepEqual([...byFirstByte.get(0xaa)], [...a]);
    assert.deepEqual([...byFirstByte.get(0xbb)], [...b]);
    assert.notEqual(byFirstByte.get(0xaa).buffer, byFirstByte.get(0xbb).buffer);
    a.fill(0);
    b.fill(0);
    assert.deepEqual([...byFirstByte.get(0xaa)], [0xaa, 0xaa, 0xaa]);
    assert.deepEqual([...byFirstByte.get(0xbb)], [0xbb, 0xbb]);
  });
}
