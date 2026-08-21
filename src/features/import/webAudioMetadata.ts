export interface WebAudioMetadata {
  bpm: string;
  key: string;
  tags: string[];
  image_base64: string | null;
}

const EMPTY_METADATA: WebAudioMetadata = {
  bpm: "",
  key: "",
  tags: [],
  image_base64: null,
};

let jsMediaTagsLoader: Promise<void> | null = null;

async function loadJsMediaTags(): Promise<void> {
  if ((window as any).jsmediatags) return;
  if (jsMediaTagsLoader) return jsMediaTagsLoader;

  jsMediaTagsLoader = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/jsmediatags@3.9.5/dist/jsmediatags.min.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load the audio metadata parser."));
    document.head.appendChild(script);
  });
  return jsMediaTagsLoader;
}

/** Browser-only, best-effort metadata hydration. Import never waits for this. */
export async function parseId3FromFile(file: File): Promise<WebAudioMetadata> {
  try {
    await loadJsMediaTags();
    const jsMediaTags: any = (window as any).jsmediatags;
    if (!jsMediaTags || typeof jsMediaTags.read !== "function") return { ...EMPTY_METADATA };

    return await new Promise(resolve => {
      try {
        jsMediaTags.read(file, {
          onSuccess: (result: any) => {
            const values = result.tags || {};
            const genre = String(values.TCON || values.genre || "");
            const tags = genre
              .split(/[,;\/]/)
              .map((tag: string) => tag.trim().toLowerCase())
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
            const picture = values.picture || values.PICTURE || null;
            if (picture?.data && picture?.format) {
              let binary = "";
              for (const byte of picture.data as number[]) binary += String.fromCharCode(byte);
              image_base64 = `data:${picture.format};base64,${btoa(binary)}`;
            }

            resolve({ bpm, key, tags, image_base64 });
          },
          onError: () => resolve({ ...EMPTY_METADATA }),
        });
      } catch {
        resolve({ ...EMPTY_METADATA });
      }
    });
  } catch {
    return { ...EMPTY_METADATA };
  }
}
