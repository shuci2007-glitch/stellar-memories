import type { ParticleCloudData } from './ParticlePhoto';
import type { QualityTier } from '../core/types';

export const PHOTO_BUDGET: Record<QualityTier, number> = {low:50000, medium:120000, high:220000, ultra:360000};
/** Coverage is stratified; high-information cells split into four smaller samples. */
export function samplePixels(rgba: Uint8ClampedArray, width: number, height: number, budget=120000): ParticleCloudData {
  const lum = new Float32Array(width*height);
  for(let i=0;i<lum.length;i++) lum[i]=(rgba[i*4]*0.2126+rgba[i*4+1]*0.7152+rgba[i*4+2]*0.0722)/255;
  const at=(x:number,y:number)=>lum[Math.max(0,Math.min(height-1,y))*width+Math.max(0,Math.min(width-1,x))];
  const edges=new Float32Array(lum.length), contrast=new Float32Array(lum.length);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const gx=at(x+1,y-1)+2*at(x+1,y)+at(x+1,y+1)-at(x-1,y-1)-2*at(x-1,y)-at(x-1,y+1);
    const gy=at(x-1,y+1)+2*at(x,y+1)+at(x+1,y+1)-at(x-1,y-1)-2*at(x,y-1)-at(x+1,y-1);
    edges[y*width+x]=Math.min(1,Math.hypot(gx,gy)/2);
    contrast[y*width+x]=Math.abs(at(x,y)-(at(x-2,y)+at(x+2,y)+at(x,y-2)+at(x,y+2))/4);
  }
  const aspect=width/height, cols=Math.max(2,Math.floor(Math.sqrt(budget/2.3*aspect))), rows=Math.max(2,Math.floor(cols/aspect));
  const targets:number[]=[],colors:number[]=[],data:number[]=[],random:number[]=[],depth:number[]=[],edgeOut:number[]=[],luminance:number[]=[],alpha:number[]=[];
  let seed=1979; const rng=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let y=0;y<rows;y++) for(let x=0;x<cols;x++) {
    const cx=Math.min(width-1,Math.floor((x+.5)/cols*width)), cy=Math.min(height-1,Math.floor((y+.5)/rows*height));
    const imp=Math.min(1,edges[cy*width+cx]*0.75+contrast[cy*width+cx]*2.5);
    const split=imp>.075 && targets.length/2+4+(rows*cols-(y*cols+x)-1)<=budget ? 2 : 1;
    for(let sy=0;sy<split;sy++) for(let sx=0;sx<split;sx++) {
      const u=(x+(sx+.5)/split)/cols, v=(y+(sy+.5)/split)/rows;
      const px=Math.min(width-1,Math.floor(u*width)), py=Math.min(height-1,Math.floor(v*height)), i=py*width+px;
      const jitterU=(rng()-.5)*.52/(cols*split), jitterV=(rng()-.5)*.52/(rows*split);
      targets.push(u+jitterU,v+jitterV); colors.push(rgba[i*4]/255,rgba[i*4+1]/255,rgba[i*4+2]/255);
      data.push(1.13/(rows*split),imp); random.push(rng(),rng(),rng(),rng());
      depth.push(((lum[i]-.5)*.033+edges[i]*.009)*aspect); edgeOut.push(edges[i]); luminance.push(lum[i]); alpha.push(rgba[i*4+3]/255);
    }
  }
  return {count:targets.length/2,width,height,target:new Float32Array(targets),color:new Float32Array(colors),data:new Float32Array(data),rand:new Float32Array(random),depth:new Float32Array(depth),edgeStrength:new Float32Array(edgeOut),luminance:new Float32Array(luminance),alpha:new Float32Array(alpha)};
}
export async function samplePhoto(url: string, tier: QualityTier='medium', signal?: AbortSignal) {
  const response=await fetch(url,{signal}); if(!response.ok) throw new Error('照片读取失败');
  const bitmap=await createImageBitmap(await response.blob(),{imageOrientation:'from-image'});
  try {
    if(signal?.aborted) throw new DOMException('Aborted','AbortError');
    const scale=Math.min(1,1400/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas'); canvas.width=Math.max(2,Math.round(bitmap.width*scale)); canvas.height=Math.max(2,Math.round(bitmap.height*scale));
    const ctx=canvas.getContext('2d',{willReadFrequently:true})!; ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
    return samplePixels(ctx.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height,PHOTO_BUDGET[tier]);
  } finally {bitmap.close();}
}
