import {useEffect,useRef,useState} from 'react';
import {Marker,type Map as GlobeMap} from 'maplibre-gl';
import {ipc} from '../core/db';
import {tmThumb,type Photo} from '../core/types';

export interface PhotoPlaceGroup {provinceKey?:string;key:string;name:string;lng:number;lat:number;photos:Photo[]}

const suppressedClicks=new WeakSet<HTMLElement>();
export function consumeLocationDragClick(source:HTMLElement) {
 if(!suppressedClicks.has(source))return false;
 suppressedClicks.delete(source);return true;
}
export function startLocatedPhotoDrag(event:PointerEvent,photo:Photo,source:HTMLElement) {
 if(event.button!==0)return;
 event.stopPropagation();
 window.dispatchEvent(new CustomEvent('map-located-photo-drag',{detail:{event,photo,source}}));
}

function photoMapScale(map:GlobeMap) {
 // A quarter zoom exponent keeps cards usable while changing at every zoom level.
 // No saturation: zooming out always shrinks the entire stack, even close up.
 return Math.pow(2,(map.getZoom()-5)/4);
}

function applyPhotoScale(marker:Marker,scale:number) {
 const sizing=marker.getElement().firstElementChild as HTMLElement|null;
 if(sizing)sizing.style.transform=`scale(${scale}) translateY(-9px)`;
}

/** Marker owns geographic projection; only its child floats, so dragging stays anchored. */
export function MapPhotoStacks({map,groups,onOpen,onWall,disabled,editable=false}:{onWall?:(group:PhotoPlaceGroup)=>void;editable?:boolean;map:GlobeMap|null;groups:PhotoPlaceGroup[];onOpen:(group:PhotoPlaceGroup)=>void;disabled:boolean}) {
 const markers=useRef(new Map<string,{marker:Marker;button:HTMLButtonElement;signature:string;group:PhotoPlaceGroup;fade:number;retiring:boolean;travel?:{from:[number,number];to:[number,number];start:number;alpha:number;targetAlpha:number}}>()).current;
 const movement=useRef(0);
 const current=useRef({groups,onOpen,onWall,disabled,editable});current.current={groups,onOpen,onWall,disabled,editable};
 useEffect(()=>{
  if(!map)return;
  const keep=new Set(groups.map(g=>g.key)),previous=[...markers.values()],now=performance.now();
  const related=(a:PhotoPlaceGroup,b:PhotoPlaceGroup)=>a.photos.some(p=>b.photos.some(q=>q.id===p.id));
  for(const [key,item] of markers)if(!keep.has(key)&&!item.retiring){
   item.retiring=true;item.button.style.pointerEvents='none';
   const destination=groups.find(g=>related(item.group,g)),at=item.marker.getLngLat();
   item.travel={from:[at.lng,at.lat],to:destination?[destination.lng,destination.lat]:[at.lng,at.lat],start:now,alpha:item.fade,targetAlpha:0};
  }
  for(const group of groups){
   let item=markers.get(group.key);
   if(!item){
    const el=document.createElement('div');el.className='earth-photo-marker';
    const button=document.createElement('button');button.className='earth-photo-stack';button.type='button';
    button.style.animationDelay=`-${group.photos[0].id%43/10}s`;
    button.onpointerdown=e=>{const c=current.current;const g=c.groups.find(g=>g.key===group.key);if(c.editable&&g&&!c.disabled)startLocatedPhotoDrag(e,g.photos[0],button);};
    button.ondblclick=e=>{e.preventDefault();e.stopPropagation();const c=current.current,g=c.groups.find(g=>g.key===group.key);if(!c.disabled&&!c.editable&&g)c.onWall?.(g);};
    button.onclick=e=>{e.stopPropagation();if(consumeLocationDragClick(button))return;const c=current.current;if(c.disabled)return;const g=c.groups.find(g=>g.key===group.key);if(g)c.onOpen(g);};
    const sizing=document.createElement('div');sizing.className='earth-photo-size';sizing.append(button);el.append(sizing);
    const pin=document.createElement('i');pin.className='earth-photo-pin';pin.setAttribute('aria-hidden','true');el.append(pin);
    const origin=previous.find(p=>related(p.group,group))?.marker.getLngLat();
    const from:[number,number]=origin?[origin.lng,origin.lat]:[group.lng,group.lat];
    const marker=new Marker({element:el,anchor:'bottom',opacityWhenCovered:0}).setLngLat(from).addTo(map);
    el.style.setProperty('--stack-alpha','0');
    item={marker,button,signature:'',group,fade:0,retiring:false,travel:{from,to:[group.lng,group.lat],start:now,alpha:0,targetAlpha:1}};markers.set(group.key,item);
   }
   if(item.retiring||item.group.lng!==group.lng||item.group.lat!==group.lat){const at=item.marker.getLngLat();item.travel={from:[at.lng,at.lat],to:[group.lng,group.lat],start:now,alpha:item.fade,targetAlpha:1};}
   item.retiring=false;item.group=group;item.button.style.pointerEvents='';item.button.disabled=disabled;
   applyPhotoScale(item.marker,photoMapScale(map));
   const signature=group.photos.map(p=>p.id).join(',');
   if(signature!==item.signature){
    item.signature=signature;
    const visible=group.photos.slice(0,3);
    // Reuse the front image across additions; the stack never flashes empty.
    visible.forEach((photo,i)=>{
     let img=item!.button.querySelector<HTMLImageElement>(`img[data-slot="${i}"]`);
     if(!img){img=document.createElement('img');img.dataset.slot=String(i);img.draggable=false;img.alt='';item!.button.append(img);}
     if(img.dataset.photo!==String(photo.id)){img.src=tmThumb(photo.id);img.dataset.photo=String(photo.id);}
     img.style.setProperty('--layer',String(i));img.style.zIndex=String(3-i);
    });
    for(const img of item.button.querySelectorAll<HTMLImageElement>('img'))if(Number(img.dataset.slot)>=visible.length)img.remove();
    let label=item.button.querySelector('span');if(!label){label=document.createElement('span');item.button.append(label);}
    label.textContent=`${group.name} · ${group.photos.length}`;
    item.button.setAttribute('aria-label',`${group.name}，${group.photos.length} 张照片，单击查看，双击展开照片墙`);
   }
  }
  cancelAnimationFrame(movement.current);
  const animate=(time:number)=>{
   let pending=false;
   for(const [key,item] of markers){
    const travel=item.travel;if(!travel)continue;
    const t=Math.min(1,(time-travel.start)/650),ease=t*t*(3-2*t);
    item.marker.setLngLat([travel.from[0]+(travel.to[0]-travel.from[0])*ease,travel.from[1]+(travel.to[1]-travel.from[1])*ease]);
    item.fade=travel.alpha+(travel.targetAlpha-travel.alpha)*ease;
    item.marker.getElement().style.setProperty('--stack-alpha',String(item.fade));
    if(t<1)pending=true;else if(item.retiring){item.marker.remove();markers.delete(key);}else item.travel=undefined;
   }
   if(pending)movement.current=requestAnimationFrame(animate);
  };movement.current=requestAnimationFrame(animate);
 },[map,groups,disabled]);
 useEffect(()=>{
  if(!map)return;
  let previous=-1;
  const sync=()=>{
   const scale=photoMapScale(map);if(scale===previous)return;previous=scale;
   for(const {marker} of markers.values())applyPhotoScale(marker,scale);
  };
  sync();map.on('zoom',sync);map.on('render',sync);
  return()=>{map.off('zoom',sync);map.off('render',sync);};
 },[map]);
 useEffect(()=>()=>{cancelAnimationFrame(movement.current);for(const item of markers.values())item.marker.remove();markers.clear();},[map]);
 return null;
}

export function QuickLocationTray({map,photos,groups,regionKey,onSaved,onClose,active}:{map:GlobeMap|null;photos:Photo[];groups:PhotoPlaceGroup[];regionKey:(lng:number,lat:number)=>string;onSaved:()=>Promise<void>;onClose:()=>void;active:boolean}) {
 const ghost=useRef<HTMLDivElement>(null),tray=useRef<HTMLElement>(null),foot=useRef<HTMLDivElement>(null);
 const drag=useRef<{id:number;pointer:number;source:HTMLElement;started:boolean;located:boolean;originX:number;originY:number;x:number;y:number;settling:boolean}|null>(null);
 const [busy,setBusy]=useState<number|null>(null),[message,setMessage]=useState('将照片拖到地球上的拍摄地点，松手保存');
 const alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;ghost.current?.closest('.memory-map')?.classList.remove('is-photo-locating');ghost.current?.getAnimations().forEach(a=>a.cancel());};},[]);
 const targetAt=(x:number,y:number)=>{
  if(!map)return null;
  const rect=map.getCanvas().getBoundingClientRect(),px=x-rect.left,py=y-rect.top;
  if(px<0||py<0||px>rect.width||py>rect.height)return null;
  const hit=document.elementFromPoint(x,y);
  if(hit?.closest('.quick-location-tray,.map-journal,.map-nearby-panel,.topbar,.location-editor'))return null;
  const ll=map.unproject([px,py]);
  if(!Number.isFinite(ll.lng)||!Number.isFinite(ll.lat)||Math.abs(ll.lat)>85.051129)return null;
  // Globe unprojection clamps sky points to the horizon. Reject that clamp.
  const projected=map.project(ll);
  if(Math.hypot(projected.x-px,projected.y-py)>2)return null;
  return {lng:((ll.lng+180)%360+360)%360-180,lat:ll.lat};
 };
 const moveGhost=(x:number,y:number)=>{if(ghost.current)ghost.current.style.transform=`translate3d(${x-40}px,${y-84}px,0)`;if(foot.current)foot.current.style.transform=`translate3d(${x}px,${y}px,0)`;};
 const reset=()=>{ghost.current?.closest('.memory-map')?.classList.remove('is-photo-locating');const d=drag.current;if(d)d.source.style.opacity='';drag.current=null;tray.current?.classList.remove('accept-location-return');if(foot.current)foot.current.style.display='none';if(ghost.current)ghost.current.style.display='none';if(alive.current)setBusy(null);};
 const returnToSource=async()=>{
  const d=drag.current,el=ghost.current;if(!d||!el)return;d.settling=true;
  await el.animate([{transform:el.style.transform,opacity:1},{transform:`translate3d(${d.originX-40}px,${d.originY-31}px,0) scale(.8)`,opacity:0}],{duration:380,easing:'cubic-bezier(.2,.7,.2,1)',fill:'forwards'}).finished.catch(()=>{});
  el.getAnimations().forEach(a=>a.cancel());reset();
 };
 useEffect(()=>{
  const cancel=(e:KeyboardEvent)=>{if(e.key==='Escape'&&drag.current){e.preventDefault();e.stopImmediatePropagation();if(!drag.current.settling)void returnToSource();}};
  window.addEventListener('keydown',cancel,true);return()=>window.removeEventListener('keydown',cancel,true);
 },[]);
 useEffect(()=>{if(!active&&drag.current&&!drag.current.settling)void returnToSource();},[active]);
 const activate=()=>{
  const d=drag.current;if(!d||d.started)return;d.started=true;ghost.current?.closest('.memory-map')?.classList.add('is-photo-locating');
  suppressedClicks.add(d.source);d.source.style.opacity='.3';setBusy(d.id);
  const el=ghost.current!;el.querySelector('img')!.src=tmThumb(d.id);el.style.display='block';el.classList.remove('can-drop');
  moveGhost(d.x,d.y);
 };
 const begin=(e:PointerEvent,photo:Photo,source:HTMLElement,located=false)=>{
  if(e.button!==0||drag.current||!map||!active)return;
  e.preventDefault();e.stopPropagation();source.setPointerCapture(e.pointerId);
  const rect=source.getBoundingClientRect();
  drag.current={id:photo.id,pointer:e.pointerId,source,started:false,located,originX:rect.left+rect.width/2,originY:rect.top+rect.height/2,x:e.clientX,y:e.clientY,settling:false};
  if(!located)activate();
 };
 const overTray=(x:number,y:number)=>{const r=tray.current?.getBoundingClientRect();return !!r&&x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom;};
 const move=(e:PointerEvent)=>{
  const d=drag.current;if(!d||d.pointer!==e.pointerId||d.settling)return;
  if(!d.started&&Math.hypot(e.clientX-d.x,e.clientY-d.y)<5)return;
  activate();d.x=e.clientX;d.y=e.clientY;moveGhost(d.x,d.y);
  const target=targetAt(d.x,d.y),returning=d.located&&overTray(d.x,d.y);
  ghost.current?.classList.toggle('can-drop',!!target||returning);
  tray.current?.classList.toggle('accept-location-return',returning);
  if(foot.current){foot.current.style.display=target?'block':'none';foot.current.querySelector('span')!.textContent=target?`${target.lat.toFixed(4)}°, ${target.lng.toFixed(4)}°`:'';}
 };
 const finish=async(e:PointerEvent)=>{
  const d=drag.current,el=ghost.current;if(!d||!el||d.pointer!==e.pointerId||d.settling)return;
  if(!d.started){reset();return;}
  setTimeout(()=>suppressedClicks.delete(d.source),0);
  const returning=d.located&&overTray(e.clientX,e.clientY);
  const target=targetAt(e.clientX,e.clientY);
  if(!target&&!returning){setMessage('请放在地球表面；也可以先旋转、缩放到目标地区');await returnToSource();return;}
  d.settling=true;setMessage(returning?'正在取消定位…':'正在保存位置…');if(foot.current)foot.current.style.display='none';
  const group=target?groups.find(g=>g.key===regionKey(target.lng,target.lat)):undefined;
  const point=map!.project(group?[group.lng,group.lat]:target?[target.lng,target.lat]:map!.getCenter());
  const rect=map!.getCanvas().getBoundingClientRect();
  const scale=photoMapScale(map!);
  const trayRect=tray.current!.getBoundingClientRect();
  const landing=returning?`translate3d(${trayRect.left+trayRect.width/2-40}px,${trayRect.top+170}px,0) scale(.85)`:`translate3d(${point.x+rect.left-40-4*scale}px,${point.y+rect.top-31-48*scale}px,0) scale(${.85*scale})`;
  const animation=el.animate([{transform:el.style.transform},{transform:landing}],{duration:550,easing:'cubic-bezier(.2,.7,.2,1)',fill:'forwards'});
  try{
   await Promise.all([ipc.setPhotoLocation(d.id,returning?null:target!.lat,returning?null:target!.lng),animation.finished.catch(()=>{})]);
   await onSaved();
   if(!alive.current)return;
   await el.animate([{opacity:1},{opacity:0}],{duration:240,fill:'forwards'}).finished;
   if(alive.current)setMessage(returning?'已取消定位，可重新拖到地球上选择地点':'位置已保存，照片已加入地球上的照片堆');
   el.getAnimations().forEach(a=>a.cancel());reset();
  }catch(err){
   animation.cancel();if(alive.current){setMessage(`保存失败，原有定位未更改：${err}`);await returnToSource();}
  }
 };
 const handlers=useRef({begin,move,finish});handlers.current={begin,move,finish};
 useEffect(()=>{
  const external=(e:Event)=>{const d=(e as CustomEvent<{event:PointerEvent;photo:Photo;source:HTMLElement}>).detail;handlers.current.begin(d.event,d.photo,d.source,true);};
  const moving=(e:PointerEvent)=>handlers.current.move(e);
  const ending=(e:PointerEvent)=>{void handlers.current.finish(e);};
  const cancel=()=>{if(drag.current&&!drag.current.settling)void returnToSource();};
  window.addEventListener('map-located-photo-drag',external);window.addEventListener('pointermove',moving);window.addEventListener('pointerup',ending);window.addEventListener('pointercancel',cancel);
  return()=>{window.removeEventListener('map-located-photo-drag',external);window.removeEventListener('pointermove',moving);window.removeEventListener('pointerup',ending);window.removeEventListener('pointercancel',cancel);if(drag.current)drag.current.source.style.opacity='';};
 },[]);
 return <><aside ref={tray} className="quick-location-tray"><div className="quick-location-heading"><div><small>给回忆一个坐标</small><h2>快速设置位置</h2></div><button disabled={busy!==null} onClick={onClose} aria-label="关闭快速设置位置">×</button></div><p role="status">{message}</p><small>未设置位置 · {photos.length} 张</small><small className="location-return-hint">把已定位照片拖回这里，即可取消定位</small><div className="quick-location-grid">{photos.map(photo=><button key={photo.id} title={photo.filename} aria-label={`拖动设置位置：${photo.filename}`} onPointerDown={e=>begin(e.nativeEvent,photo,e.currentTarget)}><img src={tmThumb(photo.id)} alt={photo.filename} draggable={false} loading="lazy"/></button>)}</div>{photos.length===0&&<p>所有照片都有位置了 ✦</p>}</aside><div ref={ghost} className="location-drag-photo" style={{display:'none'}}><img alt="正在定位的照片" draggable={false}/></div><div ref={foot} className="location-drop-foot" style={{display:'none'}}><i/><span/></div></>;
}
