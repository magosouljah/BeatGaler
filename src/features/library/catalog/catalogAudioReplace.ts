// Reemplazo de audio por arrastre sobre una BeatCard de la Gallery POSTGRES. Reutiliza los servicios de mutación del catálogo
// (`mutations.replaceBeat` = operación REPLACE C7 + transferencia por gateway); NO usa el flujo legacy de INDEX.
//  - MP3 → reemplaza MASTER. WAV → añade o reemplaza el WAV HQ.
//  - Pide confirmación ANTES de tocar nada. Hasta que la operación se confirma en el servidor, la identidad (beatId), los metadatos y los medios
//    actuales no cambian: es una operación REPLACE con `expectedVersion`; un fallo o conflicto deja el beat intacto.
//  - Nunca crea un beat nuevo: el beatId de la operación es el de la tarjeta.
import type { CatalogMutations } from "./catalogMutations";
import { beatFromCatalogDetail } from "./catalogMutations";
import { isProjectDawFileName } from "../../projects/projectFileTypes";
import { prepareProjectForBeat } from "./catalogProjectMerge";

export type DroppedAudioKind = "MP3" | "WAV" | "PROJECT";
export const classifyDroppedAudio = (file: Pick<File, "name" | "type">): DroppedAudioKind | null =>
  /\.wav$/i.test(file.name) || file.type === "audio/wav" || file.type === "audio/x-wav" ? "WAV"
    : /\.mp3$/i.test(file.name) || file.type === "audio/mpeg" ? "MP3"
      : /\.zip$/i.test(file.name) || isProjectDawFileName(file.name.toLowerCase()) ? "PROJECT" : null;

export interface ReplaceAudioInput {
  mutations: Pick<CatalogMutations, "getBeat" | "replaceBeat">;
  confirm: (o: { title: string; message: string; confirmLabel: string }) => Promise<boolean>;
  beatId: string;
  file: File;
  onProgress?: (text: string) => void;
  /** Se llama justo después de confirmar (antes de subir): la UI marca la tarjeta como ocupada. */
  onStart?: () => void;
  /** Descarga el PROJECT vigente del beat (para fusionar un archivo de DAW con su ZIP). */
  loadProject?: (beatId: string) => Promise<File | null>;
}
export type ReplaceAudioResult =
  | { status: "committed"; kind: DroppedAudioKind; beatId: string; replacedExisting: boolean }
  | { status: "cancelled" }
  | { status: "unsupported" }
  | { status: "failed"; message: string };

export async function replaceBeatAudio({ mutations, confirm, beatId, file, onProgress, onStart, loadProject }: ReplaceAudioInput): Promise<ReplaceAudioResult> {
  const kind = classifyDroppedAudio(file);
  if (!kind) return { status: "unsupported" };
  let detail;
  try { detail = await mutations.getBeat(beatId); } catch (e) { return { status: "failed", message: `No se pudo leer el beat: ${String((e as { message?: unknown })?.message ?? e)}` }; }
  const hadWav = Boolean(detail.hasWav);
  const replacing = kind === "MP3" || (kind === "WAV" ? hadWav : Boolean(detail.hasProject));
  const ok = await confirm({
    title: kind === "MP3" ? "Replace MP3?" : kind === "PROJECT" ? (replacing ? "Replace project?" : "Add project?") : hadWav ? "Replace WAV?" : "Add WAV?",
    message: kind === "MP3"
      ? `Replace the MP3 of “${detail.name}” with “${file.name}”? The current file is kept until the new one is saved.`
      : kind === "PROJECT"
        ? (replacing ? `Replace the project of “${detail.name}” with “${file.name}”? The current file is kept until the new one is saved.` : `Add “${file.name}” as the project of “${detail.name}”?`)
      : hadWav
        ? `Replace the WAV of “${detail.name}” with “${file.name}”? The current file is kept until the new one is saved.`
        : `Add “${file.name}” as the WAV of “${detail.name}”?`,
    confirmLabel: replacing ? "Replace" : "Add",
  });
  if (!ok) return { status: "cancelled" };
  onStart?.();
  const original = beatFromCatalogDetail(detail, null);
  try {
    // PROJECT: archivo de DAW → se fusiona con el ZIP actual (lógica anterior); si no se puede cargar, se aborta sin tocar nada.
    const projectFile = kind === "PROJECT" ? await prepareProjectForBeat({ beatName: detail.name, incoming: file, hasProject: Boolean(detail.hasProject), loadExisting: () => (loadProject ? loadProject(beatId) : Promise.resolve(null)) }) : null;
    const outcome = await mutations.replaceBeat({
      beatId, expectedVersion: detail.version, original, updated: original,
      files: kind === "WAV" ? { wav: file } : kind === "PROJECT" ? { project: projectFile } : { master: file },
      onProgress: (p) => onProgress?.(`${p.stage} ${Math.round((p.uploadedBytes / Math.max(1, p.totalBytes)) * 100)}%`),
    });
    if (outcome.status === "committed") return { status: "committed", kind, beatId, replacedExisting: replacing };
    if (outcome.status === "conflict") return { status: "failed", message: "Este beat cambió en otro dispositivo; no se reemplazó nada. Vuelve a intentarlo." };
    return { status: "failed", message: `La operación quedó en estado ${outcome.status}; el beat conserva su archivo actual.` };
  } catch (e) {
    return { status: "failed", message: String((e as { message?: unknown })?.message ?? e) };
  }
}
