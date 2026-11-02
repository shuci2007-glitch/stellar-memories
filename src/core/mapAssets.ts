import type {FeatureCollection} from 'geojson';

// 边界数据随安装包内置,离线可用;若文件缺失则回退到在线数据源。
// IndexedDB 缓存只存公开地理数据,不含用户照片或凭据。
const pending=new Map<string,Promise<FeatureCollection>>();
async function database(){return new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('stellar-public-maps',1);r.onupgradeneeded=()=>r.result.createObjectStore('assets');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function cached(key:string):Promise<FeatureCollection|undefined>{try{const db=await database();return await new Promise((resolve,reject)=>{const tx=db.transaction('assets'),r=tx.objectStore('assets').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);tx.oncomplete=()=>db.close();});}catch{return undefined;}}
async function save(key:string,value:FeatureCollection){try{const db=await database();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('assets','readwrite');tx.objectStore('assets').put(value,key);tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(tx.error);};});}catch{/* Storage limits do not block viewing. */}}
async function request(url:string){const response=await fetch(url,{signal:AbortSignal.timeout(12000)});if(!response.ok)throw new Error('地图数据下载失败');const data=await response.json();if(data.type!=='FeatureCollection'||!Array.isArray(data.features))throw new Error('地图数据格式错误');return data as FeatureCollection;}
/**
 * 边界数据全部离线：只读安装包内的 geojson，不再向任何第三方域名发请求。
 * 原来缺失时会回退到 geo.datav.aliyun.com —— 既与"100% 本地"的说明不符，
 * 也会在弱网/内网环境制造 12 秒超时窗口。
 */
function region(code:string):Promise<FeatureCollection>{
  const key=`region-v1-${code}`;
  let task=pending.get(key);
  if(!task){
    task=(async()=>{
      const old=await cached(key); if(old)return old;
      const local=await request('/maps/china-provinces.geojson');
      const result:FeatureCollection = code==='100000'
        ? local
        : {type:'FeatureCollection',features:local.features.filter(f=>String(f.properties?.adcode??'').startsWith(code.slice(0,2)))};
      if(result.features.length)await save(key,result);
      return result;
    })();
    pending.set(key,task);task.catch(()=>pending.delete(key));
  }
  return task;
}
// Bundled Natural Earth admin-0 codes covered by the DataV China download instead.
const chinaCodes=new Set(['CHN','TWN']);
async function earthBoundaries():Promise<FeatureCollection>{
 const world=await request('/maps/world-countries.geojson');
 try{
  const china=await region('100000');
  const rest=world.features.filter(f=>!chinaCodes.has(String(f.properties?.ADM0_A3)));
  return {type:'FeatureCollection',features:rest.concat(china.features)};
 }catch{/* Offline: fall back to the bundled Natural Earth China outline. */}
 return world;
}
export async function loadMapAsset(name:'china-provinces'|'china-cities'|'earth-boundaries'):Promise<FeatureCollection>{
 try{return await request(`/maps/${name}.geojson`);}catch{/* Optional developer-installed offline data. */}
 if(name==='earth-boundaries')return earthBoundaries();
 if(name==='china-provinces')return region('100000');
 const provinces=await region('100000'),features:FeatureCollection['features']=[];
 const queue=provinces.features.filter(f=>f.properties?.name&&f.properties?.adcode);
 await Promise.all(Array.from({length:4},async()=>{while(queue.length){const province=queue.shift()!;try{const data=await region(String(province.properties!.adcode));for(const f of data.features)features.push({...f,properties:{...f.properties,parentProvince:province.properties!.name}});}catch{features.push(province);}}}));
 return {type:'FeatureCollection',features};
}
