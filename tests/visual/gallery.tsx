/** Visual QA only. This entry is excluded from the production build.
 * Renders the actual AppShell, BeatCard and Player with isolated UI state.
 * No accounts, Cloud calls, user data or real audio are used by this fixture.
 */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import AppShell from "../../src/app/AppShell";
import LibraryUxBridge from "../../src/features/library/LibraryUxBridge";
import { useTagFilters } from "../../src/features/tags/useTagFilters";
import { useTagColors } from "../../src/lib/tagColors";
import { selectFilteredAndSortedBeats } from "../../src/features/library/librarySelectors";
import { getProceduralBeatBackgroundDataUrl } from "../../src/lib/proceduralBeatBackground";
import type { SortKey } from "../../src/features/library/components/SortMenu";
import type { Beat } from "../../src/types";
import "../../src/styles/design-foundations.css";
import "../../src/styles/library-ux.css";

const names = ["Night Drive", "Amethyst", "Blue Hour", "Slow Motion", "Afterglow", "Velvet", "Orbit", "Dawn"];
const tags = ["Ambient", "Dark", "Melodic", "Trap", "Textures", "Late Night", "Synth", "Cinematic"];
const beats = Array.from({length:24},(_,i)=>({
  id:`visual-${i}`,name:`${names[i%names.length]} ${i+1}`,folder_path:"",mp3_path:"",wav_path:null,playback_path:"",
  bpm:String(90+i*3),key:i%2?"D minor":"A major",tags:[tags[i%8],tags[(i+2)%8],tags[(i+3)%8],tags[(i+5)%8]],rating:1+i%5,
  image_base64:getProceduralBeatBackgroundDataUrl(`visual-${i}`),color:"#0c0c0c",color2:"#0c0c0c",needs_resolution:false,
  has_wav:false,has_stems:false,has_samples:false,samples_path:null,has_flp:false,has_als:false,stems_path:null,flp_path:null,als_path:null,
  other_files:[],has_loop:false,loop_path:null,cloud_status:"CLOUD_ONLY",
})) as Beat[];
const noop=()=>{};
if (new URLSearchParams(window.location.search).has("noWebgl")) {
  const original=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(type:any,...args:any[]):any {
    return type==="webgl2" ? null : (original as any).call(this,type,...args);
  } as any;
}
function GalleryFixture() {
  const filter=useTagFilters(); const tagColors=useTagColors();
  const [search,setSearch]=useState("");const [sortBy,setSortBy]=useState<SortKey>("manual");
  const [selectMode,setSelectMode]=useState(false);const [selectedIds,setSelected]=useState(new Set<string>());
  const [currentBeat,setCurrentBeat]=useState<Beat|null>(beats[0]);const [playing,setPlaying]=useState(false);
  const [progress,setProgress]=useState(1/6);const [volume,setVolume]=useState(.7);
  const [notice,setNotice]=useState("");
  const filtered=selectFilteredAndSortedBeats(beats,search,filter.includedTags,filter.excludedTags,sortBy,"any");
  const selectedBeats=beats.filter(beat=>selectedIds.has(beat.id));
  const finishSelection=()=>{setSelectMode(false);setSelected(new Set());};
  const scope={...filter, search,setSearch,sortBy,setSortBy,tagColors,allTags:tags,beats,filteredBeats:filtered,displayedBeats:filtered,
    audio:{playingId:currentBeat?.id,isPlaying:playing,progress,duration:180,volume},currentBeat,
    connectionState:"online",cloudSessionVerified:true,settings:{incomplete_warnings_enabled:false},
    backgroundUploadErrors:{},interruptedUploadNotices:[],deferredLibraryReloadRef:{current:false},
    selectedIds,selectMode,selectedBeats,revealedBeatIds:new Set(beats.map(beat=>beat.id)),sensors:[],
    openableCloudProjectIds:new Set(),offlineBusyIds:new Set(),queuedBeats:[],tagFrequency:new Map(),tagSuggestions:tags,
    handleTagClick:(tag:string,event:{altKey:boolean})=>filter.toggleTagFilter(tag,event.altKey?"exclude":"include"),
    toggleSelection:(beat:Beat|null)=>{setSelectMode(true);if(beat)setSelected(current=>{const next=new Set(current);next.has(beat.id)?next.delete(beat.id):next.add(beat.id);return next;});},
    toggleSelectAll:()=>setSelected(current=>current.size===filtered.length?new Set():new Set(filtered.map(beat=>beat.id))),
    finishSelection,clearSelection:finishSelection,handleWarm:noop,
    handlePlay:(beat:Beat)=>{setCurrentBeat(beat);setPlaying(beat.id===currentBeat?.id?!playing:true);},
    togglePause:()=>setPlaying(value=>!value),seek:(ratio:number)=>setProgress(ratio),setVolume,
    handleNext:()=>setCurrentBeat(beats[(beats.indexOf(currentBeat!)+1)%beats.length]),handlePrev:()=>setCurrentBeat(beats[(beats.indexOf(currentBeat!)+23)%beats.length]),
    cycleRepeat:noop,toggleShuffle:noop,toggleQueue:noop,repeatMode:"off",shuffleEnabled:false,
    rejectOfflineMutation:()=>false,reloadLibrary:()=>setNotice("Reload handler invoked (fixture only)"),
    setShowAdd:()=>setNotice("Add beat handler invoked (fixture only)"),setShowSettings:()=>setNotice("Settings handler invoked (fixture only)"),
    handleDisconnectTelegramAccount:()=>setNotice("Logout handler invoked (fixture only)"),openTagRename:()=>setNotice("Rename handler invoked (fixture only)"),
    setDrawer:()=>setNotice("Detail handler invoked (fixture only)"),handleEditBulk:noop,handleRemoveBulk:noop,
  };
  return <><LibraryUxBridge/><AppShell scope={scope}/><div role="status" style={{position:"fixed",bottom:0,left:0,zIndex:20000,fontSize:10,padding:"3px 8px",color:"#888",background:"#0c0c0c"}}>Visual QA � isolated state � no Cloud/audio {notice}</div></>;
}
createRoot(document.getElementById("root")!).render(<GalleryFixture/>);

