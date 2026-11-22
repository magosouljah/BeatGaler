import { editArtworkFile } from "./catalogBeatEditor";
import type { CatalogMutations } from "./catalogMutations";

export { normalizeArtworkFile, resolveArtworkFile } from "./catalogBeatEditor";

export type ReplaceArtworkResult = { status: "committed"; beatId: string } | { status: "failed"; message: string };

export async function replaceBeatArtwork({ mutations, beatId, file }: {
  mutations: Pick<CatalogMutations, "getBeat" | "replaceBeat">; beatId: string; file: File;
}): Promise<ReplaceArtworkResult> {
  const result = await editArtworkFile(mutations, beatId, file);
  if (result.reading === "success") return { status: "committed", beatId };
  return { status: "failed", message: result.message };
}
