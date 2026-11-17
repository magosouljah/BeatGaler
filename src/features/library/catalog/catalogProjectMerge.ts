// PROJECT sobre un beat existente (flujo web anterior `commitWebBeatEdit`, con la regla de fusión aprobada por el propietario).
//  - Un .zip soltado reemplaza el PROJECT completo (sin fusionar).
//  - Un archivo de DAW (.flp, .als, …) se FUSIONA con el ZIP actual: se descarga el PROJECT vigente y se reemplazan ÚNICAMENTE las entradas de DAW
//    del MISMO tipo (un .flp reemplaza los .flp; los .als, samples, backups y demás archivos se conservan); el ZIP resultante se llama «<beat>.zip».
//  - Si el PROJECT actual no se puede cargar, se ABORTA sin subir nada («actualización segura»); jamás se sustituye a ciegas.
//  - Sin PROJECT previo, el archivo de DAW se empaqueta solo.
// En PostgreSQL la subida es una operación REPLACE: la versión anterior del PROJECT no se retira hasta que la operación se confirma,
// así que un fallo (red, proveedor, conflicto) deja intacto el PROJECT anterior.
import { prepareBrowserProjectArchive } from "../../projects/browserProjectArchive";
import { isProjectDawFileName } from "../../projects/projectFileTypes";

export const PROJECT_LOAD_FAILED = "The current PROJECT could not be loaded for a safe update. Refresh and try again.";

export async function prepareProjectForBeat({ beatName, incoming, hasProject, loadExisting }: {
  beatName: string; incoming: File; hasProject: boolean; loadExisting: () => Promise<File | null>;
}): Promise<File> {
  let existing: File | null = null;
  if (isProjectDawFileName(incoming.name.toLowerCase()) && hasProject) {
    try { existing = await loadExisting(); } catch { existing = null; }
    if (!existing) throw new Error(PROJECT_LOAD_FAILED);
  }
  return (await prepareBrowserProjectArchive(beatName, incoming, existing, { sameTypeOnly: true })).file;
}
