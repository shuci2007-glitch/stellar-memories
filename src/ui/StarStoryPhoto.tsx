import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getSpherePhotoBridge } from "../three/SpherePhotoBridge";
import type { Photo, Memory } from "../core/types";
import ParticleDetailCanvas from "./ParticleDetailCanvas";

export default function StarStoryPhoto({photo,memory,onClose,exiting}:{photo:Photo;memory:Memory;onClose:()=>void;exiting:boolean}) {
  const bridge=useRef(getSpherePhotoBridge(photo.id)).current;
  const wrap=useRef<HTMLDivElement>(null);
  const [arrived,setArrived]=useState(false);
  const [error,setError]=useState("");
  useLayoutEffect(()=>{
    const resize=()=>{
      const node=wrap.current;if(!node)return;
      const parent=node.parentElement!;
      const availableWidth=parent.clientWidth*.82, availableHeight=Math.max(120,parent.clientHeight-100);
      const aspect=photo.width/Math.max(1,photo.height);
      const width=Math.min(availableWidth,availableHeight*aspect),height=width/aspect;
      Object.assign(node.style,{width:`${width}px`,height:`${height}px`,left:`${(parent.clientWidth-width)/2}px`,top:`${40+(availableHeight-height)/2}px`});
    };
    resize();window.addEventListener("resize",resize);return()=>window.removeEventListener("resize",resize);
  },[photo]);
  useEffect(()=>{
    let frame=0;
    const tick=()=>{if(!bridge||bridge.progress===1){setArrived(true);return;}frame=requestAnimationFrame(tick);};
    frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
  },[bridge]);
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==="Escape")onClose();};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);},[onClose]);
  return <section className="star-story-focus" role="dialog" aria-label="照片与故事">
    <button className="ribbon-close" aria-label="返回照片排列" onClick={onClose} disabled={exiting}>×</button>
    <div className="star-story-photo" ref={wrap}><ParticleDetailCanvas photoId={photo.id} bridge={bridge} fitPadding={1.18} active openingProgress={()=>1} frozen={exiting} onError={setError}/>
    <footer className={"star-story-caption"+(arrived&&!exiting?" visible":"")}><small>✦ 照片的故事</small>{memory.title&&<h2>{memory.title}</h2>}<p>{memory.text?.trim()||"这张照片的故事，还等待着你写下。"}</p>{memory.location&&<span>{memory.location}</span>}</footer></div>
    {error&&<p className="star-story-error" role="alert">{error}</p>}
  </section>;
}
