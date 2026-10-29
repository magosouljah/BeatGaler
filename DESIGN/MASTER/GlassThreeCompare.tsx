import {useRef,useState} from "react";
import ArchisOriginalSpecimen from "./ArchisOriginalSpecimen";
import NaughtyOriginalButton from "./NaughtyOriginalButton";
import StudioOriginalButton from "./StudioOriginalButton";
import "./glass-comparison.css";

type Offset={x:number;y:number};
function MotionStage({children,studio=false}:{children:(offset:Offset)=>React.ReactNode;studio?:boolean}){
  const [offset,setOffset]=useState<Offset>({x:0,y:0});
  const drag=useRef<{x:number;y:number;start:Offset}|null>(null);
  const move=(dx:number,dy:number)=>setOffset(prev=>({x:Math.max(-550,Math.min(550,prev.x+dx)),y:Math.max(-550,Math.min(550,prev.y+dy))}));
  return <div className={`glass-comparison-stage${studio?" is-studio":""}`}
    data-background-offset-x={Math.round(offset.x)}
    data-background-offset-y={Math.round(offset.y)}
    onWheel={e=>{e.preventDefault();move(-e.deltaX,-e.deltaY)}}
    onPointerDown={e=>{
      if(e.button!==0||e.target instanceof Element&&e.target.closest('[role="button"],button'))return;
      drag.current={x:e.clientX,y:e.clientY,start:offset};
      e.currentTarget.setPointerCapture(e.pointerId);
    }}
    onPointerMove={e=>{
      if(!drag.current)return;
      const p=drag.current;
      setOffset({x:Math.max(-550,Math.min(550,p.start.x+e.clientX-p.x)),
        y:Math.max(-550,Math.min(550,p.start.y+e.clientY-p.y))});
    }}
    onPointerUp={e=>{drag.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId)}}
    onPointerCancel={()=>{drag.current=null}}>
    {!studio&&<div className="glass-comparison-textured" aria-hidden="true"
      style={{transform:`translate3d(${offset.x}px,${offset.y}px,0)`}}>
      <div className="glass-comparison-stripe"/>
      <div className="glass-comparison-bigtype">REFRACT</div>
      <div className="glass-comparison-grid"/>
      <div className="glass-comparison-number">0123456789</div>
    </div>}
    {children(offset)}
  </div>;
}
export default function GlassThreeCompare(){
  return <div className="glass-comparison" data-glass-3-compare>
    <p className="glass-comparison-instruction">Arrastra el fondo o usa la rueda del mouse sobre cada muestra para comprobar cómo refracta el contenido. Los motores no comparten efectos ni controles.</p>
    <div className="glass-comparison-grid-layout">
      <section className="glass-comparison-card" aria-label="NaughtyDuk liquidGL original">
        <header><strong>1. NaughtyDuk</strong><span>liquidGL · WebGL2</span></header>
        <MotionStage>{()=> <NaughtyOriginalButton/>}</MotionStage>
        <p>Motor liquidGL original · snapshot del DOM</p>
      </section>
      <section className="glass-comparison-card" aria-label="Archis Vaze original">
        <header><strong>2. Archis Vaze</strong><span>SVG · Chromium</span></header>
        <ArchisOriginalSpecimen compact/>
        <p>Filtro SVG y cálculos originales · sin seguimiento del mouse</p>
      </section>
      <section className="glass-comparison-card" aria-label="iyinchao Liquid Glass Studio original">
        <header><strong>3. iyinchao</strong><span>Liquid Glass Studio · WebGL2</span></header>
        <MotionStage studio>{offset=><StudioOriginalButton offset={offset}/>}</MotionStage>
        <p>Shaders GLSL y renderizador multipaso originales</p>
      </section>
    </div>
  </div>;
}
