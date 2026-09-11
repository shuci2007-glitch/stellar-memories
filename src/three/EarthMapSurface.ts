import { addProtocol, removeProtocol, type Map as LibreMap, type RasterTileSource } from "maplibre-gl";
/** Local worker tiles: all decoding and sunlight compositing stays off the UI thread. */
export function installEarthMapSurface(map:LibreMap){
 const worker=new Worker(new URL("./earthTiles.worker.ts",import.meta.url),{type:"module"});
 const pending=new Map<number,{resolve:(data:{data:ArrayBuffer})=>void;reject:(error:Error)=>void}>();
 let serial=0,disposed=false;
 worker.onmessage=e=>{const task=pending.get(e.data.id);if(!task)return;pending.delete(e.data.id);if(e.data.error)task.reject(new Error(e.data.error));else task.resolve({data:e.data.data});};
 addProtocol("earthsurface",async(params,controller)=>{
  const values=params.url.replace("earthsurface://","").split("/").map(Number);
  return new Promise<{data:ArrayBuffer}>((resolve,reject)=>{
   const id=++serial;
   const abort=()=>{pending.delete(id);reject(new DOMException("Aborted","AbortError"));};
   if(controller.signal.aborted){abort();return;}
   controller.signal.addEventListener("abort",abort,{once:true});
   pending.set(id,{resolve:data=>{controller.signal.removeEventListener("abort",abort);resolve(data);},reject:error=>{controller.signal.removeEventListener("abort",abort);reject(error);}});
   worker.postMessage({id,time:values[0],z:values[1],x:values[2],y:values[3]});
  });
 });
 const url=()=>`earthsurface://${Date.now()}/{z}/{x}/{y}`;
 map.addSource("earth-surface",{type:"raster",tiles:[url()],tileSize:256,maxzoom:4,attribution:"Solar System Scope · CC BY 4.0"});
 map.addLayer({id:"earth-surface",type:"raster",source:"earth-surface",paint:{"raster-fade-duration":1000}},"countries-line");
 const timer=window.setInterval(()=>{if(!disposed&&!document.hidden)(map.getSource("earth-surface") as RasterTileSource)?.setTiles([url()]);},30000);
 return()=>{disposed=true;clearInterval(timer);worker.terminate();for(const task of pending.values())task.reject(new Error("地球视图已关闭"));pending.clear();removeProtocol("earthsurface");};
}
