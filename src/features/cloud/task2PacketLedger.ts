/** Diagnostic-only byte correlation. Never retains packet bytes after matching. */
export type Task2PacketIdentity = {
  packet_id: number;
  encode_seq?: number;
  ping_msg_ids: string[];
  rpc_msg_ids: string[];
  container_msg_ids: string[];
  session_id: string | null;
};

export type Task2EncodedPacket = Task2PacketIdentity & {
  encoded_bytes: number;
  encoded_fingerprint: string;
};

type QueuedPacket = { identity: Task2EncodedPacket; bytes: Uint8Array };

export function task2Fingerprint(bytes: Uint8Array): string {
  // FNV-1a is a short diagnostic label. Correlation also compares every byte.
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return hash.toString(16).padStart(16, "0");
}

function equalAt(haystack: Uint8Array, offset: number, needle: Uint8Array): boolean {
  if (offset + needle.length > haystack.length) return false;
  for (let i = 0; i < needle.length; i += 1) {
    if (haystack[offset + i] !== needle[i]) return false;
  }
  return true;
}

export class Task2PacketLedger {
  private readonly encoded: QueuedPacket[] = [];

  recordEncoded(identity: Task2PacketIdentity, bytes: Uint8Array): Task2EncodedPacket {
    const copy = bytes.slice();
    const record = {
      ...identity,
      encoded_bytes: copy.byteLength,
      encoded_fingerprint: task2Fingerprint(copy),
    };
    this.encoded.push({ identity: record, bytes: copy });
    return record;
  }

  matchSocketSend(bytes: Uint8Array): {
    matched: boolean;
    fingerprint: string;
    packet_ids: number[];
    packets: Task2EncodedPacket[];
  } {
    const fingerprint = task2Fingerprint(bytes);
    const matches: QueuedPacket[] = [];
    let matchedStart = -1;
    for (let start = 0; start < this.encoded.length; start += 1) {
      matches.length = 0;
      let offset = 0;
      for (let index = start; index < this.encoded.length; index += 1) {
        const item = this.encoded[index];
        if (!equalAt(bytes, offset, item.bytes)) break;
        matches.push(item);
        offset += item.bytes.byteLength;
        if (offset === bytes.byteLength) {
          matchedStart = start;
          break;
        }
      }
      if (matchedStart >= 0) break;
    }
    if (matchedStart < 0 || matches.length === 0) {
      return { matched: false, fingerprint, packet_ids: [], packets: [] };
    }
    this.encoded.splice(matchedStart, matches.length);
    return {
      matched: true,
      fingerprint,
      packet_ids: matches.map(item => item.identity.packet_id),
      packets: matches.map(item => item.identity),
    };
  }

  get pendingCount(): number { return this.encoded.length; }

  clear(): number[] {
    return this.encoded.splice(0).map(item => item.identity.packet_id);
  }
}

export function task2DecryptWarningReason(format: string): string | null {
  if (format.startsWith("received message with unknown authKey")) return "unknown_auth_key";
  if (format.startsWith("received message with invalid messageKey")) return "invalid_message_key";
  if (format.startsWith("ignoring message with invalid sessionId")) return "invalid_session_id";
  if (format.startsWith("ignoring message with invalid length")) return "invalid_length";
  if (format.startsWith("ignoring message with invalid padding size")) return "invalid_padding";
  return null;
}
