import { useEffect, useMemo, useState } from "react";
import StudioToolbar from "../MASTER/StudioToolbarCandidate";
import TagNavigation from "./TagNavigation";
import { clearUploadPreviewCache } from "../../library/libraryPresentationCache";
import "../shared/tokens.css";
import "./gallery.css";
import "./product-gallery.css";

export default function GalleryChrome({scope}: {scope: Record<string, any>}) {
  const [open, setOpen] = useState(() => window.matchMedia("(hover: none), (pointer: coarse)").matches);
  const [hintSeen, setHintSeen] = useState(() => { try { return sessionStorage.getItem("beatgaler:tags-hint-seen") === "yes"; } catch { return false; } });
  const { includedTags, excludedTags, allTags, tagColors, handleTagClick, clearTagFilters, openTagRename } = scope;
  const active = includedTags.size > 0 || excludedTags.size > 0;
  const visible = open || active;
  const filters = useMemo(() => Object.fromEntries([
    ...Array.from(includedTags as Set<string>, name => [name, "include"]),
    ...Array.from(excludedTags as Set<string>, name => [name, "exclude"]),
  ]) as Record<string, "include" | "exclude">, [includedTags, excludedTags]);
  useEffect(() => {
    if (!visible) return;
    setHintSeen(true);
    try { sessionStorage.setItem("beatgaler:tags-hint-seen", "yes"); } catch { /* optional */ }
  }, [visible]);
  return <div className="bg-gallery-chrome lab-gallery-page" data-tags-open={visible ? "true" : "false"}>
    <div className="lab-gallery-top-stack" data-tags-open={visible ? "true" : "false"} data-tag-variant="full-black">
      <TagNavigation visible={visible} hasActiveFilters={active} onVisibilityChange={setOpen}
        tags={allTags} filters={filters} onCycleTag={(tag, altKey) => handleTagClick(tag, {altKey})}
        onClear={clearTagFilters} tagColors={tagColors} onRename={openTagRename} />
    </div>
    <div className="lab-gallery-tag-shadow" aria-hidden="true" />
    <div className="lab-gallery-toolbar-float">
      <StudioToolbar gallery galleryTagsOpen={visible} search={scope.search} onSearchChange={scope.setSearch}
        sort={scope.sortBy} onSortChange={scope.setSortBy} selecting={scope.selectMode}
        onToggleSelect={() => scope.selectMode ? scope.finishSelection() : scope.toggleSelection(null, false, scope.displayedBeats)}
        onAddBeat={() => { if (!scope.rejectOfflineMutation("Adding a beat")) scope.setShowAdd(true); }}
        onReload={() => { clearUploadPreviewCache(); void scope.reloadLibrary(); }} reloading={scope.loading || scope.libraryRefreshing}
        onProfileAction={action => action === "settings" ? scope.setShowSettings(true) : void scope.handleDisconnectTelegramAccount()} />
    </div>
    {!hintSeen && <div className="lab-gallery-tag-cue" aria-hidden="true">Tags ↑</div>}
  </div>;
}
