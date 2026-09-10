import { readBlobAsArrayBuffer } from "../audio/mp3Metadata";

/** Decode/resample locally, then create the playback MASTER without modifying the HQ WAV. */
export async function createWebWavMaster(wav: File, signal?: AbortSignal): Promise<File> {
  try {
    signal?.throwIfAborted();
    const context = new OfflineAudioContext(2, 1, 44100);
    const audio = await context.decodeAudioData(await readBlobAsArrayBuffer(wav));
    signal?.throwIfAborted();
    if (!audio.length || audio.numberOfChannels < 1 || audio.numberOfChannels > 2) {
      throw new Error("The WAV must contain mono or stereo audio.");
    }
    const { Mp3Encoder } = await import("@breezystack/lamejs");
    const encoder = new Mp3Encoder(audio.numberOfChannels, audio.sampleRate, 320);
    const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index));
    const parts: ArrayBuffer[] = [];
    const blockSize = 1152;
    for (let offset = 0; offset < audio.length; offset += blockSize) {
      signal?.throwIfAborted();
      const pcm = channels.map(channel => {
        const block = new Int16Array(Math.min(blockSize, audio.length - offset));
        for (let index = 0; index < block.length; index++) {
          const sample = Math.max(-1, Math.min(1, channel[offset + index]));
          block[index] = Math.round(sample * (sample < 0 ? 32768 : 32767));
        }
        return block;
      });
      const encoded = encoder.encodeBuffer(pcm[0], pcm[1]);
      if (encoded.length) parts.push(new Uint8Array(encoded).buffer);
      // Let the import indicator paint and keep the UI responsive during long beats.
      if (offset % (blockSize * 32) === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    const tail = encoder.flush();
    if (tail.length) parts.push(new Uint8Array(tail).buffer);
    const master = new File(parts, wav.name.replace(/\.wav$/i, "") + ".mp3", {
      type: "audio/mpeg", lastModified: wav.lastModified,
    });
    if (!master.size) throw new Error("The MP3 encoder returned no audio.");
    return master;
  } catch (cause) {
    throw new Error(`Could not convert WAV to MASTER MP3 at 320 kbps. ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
