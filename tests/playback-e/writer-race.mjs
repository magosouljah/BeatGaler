import assert from 'node:assert/strict';
import { Bytes, FramedWriter, write } from '@fuman/io';

// Reproduce the pre-fix shared-buffer implementation alongside the patched
// installed writer. The network series separately uses the real mtcute codec.
const encoder = { async encode(frame, into) {
  await Promise.resolve();
  write.bytes(into, frame);
} };
const packets = [Uint8Array.of(1,2), Uint8Array.of(3,4)];
const writes = [];
const writable = { async write(value) { writes.push([...value]); } };
class LegacySharedWriter {
  buffer = Bytes.alloc(1024);
  async write(frame) {
    await encoder.encode(frame, this.buffer);
    const result = this.buffer.result();
    if (result.length) {
      const copy = new Uint8Array(result);
      this.buffer.reset();
      await writable.write(copy);
    }
  }
}
const shared = new LegacySharedWriter();
await Promise.all(packets.map(packet => shared.write(packet)));
assert.deepEqual(writes, [[1,2,3,4]]);

const separated = [];
const writable2 = { async write(value) { separated.push([...value]); } };
const patched = new FramedWriter(writable2, encoder);
await Promise.all(packets.map(packet => patched.write(packet)));
assert.deepEqual(separated, [[1,2],[3,4]]);
console.log('FramedWriter race reproduced: legacy shared=1 aggregate write, patched installed=2 packet writes.');
