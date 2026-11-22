import { editDroppedAudio, type AudioEditOptions } from "./catalogBeatEditor";
import type { CatalogMutations } from "./catalogMutations";
import type { DroppedAudioKind } from "./catalogDropKinds";

export { classifyDroppedAudio, type DroppedAudioKind } from "./catalogDropKinds";

export interface ReplaceAudioInput extends AudioEditOptions {
  mutations: Pick<CatalogMutations, "getBeat" | "replaceBeat">;
  beatId: string;
  file: File;
  loadProject?: (beatId: string) => Promise<File | null>;
}
export type ReplaceAudioResult =
  | { status: "committed"; kind: DroppedAudioKind; beatId: string; replacedExisting: boolean }
  | { status: "cancelled" }
  | { status: "unsupported" }
  | { status: "failed"; message: string };

export async function replaceBeatAudio({ mutations, beatId, file, loadProject, ...options }: ReplaceAudioInput): Promise<ReplaceAudioResult> {
  const result = await editDroppedAudio(mutations, beatId, file, options, loadProject);
  if (result.reading === "success") return { status: "committed", beatId, kind: result.kind, replacedExisting: result.replacedExisting };
  if (result.reading === "not-started") return result.why === "cancelled" ? { status: "cancelled" } : { status: "unsupported" };
  return { status: "failed", message: result.message };
}
