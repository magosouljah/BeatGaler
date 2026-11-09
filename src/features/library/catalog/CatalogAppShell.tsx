// T16 / V08-A — Shell POSTGRES: la misma composición visible que el AppShell web aprobado (GalleryChrome, barra de selección,
// `lab-gallery-main` como único scroller, BeatCard, botón «Add beat», Drawer, Player, menús de tags y TagPeek) con las filas
// virtualizadas de V05 en lugar del grid plano. Ningún nodo nuevo visible: las clases y el orden de los bloques son los del AppShell;
// el track virtual sustituye a `.lab-gallery-grid` usando las mismas variables de columnas/gaps de gallery.css.
import { useEffect, useRef } from "react";
import GalleryChrome from "../../design/GALLERY/GalleryChrome";
import { dismissBeatGalerStartupLoader } from "../../startup/startupLoader";
import { BeatTagPeekLayer, useBeatTagPeek } from "../../design/shared/BeatTagPeek";
import AddBeatModal from "../../../components/AddBeatModal";
import BeatCard from "../../../components/BeatCard";
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
  const [tagColorMenu, setTagColorMenu] = useState<{ tag: string; x: number; y: number } | null>(null);
  const { snapshot, interaction, playback, audio, currentBeat, selectMode, selectedCount, drawer, setDrawer, notice } = scope;
  const tenantKey = `${accountId}:${context.authority_era}:${context.authority_epoch}`;
  // V09 hallazgo: el overlay de arranque (#beatgaler-startup-loader) solo lo retiraba el pipeline LEGACY; en POSTGRES bloqueaba los clics.
  useEffect(() => { dismissBeatGalerStartupLoader(); }, []);
  const openAdd = () => { if (!scope.rejectOfflineMutation("Adding a beat")) scope.setShowAdd(true); };
  // Scope para GalleryChrome (misma forma que el legacy; `displayedBeats` no existe en POSTGRES: la selección es global en el servidor).
  const chromeScope = {
    includedTags: scope.includedTags, excludedTags: scope.excludedTags, allTags: scope.allTags, tagColors: scope.tagColors, handleTagClick: scope.handleTagClick, clearTagFilters: scope.clearTagFilters, openTagRename: scope.openTagRename,
    search: scope.search, setSearch: scope.setSearch, sortBy: scope.sortBy, setSortBy: scope.setSortBy, selectMode, displayedBeats: [] as Beat[],
    finishSelection: scope.finishSelection, toggleSelection: (b: Beat | null) => scope.toggleSelection(b, false),
    rejectOfflineMutation: scope.rejectOfflineMutation, setShowAdd: scope.setShowAdd, reloadLibrary: scope.reloadLibrary, loading: scope.loading, libraryRefreshing: false,
    setShowSettings: scope.setShowSettings, handleDisconnectTelegramAccount: scope.handleDisconnectTelegramAccount,
  };
  const renderCard = (item: CatalogBeatDto, ordinal: number) => {
    scope.noteOrdinal(item.id, ordinal);
    const beat = scope.toBeat(item);
    return (
      <BeatCard
        beat={beat} visible interactive playbackInteractive={Boolean(item.playback)} openableProject={false} tagFrequency={scope.tagFrequency} showIncompleteWarnings={false}
        playing={audio.playingId === beat.id && audio.isPlaying} selected={scope.isSelected(beat.id)} selectedCount={selectedCount} selectMode={selectMode}
        dragEnabled={false} networkOnline={scope.connectionState === "online"} offlineBusy={false} canUseOfflinePackage={false} canUseLocalHelper={false} canInspectNativeProject={false}
        onToggleOffline={() => {}} onRetryUpload={() => {}} onBulkEdit={scope.handleEditBulk} onBulkUpload={() => {}} onBulkDelete={scope.handleRemoveBulk}
        onPlay={scope.handlePlay} onWarm={scope.handleWarm}
        onDetail={(b) => setDrawer({ beat: b, mode: "detail" })} onEdit={(b) => { if (!scope.rejectOfflineMutation("Editing metadata")) setDrawer({ beat: b, mode: "edit" }); }}
        onDelete={scope.deleteBeat} onAddToQueue={scope.addToQueue}
        onUpload={() => {}} onUploadTelegram={() => {}} onDownloadTelegram={() => {}} onUploadProjectTelegram={() => {}} onOpenProject={() => {}} onUpdateProject={() => {}} onCloudFiles={() => {}}
        onToggleSelect={(b, e) => scope.toggleSelection(b, e.shiftKey)} animDelay={0}
      />
    );
  };
  return (
    <div className="bg-design lab-gallery-page bg-product-gallery" data-catalog-mode="postgres" data-account={accountId}
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
          <button type="button" onClick={scope.toggleSelectAll}>Select All</button>
          <button onClick={scope.handleEditBulk} disabled={selectedCount === 0 || interaction.selection.status !== "active"} style={{ padding: "5px 14px", background: "#1e1e1e", border: "1px solid #2a2a2a", borderRadius: 6, color: "#ccc", fontSize: 12, cursor: "pointer" }}>Edit all</button>
          <button onClick={scope.handleRemoveBulk} disabled={selectedCount === 0 || interaction.selection.status !== "active"} style={{ padding: "5px 14px", background: "transparent", border: "1px solid #3d0000", borderRadius: 6, color: "#f87171", fontSize: 12, cursor: "pointer" }}>Remove all</button>
          <button onClick={scope.finishSelection} style={{ marginLeft: "auto", background: "none", border: "none", color: "#444", fontSize: 12, cursor: "pointer" }}>Cancel</button>
        </div>
      )}
      {tagColorMenu && (
        <TagColorMenu x={tagColorMenu.x} y={tagColorMenu.y} current={scope.tagColors[tagColorMenu.tag.trim().toLowerCase()] ?? null}
          onSelect={(hex) => { setTagColor(tagColorMenu.tag, hex); setTagColorMenu(null); }} onRename={() => { scope.openTagRename(tagColorMenu.tag); setTagColorMenu(null); }} onClose={() => setTagColorMenu(null)} />
      )}
      {scope.tagRename && (
        <TagRenameDialog rename={scope.tagRename} busy={scope.tagRenameBusy} error={scope.tagRenameError} affectedCount={scope.tagRenameAffectedCount} mp3Count={0} wavCount={0}
          onNewTagChange={scope.setTagRenameNewTag} onContinue={scope.continueTagRename} onBack={scope.backTagRename} onCancel={scope.cancelTagRename} onConfirm={scope.confirmTagRename} />
      )}
      <div ref={scrollerRef} className="lab-gallery-main" data-library-scroll="true" aria-busy={scope.loading}
        style={{ flex: 1, position: "relative", overflowY: "auto", paddingBottom: currentBeat ? 140 : 90 }}>
        <div className="bg-catalog-shell-status" role="status" aria-live="polite" data-selection-count={selectedCount} data-selection-status={interaction.selection.status} data-playback-status={playback.status} data-store-status={snapshot.status}>
          {notice ? <p className="bg-catalog-notice">{notice}<button type="button" className="bg-button bg-button--ghost" aria-label="Cerrar aviso" onClick={scope.dismissNotice}>×</button></p> : null}
        </div>
        <div className="bg-catalog-grid-host" onPointerOver={tagPeek.onPointerOver} onPointerOut={tagPeek.onPointerOut} onPointerDown={tagPeek.onPointerDown} onFocusCapture={tagPeek.onFocusCapture} onBlurCapture={tagPeek.onBlurCapture}>
          <CatalogVirtualGallery store={services.store} scrollerRef={scrollerRef} tenantKey={tenantKey} renderCard={renderCard} viewportHeightFallback={viewportHeightFallback}
            onMountCard={scope.onMountCard} onUnmountCard={scope.onUnmountCard}
            cardAttributes={(item, ordinal) => ({ "data-card": item.id, "data-ordinal": String(ordinal), "data-selected": scope.isSelected(item.id) ? "true" : "false", "data-playing": playback.current?.beatId === item.id ? "true" : "false" })}
            onGoToStart={() => { void services.store.loadFirst(); }} />
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
      {scope.showAdd && <AddBeatModal onClose={() => scope.setShowAdd(false)} onAdd={scope.addBeatsAndReview} existingBeats={[]} />}
      {scope.showSettings && (
        <SettingsPanel currentFolder={null} showIncompleteWarnings={false} onIncompleteWarningsChanged={() => {}} customCursorEnabled onCustomCursorChanged={() => {}}
          telegramConnected={false} networkOnline={scope.connectionState === "online"} telegramUsername={null} onDisconnectTelegram={scope.handleDisconnectTelegramAccount}
          onClose={() => scope.setShowSettings(false)} onFolderChanged={() => {}} />
      )}
      {drawer && (
        <Drawer beat={drawer.beat} mode={drawer.mode} tagSuggestions={scope.tagSuggestions} onClose={() => { setDrawer(null); }} onSaved={scope.updateBeat}
          onReleaseAudio={() => { if (audio.playingId === drawer.beat.id) scope.releaseFile(); }}
          selectedBeats={scope.selectedBeats.length > 1 ? scope.selectedBeats : undefined} onBulkSaved={scope.applyBulkUpdate}
          mutationAllowed={scope.connectionState === "online"} onCloudMutationCommit={scope.commitDrawerCloudMutation} />
      )}
      {currentBeat && (
        <Player beat={currentBeat} playing={audio.isPlaying} progress={audio.progress} duration={audio.duration} volume={audio.volume} queue={scope.queuedBeats} currentIndex={-1}
          showQueue={scope.showQueue} shuffleEnabled={scope.shuffleEnabled} repeatMode={scope.repeatMode} canShowQueue={scope.queuedBeats.length > 0}
          onToggle={scope.togglePause} onSeek={scope.seek} onPrev={scope.handlePrev} onNext={scope.handleNext} onVolumeChange={scope.setVolume}
          onToggleShuffle={scope.toggleShuffle} onCycleRepeat={scope.cycleRepeat} onToggleQueue={scope.toggleQueue} onPlayQueueIndex={scope.playQueueIndex}
          canAddBeat={platform.capabilities.browserFileImport || platform.capabilities.nativeFilesystemDrop} onAddBeat={openAdd}
          onDetail={(b) => setDrawer({ beat: b, mode: "detail" })} onEdit={(b) => { if (!scope.rejectOfflineMutation("Editing metadata")) setDrawer({ beat: b, mode: "edit" }); }}
          onDelete={scope.deleteBeat} onAddToQueue={scope.addToQueue} />
      )}
      <BeatTagPeekLayer peek={tagPeek.peek} />
    </div>
  );
}
export default CatalogAppShell;
