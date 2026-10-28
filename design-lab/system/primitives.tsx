import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode, HTMLAttributes, ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes } from "react";
import { LabButton } from "../components";

export type Choice = { value: string; label: string };
export function DsIcon({ name, size = 18 }: { name: "search" | "chevron" | "plus" | "more" | "check" | "close" | "music" | "settings" | "filter" | "arrow" | "layers" | "play"; size?: number }) {
  const paths: Record<string, ReactNode> = {
    search:<><circle cx="10.6" cy="10.6" r="6.6"/><path d="m16 16 5 5"/></>,
    chevron:<path d="m6 9 6 6 6-6"/>,
    plus:<path d="M12 5v14M5 12h14"/>,
    more:<><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    check:<path d="m4 12 5 5L20 6"/>,
    close:<path d="M6 6l12 12M18 6 6 18"/>,
    music:<><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></>,
    settings:<><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M19 5l-2 2M7 17l-2 2"/></>,
    filter:<path d="M3 6h18M6 12h12M9 18h6"/>,
    arrow:<path d="M5 12h14m-6-6 6 6-6 6"/>,
    layers:<><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5m-18 5 9 5 9-5"/></>,
    play:<path d="m8 5 12 7-12 7z"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
export function DsIconButton({ label, icon = "more", ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { label: string; icon?: Parameters<typeof DsIcon>[0]["name"] }) {
  return <button {...props} type="button" aria-label={label} className={["ds-icon-button", props.className].filter(Boolean).join(" ")}><DsIcon name={icon} /></button>;
}
export function DsBadge({ tone = "neutral", children }: { tone?: "neutral" | "success" | "danger" | "info" | "warning"; children: ReactNode }) {
  return <span className={`ds-badge ds-badge--${tone}`}>{children}</span>;
}
export function DsAvatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map(part => part[0] ?? "").join("").toUpperCase();
  return <span className={`ds-avatar ds-avatar--${size}`} role="img" aria-label={name}>{initials || "?"}</span>;
}
export function DsSwitch({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <label className="ds-switch-line"><span>{label}</span><input className="ds-switch" type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)}/></label>;
}
export function DsCheckbox({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <label className="ds-checkbox-line"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} disabled={disabled} />{label}</label>;
}
export function DsRadioGroup({ label, options, value, onChange }: { label: string; options: Choice[]; value: string; onChange: (value: string) => void }) {
  const name = useId();
  return <fieldset className="ds-radio-group"><legend>{label}</legend>{options.map(option => <label key={option.value}><input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />{option.label}</label>)}</fieldset>;
}
export function DsSegmented({ options, value, onChange, label }: { options: Choice[]; value: string; onChange: (value: string) => void; label: string }) {
  return <div className="ds-segmented" role="group" aria-label={label}>{options.map(option=><button key={option.value} type="button" aria-pressed={value===option.value} onClick={()=>onChange(option.value)}>{option.label}</button>)}</div>;
}
export function DsSelect({label, options, ...props}: SelectHTMLAttributes<HTMLSelectElement> & {label:string;options:Choice[]}) {
  const id=useId();
  return <label className="ds-control-label" htmlFor={id}>{label}<span className="ds-select-wrap"><select {...props} id={id} className="ds-input">{options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select><DsIcon name="chevron" size={16}/></span></label>;
}
export function DsTextarea({label, ...props}: InputHTMLAttributes<HTMLTextAreaElement> & {label:string}) {
  const id=useId();return <label className="ds-control-label" htmlFor={id}>{label}<textarea {...props} id={id} className="ds-input ds-textarea"/></label>;
}
export function DsTabs({ tabs, active, onChange }: { tabs: Choice[]; active: string; onChange: (value: string) => void }) {
  return <div className="ds-tabs" role="tablist" aria-label="Display sections">{tabs.map(tab=><button type="button" key={tab.value} role="tab" aria-selected={active===tab.value} tabIndex={active===tab.value?0:-1} onKeyDown={event => {
    const i=tabs.findIndex(x=>x.value===tab.value);
    if(event.key==="ArrowRight"||event.key==="ArrowLeft"||event.key==="Home"||event.key==="End"){
      event.preventDefault();const next=event.key==="Home"?0:event.key==="End"?tabs.length-1:(i+(event.key==="ArrowRight"?1:-1)+tabs.length)%tabs.length;
      onChange(tabs[next].value);(event.currentTarget.parentElement?.children[next] as HTMLElement|undefined)?.focus();
    }
  }} onClick={()=>onChange(tab.value)}>{tab.label}</button>)}</div>;
}
export function DsProgress({value, label}: {value:number;label:string}) {
  const amount=Math.min(100,Math.max(0,value));
  return <div className="ds-progress-wrap"><div className="ds-progress-label"><span>{label}</span><span>{Math.round(amount)}%</span></div><div className="ds-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={amount}><span style={{width:`${amount}%`}}/></div></div>;
}
export function DsSkeleton({count=3}:{count?:number}) {return <div className="ds-skeleton-list" aria-label="Loading preview" role="status">{Array.from({length:count},(_,i)=><div key={i} className="ds-skeleton-row"><i/><span/></div>)}</div>}
export function DsAlert({tone="info", title, children}: {tone?:"info"|"success"|"danger";title:string;children:ReactNode}) {
  return <div className={`ds-alert ds-alert--${tone}`} role={tone==="danger"?"alert":"status"}><strong>{title}</strong><p>{children}</p></div>;
}
export function DsBreadcrumbs({items,onChoose}:{items:string[];onChoose:(index:number)=>void}) {
  return <nav aria-label="Breadcrumb" className="ds-breadcrumbs"><ol>{items.map((item,i)=><li key={i}>{i<items.length-1?<button type="button" onClick={()=>onChoose(i)}>{item}</button>:<span aria-current="page">{item}</span>}</li>)}</ol></nav>;
}
export function DsPagination({page,pages,onChange}:{page:number;pages:number;onChange:(page:number)=>void}) {
  return <nav className="ds-pagination" aria-label="Pagination"><button type="button" disabled={page<=1} onClick={()=>onChange(page-1)}>Previous</button><span>Page {page} of {pages}</span><button type="button" disabled={page>=pages} onClick={()=>onChange(page+1)}>Next</button></nav>;
}
export function DsTooltip({children,content}:{children:ReactNode;content:string}) {
  return <span className="ds-tooltip-anchor" tabIndex={0} aria-label={content}>{children}<span className="ds-tooltip" role="tooltip">{content}</span></span>;
}
export function DsPopover({label,children}:{label:string;children:ReactNode}) {
  const [open,setOpen]=useState(false);const ref=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(!open)return;const pointer=(e:PointerEvent)=>{if(!ref.current?.contains(e.target as Node))setOpen(false)};const key=(e:KeyboardEvent)=>{if(e.key==="Escape")setOpen(false)};document.addEventListener("pointerdown",pointer);document.addEventListener("keydown",key);return()=>{document.removeEventListener("pointerdown",pointer);document.removeEventListener("keydown",key)}},[open]);
  return <div ref={ref} className="ds-popover-host"><LabButton aria-expanded={open} aria-haspopup="true" onClick={()=>setOpen(x=>!x)}>{label} <DsIcon name="chevron" size={13}/></LabButton>{open&&<div className="ds-popover" role="group" aria-label={label}>{children}</div>}</div>;
}
export function DsMenu({onChoose}:{onChoose:(value:string)=>void}) {
  return <DsPopover label="Options"><div className="ds-menu" role="menu">{["Edit metadata","Add to queue","Duplicate","Delete"].map(item=><button role="menuitem" type="button" key={item} onClick={()=>onChoose(item)}>{item}</button>)}</div></DsPopover>;
}
export function DsDialog({open,title,children,onClose}:{open:boolean;title:string;children:ReactNode;onClose:()=>void}) {
  const titleId=useId();const ref=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(!open)return;const previous=document.activeElement as HTMLElement|null;const key=(event:KeyboardEvent)=>{
    if(event.key==="Escape")onClose();
    if(event.key==="Tab"){const focusable=ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])');if(!focusable?.length)return;const first=focusable[0],last=focusable[focusable.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}}
  };document.addEventListener("keydown",key);ref.current?.querySelector<HTMLElement>("button")?.focus();return()=>{document.removeEventListener("keydown",key);previous?.focus()}},[open,onClose]);
  if(!open)return null;
  return <div className="ds-dialog-overlay" onPointerDown={event=>{if(event.target===event.currentTarget)onClose()}}><div ref={ref} className="ds-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}><div className="ds-dialog-header"><h2 id={titleId}>{title}</h2><DsIconButton label="Close dialog" icon="close" onClick={onClose}/></div><div className="ds-dialog-content">{children}</div><div className="ds-dialog-actions"><LabButton onClick={onClose}>Cancel</LabButton><LabButton variant="primary" onClick={onClose}>Done</LabButton></div></div></div>;
}
export function DsCombobox({label,items,value,onChange}:{label:string;items:string[];value:string;onChange:(v:string)=>void}) {
  const [expanded,setExpanded]=useState(false);const [active,setActive]=useState(0);const id=useId();const matches=items.filter(item=>item.toLowerCase().includes(value.toLowerCase()));
  return <div className="ds-combobox"><label className="ds-control-label" htmlFor={id}>{label}</label><input className="ds-input" id={id} role="combobox" aria-expanded={expanded} aria-autocomplete="list" aria-controls={id+"-list"} aria-activedescendant={expanded&&matches.length?id+"-opt-"+active:undefined} value={value} onFocus={()=>setExpanded(true)} onChange={e=>{onChange(e.target.value);setActive(0);setExpanded(true)}} onKeyDown={e=>{if(e.key==="ArrowDown"){e.preventDefault();setExpanded(true);setActive(i=>Math.min(matches.length-1,i+1))}if(e.key==="ArrowUp"){e.preventDefault();setActive(i=>Math.max(0,i-1))}if(e.key==="Enter"&&expanded&&matches[active]){onChange(matches[active]);setExpanded(false)}if(e.key==="Escape")setExpanded(false)}} onBlur={()=>setTimeout(()=>setExpanded(false),100)} />
  {expanded&&<div role="listbox" id={id+"-list"} className="ds-combobox-list">{matches.length?matches.map((item,i)=><button type="button" role="option" aria-selected={i===active} id={id+"-opt-"+i} key={item} onPointerDown={e=>e.preventDefault()} onClick={()=>{onChange(item);setExpanded(false)}}>{item}</button>):<p>No matching tags</p>}</div>}</div>;
}
export function DsTable({rows}:{rows:{name:string;bpm:number;status:string}[]}) {
  return <div className="ds-table-scroll"><table className="ds-table"><thead><tr><th scope="col">Beat</th><th scope="col">Tempo</th><th scope="col">Status</th></tr></thead><tbody>{rows.map(row=><tr key={row.name}><th scope="row">{row.name}</th><td>{row.bpm} BPM</td><td><DsBadge tone={row.status==="Ready"?"success":"warning"}>{row.status}</DsBadge></td></tr>)}</tbody></table></div>;
}
export function DsEmpty({onReset}:{onReset:()=>void}) {return <div className="ds-empty"><DsIcon name="music" size={28}/><strong>No beats found</strong><p>Try another search or reset your filters.</p><LabButton onClick={onReset}>Clear filters</LabButton></div>}
export function DsToolbar({children}:HTMLAttributes<HTMLDivElement>){return <div className="ds-toolbar" role="toolbar" aria-label="Library actions">{children}</div>}
