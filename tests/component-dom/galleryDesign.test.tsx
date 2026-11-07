// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GalleryChrome from "../../src/features/design/GALLERY/GalleryChrome";
import { useTagFilters } from "../../src/features/tags/useTagFilters";
import { useTagColors, getTagColor } from "../../src/lib/tagColors";
import { selectFilteredAndSortedBeats } from "../../src/features/library/librarySelectors";
import type { Beat } from "../../src/types";

const actions = vi.hoisted(() => ({ add:vi.fn(), reload:vi.fn(), settings:vi.fn(), logout:vi.fn(), rename:vi.fn() }));
vi.mock("../../src/features/design/MASTER/StudioToolbarCandidate", () => ({default: (props:any) => <div>
  <button onClick={() => props.onSearchChange("night")}>Search night</button>
  <button onClick={() => props.onSortChange("rating")}>Sort rating</button>
  <button onClick={props.onToggleSelect}>Select beats</button>
  <button onClick={props.onAddBeat}>Add beat</button>
  <button onClick={props.onReload}>Reload</button>
  <button onClick={() => props.onProfileAction("settings")}>Settings</button>
  <button onClick={() => props.onProfileAction("logout")}>Log out</button>
</div> }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let host:HTMLDivElement; let root:Root;
const beats = [
  {id:"a",name:"Night",bpm:"100",key:"Dm",tags:["Trap"],rating:5},
  {id:"b",name:"Dawn",bpm:"120",key:"Am",tags:["Ambient"],rating:3},
  {id:"c",name:"Day",bpm:"90",key:"Cm",tags:["Trap","Ambient"],rating:4},
] as Beat[];
function Harness() {
  const tags = useTagFilters(); const colors = useTagColors();
  const [search,setSearch]=useState(""); const [sortBy,setSortBy]=useState<any>("manual"); const [selectMode,setSelectMode]=useState(false);
  const filtered = selectFilteredAndSortedBeats(beats,search,tags.includedTags,tags.excludedTags,sortBy,"any");
  return <div className="bg-design"><GalleryChrome scope={{...tags, tagColors:colors, allTags:["Trap","Ambient"], search,setSearch,sortBy,setSortBy,selectMode,
    handleTagClick:(tag:string,event:{altKey:boolean})=>tags.toggleTagFilter(tag,event.altKey?"exclude":"include"),
    toggleSelection:()=>setSelectMode(true),finishSelection:()=>setSelectMode(false), displayedBeats:filtered,
    openTagRename:actions.rename,rejectOfflineMutation:()=>false,setShowAdd:actions.add,reloadLibrary:actions.reload,setShowSettings:actions.settings,handleDisconnectTelegramAccount:actions.logout}} />
    <output data-results>{filtered.map(beat=>beat.id).join(",")}</output><output data-select>{String(selectMode)}</output></div>;
}
async function click(selector:string, options:MouseEventInit={}) { await act(async()=> {host.querySelector(selector)!.dispatchEvent(new MouseEvent("click",{bubbles:true,...options}));}); }
beforeEach(async()=>{
  sessionStorage.clear(); vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver",class {observe(){} disconnect(){}});
  vi.stubGlobal("matchMedia",()=>({matches:false,addEventListener(){},removeEventListener(){}}));
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  await act(async()=>root.render(<Harness/>));
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
describe("DESIGN controls connected to product state",()=>{
  it("uses real include/exclude filters, pins active tags and preserves ANY inclusion",async()=>{
    await click('[data-label="Trap"]'); expect(host.querySelector("[data-results]")?.textContent).toBe("a,c");
    expect(host.querySelector(".lab-gallery-top-stack")?.getAttribute("data-tags-open")).toBe("true");
    await click('[data-label="Ambient"]'); expect(host.querySelector("[data-results]")?.textContent).toBe("a,b,c");
    await click('[data-label="Ambient"]',{altKey:true}); expect(host.querySelector("[data-results]")?.textContent).toBe("a");
    await click('[data-label="All"]'); expect(host.querySelector("[data-results]")?.textContent).toBe("a,b,c");
  });
  it("wires search, sorting, selection and account actions to existing handlers",async()=>{
    const button=(label:string)=>Array.from(host.querySelectorAll("button")).find(node=>node.textContent===label)!;
    for(const label of ["Search night","Sort rating","Select beats","Add beat","Reload","Settings","Log out"]) await act(async()=>button(label).click());
    expect(host.querySelector("[data-results]")?.textContent).toBe("a"); expect(host.querySelector("[data-select]")?.textContent).toBe("true");
    expect(actions.add).toHaveBeenCalledWith(true); expect(actions.reload).toHaveBeenCalledOnce(); expect(actions.settings).toHaveBeenCalledWith(true); expect(actions.logout).toHaveBeenCalledOnce();
  });
  it("persists colors through the shared product store and retains rename",async()=>{
    await act(async()=>host.querySelector('[data-label="Trap"]')!.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true})));
    await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="Purple"]')!.click());
    expect(getTagColor("TRAP")).toBe("#AF52DE");
    await act(async()=>host.querySelector('[data-label="Trap"]')!.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true})));
    await act(async()=>Array.from(document.querySelectorAll("button")).find(button=>button.textContent==="Rename tag")!.click());
    expect(actions.rename).toHaveBeenCalledWith("Trap");
  });
});
