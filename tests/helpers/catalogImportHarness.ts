// M3.1b — Ayudante de caracterización de la Sesión de importación del catálogo Web (I1–I7). Se apoya en `catalogEditHarness`
// (hook y servicios reales sobre los dobles ya existentes) y solo AÑADE: un Puerto de importación falso (archivos retenidos por beat,
// registro de liberaciones) y fábricas de beats de revisión. No modifica ningún doble existente. Etiqueta: FAKES.
import type { Beat } from "../../src/types";

export interface FakeImportPort {
  files: Map<string, { file: File; slots: { MASTER?: File | Blob; WAV?: File | Blob; PROJECT?: File | Blob } }>;
  released: string[];
  /** Registra el archivo retenido de un beat de revisión (como hace «Add beat» al elegirlo). */
  retain(beatId: string, file: File, slots?: { MASTER?: File | Blob; WAV?: File | Blob; PROJECT?: File | Blob }): void;
  reset(): void;
  port: { fileForBeat(id: string): File | null; slotFilesForBeat(id: string): { MASTER?: File | Blob; WAV?: File | Blob; PROJECT?: File | Blob }; releaseBeat(id: string): void; pickSlotFile(id: string, kind: string): Promise<File | null> };
}
export function createFakeImportPort(): FakeImportPort {
  const files: FakeImportPort["files"] = new Map(); const released: string[] = [];
  return {
    files, released,
    retain(beatId, file, slots = {}) { files.set(beatId, { file, slots: { ...slots } }); },
    reset() { files.clear(); released.length = 0; },
    port: {
      fileForBeat: (id) => files.get(id)?.file ?? null,
      slotFilesForBeat: (id) => ({ ...(files.get(id)?.slots ?? {}) }),
      releaseBeat: (id) => { released.push(id); files.delete(id); },
      pickSlotFile: async () => null,
    },
  };
}
/** Singleton compartido con el `vi.mock` de la prueba (la fábrica del mock lo importa dinámicamente). */
export const fakeImporter = createFakeImportPort();

/** Beat de revisión como los que fabrica «Add beat» (id local; los campos de nube vacíos). */
export function reviewBeat(name: string, over: Partial<Beat> = {}): Beat {
  return { id: `local_file_${name}`, name, mp3_path: `${name}.mp3`, folder_path: `${name}.mp3`, tags: [], bpm: "", key: "", rating: 0, ...over } as unknown as Beat;
}
