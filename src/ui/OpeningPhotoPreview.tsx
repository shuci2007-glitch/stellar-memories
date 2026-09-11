import {useEffect,useRef} from 'react';
import {DetailPhotoMorph} from '../three/DetailPhotoMorph';

export default function OpeningPhotoPreview({image,progress,ready}:{image:HTMLImageElement|null;progress:()=>number;ready:boolean}){
  const ref=useRef<HTMLCanvasElement>(null);
  const progressRef=useRef(progress);progressRef.current=progress;
  useEffect(()=>{
    if(ready)return;
    const canvas=ref.current;if(!canvas||!image)return;
    const context=canvas.getContext('2d');if(!context)return;
    const mask=document.createElement('canvas');mask.width=mask.height=128;
    const maskContext=mask.getContext('2d')!;
    const pixels=maskContext.createImageData(128,128);
    const morph=new DetailPhotoMorph();
    const aspect=(image.naturalWidth||1)/(image.naturalHeight||1);
    canvas.width=640;canvas.height=Math.max(1,Math.round(640/aspect));
    let frame=0;
    const draw=()=>{
      morph.seekOpening(progressRef.current(),aspect);
      morph.previewAlpha(pixels.data);maskContext.putImageData(pixels,0,0);
      context.clearRect(0,0,canvas.width,canvas.height);
      context.globalCompositeOperation='source-over';
      context.drawImage(image,0,0,canvas.width,canvas.height);
      context.globalCompositeOperation='destination-in';
      context.drawImage(mask,0,0,canvas.width,canvas.height);
      frame=requestAnimationFrame(draw);
    };
    draw();return()=>{cancelAnimationFrame(frame);morph.dispose();};
  },[image,ready]);
  return <canvas ref={ref} className="detail-loading-photo" style={{zIndex:3,pointerEvents:'none',opacity:ready?0:1,transition:'opacity 180ms linear'}}/>;
}
