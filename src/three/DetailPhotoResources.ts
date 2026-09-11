import type { PhotoParticleFieldData } from './PhotoParticleField';
import type { QualityTier } from '../core/types';
import { tmPhoto } from '../core/types';
import { ipc } from '../core/db';
import { loadPhotoParticleSettings, type PhotoParticleSettings } from '../core/PhotoParticleSettings';

type Resource = {field:PhotoParticleFieldData;bitmap:ImageBitmap;settings:PhotoParticleSettings};
let cached: {id:number;promise:Promise<Resource>} | null = null;
function load(id:number):Promise<Resource> {
  return Promise.all([loadPhotoParticleSettings(),ipc.getSetting('particle_tier')]).then(([settings,tier])=>new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./detailPhoto.worker.ts',import.meta.url),{type:'module'});
    worker.onmessage=(event:MessageEvent<Resource & {error?:string}>)=>{
      worker.terminate();
      if(event.data.error)reject(new Error(event.data.error));
      else resolve({...event.data,settings});
    };
    worker.onerror=()=>{worker.terminate();reject(new Error('照片资源加载失败'));};
    worker.postMessage({url:tmPhoto(id),tier:(tier??'medium') as QualityTier});
  }));
}
export function prewarmDetailPhoto(id:number) {
  if(cached?.id===id)return;
  if(cached)void cached.promise.then(r=>r.bitmap.close(),()=>{});
  const promise=load(id);
  cached={id,promise};
  void promise.catch(()=>{if(cached?.promise===promise)cached=null;});
}
export function takeDetailPhoto(id:number) {
  if(cached?.id===id){const promise=cached.promise;cached=null;return promise;}
  return load(id);
}
