// Envoltorios de BeatCard del catalogo: fijan en un solo lugar las props inertes que la Gallery PostgreSQL no usa (sin Desktop, sin Telegram
// legacy, sin proyecto nativo, sin offline package). BeatCard compartido no se toca: el DOM resultante es el mismo que con las props explicitas.
import type { ComponentProps } from "react";
import BeatCard from "../../../components/BeatCard";

type CardProps = ComponentProps<typeof BeatCard>;
const noop = () => {};

const INERT = {
  visible: true, openableProject: false, dragEnabled: false, offlineBusy: false,
  canUseOfflinePackage: false, canUseLocalHelper: false, canInspectNativeProject: false,
  onToggleOffline: noop, onRetryUpload: noop, onBulkUpload: noop,
  onUpload: noop, onUploadTelegram: noop, onDownloadTelegram: noop, onUploadProjectTelegram: noop, onOpenProject: noop, onUpdateProject: noop,
  animDelay: 0,
} satisfies Partial<CardProps>;

type LiveKeys = "beat" | "playbackInteractive" | "tagFrequency" | "showIncompleteWarnings" | "playing" | "selected" | "selectedCount" | "selectMode" | "networkOnline"
  | "onBulkEdit" | "onBulkDelete" | "onPlay" | "onWarm" | "onDetail" | "onEdit" | "onDelete" | "onAddToQueue" | "onCloudFiles" | "onToggleSelect";

/** BeatCard viva de la Gallery del catalogo (interactiva). */
export function CatalogBeatCard(props: Pick<CardProps, LiveKeys>) {
  return <BeatCard {...INERT} interactive {...props} />;
}

/** BeatCard original de una subida en curso (E83): sin interaccion ni reproduccion; ocupa el primer hueco de la rejilla. */
export function ProvisionalBeatCard({ beat, tagFrequency, networkOnline }: Pick<CardProps, "beat" | "tagFrequency" | "networkOnline">) {
  return (
    <BeatCard {...INERT} beat={beat} interactive={false} playbackInteractive={false} tagFrequency={tagFrequency} showIncompleteWarnings={false}
      playing={false} selected={false} selectedCount={0} selectMode={false} networkOnline={networkOnline}
      onBulkEdit={noop} onBulkDelete={noop} onPlay={noop} onWarm={noop} onDetail={noop} onEdit={noop} onDelete={noop} onAddToQueue={noop} onCloudFiles={noop} onToggleSelect={noop} />
  );
}
