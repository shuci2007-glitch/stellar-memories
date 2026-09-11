import {useEffect,useRef,type RefObject} from 'react';
import type {buildProvinceWall,ProvinceWallNotes} from '../core/provinceWall';
type Layout=ReturnType<typeof buildProvinceWall>;
export type WallPhotoPose={x:number;y:number;scale:number};
export interface WallPhotoMotion {
 revision:number;
 homes:Map<number,WallPhotoPose>;
 rendered:Map<number,WallPhotoPose>;
 draggingId:number|null;
 preview:WallPhotoPose|null;
}
const size=(value:number)=>Math.max(.65,Math.min(2.4,value));
const bounds=(scale:number)=>({hw:80*scale+6,hh:69*scale+8});

/** All pointer movement stays in board coordinates, independent of camera zoom. */
export function useWallPhotoDrag(layout:Layout,board:RefObject<HTMLDivElement|null>,loaded:boolean,enabled:boolean,notes:ProvinceWallNotes,onCommit:(id:number,position:[number,number],scale:number)=>void) {
 const motion=useRef<WallPhotoMotion>({revision:0,homes:new Map(),rendered:new Map(),draggingId:null,preview:null});
 const controls=useRef<{cancel:()=>void;isDragging:()=>boolean}>({cancel:()=>{},isDragging:()=>false});
 const latest=useRef({notes,onCommit,enabled});latest.current={notes,onCommit,enabled};
 useEffect(()=>{
  const host=board.current;if(!host)return;
  const state=motion.current;
  state.draggingId=null;state.preview=null;state.homes.clear();
  const fits=(id:number,pose:WallPhotoPose)=>{
   const {hw,hh}=bounds(pose.scale);
   if(!layout.fits(pose.x,pose.y,hw,hh))return false;
   for(const p of layout.landmarkPlacements)if(Math.abs(p.x-pose.x)<hw+86+10&&Math.abs(p.y-pose.y)<hh+86+10)return false;
   for(const [other,p] of state.homes){if(other===id)continue;if(Math.abs(p.x-pose.x)<73*.94*(pose.scale+p.scale)&&Math.abs(p.y-pose.y)<61*.94*(pose.scale+p.scale))return false;}
   return true;
  };
  const nearest=(id:number,desired:WallPhotoPose,fallback:WallPhotoPose)=>{
   if(fits(id,desired))return desired;
   let best:WallPhotoPose|undefined,distance=Infinity;
   // Small local nudges preserve intentional placement; use the land index only
   // when the pointer ends outside a coastline or in a very dense area.
   for(let i=1;i<=160;i++){
    const radius=10*Math.sqrt(i),angle=i*2.39996323;
    const p={x:desired.x+Math.cos(angle)*radius,y:desired.y+Math.sin(angle)*radius,scale:desired.scale};
    if(fits(id,p)){best=p;distance=radius*radius;break;}
   }
   for(const p of layout.candidates){const d=(p.x-desired.x)**2+(p.y-desired.y)**2;if(d<distance){const candidate={...p,scale:desired.scale};if(fits(id,candidate)){best=candidate;distance=d;}}}
   return best??fallback;
  };
  const stored=latest.current.notes;
  const manual=new Set(layout.cards.filter(c=>loaded&&(stored.photoPositions?.[c.photo.id]||stored.photoScales?.[c.photo.id])).map(c=>c.photo.id));
  for(const c of layout.cards)if(!manual.has(c.photo.id))state.homes.set(c.photo.id,{x:c.x,y:c.y,scale:1});
  for(const c of layout.cards)if(manual.has(c.photo.id)){
   const coordinates=stored.photoPositions?.[c.photo.id];
   const at=coordinates?layout.project(...coordinates):c;
   const desired={x:at.x,y:at.y,scale:size(stored.photoScales?.[c.photo.id]??1)};
   state.homes.set(c.photo.id,nearest(c.photo.id,desired,{x:c.x,y:c.y,scale:1}));
  }
  // Snap only the initial restoration, beneath the sheet's opening motion.
  for(const [id,pose] of state.homes)state.rendered.set(id,{...pose});state.revision++;
  let gesture:{id:number;pointerId:number;el:HTMLElement;origin:WallPhotoPose;startX:number;startY:number;offsetX:number;offsetY:number;radius:number;resize:boolean;moved:boolean}|null=null;
  let suppressed:{id:number;until:number}|null=null;
  const point=(e:PointerEvent)=>{const r=host.getBoundingClientRect();return {x:(e.clientX-r.left)*layout.width/r.width,y:(e.clientY-r.top)*layout.height/r.height};};
  const finish=(cancel=false)=>{
   const g=gesture;if(!g)return;
   gesture=null;state.draggingId=null;
   const current=state.preview??g.origin;state.preview=null;
   g.el.classList.remove('is-photo-dragging','is-resizing','is-invalid-placement');
   if(g.el.hasPointerCapture(g.pointerId))g.el.releasePointerCapture(g.pointerId);
   if(g.moved){
    suppressed={id:g.id,until:performance.now()+500};
    const final=cancel?g.origin:nearest(g.id,current,g.origin);
    state.homes.set(g.id,final);
    if(!cancel)latest.current.onCommit(g.id,layout.unproject(final.x,final.y),final.scale);
   }
  };
  const down=(e:PointerEvent)=>{
   const target=e.target as HTMLElement,card=target.closest<HTMLElement>('.province-wall-card');
   if(!card||e.button!==0||gesture||!loaded||!latest.current.enabled||target.closest('textarea,input,a,.wall-card-flip-toggle'))return;
   const id=Number(card.dataset.photoId),origin=state.rendered.get(id)??state.homes.get(id);if(!origin)return;
   e.stopPropagation();const p=point(e);
   gesture={id,pointerId:e.pointerId,el:card,origin:{...origin},startX:e.clientX,startY:e.clientY,offsetX:p.x-origin.x,offsetY:p.y-origin.y,radius:Math.max(1,Math.hypot(p.x-origin.x,p.y-origin.y)),resize:!!target.closest('[data-wall-resize]'),moved:false};
  };
  const move=(e:PointerEvent)=>{
   const g=gesture;if(!g||g.pointerId!==e.pointerId)return;
   if(!g.moved&&Math.hypot(e.clientX-g.startX,e.clientY-g.startY)<5)return;
   if(!g.moved){g.moved=true;g.el.setPointerCapture(e.pointerId);g.el.classList.add('is-photo-dragging');if(g.resize)g.el.classList.add('is-resizing');}
   e.preventDefault();e.stopPropagation();const p=point(e);
   const pose=g.resize?{...g.origin,scale:size(g.origin.scale*Math.hypot(p.x-g.origin.x,p.y-g.origin.y)/g.radius)}:{x:p.x-g.offsetX,y:p.y-g.offsetY,scale:g.origin.scale};
   const b=bounds(pose.scale);pose.x=Math.max(b.hw+30,Math.min(layout.width-b.hw-30,pose.x));pose.y=Math.max(b.hh+110,Math.min(layout.height-b.hh-30,pose.y));
   state.draggingId=g.id;state.preview=pose;
   g.el.classList.toggle('is-invalid-placement',!fits(g.id,pose));
  };
  const up=(e:PointerEvent)=>{if(gesture?.pointerId===e.pointerId)finish(e.type==='pointercancel');};
  const lost=(e:PointerEvent)=>{if(gesture?.pointerId===e.pointerId&&gesture.moved)finish(true);};
  const click=(e:MouseEvent)=>{
   const card=(e.target as HTMLElement).closest<HTMLElement>('.province-wall-card');
   if(e.detail!==0&&suppressed&&performance.now()<suppressed.until&&Number(card?.dataset.photoId)===suppressed.id){e.preventDefault();e.stopImmediatePropagation();suppressed=null;}
  };
  const key=(e:KeyboardEvent)=>{
   if(!(e.target as HTMLElement).closest('[data-wall-resize]')||!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)||!loaded||!latest.current.enabled)return;
   const card=(e.target as HTMLElement).closest<HTMLElement>('.province-wall-card');const id=Number(card?.dataset.photoId),current=state.homes.get(id);if(!current)return;
   e.preventDefault();e.stopPropagation();
   const desired={...current,scale:size(current.scale+(['ArrowUp','ArrowRight'].includes(e.key)?.1:-.1))};
   const final=nearest(id,desired,current);state.homes.set(id,final);latest.current.onCommit(id,layout.unproject(final.x,final.y),final.scale);
  };
  controls.current={cancel:()=>finish(true),isDragging:()=>!!gesture?.moved};
  host.addEventListener('pointerdown',down);host.addEventListener('click',click,true);host.addEventListener('keydown',key);host.addEventListener('lostpointercapture',lost);
  window.addEventListener('pointermove',move,{capture:true,passive:false});window.addEventListener('pointerup',up,true);window.addEventListener('pointercancel',up,true);
  return()=>{finish(true);host.removeEventListener('pointerdown',down);host.removeEventListener('click',click,true);host.removeEventListener('keydown',key);host.removeEventListener('lostpointercapture',lost);window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',up,true);};
 },[layout,board,loaded]);
 return {motion,controls};
}
