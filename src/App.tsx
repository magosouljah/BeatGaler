import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { Beat, AppSettings } from "./types";
import BeatCard from "./components/BeatCard";
import Drawer from "./components/Drawer";
import Player from "./components/Player";
import AddBeatModal from "./components/AddBeatModal";
import SetupModal from "./components/SetupModal";
import SettingsPanel from "./components/SettingsPanel";
import { SearchIcon, PlusIcon, Artwork } from "./components/ui";
import { useAudio } from "./hooks/useAudio";
import { loadLibrary, removeBeatFromLibrary, reorderBeats, readBeatMeta, getSettings } from "./lib/tauri";
import { listen } from "@tauri-apps/api/event";
import { DndContext, DragEndEvent, DragOverlay, DragStartEvent, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy } from "@dnd-kit/sortable";

type SortKey = "name" | "bpm" | "rating" | "manual";

function SearchBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const hasText = value.trim().length > 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {open && (
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <input autoFocus value={value} onChange={e => onChange(e.target.value)}
            onBlur={() => { if (!hasText) setOpen(false); }}
            placeholder="Search beats…"
            style={{ background: "#181818", border: "1px solid #252525", borderRadius: 8, padding: "6px 32px 6px 12px", color: "#fff", fontSize: 13, width: 220, outline: "none" }} />
          {hasText && (
            <button
              onMouseDown={e => { e.preventDefault(); onChange(""); }}
              style={{ position: "absolute", right: 6, background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "2px 4px", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center" }}
              onMouseEnter={e => (e.currentTarget.style.color = "#aaa")}
              onMouseLeave={e => (e.currentTarget.style.color = "#555")}
            >✕</button>
          )}
        </div>
      )}
      <button onClick={() => setOpen(o => !o)}
        style={{ width: 32, height: 32, borderRadius: 8, background: "transparent", border: "none", color: open ? "#ccc" : "#444", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <SearchIcon />
      </button>
    </div>
  );
}

function SortMenu({ value, onChange }: { value: SortKey; onChange: (v: SortKey) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const options: { key: SortKey; label: string }[] = [
    { key: "name", label: "Name" },
    { key: "bpm", label: "BPM" },
    { key: "rating", label: "Rating" },
    { key: "manual", label: "Manual" },
  ];

  const activeLabel = options.find(o => o.key === value)?.label ?? "Sort";

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(v => !v);
        }}
        style={{
          minWidth: 0,
          height: 32,
          padding: "0 18px 0 10px",
          borderRadius: 8,
          background: open ? "#222" : "#161616",
          border: `1px solid ${open ? "#323232" : "#1e1e1e"}`,
          color: open ? "#d2d2d2" : "#8a8a8a",
          fontSize: 11,
          cursor: "pointer",
          outline: "none",
          display: "flex",
          position: "relative",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span>{activeLabel}</span>
        <span style={{ fontSize: 9, opacity: 0.75, position: "absolute", right: 6 }}>▼</span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: 36,
            right: 0,
            zIndex: 120,
            width: "fit-content",
            minWidth: 0,
            background: "rgba(24,24,24,0.96)",
            backdropFilter: "blur(12px)",
            border: "1px solid #2a2a2a",
            borderRadius: 10,
            padding: "4px 0",
            boxShadow: "0 12px 30px rgba(0,0,0,0.6)",
          }}
        >
          {options.map((opt) => {
            const active = opt.key === value;
            return (
              <button
                key={opt.key}
                onClick={() => {
                  onChange(opt.key);
                  setOpen(false);
                }}
                style={{
                  width: "auto",
                  border: "none",
                  background: "transparent",
                  color: active ? "#f1f1f1" : "#bebebe",
                  cursor: "pointer",
                  textAlign: "center",
                  padding: "7px 8px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  whiteSpace: "nowrap",
                }}
              >
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [beats, setBeats] = useState<Beat[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>("name");
  const [drawer, setDrawer] = useState<{ beat: Beat; mode: "detail" | "edit" } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [setupDone, setSetupDone] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [lastSelectedIdx, setLastSelectedIdx] = useState<number | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [repeatMode, setRepeatMode] = useState<"off" | "all" | "one">("off");
  const [showQueue, setShowQueue] = useState(false);
  const [queueIds, setQueueIds] = useState<string[]>([]);
  const lastHandledEndedSeqRef = useRef(0);

  const { state: audio, play, togglePause, seek, setVolume, releaseFile } = useAudio();

  // Keep a ref to togglePause so the keydown handler never goes stale
  const togglePauseRef = useRef(togglePause);
  useEffect(() => { togglePauseRef.current = togglePause; }, [togglePause]);

  useEffect(() => {
    getSettings().then(s => {
      setSettings(s);
      if (s.beats_folder) setSetupDone(true);
    }).catch(() => setSetupDone(true)); // on error, skip setup
  }, []);

  useEffect(() => {
    if (!setupDone && settings !== null && !settings.beats_folder) return; // wait for setup
    loadLibrary().then(setBeats).catch(console.error).finally(() => setLoading(false));
  }, [setupDone]);

  // Tauri native file drag-drop
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ paths: string[] }>("tauri://drag-drop", async (event) => {
      const paths: string[] = event.payload?.paths ?? [];
      for (const filePath of paths) {
        const lower = filePath.toLowerCase();
        if (!lower.endsWith(".mp3") && !lower.endsWith(".wav")) continue;
        try {
          const beat = await readBeatMeta(filePath);
          setBeats(bs => {
            const existing = new Set(bs.map(b => b.folder_path));
            if (existing.has(beat.folder_path)) return bs;
            return [beat, ...bs];
          });
        } catch (err) { console.error("Drop import failed:", err); }
      }
    }).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, []);

  // Global keyboard shortcuts — stable handler via ref
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const isTyping = tag === "INPUT" || tag === "TEXTAREA";
      if (e.key === "Escape") {
        setSelectedIds(new Set());
        setSelectMode(false);
        setDrawer(null);
        setShowAdd(false);
        setShowSettings(false);
        setShowQueue(false);
      }
      if (e.key === " " && !isTyping) { e.preventDefault(); togglePauseRef.current(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []); // empty deps — safe because we use ref

  const handlePlay = useCallback((beat: Beat) => { play(beat.id, beat.playback_path || beat.mp3_path); }, [play]);

  const addToQueue = useCallback((beat: Beat) => {
    setQueueIds((ids) => (ids.includes(beat.id) ? ids : [...ids, beat.id]));
  }, []);

  const addBeats = useCallback((newBeats: Beat[]) => {
    setBeats(bs => {
      const existing = new Set(bs.map(b => b.mp3_path));
      return [...newBeats.filter(b => !existing.has(b.mp3_path)), ...bs];
    });
  }, []);

  const updateBeat = useCallback((updated: Beat) => {
    setBeats(bs => bs.map(b => b.id === updated.id ? updated : b));
    if (drawer?.beat.id === updated.id) setDrawer(d => d ? { ...d, beat: updated } : null);
  }, [drawer]);

  const reloadLibrary = useCallback(async () => {
    setLoading(true);
    try {
      const loaded = await loadLibrary();
      setBeats(loaded);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  const applyBulkUpdate = useCallback((updates: Partial<Beat>, options?: { tagsMode?: "add" | "replace" }) => {
    setBeats(bs => bs.map(b => {
      if (!selectedIds.has(b.id)) return b;
      if (!updates.tags) return { ...b, ...updates };
      if (options?.tagsMode === "replace") {
        const replacedTags = Array.from(new Set(updates.tags.map(t => t.trim().toLowerCase()).filter(Boolean)));
        return { ...b, ...updates, tags: replacedTags };
      }
      const mergedTags = Array.from(new Set([...b.tags, ...updates.tags].map(t => t.trim().toLowerCase()).filter(Boolean)));
      return { ...b, ...updates, tags: mergedTags };
    }));
    setSelectedIds(new Set());
    setSelectMode(false);
  }, [selectedIds]);

  const deleteBeat = useCallback(async (beat: Beat) => {
    if (!confirm(`¿Seguro que quieres eliminar "${beat.name}"?\n\nEsto borrará el beat y sus archivos del disco de forma permanente.`)) return;
    if (audio.playingId === beat.id) releaseFile();
    try {
      await removeBeatFromLibrary(beat.id);
      setBeats(bs => bs.filter(b => b.id !== beat.id));
      setQueueIds(ids => ids.filter(id => id !== beat.id));
    } catch (err) {
      console.error(err);
      alert("No se pudo eliminar el beat del disco.");
    }
  }, [audio.playingId, releaseFile]);

  const handleToggleSelect = useCallback((beat: Beat, e: React.MouseEvent, currentFiltered: Beat[]) => {
    const idx = currentFiltered.findIndex(b => b.id === beat.id);
    if (e.shiftKey && lastSelectedIdx !== null) {
      const lo = Math.min(idx, lastSelectedIdx);
      const hi = Math.max(idx, lastSelectedIdx);
      setSelectedIds(s => {
        const n = new Set(s);
        currentFiltered.slice(lo, hi + 1).forEach(b => n.add(b.id));
        return n;
      });
    } else {
      setSelectedIds(s => { const n = new Set(s); n.has(beat.id) ? n.delete(beat.id) : n.add(beat.id); return n; });
      setLastSelectedIdx(idx);
    }
    if (!selectMode) setSelectMode(true);
  }, [lastSelectedIdx, selectMode]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { delay: 140, tolerance: 6 },
    })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = String(event.active.id);
    setActiveDragId(id);
    if (sortBy !== "rating") setSortBy("manual");
  }, [sortBy]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    setActiveDragId(null);
    if (!overId || activeId === overId) return;

    setBeats((current) => {
      const oldIndex = current.findIndex((b) => b.id === activeId);
      const newIndex = current.findIndex((b) => b.id === overId);
      if (oldIndex === -1 || newIndex === -1) return current;

      if (sortBy === "rating") {
        const moved = current[oldIndex];
        const target = current[newIndex];
        if (moved.rating !== target.rating) return current;
      }

      const next = arrayMove(current, oldIndex, newIndex);
      reorderBeats(next.map((b) => b.id)).catch(console.error);
      return next;
    });
  }, [sortBy]);

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
  }, []);

  const allTags = [...new Set(beats.flatMap(b => b.tags))].sort();

  const tagSuggestions = useMemo(() => {
    const freq = new Map<string, number>();
    for (const beat of beats) {
      for (const tag of beat.tags) {
        const normalized = tag.trim().toLowerCase();
        if (!normalized) continue;
        freq.set(normalized, (freq.get(normalized) ?? 0) + 1);
      }
    }
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag]) => tag);
  }, [beats]);

  const manualOrderIndex = useMemo(() => {
    const index = new Map<string, number>();
    beats.forEach((b, i) => index.set(b.id, i));
    return index;
  }, [beats]);

  const filteredBeats = beats
    .filter(b => {
      const q = search.trim().toLowerCase();
      return (!q || b.name.toLowerCase().includes(q) || b.tags.some(t => t.includes(q)) || b.key.toLowerCase().includes(q) || String(b.bpm).includes(q))
        && (!filterTag || b.tags.includes(filterTag));
    })
    .sort((a, b) => {
      if (sortBy === "manual") return 0;
      if (sortBy === "bpm") return Number(a.bpm || 0) - Number(b.bpm || 0);
      if (sortBy === "rating") {
        const ratingDiff = b.rating - a.rating;
        if (ratingDiff !== 0) return ratingDiff;
        return (manualOrderIndex.get(a.id) ?? 0) - (manualOrderIndex.get(b.id) ?? 0);
      }
      return a.name.localeCompare(b.name);
    });

  const playbackQueue = useMemo(() => {
    if (!audio.playingId) return filteredBeats;
    if (filteredBeats.some((b) => b.id === audio.playingId)) return filteredBeats;
    return beats;
  }, [audio.playingId, filteredBeats, beats]);

  const currentQueueIndex = useMemo(
    () => playbackQueue.findIndex((b) => b.id === audio.playingId),
    [playbackQueue, audio.playingId]
  );

  const playFromQueueIndex = useCallback((index: number) => {
    if (index < 0 || index >= playbackQueue.length) return;
    const target = playbackQueue[index];
    if (target) handlePlay(target);
  }, [playbackQueue, handlePlay]);

  const handleNext = useCallback((fromEnded = false) => {
    if (queueIds.length > 0) {
      const nextId = queueIds[0];
      const nextBeat = beats.find((b) => b.id === nextId);
      setQueueIds((ids) => ids.slice(1));
      if (nextBeat) {
        handlePlay(nextBeat);
        return;
      }
    }

    if (playbackQueue.length === 0) return;
    if (currentQueueIndex === -1) {
      playFromQueueIndex(0);
      return;
    }

    if (fromEnded && repeatMode === "one") {
      playFromQueueIndex(currentQueueIndex);
      return;
    }

    if (shuffleEnabled) {
      if (playbackQueue.length === 1) {
        if (!fromEnded || repeatMode !== "off") playFromQueueIndex(0);
        return;
      }
      let nextIndex = currentQueueIndex;
      while (nextIndex === currentQueueIndex) {
        nextIndex = Math.floor(Math.random() * playbackQueue.length);
      }
      playFromQueueIndex(nextIndex);
      return;
    }

    let nextIndex = currentQueueIndex + 1;
    if (nextIndex >= playbackQueue.length) {
      if (fromEnded && repeatMode === "off") return;
      nextIndex = 0;
    }
    playFromQueueIndex(nextIndex);
  }, [queueIds, beats, handlePlay, playbackQueue, currentQueueIndex, repeatMode, shuffleEnabled, playFromQueueIndex]);

  const handlePrev = useCallback(() => {
    if (playbackQueue.length === 0) return;
    if (audio.progress > 0.05) {
      seek(0);
      return;
    }
    if (shuffleEnabled && playbackQueue.length > 1) {
      let prevIndex = currentQueueIndex;
      while (prevIndex === currentQueueIndex) {
        prevIndex = Math.floor(Math.random() * playbackQueue.length);
      }
      playFromQueueIndex(prevIndex);
      return;
    }
    if (currentQueueIndex <= 0) {
      playFromQueueIndex(playbackQueue.length - 1);
      return;
    }
    playFromQueueIndex(currentQueueIndex - 1);
  }, [playbackQueue, audio.progress, seek, shuffleEnabled, currentQueueIndex, playFromQueueIndex]);

  useEffect(() => {
    if (audio.endedSeq === 0) return;
    if (audio.endedSeq <= lastHandledEndedSeqRef.current) return;
    lastHandledEndedSeqRef.current = audio.endedSeq;
    handleNext(true);
  }, [audio.endedSeq, handleNext]);

  const queuedBeats = useMemo(() => {
    const map = new Map(beats.map((b) => [b.id, b] as const));
    return queueIds.map((id) => map.get(id)).filter(Boolean) as Beat[];
  }, [queueIds, beats]);

  const currentBeat = beats.find(b => b.id === audio.playingId);
  const selectedBeats = beats.filter(b => selectedIds.has(b.id));
  const activeDragBeat = activeDragId ? beats.find(b => b.id === activeDragId) ?? null : null;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#0c0c0c", overflow: "hidden" }}>
      {/* Top bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 24px", height: 50, flexShrink: 0, borderBottom: "1px solid #111" }}>
        <span style={{ fontWeight: 400, fontSize: 14, color: "#aaa", letterSpacing: 0.3 }}>beatvault</span>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <SearchBar value={search} onChange={setSearch} />
          <SortMenu value={sortBy} onChange={setSortBy} />
          {/* Settings gear */}
          <button
            onClick={() => setShowSettings(true)}
            title="Settings"
            style={{ width: 32, height: 32, borderRadius: 8, background: "transparent", border: "none", color: "#444", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}
            onMouseEnter={e => (e.currentTarget.style.color = "#aaa")}
            onMouseLeave={e => (e.currentTarget.style.color = "#444")}
          >⚙</button>
          <button
            onClick={reloadLibrary}
            title="Reload Library"
            disabled={loading}
            style={{ width: 32, height: 32, borderRadius: 8, background: "transparent", border: "none", color: loading ? "#2a2a2a" : "#444", cursor: loading ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}
            onMouseEnter={e => { if (!loading) e.currentTarget.style.color = "#aaa"; }}
            onMouseLeave={e => { e.currentTarget.style.color = loading ? "#2a2a2a" : "#444"; }}
          >↻</button>
          {/* Apple-style Select / Select All / Done */}
          {selectMode ? (
            <>
              <button
                onClick={() => {
                  const allSelected = filteredBeats.every(b => selectedIds.has(b.id));
                  setSelectedIds(allSelected ? new Set() : new Set(filteredBeats.map(b => b.id)));
                }}
                style={{ padding: "5px 12px", borderRadius: 7, background: "transparent", border: "1px solid #2a2a2a", color: "#888", fontSize: 12, cursor: "pointer" }}>
                {filteredBeats.every(b => selectedIds.has(b.id)) ? "Deselect All" : "Select All"}
              </button>
              <button
                onClick={() => { setSelectMode(false); setSelectedIds(new Set()); }}
                style={{ padding: "5px 12px", borderRadius: 7, background: "transparent", border: "1px solid #2a2a2a", color: "#ccc", fontSize: 12, cursor: "pointer", fontWeight: 500 }}>
                Done
              </button>
            </>
          ) : (
            <button
              onClick={() => setSelectMode(true)}
              style={{ padding: "5px 12px", borderRadius: 7, background: "transparent", border: "1px solid #1e1e1e", color: "#555", fontSize: 12, cursor: "pointer" }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#aaa"; (e.currentTarget as HTMLElement).style.borderColor = "#2a2a2a"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "#555"; (e.currentTarget as HTMLElement).style.borderColor = "#1e1e1e"; }}>
              Select
            </button>
          )}
        </div>
      </div>

      {/* Selection toolbar */}
      {selectedIds.size > 0 && (
        <div style={{ padding: "0 24px", height: 40, display: "flex", alignItems: "center", gap: 12, background: "#111", borderBottom: "1px solid #1a1a1a", flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: "#888" }}>{selectedIds.size} selected</span>
          <button onClick={() => setDrawer({ beat: selectedBeats[0], mode: "edit" })}
            style={{ padding: "5px 14px", background: "#1e1e1e", border: "1px solid #2a2a2a", borderRadius: 6, color: "#ccc", fontSize: 12, cursor: "pointer" }}>
            Edit all
          </button>
          <button onClick={async () => {
            if (!confirm(`¿Seguro que quieres eliminar ${selectedIds.size} beats?\n\nEsto borrará los beats seleccionados y sus archivos del disco de forma permanente.`)) return;
            const deleted = new Set<string>();
            for (const id of selectedIds) {
              try {
                await removeBeatFromLibrary(id);
                deleted.add(id);
              } catch (err) {
                console.error(err);
              }
            }
            if (deleted.size > 0) {
              setBeats(bs => bs.filter(b => !deleted.has(b.id)));
            }
            if (deleted.size !== selectedIds.size) {
              alert("Algunos beats no se pudieron eliminar del disco.");
            }
            setSelectedIds(new Set()); setSelectMode(false);
          }}
            style={{ padding: "5px 14px", background: "transparent", border: "1px solid #3d0000", borderRadius: 6, color: "#f87171", fontSize: 12, cursor: "pointer" }}>
            Remove all
          </button>
          <button onClick={() => { setSelectedIds(new Set()); setSelectMode(false); }}
            style={{ marginLeft: "auto", background: "none", border: "none", color: "#444", fontSize: 12, cursor: "pointer" }}>
            Cancel
          </button>
        </div>
      )}

      {/* Tag filter */}
      <div style={{ padding: "7px 24px", display: "flex", gap: 6, flexWrap: "wrap", borderBottom: "1px solid #111", flexShrink: 0 }}>
        <button onClick={() => setFilterTag(null)} style={{ padding: "4px 12px", borderRadius: 20, background: !filterTag ? "#e5e5e5" : "transparent", border: `1px solid ${!filterTag ? "#e5e5e5" : "#1e1e1e"}`, color: !filterTag ? "#000" : "#444", fontSize: 12, cursor: "pointer" }}>All</button>
        {allTags.map(t => (
          <button key={t} onClick={() => setFilterTag(filterTag === t ? null : t)}
            style={{ padding: "4px 12px", borderRadius: 20, background: filterTag === t ? "#1e1e1e" : "transparent", border: `1px solid ${filterTag === t ? "#333" : "#1e1e1e"}`, color: filterTag === t ? "#e0e0e0" : "#444", fontSize: 12, cursor: "pointer" }}>
            {t}
          </button>
        ))}
      </div>

      {/* Grid — OS file drag-drop */}
      <div
        style={{ flex: 1, overflowY: "auto", padding: "28px 24px", paddingBottom: currentBeat ? 90 : 28 }}

      >
        {loading ? (
          <div style={{ textAlign: "center", paddingTop: 80, color: "#333", fontSize: 13 }}>Loading library…</div>
        ) : filteredBeats.length === 0 ? (
          <div style={{ textAlign: "center", paddingTop: 80, color: "#252525", fontSize: 13 }}>
            {beats.length === 0 ? 'No beats yet — click "+ Add beat" to get started' : "No beats match your search"}
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <SortableContext items={filteredBeats.map((b) => b.id)} strategy={rectSortingStrategy}>
              <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
                <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "28px 22px", alignContent: "flex-start", maxWidth: 1300 }}>
                {filteredBeats.map((beat, i) => (
                  <BeatCard
                    key={beat.id}
                    beat={beat}
                    playing={audio.playingId === beat.id && audio.isPlaying}
                    selected={selectedIds.has(beat.id)}
                    selectMode={selectMode}
                    dragEnabled={!selectMode}
                    onPlay={handlePlay}
                    onDetail={b => setDrawer({ beat: b, mode: "detail" })}
                    onEdit={b => setDrawer({ beat: b, mode: "edit" })}
                    onDelete={deleteBeat}
                    onAddToQueue={addToQueue}
                    onToggleSelect={(b, e) => handleToggleSelect(b, e, filteredBeats)}
                    animDelay={i * 0.02}
                  />
                ))}
                </div>
              </div>
            </SortableContext>
            <DragOverlay>
              {activeDragBeat ? (
                <div style={{ width: 160, borderRadius: 12, transform: "scale(1.02)", boxShadow: "0 20px 40px rgba(0,0,0,0.6)" }}>
                  <Artwork beat={activeDragBeat} size={160} playing={false} />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      {/* + Add beat */}
      {!currentBeat && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 45 }}>
          <button onClick={() => setShowAdd(true)}
            style={{ padding: "9px 20px", borderRadius: 40, background: "#161616", border: "1px solid #242424", color: "#777", fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, boxShadow: "0 4px 24px rgba(0,0,0,0.6)" }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#202020"; (e.currentTarget as HTMLElement).style.color = "#ccc"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "#161616"; (e.currentTarget as HTMLElement).style.color = "#777"; }}>
            <PlusIcon size={11} /> Add beat
          </button>
        </div>
      )}

      {showAdd && <AddBeatModal onClose={() => setShowAdd(false)} onAdd={addBeats} existingBeats={beats} />}

      {!setupDone && settings !== null && !settings.beats_folder && (
        <SetupModal onDone={(folder, beats) => {
          setSettings(s => s ? { ...s, beats_folder: folder } : { beats_folder: folder });
          if (beats && beats.length > 0) {
            setBeats(beats);
          }
          setSetupDone(true);
        }} />
      )}

      {showSettings && (
        <SettingsPanel
          currentFolder={settings?.beats_folder ?? null}
          onClose={() => setShowSettings(false)}
          onFolderChanged={folder => setSettings(s => s ? { ...s, beats_folder: folder } : { beats_folder: folder })}
        />
      )}

      {drawer && (
        <Drawer
          beat={drawer.beat}
          mode={drawer.mode}
          tagSuggestions={tagSuggestions}
          onClose={() => { setDrawer(null); setSelectedIds(new Set()); setSelectMode(false); }}
          onSaved={updateBeat}
          onReleaseAudio={() => { if (audio.playingId === drawer.beat.id) releaseFile(); }}
          selectedBeats={selectedBeats.length > 1 ? selectedBeats : undefined}
          onBulkSaved={applyBulkUpdate}
        />
      )}

      {currentBeat && (
        <Player
          beat={currentBeat}
          playing={audio.isPlaying}
          progress={audio.progress}
          duration={audio.duration}
          volume={audio.volume}
          queue={queuedBeats}
          currentIndex={-1}
          showQueue={showQueue}
          shuffleEnabled={shuffleEnabled}
          repeatMode={repeatMode}
          canShowQueue={queuedBeats.length > 0}
          onToggle={togglePause}
          onSeek={seek}
          onPrev={handlePrev}
          onNext={() => handleNext(false)}
          onVolumeChange={setVolume}
          onToggleShuffle={() => setShuffleEnabled((v) => !v)}
          onCycleRepeat={() => setRepeatMode((m) => (m === "off" ? "all" : m === "all" ? "one" : "off"))}
          onToggleQueue={() => setShowQueue((v) => !v)}
          onPlayQueueIndex={(index) => {
            const target = queuedBeats[index];
            if (!target) return;
            handlePlay(target);
            setQueueIds((ids) => ids.filter((id) => id !== target.id));
          }}
          onAddBeat={() => setShowAdd(true)}
          onDetail={(b) => setDrawer({ beat: b, mode: "detail" })}
          onEdit={(b) => setDrawer({ beat: b, mode: "edit" })}
          onDelete={deleteBeat}
          onAddToQueue={addToQueue}
        />
      )}
    </div>
  );
}
