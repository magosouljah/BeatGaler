import { browserId3Reader } from "../../lib/id3BrowserParser";
import type { WebAudioMetadata } from "./webAudioMetadata";

export function readId3Metadata(file: File): Promise<Omit<WebAudioMetadata, "rating">> {
  return new Promise((resolve, reject) => {
    browserId3Reader.read(file, {
      onSuccess: ({ tags: values }) => {
        const genre = String(values.TCON || values.genre || "");
        const tags = genre
          .split(/[,;\/]/)
          .map(tag => tag.trim().toLowerCase())
          .filter(Boolean);

        let bpm = String([values.TBPM, values.bpm, values.BPM, values.tbpm].find(Boolean) || "").trim();
        let key = String([values.TKEY, values.key, values.INITIALKEY, values.initialkey].find(Boolean) || "").trim();
        const bpmPattern = /^\d{2,3}$/;
        const keyPattern = /^[A-G](?:b|#)?(?:\s*(?:maj|major|min|minor|m)?)?$/i;

        if (!bpm || !key) {
          for (const value of Object.values(values)) {
            if (typeof value !== "string") continue;
            const normalized = value.trim();
            if (!bpm && bpmPattern.test(normalized)) bpm = normalized;
            const possibleKey = normalized.split(/[\[\]\(\)\-_,]/)[0].trim();
            if (!key && keyPattern.test(possibleKey)) key = possibleKey;
            if (bpm && key) break;
          }
        }

        let image_base64: string | null = null;
        const picture = (values.picture || values.PICTURE) as { data: number[]; format: string } | undefined;
        if (picture?.data && picture?.format) {
          let binary = "";
          for (const byte of picture.data) binary += String.fromCharCode(byte);
          image_base64 = `data:${picture.format};base64,${btoa(binary)}`;
        }

        resolve({ bpm, key, tags, image_base64 });
      },
      onError: reject,
    });
  });
}
