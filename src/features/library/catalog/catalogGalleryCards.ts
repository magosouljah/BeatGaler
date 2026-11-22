import type { Beat } from "../../../types";
import type { CatalogBeatDto } from "./catalogApi";
import type { CatalogServices } from "./catalogLibraryProvider";
import { beatFromCatalogDetail } from "./catalogMutations";

export const KNOWN_BEATS_MAX = 512;
type ArtworkUrls = Record<string, string>;
type ArtworkUpdate = (urls: ArtworkUrls) => ArtworkUrls;
type CardMedia = Pick<CatalogServices["media"], "loadArtwork" | "invalidate">;

const placeholderBeat = (id: string): Beat => beatFromCatalogDetail({ id, version: "", state: "ACTIVE", name: "…", bpm: "", key: "", tags: [], rating: 0, color: null, color2: null, artwork: null, playback: null, hasArtwork: false, hasWav: false, hasStems: false, hasProject: false, fileCount: 0 } as CatalogBeatDto);


export function createKnownGalleryCards() {
  const dtoById = new Map<string, CatalogBeatDto>();
  const ordinalById = new Map<string, number>();
  let artworkBatch: Map<string, string> | null = null;

  function noteOrdinal(id: string, ordinal: number) { ordinalById.set(id, ordinal); }

  // Las portadas que llegan en el mismo fotograma se publican juntas (E80).
  function applyArtwork(fileId: string, url: string, setArtworkUrls: (update: ArtworkUpdate) => void) {
    if (artworkBatch) { artworkBatch.set(fileId, url); return; }
    const batch = artworkBatch = new Map([[fileId, url]]);
    const flush = () => {
      artworkBatch = null;
      setArtworkUrls((previous) => {
        let next = previous;
        for (const [id, value] of batch) {
          if (next[id] === value) continue;
          if (next === previous) next = { ...previous };
          next[id] = value;
        }
        return next;
      });
    };
    if (typeof requestAnimationFrame === "function" && typeof document !== "undefined" && document.visibilityState === "visible") requestAnimationFrame(flush);
    else setTimeout(flush, 0);
  }

  return {
    knownDto: (id: string) => dtoById.get(id),
    ordinalOf: (id: string) => ordinalById.get(id),
    noteOrdinal,
    onUnmountCard: (id: string) => { ordinalById.delete(id); },
    bindArtworkLoader(media: Pick<CardMedia, "loadArtwork">, setArtworkUrls: (update: ArtworkUpdate) => void) {
      return (id: string, ordinal?: number) => {
        if (ordinal !== undefined) noteOrdinal(id, ordinal);
        const ref = dtoById.get(id)?.artwork;
        if (!ref) return;
        void media.loadArtwork(ref, id).then(
          (url) => applyArtwork(ref.fileId, url, setArtworkUrls),
          () => applyArtwork(ref.fileId, "", setArtworkUrls),
        );
      };
    },
    forgetArtworkOf(id: string, media: Pick<CardMedia, "invalidate">, firstBlockCache: CatalogServices["firstBlockCache"], accountId: string, setArtworkUrls: (update: ArtworkUpdate) => void) {
      const oldFile = dtoById.get(id)?.artwork?.fileId;
      media.invalidate(id);
      if (oldFile) setArtworkUrls((previous) => {
        if (!(oldFile in previous)) return previous;
        const next = { ...previous };
        delete next[oldFile];
        return next;
      });
      void firstBlockCache?.dropBeat(accountId, id);
    },
    forRender({ artworkUrls, playingId, getSeededArtwork }: {
      artworkUrls: ArtworkUrls;
      playingId: string | null;
      getSeededArtwork(id: string): string | undefined;
    }) {
      function toBeat(dto: CatalogBeatDto): Beat {
        dtoById.delete(dto.id);
        dtoById.set(dto.id, dto);
        if (dtoById.size > KNOWN_BEATS_MAX) {
          const keys = dtoById.keys();
          const oldest = keys.next().value;
          const victim = oldest === playingId ? keys.next().value : oldest;
          if (victim !== undefined) dtoById.delete(victim);
        }
        // E83: la tarjeta real puede usar la portada de la provisional al aparecer.
        const url = dto.artwork ? artworkUrls[dto.artwork.fileId] ?? getSeededArtwork(dto.id) ?? null : null;
        return beatFromCatalogDetail(dto, url || null, url === "");
      }

      return {
        toBeat,
        beatById(id: string): Beat {
          const dto = dtoById.get(id);
          return dto ? toBeat(dto) : placeholderBeat(id);
        },
      };
    },
  };
}
