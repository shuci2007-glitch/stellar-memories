import landmarkCatalog from "../core/provinceLandmarks.json";
import {useWallCamera} from './useWallCamera';
import {useWallPhotoDrag,type WallPhotoMotion} from './useWallPhotoDrag';
import WallLandmarkArt from './WallLandmarkArt';
import '../styles/province-wall.css';
import {useEffect,useMemo,useRef,useState,type CSSProperties} from 'react';
import {ipc} from '../core/db';
import {tmPhoto,tmPreview,tmThumb,type Photo} from '../core/types';
import {buildProvinceWall,emptyWallNotes,type ProvinceShape,type ProvinceWallNotes} from '../core/provinceWall';

type Layout=ReturnType<typeof buildProvinceWall>;

/** Small Verlet ropes: fixed photo endpoints, gravity, inertia and length constraints. */
function WallThreads({layout,board,highlighted,motion}:{motion:React.RefObject<WallPhotoMotion>;highlighted:number|null;layout:Layout;board:React.RefObject<HTMLDivElement|null>}) {
 const svg=useRef<SVGSVGElement>(null);
 useEffect(()=>{
  const el=svg.current,host=board.current;if(!el||!host)return;
  const nodes=layout.cards.map(c=>({...motion.current.rendered.get(c.photo.id)??{x:c.x,y:c.y,scale:1},vx:0,vy:0}));
  let revision=motion.current.revision;
  const ropes=layout.links.map(([a,b])=>{
   const start=nodes[a],end=nodes[b];
   return {a,b,length:Math.hypot(end.x-start.x,end.y-start.y)/12*1.06,points:Array.from({length:13},(_,i)=>({x:start.x+(end.x-start.x)*i/12,y:start.y+(end.y-start.y)*i/12-61+Math.sin(i/12*Math.PI)*12,px:start.x+(end.x-start.x)*i/12,py:start.y+(end.y-start.y)*i/12-61+Math.sin(i/12*Math.PI)*12}))};
  });
  let raf=0,previous=performance.now();const pointer={x:-1e6,y:-1e6};
  const move=(e:PointerEvent)=>{const r=host.getBoundingClientRect();pointer.x=(e.clientX-r.left)*layout.width/r.width;pointer.y=(e.clientY-r.top)*layout.height/r.height;};
  const leave=()=>{pointer.x=pointer.y=-1e6;};
  host.addEventListener('pointermove',move);host.addEventListener('pointerleave',leave);
  const cards=host.querySelectorAll<HTMLElement>('.province-wall-card');
  const paths=el.querySelectorAll<SVGPathElement>('.wall-thread'),fibers=el.querySelectorAll<SVGPathElement>('.wall-hemp-fiber'),tethers=el.querySelectorAll<SVGPathElement>('.wall-tether');
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tick=(now:number)=>{
   const dt=Math.min(2,(now-previous)/16.667);previous=now;
   if(revision!==motion.current.revision){revision=motion.current.revision;nodes.forEach((n,i)=>Object.assign(n,motion.current.rendered.get(layout.cards[i].photo.id)));}
   nodes.forEach((n,i)=>{
    const c=layout.cards[i],home=motion.current.homes.get(c.photo.id)??{x:c.x,y:c.y,scale:1};
    const active=motion.current.draggingId===c.photo.id?motion.current.preview:null;
    if(active){n.x=active.x;n.y=active.y;n.scale=active.scale;}
    else {
     const dx=home.x-pointer.x,dy=home.y-pointer.y,dist=Math.hypot(dx,dy);
     const force=!reduced&&motion.current.draggingId===null&&dist<160?(1-dist/160)*4:0;
     const ease=1-Math.exp(-.22*dt);
     n.x+=(home.x+(dist>1?dx/dist*force:0)-n.x)*ease;
     n.y+=(home.y+(dist>1?dy/dist*force:0)-n.y)*ease;n.scale+=(home.scale-n.scale)*ease;
    }
    motion.current.rendered.set(c.photo.id,{x:n.x,y:n.y,scale:n.scale});
    if(cards[i]){cards[i].style.transform=`translate(${n.x-c.x}px,${n.y-c.y}px) scale(${n.scale})`;cards[i].style.setProperty('--photo-size',`"${Math.round(n.scale*100)}%"`);}
    tethers[i]?.setAttribute('d',`M${c.pin.x},${c.pin.y} Q${c.pin.x},${n.y+35*n.scale} ${n.x},${n.y+45*n.scale}`);
   });
   ropes.forEach((rope,i)=>{
    const ps=rope.points,a=nodes[rope.a],b=nodes[rope.b];
    const distance=Math.hypot(b.x-a.x,(b.y-61*b.scale)-(a.y-61*a.scale));
    rope.length+=(distance/12*1.06-rope.length)*(1-Math.exp(-.25*dt));
    if(paths[i]?.parentElement)paths[i].parentElement!.style.opacity=String(Math.max(0,Math.min(1,(1200-distance)/400)));
    for(let j=1;j<12;j++){
     const p=ps[j],vx=(p.x-p.px)*Math.pow(.965,dt),vy=(p.y-p.py)*Math.pow(.965,dt);p.px=p.x;p.py=p.y;p.x+=vx;p.y+=vy+.075*dt*dt;
     const dx=p.x-pointer.x,dy=p.y-pointer.y,d=Math.hypot(dx,dy);if(!reduced&&d>1&&d<48){p.x+=dx/d*(1-d/48)*.5;p.y+=dy/d*(1-d/48)*.5;}
    }
    for(let k=0;k<6;k++){
     ps[0].x=nodes[rope.a].x;ps[0].y=nodes[rope.a].y-61*nodes[rope.a].scale;ps[12].x=nodes[rope.b].x;ps[12].y=nodes[rope.b].y-61*nodes[rope.b].scale;
     for(let j=0;j<12;j++){const a=ps[j],b=ps[j+1],dx=b.x-a.x,dy=b.y-a.y,d=Math.max(.001,Math.hypot(dx,dy)),f=(d-rope.length)/d*.5;if(j){a.x+=dx*f;a.y+=dy*f;}if(j<11){b.x-=dx*f;b.y-=dy*f;}}
    }
    paths[i]?.setAttribute('d',ps.map((p,j)=>`${j?'L':'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' '));
    // Two counter-wound strands follow the live rope curve, not a flat dashed line.
    let length=0;const strands=['',''];
    for(let j=0;j<12;j++){
     const a=ps[j],b=ps[j+1],dx=b.x-a.x,dy=b.y-a.y,d=Math.max(.01,Math.hypot(dx,dy)),steps=Math.max(1,Math.min(24,Math.ceil(d/3)));
     for(let k=0;k<steps;k++){
      const f=k/steps;
      for(let strand=0;strand<2;strand++){const offset=Math.sin((length+d*f)*.7+strand*Math.PI)*1.05;strands[strand]+=`${j||k?'L':'M'}${(a.x+dx*f-dy/d*offset).toFixed(2)},${(a.y+dy*f+dx/d*offset).toFixed(2)} `;}
     }length+=d;
    }
    fibers[i*2]?.setAttribute('d',strands[0]);fibers[i*2+1]?.setAttribute('d',strands[1]);
   });
   raf=requestAnimationFrame(tick);
  };raf=requestAnimationFrame(tick);
  return()=>{cancelAnimationFrame(raf);host.removeEventListener('pointermove',move);host.removeEventListener('pointerleave',leave);};
 },[layout,board,motion]);
 return <svg ref={svg} className="province-wall-threads" viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">{layout.cards.map(c=><path className={"wall-tether"+(highlighted===c.photo.id?" is-highlighted":"")} key={c.photo.id}/>)}{layout.links.map(([a,b])=><g key={`${a}-${b}`}><path className="wall-thread"/><path className="wall-hemp-fiber"/><path className="wall-hemp-fiber wall-hemp-shadow"/></g>)}</svg>;
}

export default function ProvincePhotoWall({name,shape,districts=[],photos,onClose}:{name:string;shape:ProvinceShape;districts?:ProvinceShape[];photos:Photo[];onClose:()=>void}) {
 const landmarks=useMemo(()=>landmarkCatalog.filter(p=>p.province===name),[name]);
 const layout=useMemo(()=>buildProvinceWall(shape,photos,landmarks),[shape,photos,landmarks]);
 const [highlighted,setHighlighted]=useState<number|null>(null);
 const board=useRef<HTMLDivElement>(null),viewport=useRef<HTMLDivElement>(null),sheet=useRef<HTMLElement>(null);
 const [flipped,setFlipped]=useState<Set<number>>(new Set());
 const [notes,setNotes]=useState<ProvinceWallNotes>(emptyWallNotes),[loaded,setLoaded]=useState(false),[status,setStatus]=useState('正在读取照片墙…'),[failure,setFailure]=useState('');
 const [focus,setFocus]=useState<Photo|null>(null),[closing,setClosing]=useState(false);
 const latest=useRef(notes),saved=useRef(''),queue=useRef<Promise<void>>(Promise.resolve()),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const live=useRef(true),closingRef=useRef(false),focusSource=useRef<HTMLElement|null>(null),focusEl=useRef<HTMLDivElement>(null);
 const [imageReady,setImageReady]=useState(false);
 const focusAnimation=useRef<Animation|null>(null),focusClosing=useRef(false);
 const key=`province_wall_${name}`;
 const flush=()=>{
  const snapshot=JSON.stringify(latest.current);
  const task=queue.current.catch(()=>{}).then(async()=>{
   if(snapshot===saved.current)return;
   await ipc.saveProvinceWall(name,JSON.parse(snapshot));saved.current=snapshot;
   if(live.current&&JSON.stringify(latest.current)===snapshot){setStatus('摆放与手记已保存');setFailure('');}
  });queue.current=task;return task;
 };
 const flushRef=useRef(flush);flushRef.current=flush;
 useEffect(()=>{
  live.current=true;let dead=false;
  ipc.getSetting(key).then(raw=>{
   if(dead)return;const value=raw?JSON.parse(raw):emptyWallNotes();
   if(typeof value.wallText!=='string'||!value.photoNotes||typeof value.photoNotes!=='object'||Array.isArray(value.photoNotes)||Object.values(value.photoNotes).some(v=>typeof v!=='string'))throw new Error('手记格式无法读取');
   const validPositions=value.photoPositions??{},validScales=value.photoScales??{};
   if(typeof validPositions!=='object'||Array.isArray(validPositions)||Object.values(validPositions).some(p=>!Array.isArray(p)||p.length!==2||p.some(n=>typeof n!=='number'||!Number.isFinite(n))||Math.abs(p[0])>180||Math.abs(p[1])>90))throw new Error('摆放位置无法读取');
   if(typeof validScales!=='object'||Array.isArray(validScales)||Object.values(validScales).some(s=>typeof s!=='number'||!Number.isFinite(s)||s<.65||s>2.4))throw new Error('照片尺寸无法读取');
   value.photoPositions=validPositions;value.photoScales=validScales;
   latest.current=value;saved.current=JSON.stringify(value);setNotes(value);setLoaded(true);setStatus('摆放与手记已保存');
  }).catch(e=>{if(!dead){setStatus('手记读取失败');setFailure(String(e));}});
  const el=sheet.current;el?.animate([{transform:'translateY(-105%)'},{transform:'translateY(0)'}],{duration:850,easing:'cubic-bezier(.16,1,.3,1)'});
  return()=>{dead=true;live.current=false;if(timer.current)clearTimeout(timer.current);if(saved.current)void flushRef.current().catch(()=>{});};
 },[key,name]);
 const update=(value:ProvinceWallNotes)=>{
  latest.current=value;setNotes(value);setStatus('正在保存…');if(timer.current)clearTimeout(timer.current);
  timer.current=setTimeout(()=>{void flushRef.current().catch(e=>{if(live.current){setStatus('保存失败');setFailure(String(e));}});},650);
 };
 const close=async()=>{
  if(closingRef.current)return;closingRef.current=true;setClosing(true);
  try{
   if(timer.current)clearTimeout(timer.current);if(loaded)await flushRef.current();
   await sheet.current?.animate([{transform:'translateY(0)'},{transform:'translateY(-105%)'}],{duration:620,easing:'cubic-bezier(.5,0,.8,.3)',fill:'forwards'}).finished;
   onClose();
  }catch(e){closingRef.current=false;setClosing(false);setFailure(`未能保存：${e}`);setStatus('请重试保存');}
 };
 const closeRef=useRef(close);closeRef.current=close;
 const shrink=async()=>{
  if(focusClosing.current)return;focusClosing.current=true;
  const el=focusEl.current,src=focusSource.current;if(!el){setFocus(null);focusClosing.current=false;return;}
  const parent=el.offsetParent?.getBoundingClientRect(),b=src?.getBoundingClientRect();
  const left=(parent?.left??0)+el.offsetLeft,top=(parent?.top??0)+el.offsetTop;
  const current=getComputedStyle(el).transform;focusAnimation.current?.cancel();
  await el.animate([{transform:current,opacity:1},{transform:b?`translate(${b.left-left}px,${b.top-top}px) scale(${b.width/el.offsetWidth},${b.height/el.offsetHeight})`:'scale(.9)',opacity:b?1:0}],{duration:450,easing:'cubic-bezier(.4,0,.4,1)',fill:'forwards'}).finished.catch(()=>{});
  setFocus(null);focusClosing.current=false;
 };
 const focusRef=useRef({focus,shrink});focusRef.current={focus,shrink};
 useEffect(()=>{const keydown=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();if(photoDrag.controls.current.isDragging()){photoDrag.controls.current.cancel();return;}if(focusRef.current.focus)void focusRef.current.shrink();else void closeRef.current();}};window.addEventListener('keydown',keydown,true);return()=>window.removeEventListener('keydown',keydown,true);},[]);
 useEffect(()=>{
  if(!focus||!focusEl.current)return;
  const el=focusEl.current,source=focusSource.current;const a=el.getBoundingClientRect(),b=source?.getBoundingClientRect();
  focusAnimation.current=el.animate([{transform:b?`translate(${b.left-a.left}px,${b.top-a.top}px) scale(${b.width/a.width},${b.height/a.height})`:'scale(.9)'},{transform:'none'}],{duration:600,easing:'cubic-bezier(.16,1,.3,1)'});
  return()=>{focusAnimation.current?.cancel();};
 },[focus]);
 const initialCenter=useMemo(()=>layout.cards.length?{
  x:(Math.min(...layout.cards.map(c=>c.x))+Math.max(...layout.cards.map(c=>c.x)))/2,
  y:(Math.min(...layout.cards.map(c=>c.y))+Math.max(...layout.cards.map(c=>c.y)))/2,
 }:undefined,[layout]);
 const camera=useWallCamera(viewport,board,layout.width,layout.height,photos.length,initialCenter);
 const photoDrag=useWallPhotoDrag(layout,board,loaded,!closing&&!focus,notes,(id,position,scale)=>{
  update({...latest.current,photoPositions:{...latest.current.photoPositions,[id]:position},photoScales:{...latest.current.photoScales,[id]:scale}});
 });
 const toggle=(id:number)=>setFlipped(old=>{const next=new Set(old);if(next.has(id))next.delete(id);else next.add(id);return next;});
 return <section ref={sheet} className="province-wall" role="dialog" aria-modal="true" aria-label={`${name}照片墙`}>
  <header className="province-wall-header"><div><small>把走过的风景，留在这里</small><h1>{name}<span> · 回忆手帐</span></h1><p>{photos.length} 张照片 · 拖照片摆放 · 拖照片左下角调大小 · 滚轮缩放地图 · 点击放大，点写字翻面</p></div><div className="province-wall-tools"><button onClick={()=>camera.current.zoomBy(1/1.25)} aria-label="缩小照片墙">−</button><button onClick={()=>camera.current.fit()}>全览</button><button onClick={()=>camera.current.zoomBy(1.25)} aria-label="放大照片墙">＋</button><button disabled={closing} onClick={()=>void close()} aria-label="收起照片墙">收起 ×</button></div></header>
  <div className="province-wall-workspace"><div ref={viewport} className="province-wall-viewport"><div className="wall-camera-space"><div ref={board} className="province-wall-board" style={{width:layout.width,height:layout.height,transformOrigin:'0 0'}}>
   <svg className="province-wall-map" viewBox={`0 0 ${layout.width} ${layout.height}`} aria-label={`${name}地图`}>
    <defs><clipPath id="wall-province-clip">{layout.paths.map((d,i)=><path key={i} d={d} clipRule="evenodd"/>)}</clipPath><pattern id="wall-paper" width="12" height="12" patternUnits="userSpaceOnUse"><path d="M0 3H12M3 0V12" stroke="#9a927b" strokeWidth=".25" opacity=".08"/></pattern></defs>
    <rect width="100%" height="100%" fill="url(#wall-paper)"/>
    {layout.paths.map((d,i)=><path key={i} d={d} fill="#c4cbb2" fillRule="evenodd" stroke="#929880" strokeWidth="2" strokeLinejoin="round"/>)}
    <g clipPath="url(#wall-province-clip)"><image href={`/maps/province-relief/${encodeURIComponent(name)}.png?v=surface-20260909`} x={layout.project(layout.bounds.minLng,layout.bounds.maxLat).x} y={layout.project(layout.bounds.minLng,layout.bounds.maxLat).y} width={layout.project(layout.bounds.maxLng,0).x-layout.project(layout.bounds.minLng,0).x} height={layout.project(0,layout.bounds.minLat).y-layout.project(0,layout.bounds.maxLat).y} preserveAspectRatio="none"/>{districts.map((district,i)=>{const polys=district.geometry.type==='Polygon'?[district.geometry.coordinates as number[][][]]:district.geometry.coordinates as number[][][][];const d=polys.map(p=>p.map(r=>r.map(([lng,lat],j)=>{const at=layout.project(lng,lat);return `${j?'L':'M'}${at.x},${at.y}`;}).join(' ')+' Z').join(' ')).join(' ');return <path key={i} d={d} fill="none" stroke="#f7f0d9" strokeWidth="1.2" opacity=".8"/>;})}</g>
    <text x="50" y="70" className="wall-map-title">{name} · 旅行地图</text><g transform={`translate(${layout.width-90},65)`} stroke="#92937e" fill="none"><path d="M0 -24V24M-18 0H18M0 -24L-5 -11L0 -15L5 -11Z"/><text x="-5" y="-32" fill="#92937e" stroke="none" fontSize="12">N</text></g>
    {layout.landmarkPlacements.map(p=><g key={p.source} className="wall-landmark"><title>{p.name}</title>{Math.hypot(p.x-p.pin.x,p.y-p.pin.y)>35&&<path d={`M${p.pin.x} ${p.pin.y}L${p.x} ${p.y}`} className="wall-landmark-leader"/>}<circle cx={p.pin.x} cy={p.pin.y} r="3" fill="#9b825e"/><g transform={`translate(${p.x},${p.y})`}><WallLandmarkArt name={p.name}/><text x="0" y="25" textAnchor="middle">{(p.name.replace(/\s*[（(].*?[)）]/g,'').match(/.{1,8}/gu)??[p.name]).map((line,i)=><tspan key={i} x="0" dy={i?21:0}>{line}</tspan>)}</text></g></g>)}
    {layout.cards.map(c=><circle opacity={highlighted===c.photo.id?1:0} key={c.photo.id} cx={c.pin.x} cy={c.pin.y} r="4" fill="#ad8169"/>)}
   </svg>
   <WallThreads layout={layout} board={board} highlighted={highlighted} motion={photoDrag.motion}/>
   {layout.cards.map(c=><article key={c.photo.id} className="province-wall-card" data-photo-id={c.photo.id} onPointerEnter={()=>setHighlighted(c.photo.id)} onPointerLeave={()=>setHighlighted(null)} onFocus={()=>setHighlighted(c.photo.id)} onBlur={()=>setHighlighted(null)} style={{left:c.x-73,top:c.y-61} as CSSProperties}><i className="wall-card-clip"/><div style={{rotate:`${c.tilt}deg`}} className={'wall-card-flipper'+(flipped.has(c.photo.id)?' is-flipped':'')}><div className="wall-card-front" inert={flipped.has(c.photo.id)}><button className="wall-card-image" onClick={e=>{focusSource.current=e.currentTarget;setImageReady(false);setFocus(c.photo);}} title="放大照片"><img src={tmPreview(c.photo.id)} alt={c.photo.filename} draggable={false} loading="lazy"/></button><footer><span>{c.photo.captureDate?.slice(0,10)||'某个好日子'}</span></footer></div><div className="wall-card-back" inert={!flipped.has(c.photo.id)}><textarea disabled={!loaded||closing} aria-label={`${c.photo.filename}背面手记`} placeholder="写在照片背面…" value={notes.photoNotes[c.photo.id]??''} onChange={e=>update({...latest.current,photoNotes:{...latest.current.photoNotes,[c.photo.id]:e.target.value}})} onBlur={()=>{void flushRef.current().catch(e=>setFailure(String(e)));}}/></div></div><button className="wall-card-flip-toggle" onClick={e=>{e.stopPropagation();toggle(c.photo.id);}} aria-label={`翻转${c.photo.filename}`} aria-pressed={flipped.has(c.photo.id)}>{flipped.has(c.photo.id)?'正面 ↻':'写字 ↺'}</button><button className="wall-card-resize" data-wall-resize disabled={!loaded||closing} aria-label={`调整 ${c.photo.filename} 大小，拖动或按方向键`} title="拖动调节大小 · 方向键微调" onClick={e=>e.stopPropagation()}>↙</button></article>)}
  </div></div></div><aside className="province-wall-journal"><small>写给这段旅程</small><h2>留一页心情</h2><textarea disabled={!loaded||closing} aria-label="照片墙手记" placeholder="天气、路上的小事、想再去的地方…" value={notes.wallText} onChange={e=>update({...latest.current,wallText:e.target.value})}/><span role="status">{status}</span>{failure&&<div className="wall-save-error">{failure}{loaded&&<button onClick={()=>void flushRef.current().catch(e=>setFailure(String(e)))}>重试保存</button>}</div>}<div className="wall-landmark-list"><small>地图上的风景</small>{layout.landmarkPlacements.map(p=><button key={p.source} onClick={()=>camera.current.focusAt(p.x,p.y)} title={`在地图中找到${p.name}`}>⌖ {p.name}</button>)}<small>省界：DataV.GeoAtlas<br/>景点坐标：Wikidata · CC0<br/>地形：Mapzen / SRTM<br/>地表：Solar System Scope · CC BY 4.0</small></div></aside></div>
  {focus&&<div className="wall-photo-focus" onClick={()=>void shrink()}><button className="wall-focus-close" onClick={e=>{e.stopPropagation();void shrink();}} aria-label="收回照片">×</button><div ref={focusEl} className="wall-focus-image" style={{aspectRatio:`${focus.width||4}/${focus.height||3}`,width:`min(80vw, ${76*(focus.width||4)/(focus.height||3)}vh)`}} onClick={e=>e.stopPropagation()}><img src={tmThumb(focus.id)} alt=""/><img src={tmPhoto(focus.id)} alt={focus.filename} onLoad={()=>setImageReady(true)} style={{opacity:imageReady?1:0}}/></div></div>}
 </section>;
}
