export interface BrowserId3Result {
  tags: Record<string, unknown>;
}

export interface BrowserId3Handlers {
  onSuccess(result: BrowserId3Result): void;
  onError?(error: unknown): void;
}

function synchsafe32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] & 0x7f) << 21)
    | ((bytes[offset + 1] & 0x7f) << 14)
    | ((bytes[offset + 2] & 0x7f) << 7)
    | (bytes[offset + 3] & 0x7f);
}

function uint32be(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] << 24) >>> 0)
    + (bytes[offset + 1] << 16)
    + (bytes[offset + 2] << 8)
    + bytes[offset + 3]) >>> 0;
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

function utf16be(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  }
  return out;
}

function decodeText(bytes: Uint8Array): string {
  if (!bytes.length) return "";
  const encoding = bytes[0];
  const payload = bytes.subarray(1);
  let decoded = "";
  if (encoding === 0) decoded = latin1(payload);
  else if (encoding === 3) decoded = new TextDecoder("utf-8", { fatal: false }).decode(payload);
  else if (encoding === 2) decoded = utf16be(payload);
  else {
    if (payload.length >= 2 && payload[0] === 0xfe && payload[1] === 0xff) {
      decoded = utf16be(payload.subarray(2));
    } else if (payload.length >= 2 && payload[0] === 0xff && payload[1] === 0xfe) {
      const swapped = new Uint8Array(payload.length - 2);
      for (let i = 2; i + 1 < payload.length; i += 2) {
        swapped[i - 2] = payload[i + 1];
        swapped[i - 1] = payload[i];
      }
      decoded = utf16be(swapped);
    } else {
      decoded = utf16be(payload);
    }
  }
  return decoded.replace(/\0+$/g, "").trim();
}

function terminatorLength(encoding: number): number {
  return encoding === 1 || encoding === 2 ? 2 : 1;
}

function findTerminator(bytes: Uint8Array, offset: number, width: number): number {
  for (let i = offset; i + width - 1 < bytes.length; i += width) {
    let allZero = true;
    for (let j = 0; j < width; j += 1) allZero = allZero && bytes[i + j] === 0;
    if (allZero) return i;
  }
  return bytes.length;
}

function parsePicture(frame: Uint8Array): { data: number[]; format: string } | null {
  if (frame.length < 5) return null;
  const encoding = frame[0];
  const mimeEnd = frame.indexOf(0, 1);
  if (mimeEnd < 0 || mimeEnd + 2 >= frame.length) return null;
  const mime = latin1(frame.subarray(1, mimeEnd)).trim() || "image/jpeg";
  const descriptionStart = mimeEnd + 2;
  const width = terminatorLength(encoding);
  const descriptionEnd = findTerminator(frame, descriptionStart, width);
  const imageStart = Math.min(frame.length, descriptionEnd + width);
  if (imageStart >= frame.length) return null;
  return { data: Array.from(frame.subarray(imageStart)), format: mime };
}

function removeUnsynchronization(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length);
  let write = 0;
  for (let read = 0; read < input.length; read += 1) {
    out[write++] = input[read];
    if (input[read] === 0xff && input[read + 1] === 0x00) read += 1;
  }
  return out.subarray(0, write);
}

function parseId3(bytes: Uint8Array): BrowserId3Result {
  const tags: Record<string, unknown> = {};
  if (bytes.length < 10 || latin1(bytes.subarray(0, 3)) !== "ID3") return { tags };
  const version = bytes[3];
  if (version !== 3 && version !== 4) return { tags };
  const flags = bytes[5];
  const declaredSize = synchsafe32(bytes, 6);
  let body = bytes.subarray(10, Math.min(bytes.length, 10 + declaredSize));
  if ((flags & 0x80) !== 0) body = removeUnsynchronization(body);

  let offset = 0;
  if ((flags & 0x40) !== 0 && body.length >= 4) {
    const extended = version === 4 ? synchsafe32(body, 0) : uint32be(body, 0) + 4;
    if (extended > 0 && extended <= body.length) offset = extended;
  }

  while (offset + 10 <= body.length) {
    const id = latin1(body.subarray(offset, offset + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize = version === 4 ? synchsafe32(body, offset + 4) : uint32be(body, offset + 4);
    if (!frameSize || offset + 10 + frameSize > body.length) break;
    const frame = body.subarray(offset + 10, offset + 10 + frameSize);

    if (id === "TBPM" || id === "TKEY" || id === "TCON") {
      const value = decodeText(frame);
      if (value) tags[id] = value;
      if (id === "TBPM" && value) tags.bpm = value;
      if (id === "TKEY" && value) tags.key = value;
      if (id === "TCON" && value) tags.genre = value;
    } else if (id === "APIC") {
      const picture = parsePicture(frame);
      if (picture) tags.picture = picture;
    }
    offset += 10 + frameSize;
  }
  return { tags };
}

function readFileArrayBuffer(file: File): Promise<ArrayBuffer> {
  const native = (file as File & { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer;
  if (typeof native === "function") return native.call(file);
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Could not read ID3 file."));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("ID3 FileReader returned a non-binary result."));
    };
    reader.readAsArrayBuffer(file);
  });
}

export const browserId3Reader = {
  read(file: File, handlers: BrowserId3Handlers): void {
    void readFileArrayBuffer(file)
      .then(buffer => handlers.onSuccess(parseId3(new Uint8Array(buffer))))
      .catch(error => handlers.onError?.(error));
  },
};
