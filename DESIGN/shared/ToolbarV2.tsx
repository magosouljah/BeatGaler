import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import "./toolbar-v2.css";
import GlassButton from "./GlassButton";

export type LabSort = "manual" | "name" | "bpm" | "stars" | "date";
type Menu = "sort" | "profile" | null;
type Symbol = "magnifyingglass" | "line.3.horizontal.decrease" | "xmark" | "person.crop.circle";
const OPTIONS: { key: LabSort; label: string }[] = [
  {key:"manual",label:"Manual"}, {key:"name",label:"Name"}, {key:"bpm",label:"BPM"},
  {key:"stars",label:"Stars"}, {key:"date",label:"Date"}
];
// The names reference SF Symbols, but the web SVGs below are stand-ins rather than
// Apple SF Symbols exports. Replace with legitimately exported assets when available.
function Icon({name}:{name:Symbol}) {
  const p={viewBox:"0 0 24 24",width:19,height:19,stroke:"currentColor",strokeWidth:1.85,
    strokeLinecap:"round" as const,strokeLinejoin:"round" as const,fill:"none","aria-hidden":true as const,"data-sf-reference":name};
  switch(name) {
    case "magnifyingglass": return <svg {...p}><circle cx="10.7" cy="10.7" r="6.4"/><path d="m15.4 15.4 5.2 5.2"/></svg>;
    case "line.3.horizontal.decrease": return <svg {...p}><path d="M3.6 6h16.8M3.6 12h11.6M3.6 18h6.4"/></svg>;
    case "xmark": return <svg {...p}><path d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6"/></svg>;
    case "person.crop.circle": return <svg {...p}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="9.1" r="2.6"/><path d="M6.7 18.1c.4-2.8 2.4-4.3 5.3-4.3s4.9 1.5 5.3 4.3"/></svg>;
  }
}
export default function LabToolbarV2({search,onSearchChange,sort,onSortChange,selecting,onToggleSelect,onProfileAction,username="Demo User"}:{
  search:string;onSearchChange:(value:string)=>void;sort:LabSort;onSortChange:(sort:LabSort)=>void;
  selecting:boolean;onToggleSelect:()=>void;onProfileAction?:(action:"settings"|"logout")=>void;username?:string;
}) {
  const [searchOpen,setSearchOpen]=useState(false),[menu,setMenu]=useState<Menu>(null);
  const root=useRef<HTMLDivElement>(null),input=useRef<HTMLInputElement>(null);
  const searchButton=useRef<HTMLButtonElement>(null),sortButton=useRef<HTMLButtonElement>(null),
    profileButton=useRef<HTMLButtonElement>(null);
  const sortMenu=useRef<HTMLDivElement>(null),profileMenu=useRef<HTMLDivElement>(null);
  const sortId=useId(),profileId=useId();
  useEffect(()=>{if(searchOpen)input.current?.focus({preventScroll:true});},[searchOpen]);
  useEffect(()=>{
    if(!menu&&!searchOpen)return;
    const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node)){setMenu(null);setSearchOpen(false);}};
    const escape=(e:KeyboardEvent)=>{
      if(e.key!=="Escape")return;
      if(menu){e.preventDefault();const was=menu;setMenu(null);(was==="sort"?sortButton:profileButton).current?.focus({preventScroll:true});}
      else if(searchOpen){e.preventDefault();setSearchOpen(false);searchButton.current?.focus({preventScroll:true});}
    };
    document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape);
    return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape);};
  },[menu,searchOpen]);
  const openMenu=(target:"sort"|"profile")=>{
    setSearchOpen(false);
    if(menu===target){setMenu(null);return;}
    setMenu(target);
    requestAnimationFrame(()=>{
      (target==="sort"?sortMenu:profileMenu).current
        ?.querySelector<HTMLButtonElement>('[role^="menuitem"]')?.focus({preventScroll:true});
    });
  };
  const closeMenu=(target:"sort"|"profile")=>{
    setMenu(null);(target==="sort"?sortButton:profileButton).current?.focus({preventScroll:true});
  };
  const onMenuKeyDown=(e:ReactKeyboardEvent<HTMLDivElement>)=>{
    if(!["Home","End","ArrowDown","ArrowUp"].includes(e.key))return;
    const buttons=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'));
    const current=buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next=e.key==="Home"?0:e.key==="End"?buttons.length-1:e.key==="ArrowDown"?(current+1)%buttons.length:(current+buttons.length-1)%buttons.length;
    e.preventDefault();buttons[next]?.focus();
  };
  return <div ref={root} className={`lab-toolbar-v2${searchOpen?" is-searching":""}`} role="group" aria-label="Library toolbar">
    <div className="lab-toolbar-v2-search-slot">
    <GlassButton as="div" size={44} width={searchOpen?"min(290px, calc(100vw - 244px))":44} className={`glass-button--toolbar lab-toolbar-v2-search${searchOpen?" is-open":""}`}>

      <input ref={input} type="search" autoComplete="off" aria-label="Search beats" placeholder="Search beats"
        className="lab-toolbar-v2-search-input" tabIndex={searchOpen?0:-1}
        value={search} onChange={e=>onSearchChange(e.target.value)}/>
      <button ref={searchButton} type="button" className="lab-toolbar-v2-search-trigger"
        aria-label={searchOpen?"Close search":"Search beats"} aria-expanded={searchOpen}
        onClick={()=>{setMenu(null);setSearchOpen(v=>!v);}}>
        <Icon name="magnifyingglass"/>{search&&!searchOpen&&<span className="lab-toolbar-v2-search-dot" aria-hidden="true"/>}
      </button>
    </GlassButton>
    </div>
    <GlassButton size={44} ref={sortButton} type="button" className="glass-button--toolbar lab-toolbar-v2-circle" active={menu==="sort"}
      aria-label="Sort beats" aria-haspopup="menu" aria-controls={sortId} aria-expanded={menu==="sort"} onClick={()=>openMenu("sort")}>
      <Icon name="line.3.horizontal.decrease"/>
    </GlassButton>
    <GlassButton size={44} width={selecting?44:78} className={`glass-button--toolbar lab-toolbar-v2-select${selecting?" is-selecting":""}`} active={selecting}
      aria-label={selecting?"Cancel selection":"Select beats"} aria-pressed={selecting}
      onClick={()=>{setMenu(null);setSearchOpen(false);onToggleSelect();}}>
      <span className="lab-toolbar-v2-select-text" aria-hidden={selecting}>Select</span>
      <span className="lab-toolbar-v2-select-x" aria-hidden={!selecting}><Icon name="xmark"/></span>
    </GlassButton>
    <GlassButton ref={profileButton} size={44} className="glass-button--toolbar lab-toolbar-v2-circle" active={menu==="profile"}
      aria-label="Profile" aria-haspopup="menu" aria-controls={profileId} aria-expanded={menu==="profile"} onClick={()=>openMenu("profile")}>
      <Icon name="person.crop.circle"/>
    </GlassButton>
    {/* Identical top and right anchors for sorting and profile. */}
    <div ref={sortMenu} id={sortId} role="menu" aria-label="Sort beats" aria-hidden={menu!=="sort"}
      onKeyDown={onMenuKeyDown} className={`lab-toolbar-v2-popover is-sort${menu==="sort"?" is-open":""}`}>
      <div className="lab-toolbar-v2-menu-title">Sort by</div><div className="lab-toolbar-v2-menu-divider"/>
      {OPTIONS.map(o=><button key={o.key} type="button" role="menuitemradio" aria-checked={sort===o.key}
        tabIndex={menu==="sort"?0:-1} className={`lab-toolbar-v2-menu-item${sort===o.key?" is-current":""}`}
        onClick={()=>{onSortChange(o.key);closeMenu("sort");}}>
        {o.label}<span aria-hidden="true" className="lab-toolbar-v2-selected-dot"/>
      </button>)}
    </div>
    <div ref={profileMenu} id={profileId} role="menu" aria-label="Profile" aria-hidden={menu!=="profile"}
      onKeyDown={onMenuKeyDown} className={`lab-toolbar-v2-popover is-profile${menu==="profile"?" is-open":""}`}>
      <div className="lab-toolbar-v2-profile-name"><span className="lab-toolbar-v2-avatar"><Icon name="person.crop.circle"/></span><strong>{username}</strong></div>
      <div className="lab-toolbar-v2-menu-divider"/>
      <button type="button" role="menuitem" tabIndex={menu==="profile"?0:-1} className="lab-toolbar-v2-menu-item"
        onClick={()=>{onProfileAction?.("settings");closeMenu("profile");}}>Settings</button>
      <div className="lab-toolbar-v2-menu-divider"/>
      <button type="button" role="menuitem" tabIndex={menu==="profile"?0:-1} className="lab-toolbar-v2-menu-item"
        onClick={()=>{onProfileAction?.("logout");closeMenu("profile");}}>Log out</button>
    </div>
  </div>;
}
