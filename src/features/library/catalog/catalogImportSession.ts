import type { CatalogStoreSnapshot } from "./catalogQueryStore";
import type { Beat } from "../../../types";
import type { appAlert } from "../../../lib/dialog";
import { cleanTags } from "../../../lib/metadataValidation";
import { noticeTone } from "../../../components/FloatingNotice";
import type { CatalogMutations, MutationProgress } from "./catalogMutations";
import { pendingTransferNotice, readOutcome } from "./catalogBeatEditor";
import { enqueueReview, nextReview, summarizePendingTransfers, type ReviewEntry } from "./catalogDrawerSave";
import { resolveImportPlan } from "./catalogImportPlan";
import { aggregateUploadPercent, uploadPercent } from "./catalogUploadProgress";

export const IMPORT_NO_FILE_NOTICE = "No se encontró el archivo del beat a importar.";

export function importFailureMessage(error: unknown): string {
  const e = error as { code?: unknown; detail?: { max?: unknown; used?: unknown; max_bytes?: unknown; name?: unknown }; message?: unknown } | null;
  if (e?.code === "NAME_TAKEN") return `Ya existe un beat llamado «${String(e.detail?.name ?? "")}». Cambia el nombre para continuar.`;
  if (e?.code === "QUOTA_EXCEEDED") return `Tu plan alcanzó el límite de beats${e.detail?.max != null ? ` (${String(e.detail.used ?? "?")} de ${String(e.detail.max)})` : ""}. Revisa Settings → Plan para ampliarlo.`;
  if (e?.code === "TRANSFER_UNAVAILABLE") return "El servicio de almacenamiento de archivos no está disponible en este entorno. El beat no se guardó.";
  if (e?.code === "PROJECT_TOO_LARGE") return "El PROJECT supera el tamaño máximo de tu plan.";
  return String(e?.message ?? error);
}

interface ImportSessionPorts {
  mutations: Pick<CatalogMutations, "importBeat" | "resolvePendingTransfers" | "forgetOperation">;
  importer: {
    fileForBeat(id: string): File | null;
    slotFilesForBeat(id: string): { MASTER?: File | Blob; WAV?: File | Blob; PROJECT?: File | Blob };
    releaseBeat(id: string): void;
  };
  clock: { setTimeout(callback: () => void, ms: number): void };
  landsProbe(): boolean;
  setBusy(id: string, active: boolean, success?: boolean): void;
  refreshLibrary(): void;
  alert: typeof appAlert;
}

interface UploadView {
  id: string;
  name: string;
  percent: number;
  uploadedBytes: number;
  totalBytes: number;
}
interface PendingCard { id: string; beat: Beat; realId: string | null }
interface ImportState {
  review: ReviewEntry | null;
  uploads: UploadView[];
  pendingCards: PendingCard[];
  notice: string | null;
}
interface ImportSnapshot extends ImportState {
  uploadNotice: string | null;
  batchOpen: boolean;
}

function uploadNotice(uploads: UploadView[]): string | null {
  if (uploads.length === 0) return null;
  if (uploads.length === 1) return `Subiendo «${uploads[0].name}»… ${uploads[0].percent} %`;
  return `Subiendo ${uploads.length} beats… ${aggregateUploadPercent(uploads)} %`;
}

function pendingNotice(name: string, why: string): string {
  return why === "uncertain"
    ? `La subida de «${name}» no se pudo confirmar. No se reenvía ni se borra nada: el servidor lo revisará y el beat aparecerá si Telegram lo recibió.`
    : pendingTransferNotice(name);
}

export interface ImportSession {
  open(beats: Beat[], hydrated?: Promise<Beat>[]): void;
  cancelReview(): void;
  advanceReview(): void;
  save(updated: Beat, onProgress?: (progress: MutationProgress) => void): Promise<void>;
  noteResident(ids: ReadonlySet<string>): void;
  getSeededArtwork(id: string): string | undefined;
  resumePending(): Promise<void>;
  setNotice(value: string | null): void;
  getSnapshot(): ImportSnapshot;
  subscribe(listener: () => void): () => void;
}

export function createImportSession(ports: ImportSessionPorts): ImportSession {
  const { importer, clock, setBusy, alert } = ports;
  const listeners = new Set<() => void>();
  const seededArtwork = new Map<string, string>();
  const handedOff = new Set<string>();
  let queue: ReviewEntry[] = [];
  let pendingChecked = false;
  let snapshot: ImportSnapshot = {
    review: null, uploads: [], pendingCards: [], notice: null, uploadNotice: null, batchOpen: false,
  };

  function update(patch: Partial<ImportState>) {
    const next = { ...snapshot, ...patch };
    if (next.review === snapshot.review && next.uploads === snapshot.uploads
      && next.pendingCards === snapshot.pendingCards && next.notice === snapshot.notice) return;
    snapshot = {
      ...next, batchOpen: Boolean(next.review) || next.uploads.length > 0,
      uploadNotice: next.uploads === snapshot.uploads ? snapshot.uploadNotice : uploadNotice(next.uploads),
    };
    for (const listener of listeners) listener();
  }

  function showReview(entry: ReviewEntry, patch?: Partial<ImportState>) {
    const result = enqueueReview(snapshot.review, queue, entry);
    queue = result.queue;
    update({ ...patch, review: result.current });
    void entry.hydrated?.then((beat) => {
      const next = { ...beat, tags: cleanTags(beat.tags || []).tags };
      queue = queue.map((item) => item.beat.id === entry.beat.id ? { beat: next, hydrated: null } : item);
      const { review } = snapshot;
      if (review?.beat.id === entry.beat.id) update({ review: { ...review, beat: next } });
    }).catch((error) => {
      if (importer.fileForBeat(entry.beat.id)) void alert({ title: "Import failed", message: String(error), danger: true });
    });
  }

  function completeHandoff(uploadId: string, realId: string) {
    if (handedOff.has(uploadId)) return;
    handedOff.add(uploadId);
    setBusy(realId, false, true);
    setBusy(uploadId, false);
    clock.setTimeout(() => seededArtwork.delete(realId), 4000);
    update({ pendingCards: snapshot.pendingCards.filter((card) => card.id !== uploadId) });
  }

  async function save(updated: Beat, onProgress?: (p: MutationProgress) => void) {
    const { review } = snapshot;
    if (!review) return;
    const { mutations, refreshLibrary } = ports;
    const reviewId = review.beat.id;
    const plan = await resolveImportPlan({
      beat: updated, hydrated: review.hydrated ? review.hydrated.then(() => updated) : null,
      slotFiles: () => importer.slotFilesForBeat(reviewId), originalFile: importer.fileForBeat(reviewId),
    });

    let begun: () => void = () => {};
    const begunP = new Promise<"started">((resolve) => { begun = () => resolve("started"); });
    const uploadId = updated.id;
    let percent = 0;
    let bytes = { uploadedBytes: 0, totalBytes: 0 };
    const job = mutations.importBeat({ beat: plan.beat, files: plan.files, onProgress: (progress) => {
      onProgress?.(progress);
      if (progress.stage === "preparing") {
        bytes = { uploadedBytes: 0, totalBytes: progress.totalBytes };
        return;
      }
      begun();
      bytes = { uploadedBytes: Math.min(progress.uploadedBytes, progress.totalBytes), totalBytes: progress.totalBytes };
      const next = uploadPercent(bytes.uploadedBytes, bytes.totalBytes);
      if (next !== percent) {
        percent = next;
        const uploads = snapshot.uploads;
        if (uploads.some((upload) => upload.id === uploadId)) {
          update({ uploads: uploads.map((upload) => upload.id === uploadId ? { ...upload, percent, ...bytes } : upload) });
        }
      }
    } }).then((outcome) => ({ outcome, error: null as unknown }), (error: unknown) => ({ outcome: null, error }));

    const first = await Promise.race([begunP, job.then(() => "settled" as const)]);
    if (first === "settled") {
      const { outcome, error } = await job;
      if (error) throw new Error(importFailureMessage(error));
      const reading = readOutcome(outcome!);
      if (reading.reading === "rejected") {
        throw new Error(reading.error ? importFailureMessage(reading.error) : `La importación de «${updated.name}» quedó en estado ${reading.status}; no se guardó el beat.`);
      }
      importer.releaseBeat(reviewId);
      update({ review: null, notice: reading.reading === "pending" ? pendingNotice(updated.name, reading.why) : `«${updated.name}» importado.` });
      refreshLibrary();
      return;
    }

    const lands = ports.landsProbe();
    if (lands) setBusy(uploadId, true);
    update({
      uploads: [...snapshot.uploads.filter((upload) => upload.id !== uploadId), { id: uploadId, name: updated.name, percent, ...bytes }],
      pendingCards: lands ? [{ id: uploadId, beat: updated, realId: null }, ...snapshot.pendingCards.filter((card) => card.id !== uploadId)] : snapshot.pendingCards,
      notice: snapshot.notice && noticeTone(snapshot.notice) === "success" ? null : snapshot.notice,
      review: null,
    });

    void job.then(({ outcome, error }) => {
      const uploads = snapshot.uploads.filter((upload) => upload.id !== uploadId);
      const reading = outcome ? readOutcome(outcome) : null;
      if (outcome?.status === "committed") {
        importer.releaseBeat(reviewId);
        const realId = outcome.beatId;
        let pendingCards = snapshot.pendingCards;
        if (lands && realId) {
          setBusy(realId, true);
          if (updated.image_base64 && String(updated.image_base64).startsWith("data:")) seededArtwork.set(realId, String(updated.image_base64));
          pendingCards = pendingCards.map((card) => card.id === uploadId ? { ...card, realId } : card);
          clock.setTimeout(() => completeHandoff(uploadId, realId), 5000);
        }
        refreshLibrary();
        update({ uploads, pendingCards, notice: snapshot.notice && noticeTone(snapshot.notice) === "error" ? snapshot.notice : `«${updated.name}» importado.` });
        return;
      }

      const pendingCards = snapshot.pendingCards.filter((card) => card.id !== uploadId);
      setBusy(uploadId, false);
      if (reading?.reading === "pending") {
        importer.releaseBeat(reviewId);
        update({ uploads, pendingCards, notice: pendingNotice(updated.name, reading.why) });
        refreshLibrary();
        return;
      }
      const failure = error || (reading?.reading === "rejected" && reading.error);
      const reason = failure ? importFailureMessage(failure) : `quedó en estado ${outcome ? outcome.status : "desconocido"}`;
      const patch = { uploads, pendingCards, notice: `No se pudo importar «${updated.name}»: ${reason.replace(/[.s]+$/, "")}. Tus cambios siguen en la revisión.` };
      if (importer.fileForBeat(reviewId)) showReview({ beat: updated, hydrated: null }, patch);
      else update(patch);
    });
  }

  return {
    open(beats, hydrated) {
      const beat = beats[0];
      if (!beat) return;
      if (!importer.fileForBeat(beat.id)) {
        update({ notice: IMPORT_NO_FILE_NOTICE });
        return;
      }
      showReview({ beat, hydrated: hydrated?.[0] ?? null });
    },
    cancelReview() {
      if (snapshot.review) importer.releaseBeat(snapshot.review.beat.id);
      update({ review: null });
    },
    // La revisión anterior sale del render antes de montar la siguiente.
    advanceReview() {
      if (snapshot.review || !queue.length) return;
      const result = nextReview(queue, (id) => Boolean(importer.fileForBeat(id)));
      queue = result.queue;
      if (result.next) update({ review: result.next });
    },
    save,
    noteResident(ids) {
      for (const card of snapshot.pendingCards) {
        if (card.realId && ids.has(card.realId)) completeHandoff(card.id, card.realId);
      }
    },
    getSeededArtwork: (id) => seededArtwork.get(id),
    async resumePending() {
      if (pendingChecked) return;
      pendingChecked = true;
      const { mutations, refreshLibrary } = ports;
      try {
        const result = summarizePendingTransfers(await mutations.resolvePendingTransfers());
        for (const id of result.forget) mutations.forgetOperation(id);
        if (result.notice) update({ notice: result.notice });
        if (result.refresh) refreshLibrary();
      } catch { /* La consulta de arranque no interrumpe el uso de la Gallery. */ }
    },
    setNotice: (notice) => update({ notice }),
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}


export function importLandsAtTop({ filters, firstOrdinal }: Pick<CatalogStoreSnapshot, "filters" | "firstOrdinal">, scrollTop?: number | null): boolean {
  return filters.state === "ACTIVE" && !filters.q.trim() && filters.includeTags.length === 0
    && filters.excludeTags.length === 0 && firstOrdinal === 0 && (scrollTop == null || scrollTop < 24);
}

export function projectPendingCards(cards: PendingCard[], blocks: CatalogStoreSnapshot["blocks"]) {
  const residentIds = new Set<string>();
  if (cards.some((card) => card.realId)) {
    for (const block of blocks) for (const item of block.items) residentIds.add(item.id);
  }
  // La provisional sale de la rejilla en el mismo render en que llega la real.
  const pendingCards = cards.filter((card) => !(card.realId && residentIds.has(card.realId))).map(({ id, beat }) => ({ id, beat }));
  return { residentIds, pendingCards };
}
