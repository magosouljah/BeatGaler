import { useMemo, useState } from "react";
import type { Dispatch, SetStateAction, ReactNode } from "react";
import { LabArtwork, LabBeatTile, LabButton, LabField, LabPlayer, LabTag } from "../components";
import { DEMO_BEATS } from "../data";
import type { DemoBeat } from "../data";
import type { CoverMode } from "../coverSources";
import { REAL_COVER_COUNT } from "../coverSources";
import { CATALOG, AREAS } from "./catalog";
import type { Area, CatalogEntry } from "./catalog";
import { DEFAULT_COLORS, DEFAULT_FOUNDATIONS, FOUNDATION_DESCRIPTIONS, FOUNDATION_LIMITS } from "./foundations";
import type { Colors, FoundationSettings } from "./foundations";
import { DsAlert, DsAvatar, DsBadge, DsBreadcrumbs, DsCheckbox, DsCombobox, DsDialog, DsEmpty, DsIcon, DsIconButton, DsMenu, DsPagination, DsPopover, DsProgress, DsRadioGroup, DsSegmented, DsSelect, DsSkeleton, DsSwitch, DsTable, DsTabs, DsTextarea, DsToolbar, DsTooltip } from "./primitives";
import { MotionPlayground } from "../motion/MotionPlayground";

type Props = {
  colors: Colors; setColors: Dispatch<SetStateAction<Colors>>;
  settings: FoundationSettings; setSettings: Dispatch<SetStateAction<FoundationSettings>>;
  coverMode: CoverMode; setCoverMode: (mode: CoverMode) => void;
  playing: boolean; beat: DemoBeat; toggle: () => void; selectBeat: (beat: DemoBeat) => void;
  onNavigate: (page: "landing" | "gallery") => void;
};
const COLOR_FIELDS: {key:keyof Colors;label:string;role:string}[] = [
  {key:"canvas",label:"Canvas",role:"Fixed · matches artwork generator"},
  {key:"surface",label:"Surface",role:"Panels and containers"},
  {key:"raised",label:"Raised",role:"Inputs and controls"},
  {key:"ink",label:"Text primary",role:"High contrast content"},
  {key:"secondary",label:"Text secondary",role:"Supporting content"},
  {key:"accent",label:"Experimental accent",role:"Selection and interactive detail"},
];
const FIELDS: (keyof FoundationSettings)[]=["spacing","radius","control","type","shadow","motion"];
const OPTIONS=[{value:"manual",label:"Manual"},{value:"name",label:"Name"},{value:"bpm",label:"BPM"}];
const TAGS=["Ambient","Trap","Electronic"];
const hardBeat: DemoBeat = { ...DEMO_BEATS[1], id:"stress-02", title:"An Extremely Long Unreleased Late-Night Instrumental Version 2026 (Extended Studio Session)", bpm:197, key:"F# minor" };
function Meta({label,children}:{label:string;children:ReactNode}) {
  return <div className="ds-meta"><span>{label}</span><p>{children}</p></div>;
}
function Kicker({children}:{children:ReactNode}) {return <span className="ds-kicker">{children}</span>}
function Well({title,children}:{title:string;children:ReactNode}) {return <div className="ds-well"><span className="ds-well-title">{title}</span>{children}</div>}
export default function MasterPage({colors,setColors,settings,setSettings,coverMode,setCoverMode,playing,beat,toggle,selectBeat,onNavigate}:Props) {
  const [id,setId]=useState("colors");
  const [query,setQuery]=useState("");
  const [viewport,setViewport]=useState<"auto"|"phone"|"tablet">("auto");
  const [stress,setStress]=useState(false);
  const [variant,setVariant]=useState<"primary"|"secondary"|"ghost"|"danger">("secondary");
  const [size,setSize]=useState<"sm"|"md"|"lg"|"hero">("md");
  const [shape,setShape]=useState<"rounded"|"pill">("rounded");
  const [disabled,setDisabled]=useState(false);
  const [busy,setBusy]=useState(false);
  const [input,setInput]=useState("");
  const [search,setSearch]=useState("");
  const [longText,setLongText]=useState("An idea worth saving.");
  const [choice,setChoice]=useState("Ambient");
  const [selected,setSelected]=useState<string[]>([]);
  const [checked,setChecked]=useState(false);
  const [level,setLevel]=useState(48);
  const [active,setActive]=useState("overview");
  const [dialog,setDialog]=useState(false);
  const [toast,setToast]=useState("");
  const [page,setPage]=useState(2);
  const [result,setResult]=useState("No action yet");
  const [sort,setSort]=useState("manual");
  const [testEmpty,setTestEmpty]=useState(false);
  const [mobileNav,setMobileNav]=useState(false);
  const [mode,setMode]=useState("generated");
  const entry=CATALOG.find(item=>item.id===id) ?? CATALOG[0];
  const matches=useMemo(()=>CATALOG.filter(item=>[item.title,item.id,item.group,item.description,item.area].join(" ").toLowerCase().includes(query.trim().toLowerCase())),[query]);
  const title=stress?"Schwarzlicht Sessions — Extended Edit, Remastered ∞ Edition": "Afterimage";
  const sample=stress?hardBeat:DEMO_BEATS[1];
  const toggleSelect=(key:string)=>setSelected(items=>items.includes(key)?items.filter(item=>item!==key):[...items,key]);
  const announce=(message:string)=>{setResult(message);setToast(message)};
  const settingsRange=(key:keyof FoundationSettings)=> {
    const [min,max,step]=FOUNDATION_LIMITS[key];
    return <label className="ds-range-label" key={key}><span><span>{key[0].toUpperCase()+key.slice(1)}</span><strong>{settings[key]}{key==="shadow"?"%":key==="motion"?"ms":"px"}</strong></span><input type="range" min={min} max={max} step={step} value={settings[key]} onChange={event=>setSettings(current=>({...current,[key]:Number(event.target.value)}))}/><small>{FOUNDATION_DESCRIPTIONS[key]}</small></label>;
  };
  const liveButtons=<div className="ds-flow">
    {(["primary","secondary","ghost","danger"] as const).map(item=><LabButton key={item} variant={item} size={size} shape={shape} disabled={disabled} loading={busy} onClick={()=>announce(item+" action clicked")} trailingIcon={item==="primary"?<DsIcon name="arrow" size={15}/>:undefined}>{stress?"Create a collection with a very long display name":item[0].toUpperCase()+item.slice(1)}</LabButton>)}
    <LabButton size={size} shape={shape} disabled={true}>Disabled</LabButton>
  </div>;
  const showcase=():ReactNode=>{
    switch(id){
      case "colors":return <div className="ds-color-grid">{COLOR_FIELDS.map(({key,label,role})=><label key={key} className="ds-swatch"><span className="ds-swatch-chip" style={{background:colors[key]}}/><span className="ds-swatch-info"><strong>{label}</strong><small>{role}</small><code>{colors[key]}</code></span>{key!=="canvas"&&<input aria-label={"Edit "+label} type="color" value={colors[key]} onChange={e=>setColors(current=>({...current,[key]:e.target.value}))}/>}</label>)}</div>;
      case "typography":return <div className="ds-type-sample"><span className="ds-type-display">Sound has a place.</span><span className="ds-type-heading">Your sound library, refined.</span><p>Organize every beat, tag, and session without losing focus.</p><small>METADATA / 12 PX · WEIGHT 600 / TRACKING +0.10EM</small><p style={{fontSize:"var(--ds-font-size)"}}>Editable body sample using the shared typography scale.</p></div>;
      case "spacing":return <div className="ds-space-grid">{[1,2,3,4,5,6,8,12,16].map(n=><div key={n}><code>{n} × 4</code><span style={{width:`calc(var(--lab-space-4) * ${n}/4)`}}/><small>{n*4}px reference</small></div>)}</div>;
      case "radius":return <div className="ds-shapes">{["sm","md","lg","pill"].map(r=><div key={r} style={{borderRadius:`var(--lab-radius-${r})`}}><strong>{r}</strong><small>--lab-radius-{r}</small></div>)}</div>;
      case "borders":return <div className="ds-flow"><div className="ds-border-box">Hairline</div><div className="ds-border-box ds-border-box--strong">Default</div><LabButton onClick={()=>document.getElementById("ds-focus-demo")?.focus()} >Focus sample</LabButton><button id="ds-focus-demo" className="ds-focus-demo" type="button">Tab to focus</button></div>;
      case "elevation":return <div className="ds-depth"><div className="ds-depth-card">Surface 01 <small>Canvas</small></div><div className="ds-depth-card ds-depth-raised">Surface 02 <small>Card / shadow</small></div><div className="ds-depth-card ds-depth-glass">Surface 03 <small>Translucent overlay</small></div></div>;
      case "sizes":return <div className="ds-stack">{(["sm","md","lg","hero"] as const).map(v=><div className="ds-size-row" key={v}><code>{v.toUpperCase()}</code><LabButton variant="primary" size={v} trailingIcon={<DsIcon name="arrow" size={14}/>} onClick={()=>announce(v+" size")}>Create ur Galer</LabButton><span>Intrinsic width</span></div>)}</div>;
      case "responsive":return <div className="ds-responsive-preview"><div className="ds-responsive-top"><strong>Adaptive gallery</strong><small>Resize using the preview controls above</small></div><div className="ds-responsive-items">{DEMO_BEATS.slice(0,3).map(item=><LabArtwork key={item.id} beat={item} coverMode={coverMode}/>)}</div></div>;
      case "icons":return <div className="ds-icons">{(["search","chevron","plus","more","check","close","music","settings","filter","arrow","layers","play"] as const).map(name=><button type="button" key={name} onClick={()=>announce(name+" icon")}><DsIcon name={name} size={23}/><small>{name}</small></button>)}</div>;
      case "artwork-mode":return <div className="ds-stack"><DsSegmented label="Artwork mode" options={[{value:"generated",label:"Generated"},{value:"real",label:"Real covers"}]} value={coverMode} onChange={value=>setCoverMode(value as CoverMode)}/><div className="ds-artwork-grid">{DEMO_BEATS.slice(0,4).map(item=><LabArtwork key={item.id} beat={item} coverMode={coverMode}/>)}</div><p>{REAL_COVER_COUNT} bundled reference covers. Mode is shared with Landing and Gallery.</p></div>;
      case "buttons":return liveButtons;
      case "icon-buttons":return <div className="ds-flow">{(["search","plus","more","settings","play"] as const).map(icon=><DsIconButton key={icon} label={"Open "+icon} icon={icon} onClick={()=>announce(icon+" clicked")}/>)}</div>;
      case "links":return <div className="ds-stack"><a className="ds-link" href="#design-lab" onClick={e=>{e.preventDefault();onNavigate("gallery")}}>Open Gallery preview <DsIcon name="arrow" size={15}/></a><button type="button" className="ds-text-link" onClick={()=>announce("Secondary text link activated")}>Secondary inline action</button></div>;
      case "fields":return <div className="ds-form-width"><LabField id="ds-input-demo" label="Beat title" value={input} onChange={e=>setInput(e.target.value)} placeholder="Enter your beat title" hint="Shown only in this isolated preview." error={input.length>24?"Keep the title below 25 characters for this demo.":undefined}/><LabField id="ds-disabled" label="Disabled field" disabled value="Read-only example" readOnly /></div>;
      case "search":return <div className="ds-stack"><label className="ds-search-field"><DsIcon name="search" size={18}/><input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search your beats…" aria-label="Search beat demo"/>{search&&<DsIconButton label="Clear search" icon="close" onClick={()=>setSearch("")}/>}</label><div className="ds-results">{DEMO_BEATS.filter(b=>b.title.toLowerCase().includes(search.toLowerCase())).map(b=><button type="button" key={b.id} onClick={()=>{selectBeat(b);announce("Selected "+b.title)}}>{b.title}<small>{b.bpm} BPM</small></button>)}{!DEMO_BEATS.some(b=>b.title.toLowerCase().includes(search.toLowerCase()))&&<DsEmpty onReset={()=>setSearch("")}/>}</div></div>;
      case "textarea":return <div className="ds-form-width"><DsTextarea label="Session notes" rows={4} maxLength={160} value={longText} onChange={e=>setLongText(e.target.value)}/><small>{longText.length} / 160 characters</small></div>;
      case "select":return <div className="ds-form-width"><DsSelect label="Sort beats by" options={OPTIONS} value={sort} onChange={e=>setSort(e.target.value)}/><p>Selected: {sort}</p></div>;
      case "combobox":return <div className="ds-form-width"><DsCombobox label="Find a tag" value={input} onChange={setInput} items={TAGS.concat(["Lo-fi","Melodic House","Unreleased","2026 Sessions"])}/><p>Value: {input||"—"}</p></div>;
      case "checkbox":return <div className="ds-stack"><DsCheckbox label="Select this beat" checked={checked} onChange={setChecked}/><DsCheckbox label="A disabled option" checked={false} onChange={()=>{}} disabled/><p>{checked?"Selected for batch actions":"No selection"}</p></div>;
      case "radio":return <DsRadioGroup label="Artwork source" value={choice} onChange={setChoice} options={TAGS.map(label=>({label,value:label}))}/>;
      case "switch":return <div className="ds-form-width"><DsSwitch label="Enable shuffle" checked={checked} onChange={setChecked}/><DsSwitch label="Disabled switch" checked={false} onChange={()=>{}} disabled/><p>Shuffle is {checked?"enabled":"off"}.</p></div>;
      case "slider":return <div className="ds-form-width"><label className="ds-range-label"><span>Volume <strong>{level}%</strong></span><input type="range" value={level} min={0} max={100} onChange={e=>setLevel(Number(e.target.value))}/></label><DsProgress value={level} label="Volume preview"/></div>;
      case "chips":return <div className="ds-flow">{TAGS.map(item=><LabTag key={item} active={choice===item} onClick={()=>setChoice(item)}>{item}</LabTag>)}<LabTag>{stress?"An excessively long optional tag name":"Unreleased"}</LabTag></div>;
      case "badges":return <div className="ds-flow">{(["neutral","success","warning","danger","info"] as const).map(tone=><DsBadge key={tone} tone={tone}>{tone}</DsBadge>)}</div>;
      case "avatars":return <div className="ds-flow"><DsAvatar size="sm" name="Sofia Kim"/><DsAvatar size="md" name="Jo"/><DsAvatar size="lg" name={stress?"Aleksandra Wiśniewska-Kowalczyk":"BeatGaler"}/><DsAvatar name=""/></div>;
      case "artwork":return <div className="ds-artwork-grid">{DEMO_BEATS.slice(0,4).map(item=><LabArtwork key={item.id} beat={item} coverMode={coverMode}/>)}</div>;
      case "beat-cards":return <div className="ds-beats">{[sample,DEMO_BEATS[2],DEMO_BEATS[3]].map(item=><LabBeatTile key={item.id} beat={item} coverMode={coverMode} selected={playing&&item.id===beat.id} onPlay={selectBeat}/>)}</div>;
      case "player":case "queue-pattern":return <div className="ds-player-stage"><LabPlayer beat={beat} playing={playing} onToggle={toggle} coverMode={coverMode} beats={DEMO_BEATS} onPlayBeat={selectBeat} variant="preview"/></div>;
      case "cards":return <div className="ds-card-grid">{DEMO_BEATS.slice(0,2).map(item=><article className="ds-preview-card" key={item.id}><LabArtwork beat={item} coverMode={coverMode}/><strong>{stress?title:item.title}</strong><small>{item.tag} · {item.bpm} BPM</small><LabButton onClick={()=>selectBeat(item)}>Preview</LabButton></article>)}</div>;
      case "lists":return <div className="ds-list">{DEMO_BEATS.slice(0,4).map(item=><button className="ds-list-row" type="button" key={item.id} onClick={()=>selectBeat(item)}><span>{item.title}<small>{item.tag} · {item.key}</small></span><DsIcon name="arrow" size={17}/></button>)}</div>;
      case "table":return <DsTable rows={DEMO_BEATS.slice(0,4).map((item,i)=>({name:stress&&i===0?title:item.title,bpm:item.bpm,status:i%2?"Processing":"Ready"}))}/>;
      case "tabs":return <div className="ds-stack"><DsTabs tabs={[{label:"Overview",value:"overview"},{label:"Metadata",value:"metadata"},{label:"Files",value:"files"}]} active={active} onChange={setActive}/><div role="tabpanel" className="ds-tab-panel">Selected panel: <strong>{active}</strong></div></div>;
      case "breadcrumbs":return <DsBreadcrumbs items={["Library","Collections",choice]} onChoose={index=>announce("Breadcrumb "+index)}/>;
      case "pagination":return <DsPagination page={page} pages={8} onChange={setPage}/>;
      case "toolbar":return <DsToolbar><DsIconButton label="Search" icon="search" onClick={()=>announce("Search action")}/><LabButton onClick={()=>setChecked(x=>!x)}>{checked?"Exit selection":"Select"}</LabButton><DsSelect label="Order" options={OPTIONS} value={sort} onChange={e=>setSort(e.target.value)}/><DsIconButton label="More" icon="more" onClick={()=>announce("More toolbar")}/></DsToolbar>;
      case "menu":return <div className="ds-stack"><DsMenu onChoose={announce}/><p role="status">Last action: {result}</p></div>;
      case "popover":return <DsPopover label="Inspect track"><p>Afterimage</p><p>92 BPM · D minor</p><LabButton onClick={()=>announce("Added to preview queue")}>Add to queue</LabButton></DsPopover>;
      case "tooltip":return <div className="ds-flow"><DsTooltip content="Add a new beat"><DsIconButton label="Add a new beat" icon="plus" onClick={()=>announce("Add beat")}/></DsTooltip><DsTooltip content="This appears on hover or keyboard focus"><LabButton>Hover or focus</LabButton></DsTooltip></div>;
      case "dialog":return <LabButton variant="primary" onClick={()=>setDialog(true)}>Open confirmation dialog</LabButton>;
      case "alerts":return <div className="ds-stack"><DsAlert title="Library synced" tone="success">The fictional session is up to date.</DsAlert><DsAlert title="Information" tone="info">This preview has no production connections.</DsAlert><DsAlert title="Unable to save" tone="danger">This is a simulated validation example.</DsAlert></div>;
      case "toast":return <div className="ds-stack"><LabButton variant="primary" onClick={()=>announce("Changes saved locally")}>Show toast</LabButton><p role="status">{result}</p></div>;
      case "progress":case "upload-pattern":return <div className="ds-stack"><DsProgress label="Fictional audio upload" value={level}/><label className="ds-range-label"><span>Upload progress <strong>{level}%</strong></span><input type="range" min="0" max="100" value={level} onChange={e=>setLevel(Number(e.target.value))}/></label><DsBadge tone={level===100?"success":"info"}>{level===100?"Complete":"Uploading"}</DsBadge></div>;
      case "loading":return <div className="ds-flow"><LabButton loading>Loading state</LabButton><LabButton disabled>Disabled state</LabButton><LabButton onClick={()=>setBusy(x=>!x)}>{busy?"Stop loading":"Toggle button loading"}</LabButton></div>;
      case "skeleton":return <div className="ds-stack"><DsSwitch label="Show loaded content" checked={checked} onChange={setChecked}/>{checked?<DsTable rows={[{name:"Afterimage",bpm:92,status:"Ready"}]}/>:<DsSkeleton count={4}/>}</div>;
      case "empty":case "empty-pattern":return <div className="ds-stack"><DsSwitch label="Show empty state" checked={!testEmpty} onChange={v=>setTestEmpty(!v)}/>{testEmpty?<DsTable rows={[{name:"Afterimage",bpm:92,status:"Ready"}]}/>:<DsEmpty onReset={()=>setTestEmpty(true)}/>}</div>;
      case "library-pattern":return <div className="ds-stack"><DsToolbar><label className="ds-search-field"><DsIcon name="search"/><input aria-label="Filter library" placeholder="Filter beats…" value={search} onChange={e=>setSearch(e.target.value)}/></label><LabButton onClick={()=>onNavigate("gallery")}>Open full Gallery <DsIcon name="arrow" size={14}/></LabButton></DsToolbar><div className="ds-beats">{DEMO_BEATS.filter(b=>b.title.toLowerCase().includes(search.toLowerCase())).slice(0,3).map(item=><LabBeatTile key={item.id} beat={item} selected={playing&&beat.id===item.id} coverMode={coverMode} onPlay={selectBeat}/>)}</div></div>;
      case "selection-pattern":return <div className="ds-stack"><DsToolbar><DsBadge tone={selected.length?"success":"neutral"}>{selected.length} selected</DsBadge><LabButton onClick={()=>setSelected(selected.length===3?[]:DEMO_BEATS.slice(0,3).map(item=>item.id))}>Toggle all</LabButton><LabButton disabled={!selected.length} onClick={()=>{announce(selected.length+" beats organized");setSelected([])}}>Organize selected</LabButton></DsToolbar>{DEMO_BEATS.slice(0,3).map(item=><div className="ds-selection-row" key={item.id}><DsCheckbox label={item.title} checked={selected.includes(item.id)} onChange={()=>toggleSelect(item.id)}/><small>{item.bpm} BPM</small></div>)}</div>;
      case "metadata-pattern":return <div className="ds-form-width ds-stack"><LabField id="ds-meta-name" label="Beat name" placeholder="Afterimage" value={input} onChange={e=>setInput(e.target.value)} error={input.length>30?"Keep this demo value under 30 characters":undefined}/><DsSelect label="Primary tag" value={choice} onChange={e=>setChoice(e.target.value)} options={TAGS.map(t=>({value:t,label:t}))}/><label className="ds-range-label"><span>BPM <strong>{level+80}</strong></span><input type="range" min={0} max={120} value={level} onChange={e=>setLevel(Number(e.target.value))}/></label><LabButton variant="primary" disabled={input.length>30} onClick={()=>announce("Fictional metadata saved")}>Save changes</LabButton></div>;
      case "orbit":return <div className="ds-stack"><p>The 24-cover orbit is active on Landing. It responds to pointer movement, scales by depth and respects reduced-motion preferences.</p><LabButton variant="primary" onClick={()=>onNavigate("landing")}>Open interactive orbit <DsIcon name="arrow" size={14}/></LabButton><div className="ds-artwork-grid">{DEMO_BEATS.slice(0,4).map(item=><LabArtwork beat={item} coverMode={coverMode} key={item.id}/>)}</div></div>;
      default:if(entry.area==="Motion & Physics")return <MotionPlayground key={id} initial={id as "spring"|"repel"|"attract"|"inertia"|"gravity"}/>;
      return <p>Select a component.</p>;
    }
  };
  const grouped=(area:Area)=>Array.from(new Set(matches.filter(item=>item.area===area).map(item=>item.group)));
  return <div className="ds-app">
    <aside className={`ds-sidebar ${mobileNav?"ds-sidebar--open":""}`} aria-label="Design system navigation">
      <div className="ds-side-brand"><span className="ds-mark">b<span>g</span></span><div><strong>BeatGaler</strong><small>DESIGN SYSTEM / LAB</small></div></div>
      <label className="ds-nav-search"><DsIcon name="search" size={16}/><input type="search" aria-label="Search design components" placeholder="Search components…" value={query} onChange={e=>setQuery(e.target.value)}/><kbd>⌕</kbd></label>
      <div className="ds-nav-scroll">
        {AREAS.map(area=><section key={area} className="ds-side-section"><h2>{area}<span>{CATALOG.filter(item=>item.area===area).length}</span></h2>{grouped(area).map(group=><div key={group} className="ds-side-group"><span>{group}</span>{matches.filter(item=>item.area===area&&item.group===group).map(item=><button key={item.id} type="button" aria-current={id===item.id?"page":undefined} onClick={()=>{setId(item.id);setMobileNav(false)}}>{item.title}</button>)}</div>)}</section>)}
        {!matches.length&&<p className="ds-no-results">No components match your search.</p>}
      </div>
      <div className="ds-side-footer"><span className="ds-online"/><div><strong>Local preview</strong><small>No APIs or real accounts</small></div></div>
    </aside>
    <div className="ds-workspace">
      <header className="ds-topbar"><button type="button" className="ds-mobile-nav" onClick={()=>setMobileNav(v=>!v)} aria-expanded={mobileNav}>☰ <span>Library</span></button><div className="ds-top-location"><DsIcon name="layers" size={15}/><span>Workspace</span><span className="ds-top-chevron">/</span><strong>{entry.area}</strong><span className="ds-top-chevron">/</span><strong>{entry.title}</strong></div><div className="ds-top-actions"><span>EXPERIMENTAL</span><button type="button" onClick={()=>onNavigate("gallery")}>Gallery ↗</button><button type="button" onClick={()=>onNavigate("landing")}>Landing ↗</button></div></header>
      <div className="ds-workspace-content">
        <div className="ds-header"><Kicker>{entry.area.toUpperCase()} / {entry.group.toUpperCase()}</Kicker><h1>{entry.title}</h1><p>{entry.description}</p><div className="ds-header-line"><DsBadge tone="success">Live specimen</DsBadge><span>Local state · editable properties</span><span>Code: {entry.source}</span></div></div>
        <div className="ds-layout">
          <main className="ds-main">
            <section className="ds-canvas-section" aria-label="Interactive specimen">
              <div className="ds-section-toolbar"><div><span className="ds-dot"/> PLAYGROUND <small>Interactive preview</small></div><div className="ds-preview-controls"><DsSegmented label="Specimen width" value={viewport} options={[{value:"auto",label:"Fluid"},{value:"tablet",label:"Tablet"},{value:"phone",label:"Phone"}]} onChange={v=>setViewport(v as typeof viewport)}/></div></div>
              <div className={`ds-preview ds-preview--${viewport}`}><div className="ds-preview-inner" style={viewport==="phone"?{width:320}:viewport==="tablet"?{width:480}:undefined}>{showcase()}</div></div>
              <div className="ds-canvas-footer"><label><input type="checkbox" checked={stress} onChange={e=>setStress(e.target.checked)}/> Stress-test long labels</label><span>Try tab, touch, keyboard and resize</span></div>
            </section>
            <section className="ds-specs"><div className="ds-specs-heading"><Kicker>REFERENCE</Kicker><h2>Usage & anatomy</h2><p>Component contracts are tied to code, not speculative guidelines.</p></div><div className="ds-spec-grid"><Meta label="ANATOMY">{entry.anatomy}</Meta><Meta label="PROPERTIES">{entry.props}</Meta><Meta label="STATES">{entry.states}</Meta><Meta label="SOURCE">{entry.source}</Meta></div></section>
            <section className="ds-overview"><div><Kicker>APPLY THE SYSTEM</Kicker><h2>One library. Three surfaces.</h2><p>Foundations, components and motion drive MASTER. Landing and Gallery remain independent fictional screens that share primitives and tokens where implemented.</p></div><div className="ds-surface-links"><button type="button" onClick={()=>onNavigate("landing")}>01 <strong>Landing</strong><span>Art direction & orbit ↗</span></button><button type="button" onClick={()=>onNavigate("gallery")}>02 <strong>Gallery</strong><span>Library & player ↗</span></button></div></section>
          </main>
          <aside className="ds-inspector" aria-label="Live property inspector"><div className="ds-inspector-heading"><DsIcon name="settings" size={17}/><strong>Inspector</strong><span>LIVE</span></div>
            <div className="ds-inspector-section"><Kicker>SPECIMEN</Kicker><strong>{entry.title}</strong><p>Edits immediately update this preview.</p></div>
            {entry.id==="buttons"&&<div className="ds-inspector-section"><DsSelect label="Variant" value={variant} onChange={e=>setVariant(e.target.value as typeof variant)} options={["primary","secondary","ghost","danger"].map(value=>({value,label:value}))}/><DsSelect label="Size" value={size} onChange={e=>setSize(e.target.value as typeof size)} options={["sm","md","lg","hero"].map(value=>({value,label:value}))}/><DsSegmented label="Button shape" value={shape} onChange={v=>setShape(v as typeof shape)} options={[{value:"rounded",label:"Rounded"},{value:"pill",label:"Pill"}]}/><DsSwitch label="Disabled" checked={disabled} onChange={setDisabled}/><DsSwitch label="Loading" checked={busy} onChange={setBusy}/><LabButton size={size} variant={variant} shape={shape} disabled={disabled} loading={busy} onClick={()=>announce("Configured button pressed")}>Custom specimen</LabButton></div>}
            {entry.id==="colors"&&<div className="ds-inspector-section"><Kicker>COLOR ROLES</Kicker>{COLOR_FIELDS.filter(f=>f.key!=="canvas").map(f=><label key={f.key} className="ds-inspector-color"><span>{f.label}</span><code>{colors[f.key]}</code><input type="color" aria-label={"Edit "+f.label} value={colors[f.key]} onChange={e=>setColors(current=>({...current,[f.key]:e.target.value}))}/></label>)}</div>}
            {(entry.area==="Foundations"||entry.area==="Motion & Physics")&&<div className="ds-inspector-section"><Kicker>FOUNDATION CONTROLS</Kicker>{FIELDS.filter(f=>entry.area==="Motion & Physics"?f==="motion":entry.id==="spacing"?f==="spacing":entry.id==="radius"?f==="radius":entry.id==="sizes"?f==="control":entry.id==="typography"?f==="type":entry.id==="elevation"?f==="shadow":false).map(settingsRange)}<p>Global edits are shared until you refresh this lab.</p></div>}
            <div className="ds-inspector-section"><Kicker>WORKSPACE</Kicker><DsSegmented label="Artwork source" value={coverMode} options={[{value:"generated",label:"Generated"},{value:"real",label:"Real covers"}]} onChange={v=>setCoverMode(v as CoverMode)}/><small>Changes Landing, Gallery and MASTER.</small><div className="ds-inspector-divider"/><DsSwitch label="Stress labels" checked={stress} onChange={setStress}/><button className="ds-reset" type="button" onClick={()=>{setColors({...DEFAULT_COLORS});setSettings({...DEFAULT_FOUNDATIONS});setVariant("secondary");setSize("md");setStress(false);setDisabled(false);setBusy(false)}}>Reset all foundations ↺</button></div>
            <div className="ds-inspector-section ds-inspector-code"><Kicker>IMPLEMENTATION</Kicker><code>{entry.source}</code><small>Only the actual lab implementation is documented.</small></div>
          </aside>
        </div>
      </div>
    </div>
    <DsDialog open={dialog} title="Confirm changes" onClose={()=>setDialog(false)}><p>This is an isolated demonstration. No real beats will be changed.</p></DsDialog>
    {toast&&<div role="status" className="ds-toast"><DsIcon name="check" size={18}/><span>{toast}</span><DsIconButton icon="close" label="Dismiss notification" onClick={()=>setToast("")}/></div>}
  </div>;
}
