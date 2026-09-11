import { earthSun } from "../core/earthSun";
const SIZE=256;
const assets=Promise.all(["earth_day_4096.jpg","earth_night_4096.jpg","earth_bump_roughness_clouds_4096.jpg"].map(async name=>{
  const response=await fetch(`/maps/earth/${name}`);if(!response.ok)throw new Error("地球贴图读取失败");
  const bitmap=await createImageBitmap(await response.blob());
  const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext("2d")!;
  ctx.drawImage(bitmap,0,0);bitmap.close();
  return {width:canvas.width,height:canvas.height,pixels:ctx.getImageData(0,0,canvas.width,canvas.height).data};
}));
const smooth=(a:number,b:number,x:number)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
self.onmessage=async(event:MessageEvent<{id:number;z:number;x:number;y:number;time:number}>)=>{
 const {id,z,x,y,time}=event.data;
 try{
  const [day,night,bump]=await assets,sun=earthSun(new Date(time));
  const canvas=new OffscreenCanvas(SIZE,SIZE),ctx=canvas.getContext("2d")!,out=ctx.createImageData(SIZE,SIZE),n=2**z;
  for(let py=0;py<SIZE;py++){
   const lat=Math.atan(Math.sinh(Math.PI*(1-2*(y+(py+.5)/SIZE)/n)));
   const row=Math.min(day.height-1,Math.max(0,Math.floor((.5-lat/Math.PI)*day.height)));
   for(let px=0;px<SIZE;px++){
    const u=(x+(px+.5)/SIZE)/n,lng=(u-.5)*Math.PI*2;
    const column=Math.min(day.width-1,Math.max(0,Math.floor(u*day.width)));
    const source=(row*day.width+column)*4,dest=(py*SIZE+px)*4;
    const cosine=Math.cos(lat)*(sun[0]*Math.cos(lng)-sun[2]*Math.sin(lng))+Math.sin(lat)*sun[1];
    const daylight=smooth(-.12,.12,cosine),lights=1-smooth(-.16,.02,cosine);
    const left=(row*bump.width+(column+bump.width-1)%bump.width)*4;
    const above=(Math.max(0,row-1)*bump.width+column)*4;
    const relief=Math.max(.7,Math.min(1.18,1+(bump.pixels[left]-bump.pixels[source]+bump.pixels[above]-bump.pixels[source])*.004));
    const illumination=.12+daylight*(.45+.43*Math.sqrt(Math.max(0,cosine)));
    for(let c=0;c<3;c++)out.data[dest+c]=Math.min(255,day.pixels[source+c]*illumination*relief+night.pixels[source+c]*lights*1.1);
    out.data[dest+3]=255;
   }
  }
  ctx.putImageData(out,0,0);
  const data=await(await canvas.convertToBlob({type:"image/png"})).arrayBuffer();
  self.postMessage({id,data},{transfer:[data]});
 }catch(error){self.postMessage({id,error:String(error)});}
};
