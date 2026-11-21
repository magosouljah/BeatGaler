// Preparación de archivos antes de subirlos por una operación del catálogo (la misma que hacía el flujo web anterior):
//  - MASTER: se quitan solo ID3v2/ID3v1 (los bytes MPEG/Xing/VBRI/LAME se conservan exactos); el INDEX/PostgreSQL es dueño de título/BPM/key/tags.
//  - PROJECT: un .zip pasa tal cual; un archivo de DAW soportado (.flp, .als, …) se empaqueta en un ZIP con nombre seguro; otro tipo se rechaza.
//  - WAV y portada pasan sin cambios.
// `createCatalogMutations({ prepareFiles })` existía pero el provider real no la cableaba: los imports subían el MP3 con su ID3 y un PROJECT sin empaquetar.
import { stripId3MetadataForCloud } from "../../audio/mp3Metadata";
import { prepareBrowserProjectArchive } from "../../projects/browserProjectArchive";
import type { PreparedTransferFiles, TransferFiles } from "./catalogMutations";

export async function prepareCatalogFiles(files: TransferFiles, beatName: string): Promise<PreparedTransferFiles> {
  const master = files.master ? (await stripId3MetadataForCloud(files.master)).file : files.master;
  let project = files.project ?? null; let projectFlags: PreparedTransferFiles["projectFlags"] = null;
  if (project) {
    const prepared = await prepareBrowserProjectArchive(beatName, project, null);
    project = prepared.file; projectFlags = { openable: prepared.openable, hasFlp: prepared.hasFlp, hasAls: prepared.hasAls, hasSamples: prepared.hasSamples };
  }
  return { ...files, master, project, projectFlags };
}
