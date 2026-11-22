import { readMp3Rating } from "../audio/id3Rating";

export interface WebAudioMetadata {
  bpm: string;
  key: string;
  tags: string[];
  image_base64: string | null;
  /** Estrellas 0–5 del POPM del MP3 (0 si no hay). */
  rating: number;
}

/** Browser-only, best-effort metadata hydration. Import never waits for this. */
export async function parseId3FromFile(file: File): Promise<WebAudioMetadata> {
  const rating = await readMp3Rating(file);
  try {
    const { readId3Metadata } = await import("./webId3Metadata");
    const metadata = await readId3Metadata(file);
    return { ...metadata, rating };
  } catch {
    return { bpm: "", key: "", tags: [], image_base64: null, rating };
  }
}
