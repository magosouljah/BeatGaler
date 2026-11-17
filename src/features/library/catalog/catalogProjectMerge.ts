// PROJECT sobre un beat existente: MISMA lógica que el flujo web anterior (`commitWebBeatEdit`).
//  - Un .zip soltado reemplaza el PROJECT completo (sin fusionar).
//  - Un archivo de DAW (.flp, .als, …) se FUSIONA con el ZIP actual: se descarga el PROJECT vigente, se quitan SOLO las entradas de DAW y las
//    carpetas Backup/Backups, se conservan samples y demás archivos, y se añade el nuevo archivo; el ZIP resultante se llama «<beat>.zip».
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
  return (await prepareBrowserProjectArchive(beatName, incoming, existing)).file;
}
