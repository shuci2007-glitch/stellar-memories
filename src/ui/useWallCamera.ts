import {useLayoutEffect,useRef,type RefObject} from 'react';

/** Pan and zoom share one camera, anchored to the cursor, with inertial settling. */
export function useWallCamera(viewport:RefObject<HTMLDivElement|null>,board:RefObject<HTMLDivElement|null>,width:number,height:number,count:number,initialCenter?:{x:number;y:number}) {
 const controls=useRef({zoomBy:(_factor:number)=>{},fit:()=>{},focusAt:(_x:number,_y:number)=>{}});
 useLayoutEffect(()=>{
  const host=viewport.current,el=board.current;if(!host||!el)return;
  const camera={x:0,y:0,s:1},target={...camera};
  let raf=0,last=performance.now(),fitScale=1,vx=0,vy=0;
  let drag:{id:number;x:number;y:number;time:number}|null=null;
  const clamp=()=>{
   const margin=host.clientWidth*.7;
   target.x=Math.max(-width*target.s+host.clientWidth-margin,Math.min(margin,target.x));
   target.y=Math.max(-height*target.s+host.clientHeight-100,Math.min(host.clientHeight-100,target.y));
  };
  const fit=(initial=false)=>{
   fitScale=Math.min((host.clientWidth-40)/width,(host.clientHeight-40)/height);
   // Large walls open at a readable scale; full overview remains a separate action.
   target.s=initial?(count>18?.85:.9):fitScale;
   target.x=host.clientWidth/2-(initial&&initialCenter?initialCenter.x:width/2)*target.s;target.y=host.clientHeight/2-(initial&&initialCenter?initialCenter.y:height/2)*target.s;vx=vy=0;
   if(initial)Object.assign(camera,target);
  };
  const zoom=(factor:number,x=host.clientWidth/2,y=host.clientHeight/2)=>{
   const next=Math.max(Math.min(.25,fitScale*.7),Math.min(5,target.s*factor));
   target.x=x-(x-target.x)*next/target.s;target.y=y-(y-target.y)*next/target.s;target.s=next;vx=vy=0;clamp();
  };
  const wheel=(e:WheelEvent)=>{
   if(host.querySelector('.is-photo-dragging')){e.preventDefault();return;}
   if((e.target as HTMLElement).closest('textarea,input'))return;
   e.preventDefault();e.stopPropagation();const r=host.getBoundingClientRect();
   zoom(Math.exp(-Math.max(-120,Math.min(120,e.deltaY*(e.deltaMode===1?16:1)))*.0018),e.clientX-r.left,e.clientY-r.top);
  };
  const down=(e:PointerEvent)=>{
   if(e.button!==0||(e.target as HTMLElement).closest('button,textarea,input,a,.province-wall-card'))return;
   e.preventDefault();host.setPointerCapture(e.pointerId);drag={id:e.pointerId,x:e.clientX,y:e.clientY,time:performance.now()};vx=vy=0;host.classList.add('is-panning');
  };
  const move=(e:PointerEvent)=>{
   if(!drag||drag.id!==e.pointerId)return;
   const now=performance.now(),dt=Math.max(8,now-drag.time),dx=e.clientX-drag.x,dy=e.clientY-drag.y;
   target.x+=dx;target.y+=dy;camera.x=target.x;camera.y=target.y;
   vx=dx/dt*16.667;vy=dy/dt*16.667;drag={id:e.pointerId,x:e.clientX,y:e.clientY,time:now};clamp();
  };
  const up=()=>{drag=null;host.classList.remove('is-panning');};
  controls.current={zoomBy:zoom,fit:()=>fit(),focusAt:(x,y)=>{target.s=Math.max(.9,target.s);target.x=host.clientWidth/2-x*target.s;target.y=host.clientHeight/2-y*target.s;vx=vy=0;clamp();}};fit(true);
  const draw=(now:number)=>{
   const dt=Math.min(2,(now-last)/16.667);last=now;
   if(host.querySelector('.is-photo-dragging')){vx=vy=0;Object.assign(target,camera);}
   if(!drag){target.x+=vx*dt;target.y+=vy*dt;vx*=Math.pow(.87,dt);vy*=Math.pow(.87,dt);clamp();}
   const ease=1-Math.pow(.73,dt);
   camera.x+=(target.x-camera.x)*ease;camera.y+=(target.y-camera.y)*ease;camera.s+=(target.s-camera.s)*ease;
   el.style.transform=`translate3d(${camera.x}px,${camera.y}px,0) scale(${camera.s})`;
   raf=requestAnimationFrame(draw);
  };
  el.style.transform=`translate3d(${camera.x}px,${camera.y}px,0) scale(${camera.s})`;raf=requestAnimationFrame(draw);
  host.addEventListener('wheel',wheel,{passive:false});host.addEventListener('pointerdown',down);host.addEventListener('pointermove',move);host.addEventListener('pointerup',up);host.addEventListener('pointercancel',up);host.addEventListener('lostpointercapture',up);
  const ro=new ResizeObserver(()=>{fitScale=Math.min((host.clientWidth-40)/width,(host.clientHeight-40)/height);clamp();});ro.observe(host);
  return()=>{cancelAnimationFrame(raf);ro.disconnect();host.removeEventListener('wheel',wheel);host.removeEventListener('pointerdown',down);host.removeEventListener('pointermove',move);host.removeEventListener('pointerup',up);host.removeEventListener('pointercancel',up);host.removeEventListener('lostpointercapture',up);};
 },[viewport,board,width,height,count,initialCenter?.x,initialCenter?.y]);
 return controls;
}
