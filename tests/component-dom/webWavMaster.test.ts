import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebWavMaster } from "../../src/features/import/webWavMaster";
import { readBlobAsArrayBuffer } from "../../src/features/audio/mp3Metadata";

afterEach(() => vi.unstubAllGlobals());

describe("Web WAV MASTER encoder", () => {
  it.each([1, 2])("encodes %i channel PCM as actual MPEG-1 Layer III at 320 kbps", async channels => {
    // jsdom lacks Web Audio. Only decoding is stubbed; LAME and MP3 bytes are real.
    const samples = Float32Array.from({ length: 4410 }, (_, i) => Math.sin(i * 2 * Math.PI * 440 / 44100) * 0.5);
    vi.stubGlobal("OfflineAudioContext", class {
      async decodeAudioData() {
        return { length: samples.length, numberOfChannels: channels, sampleRate: 44100, getChannelData: () => samples };
      }
    });
    const source = new File(["wav"], "Beat.wav", { type: "audio/wav", lastModified: 77 });
    const master = await createWebWavMaster(source);
    const bytes = new Uint8Array(await readBlobAsArrayBuffer(master));
    expect(master.name).toBe("Beat.mp3");
    expect(master.type).toBe("audio/mpeg");
    expect(master.lastModified).toBe(77);
    expect(bytes.length).toBeGreaterThan(4000);
    // Walk every MPEG frame: sync, MPEG-1 Layer III, bitrate index 14 = 320 kbps.
    let offset = 0;
    let frames = 0;
    while (offset < bytes.length) {
      expect(bytes[offset]).toBe(0xff);
      expect(bytes[offset + 1] & 0xfe).toBe(0xfa);
      expect(bytes[offset + 2] >> 4).toBe(14);
      expect((bytes[offset + 2] >> 2) & 3).toBe(0); // 44.1 kHz
      expect(bytes[offset + 3] >> 6 === 3).toBe(channels === 1);
      offset += Math.floor(144 * 320000 / 44100) + ((bytes[offset + 2] >> 1) & 1);
      frames++;
    }
    expect(offset).toBe(bytes.length);
    expect(frames).toBeGreaterThan(3);
  });

  it("reports decoding failures instead of returning an incomplete MASTER", async () => {
    vi.stubGlobal("OfflineAudioContext", class {
      async decodeAudioData() { throw new Error("Invalid WAV"); }
    });
    await expect(createWebWavMaster(new File(["bad"], "Broken.wav")))
      .rejects.toThrow("Could not convert WAV to MASTER MP3 at 320 kbps. Invalid WAV");
  });
});
