// Plan de importación de «Add beat»/arrastre: reúne lo que el navegador prepara en segundo plano para un archivo elegido
// (metadatos ID3: BPM, key, tags, portada incrustada; y para un WAV, el MP3 maestro convertido) antes de subir.
// Antes se subía el archivo original como MASTER y se descartaba todo lo hidratado: un WAV se importaba como «MASTER» sin MP3 ni WAV HQ.
import type { Beat } from "../../../types";
import { cleanTags } from "../../../lib/metadataValidation";

export interface ImportPlan { beat: Beat; files: { master: File; wav: File | null } }

export async function resolveImportPlan({ beat, hydrated, slotFiles, originalFile }: {
  beat: Beat; hydrated?: Promise<Beat> | null; slotFiles: () => { MASTER?: File | Blob; WAV?: File | Blob }; originalFile: File | null;
}): Promise<ImportPlan> {
  const isWav = Boolean(beat.has_wav) || /\.wav$/i.test(originalFile?.name ?? "");
  let h: Beat | null = null;
  try { h = hydrated ? await hydrated : null; } catch (e) { if (isWav) throw e; /* ID3 ilegible: se importa sin metadatos */ }
  const slots = slotFiles();
  const asFile = (b: File | Blob | undefined, fallbackName: string): File | null => (!b ? null : b instanceof File ? b : new File([b], fallbackName, { type: b.type }));
  const master = asFile(slots.MASTER, `${beat.name}.mp3`) ?? (isWav ? null : originalFile);
  const wav = asFile(slots.WAV, originalFile?.name ?? `${beat.name}.wav`);
  if (!master) throw new Error("El WAV no pudo convertirse a MP3 para la reproducción.");
  const merged: Beat = { ...beat, bpm: beat.bpm || h?.bpm || "", key: beat.key || h?.key || "", tags: cleanTags([...(beat.tags || []), ...(h?.tags || [])]).tags, image_base64: beat.image_base64 ?? h?.image_base64 ?? null };
  return { beat: merged, files: { master, wav } };
}
