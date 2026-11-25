// T16 / V08-A — Shell POSTGRES: la misma composición visible que el AppShell web aprobado (GalleryChrome, barra de selección,
// `lab-gallery-main` como único scroller, BeatCard, botón «Add beat», Drawer, Player, menús de tags y TagPeek) con las filas
// virtualizadas de V05 en lugar del grid plano. Ningún nodo nuevo visible: las clases y el orden de los bloques son los del AppShell;
// el track virtual sustituye a `.lab-gallery-grid` usando las mismas variables de columnas/gaps de gallery.css.
import { useEffect, useMemo, useRef } from "react";
import GalleryChrome, { type GalleryChromeScope } from "../../design/GALLERY/GalleryChrome";
import { dismissBeatGalerStartupLoader } from "../../startup/startupLoader";
import { BeatTagPeekLayer, useBeatTagPeek } from "../../design/shared/BeatTagPeek";
import AddBeatModal from "../../../components/AddBeatModal";
import { BEAT_NAME_MAX } from "../../../lib/metadataValidation";
import { CatalogBeatCard, ProvisionalBeatCard } from "./CatalogBeatCards";
import Drawer from "../../../components/Drawer";
import Player from "../../../components/Player";
import SettingsPanel from "../../../components/SettingsPanel";
import TagColorMenu from "../../tags/components/TagColorMenu";
import TagRenameDialog from "../../tags/components/TagRenameDialog";
import { PlusIcon } from "../../../components/ui";
import { setTagColor } from "../../../lib/tagColors";
import { platform } from "../../../platform";
import type { Beat } from "../../../types";
import type { CatalogBeatDto } from "./catalogApi";
import { CatalogVirtualGallery } from "./CatalogVirtualGallery";
import type { CatalogServices } from "./catalogLibraryProvider";
import { useCatalogGalleryScope } from "./useCatalogGalleryScope";
import { useState } from "react";
import { appAlert } from "../../../lib/dialog";
import FloatingNotice from "../../../components/FloatingNotice";
import { useCatalogFileDrop } from "./useCatalogFileDrop";
import { routeDrop } from "./catalogDropRouting";
import { createCatalogTrashSource } from "./catalogTrashSource";
import CloudFilesModal from "../../downloads/components/CloudFilesModal";

export interface CatalogAppShellProps {
  services: CatalogServices;
  accountId: string;
  context: { authority_era: string; authority_epoch: string; revision: string };
  viewportHeightFallback?: number;
}

export function CatalogAppShell({ services, accountId, context, viewportHeightFallback = 800 }: CatalogAppShellProps) {
  const scope = useCatalogGalleryScope({ services, accountId, context });
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const tagPeek = useBeatTagPeek();
  // Preferencia «Incomplete file warnings» (se guarda en este dispositivo; por defecto activada, como en la Gallery anterior). Antes el panel la mostraba fija en OFF.
  const [incompleteWarnings, setIncompleteWarnings] = useState(true);
  useEffect(() => { void platform.preferences.load().then((p) => setIncompleteWarnings(p.incomplete_warnings_enabled ?? true)).catch(() => {}); }, []);
  const trashSource = useMemo(() => createCatalogTrashSource({ api: services.api, mutations: services.mutations }), [services]);
  const [tagColorMenu, setTagColorMenu] = useState<{ tag: string; x: number; y: number } | null>(null);
  const { snapshot, interaction, playback, audio, currentBeat, notice } = scope;
  const { selectMode, selectedCount } = scope.selection;
  const { drawer, setDrawer } = scope.editor;
  const tenantKey = `${accountId}:${context.authority_era}:${context.authority_epoch}`;
  // V09 hallazgo: el overlay de arranque (#beatgaler-startup-loader) solo lo retiraba el pipeline LEGACY; en POSTGRES bloqueaba los clics.
  useEffect(() => { dismissBeatGalerStartupLoader(); }, []);
  // Arrastrar y soltar: la acción depende del TIPO de archivo y la tarjeta solo decide el destino (catalogDropRouting):
  // imagen sobre cualquier zona de una BeatCard → portada; MP3/WAV sobre una BeatCard → reemplazo de audio con confirmación; MP3/WAV fuera → beat nuevo (AddBeatModal con `initialFile`).
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const { active: dropActive, targetId: dropTargetId } = useCatalogFileDrop({
    enabled: !droppedFile && !scope.imports.showAdd && !drawer && !scope.imports.review && !snapshot.provisional,
    onDrop: (event) => {
      const action = routeDrop(event);
      if (action.type === "alert") { void appAlert({ title: action.title, message: action.message }); return; }
      if (scope.rejectOfflineMutation(action.type === "import" ? "Importing beats" : "Updating a beat")) return;
      if (action.type === "import") { setDroppedFile(action.file); scope.imports.setShowAdd(true); }
      else if (action.type === "replace-audio") void scope.editor.replaceAudioByDrop(action.beatId, action.file);
      else if (action.type === "artwork-file") void scope.editor.replaceArtworkByDrop(action.beatId, [{ kind: "file", file: action.file }]);
      else void scope.editor.replaceArtworkByDrop(action.beatId, action.sources);
    },
  });
  const closeAdd = () => { setDroppedFile(null); scope.imports.setShowAdd(false); };
  // B11: cerrar «Añadir» por cualquier vía (Escape incluido) libera el archivo soltado y reabre el arrastre.
  useEffect(() => { if (!scope.imports.showAdd) setDroppedFile(null); }, [scope.imports.showAdd]);
  const openAdd = () => { if (!scope.rejectOfflineMutation("Adding a beat")) scope.imports.setShowAdd(true); };
  // Scope para GalleryChrome (misma forma que el legacy; `displayedBeats` no existe en POSTGRES: la selección es global en el servidor).
  const chromeScope: GalleryChromeScope = {
    includedTags: scope.filters.includedTags, excludedTags: scope.filters.excludedTags, allTags: scope.filters.allTags, tagColors: scope.filters.tagColors, handleTagClick: scope.filters.handleTagClick, clearTagFilters: scope.filters.clearTagFilters, openTagRename: scope.rename.open,
    search: scope.filters.search, setSearch: scope.filters.setSearch, sortBy: scope.filters.sortBy, setSortBy: scope.filters.setSortBy, selectMode, displayedBeats: [] as Beat[],
    finishSelection: scope.selection.finishSelection, toggleSelection: (b: Beat | null) => scope.selection.toggleSelection(b, false),
    rejectOfflineMutation: scope.rejectOfflineMutation, setShowAdd: scope.imports.setShowAdd, reloadLibrary: scope.reloadLibrary, loading: scope.loading, libraryRefreshing: false,
    setShowSettings: scope.settings.setShowSettings, handleDisconnectTelegramAccount: scope.settings.handleDisconnectTelegramAccount,
  };
  const renderCard = (item: CatalogBeatDto, ordinal: number) => {
    scope.noteOrdinal(item.id, ordinal);
    const beat = scope.toBeat(item);
    return (
      <CatalogBeatCard
        beat={beat} playbackInteractive={Boolean(item.playback)} tagFrequency={scope.filters.tagFrequency} showIncompleteWarnings={incompleteWarnings}
        playing={audio.playingId === beat.id && audio.isPlaying} selected={scope.isSelected(beat.id)} selectedCount={selectedCount} selectMode={selectMode}
        networkOnline={scope.connectionState === "online"} onBulkEdit={scope.selection.handleEditBulk} onBulkDelete={scope.selection.handleRemoveBulk}
        onPlay={scope.transport.handlePlay} onWarm={scope.transport.handleWarm}
        onDetail={(b) => setDrawer({ beat: b, mode: "detail" })} onEdit={(b) => { if (!scope.rejectOfflineMutation("Editing metadata")) setDrawer({ beat: b, mode: "edit" }); }}
        onDelete={scope.editor.deleteBeat} onAddToQueue={scope.transport.addToQueue} onCloudFiles={scope.downloads.open}
        onToggleSelect={(b, e) => scope.selection.toggleSelection(b, e.shiftKey)}
      />
    );
  };
  return (
    // Copia local aún no revalidada con PostgreSQL: misma presentación, pero sin interacción (inert) hasta que llegue el primer bloque vigente.
    <div className="bg-design lab-gallery-page bg-product-gallery" data-catalog-mode="postgres" data-account={accountId}
      data-catalog-provisional={snapshot.provisional ? "true" : undefined} aria-busy={snapshot.provisional || undefined} {...(snapshot.provisional ? { inert: "" } : {})}
      style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#0c0c0c", overflow: "hidden" }}>
      {scope.connectionState === "offline" && (
        <div style={{ position: "fixed", top: 62, left: "50%", transform: "translateX(-50%)", zIndex: 20200, maxWidth: "min(620px, calc(100vw - 36px))", padding: "10px 14px", borderRadius: 10, border: "1px solid #7a6525", background: "#302913", color: "#f0d77d", boxShadow: "0 12px 34px rgba(0,0,0,.4)", fontSize: 11.5, lineHeight: 1.4, textAlign: "center" }}>
          Reconnect to verify your Galer Cloud library.
        </div>
      )}
      <GalleryChrome scope={chromeScope} />
      {(selectedCount > 0 || selectMode) && (
        <div className="bg-gallery-selection-actions" style={{ padding: "0 24px", height: 40, display: "flex", alignItems: "center", gap: 12, background: "#111", borderBottom: "1px solid #1a1a1a", flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: "#888" }} data-selection-count={selectedCount} data-selection-status={interaction.selection.status}>{selectedCount} selected</span>
          <button type="button" onClick={scope.selection.toggleSelectAll}>Select All</button>
          <button onClick={scope.selection.handleEditBulk} disabled={selectedCount === 0 || interaction.selection.status !== "active"} style={{ padding: "5px 14px", background: "#1e1e1e", border: "1px solid #2a2a2a", borderRadius: 6, color: "#ccc", fontSize: 12, cursor: "pointer" }}>Edit all</button>
          <button onClick={scope.selection.handleRemoveBulk} disabled={selectedCount === 0 || interaction.selection.status !== "active"} style={{ padding: "5px 14px", background: "transparent", border: "1px solid #3d0000", borderRadius: 6, color: "#f87171", fontSize: 12, cursor: "pointer" }}>Remove all</button>
          <button onClick={scope.selection.finishSelection} style={{ marginLeft: "auto", background: "none", border: "none", color: "#444", fontSize: 12, cursor: "pointer" }}>Cancel</button>
        </div>
      )}
      {tagColorMenu && (
        <TagColorMenu x={tagColorMenu.x} y={tagColorMenu.y} current={scope.filters.tagColors[tagColorMenu.tag.trim().toLowerCase()] ?? null}
          onSelect={(hex) => { setTagColor(tagColorMenu.tag, hex); setTagColorMenu(null); }} onRename={() => { scope.rename.open(tagColorMenu.tag); setTagColorMenu(null); }} onClose={() => setTagColorMenu(null)} />
      )}
      {scope.rename.tagRename && (
        <TagRenameDialog rename={scope.rename.tagRename} busy={scope.rename.busy} error={scope.rename.error} affectedCount={scope.rename.affectedCount} mp3Count={0} wavCount={0}
          onNewTagChange={scope.rename.setNewTag} onContinue={scope.rename.onContinue} onBack={scope.rename.back} onCancel={scope.rename.cancel} onConfirm={scope.rename.confirm} />
      )}
      <div ref={scrollerRef} className="lab-gallery-main" data-library-scroll="true" aria-busy={scope.loading}
        style={{ flex: 1, position: "relative", overflowY: "auto", paddingBottom: currentBeat ? 140 : 90 }}>
        <div className="bg-catalog-shell-status" role="status" aria-live="polite" data-uploads={scope.imports.uploads.length} data-selection-count={selectedCount} data-selection-status={interaction.selection.status} data-playback-status={playback.status} data-store-status={snapshot.status}>
          {/* Los avisos son flotantes (FloatingNotice, fixed): no ocupan espacio aquí ni desplazan la Gallery. */}
        </div>
        <div className="bg-catalog-grid-host" onPointerOver={tagPeek.onPointerOver} onPointerOut={tagPeek.onPointerOut} onPointerDown={tagPeek.onPointerDown} onFocusCapture={tagPeek.onFocusCapture} onBlurCapture={tagPeek.onBlurCapture}>
          {/* E79: los beats que están subiendo no tienen tarjeta; la Gallery solo dibuja lo que PostgreSQL confirma (una representación por beat). */}
          <CatalogVirtualGallery store={services.store} scrollerRef={scrollerRef} tenantKey={tenantKey} renderCard={renderCard} viewportHeightFallback={viewportHeightFallback}
            onMountCard={scope.onMountCard} onUnmountCard={scope.onUnmountCard}
            leadCards={scope.imports.pendingCards.map(({ id, beat }) => ({ id, node: (
              // E83: la BeatCard original de una subida en curso (logo de BeatGaler girando sobre la portada, sin reproducción): ocupa el primer hueco de la rejilla.
              <ProvisionalBeatCard beat={beat} tagFrequency={scope.filters.tagFrequency} networkOnline={scope.connectionState === "online"} />) }))}
            cardAttributes={(item, ordinal) => ({ "data-card": item.id, "data-ordinal": String(ordinal), "data-selected": scope.isSelected(item.id) ? "true" : "false", "data-playing": playback.current?.beatId === item.id ? "true" : "false" })}
            onGoToStart={() => { void services.store.loadFirst(); }} onAddBeat={openAdd} onClearFilters={() => { scope.filters.setSearch(""); scope.filters.clearTagFilters(); }} />
        </div>
      </div>
      {!currentBeat && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 45 }}>
          <button onClick={openAdd} style={{ padding: "9px 20px", borderRadius: 40, background: "#161616", border: "1px solid #242424", color: "#777", fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, boxShadow: "0 4px 24px rgba(0,0,0,0.6)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#202020"; (e.currentTarget as HTMLElement).style.color = "#ccc"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "#161616"; (e.currentTarget as HTMLElement).style.color = "#777"; }}>
            <PlusIcon size={11} /> Add beat
          </button>
        </div>
      )}
      {dropActive && !dropTargetId && (
        <div data-testid="catalog-drop-overlay" aria-hidden style={{ position: "fixed", left: "50%", bottom: currentBeat ? 86 : 24, transform: "translateX(-50%)", zIndex: 10000, pointerEvents: "none", width: "min(620px, calc(100vw - 48px))" }}>
          <div style={{ padding: "13px 18px", borderRadius: 12, border: "2px dashed #f5a623", background: "rgba(17,17,17,0.94)", textAlign: "center", boxShadow: "0 10px 32px rgba(0,0,0,0.42)" }}>
            <div style={{ fontSize: 13, color: "#eee", fontWeight: 600 }}>Suelta aquí para agregar como beat aparte</div>
            <div style={{ fontSize: 10, color: "#777", marginTop: 4, lineHeight: 1.45 }}>O arrástralo encima de un beat para agregarlo a ese beat.</div>
          </div>
        </div>
      )}
      {scope.downloads.cloudFiles && (
        <CloudFilesModal beat={scope.downloads.cloudFiles.beat}
          files={scope.downloads.cloudFiles.files.map((f) => ({ cloud_file_id: f.fileId, beat_id: scope.downloads.cloudFiles!.beat.id, file_type: f.role as never, filename: f.filename ?? "", original_size: Number(f.sizeBytes), part_count: f.partCount, status: f.status }))}
          busyId={scope.downloads.busyId} downloadedIds={scope.downloads.downloaded} onDownload={scope.downloads.download} onClose={scope.downloads.close} />
      )}
      {scope.imports.showAdd && <AddBeatModal key={droppedFile ? "drop" : "pick"} initialFile={droppedFile ?? undefined} onClose={closeAdd} onAdd={scope.imports.addBeatsAndReview} existingBeats={[]} />}
      {scope.imports.review && !drawer && (
        <Drawer beat={scope.imports.review.beat} mode="edit" tagSuggestions={scope.filters.tagSuggestions} reviewInfo={{ current: 1, total: 1 }} closeAfterSave={false}
          onClose={scope.imports.cancelReview} onSkipCurrent={scope.imports.cancelReview} onSkipAll={scope.imports.cancelReview} isReviewNameTaken={() => false}
          mutationAllowed={scope.connectionState === "online"} maxNameChars={BEAT_NAME_MAX} onWebSave={scope.editor.saveWebDrawer} onReleaseAudio={() => {}} />
      )}
      {scope.settings.showSettings && (
        <SettingsPanel currentFolder={null} showIncompleteWarnings={incompleteWarnings} onIncompleteWarningsChanged={setIncompleteWarnings} customCursorEnabled onCustomCursorChanged={() => {}}
          telegramConnected={false} networkOnline={scope.connectionState === "online"} telegramUsername={null} onDisconnectTelegram={scope.settings.handleDisconnectTelegramAccount}
          onClose={() => scope.settings.setShowSettings(false)} onFolderChanged={() => {}} hideCustomCursor trashSource={trashSource} localCaches={services.localCaches} onBeatRestored={() => { void scope.reloadLibrary(); }} />
      )}
      {drawer && (
        <Drawer beat={drawer.beat} mode={drawer.mode} tagSuggestions={scope.filters.tagSuggestions} onClose={() => { setDrawer(null); }}
          onReleaseAudio={() => { if (audio.playingId === drawer.beat.id) scope.transport.releaseFile(); }}
          selectedBeats={scope.selection.selectedCount > 1 ? scope.selection.selectedBeats : undefined}
          selectedCount={scope.selection.selectedCount > 1 ? scope.selection.selectedCount : undefined}
          mutationAllowed={scope.connectionState === "online"} onWebSave={scope.editor.saveWebDrawer} />
      )}
      {currentBeat && (
        <Player beat={currentBeat} playing={audio.isPlaying} progress={audio.progress} duration={audio.duration} volume={audio.volume} queue={scope.queue.queuedBeats} currentIndex={-1}
          showQueue={scope.queue.showQueue} shuffleEnabled={scope.transport.shuffleEnabled} repeatMode={scope.transport.repeatMode} canShowQueue={scope.queue.queuedBeats.length > 0}
          onToggle={scope.transport.togglePause} onSeek={scope.transport.seek} onPrev={scope.transport.handlePrev} onNext={scope.transport.handleNext} onVolumeChange={scope.transport.setVolume}
          onToggleShuffle={scope.transport.toggleShuffle} onCycleRepeat={scope.transport.cycleRepeat} onToggleQueue={scope.queue.toggleQueue} onPlayQueueIndex={scope.queue.playQueueIndex}
          canAddBeat={platform.capabilities.browserFileImport || platform.capabilities.nativeFilesystemDrop} onAddBeat={openAdd}
          onDetail={(b) => setDrawer({ beat: b, mode: "detail" })} onEdit={(b) => { if (!scope.rejectOfflineMutation("Editing metadata")) setDrawer({ beat: b, mode: "edit" }); }}
          onDelete={scope.editor.deleteBeat} onAddToQueue={scope.transport.addToQueue} />
      )}
      <FloatingNotice notice={notice} onDismiss={scope.dismissNotice} lifted={Boolean(currentBeat)} />
      <BeatTagPeekLayer peek={tagPeek.peek} />
    </div>
  );
}
export default CatalogAppShell;
