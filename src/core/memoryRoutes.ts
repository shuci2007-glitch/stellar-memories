import type {FeatureCollection,Feature,LineString} from 'geojson';
import type {Photo} from './types';
export function validGps(p:Photo){return p.gpsLat!==null&&p.gpsLon!==null&&Number.isFinite(p.gpsLat)&&Number.isFinite(p.gpsLon)&&Math.abs(p.gpsLat)<=90&&Math.abs(p.gpsLon)<=180;}

/** Use the recorded local calendar day without shifting EXIF dates through UTC. */
function photoDay(photo:Photo) {
 const parts=photo.captureDate?.match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:\b|T)/);
 if(!parts)return null;
 const day=`${parts[1]}-${parts[2]}-${parts[3]}`,date=new Date(`${day}T00:00:00Z`);
 return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===day?day:null;
}
const dayNumber=(day:string)=>Math.floor(Date.parse(`${day}T00:00:00Z`)/86400000);
/** Stable hue for a date, independent of import order, zoom and the selected day. */
export function routeDayColor(day:string){const hue=((dayNumber(day)*137.507764)%360+360)%360;return `hsl(${hue.toFixed(3)}, 68%, 72%)`;}
export function memoryRoutes(photos:Photo[]) {
 const days=new Map<string,Photo[]>(),seen=new Set<number>();
 for(const photo of photos){
  if(seen.has(photo.id)||!validGps(photo))continue;
  const day=photoDay(photo);if(!day)continue;
  seen.add(photo.id);const group=days.get(day)??[];group.push(photo);days.set(day,group);
 }
 return [...days].sort(([a],[b])=>b.localeCompare(a)).map(([day,photos])=>({day,color:routeDayColor(day),photos:[...photos].sort((a,b)=>(a.captureDate??'').replaceAll('/','-').localeCompare((b.captureDate??'').replaceAll('/','-'))||a.id-b.id)}));
}
type Vec=[number,number,number];
const dot=(a:Vec,b:Vec)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a:Vec,b:Vec):Vec=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=(v:Vec):Vec=>{const size=Math.hypot(...v);return v.map(n=>n/size) as Vec;};
const globe=(photo:Photo):Vec=>{const lat=photo.gpsLat!*Math.PI/180,lon=photo.gpsLon!*Math.PI/180;return [Math.cos(lat)*Math.cos(lon),Math.sin(lat),Math.cos(lat)*Math.sin(lon)];};
function curvedConnection(a:Photo,b:Photo,day:string):number[][] {
 const start=globe(a),end=globe(b),cos=Math.max(-1,Math.min(1,dot(start,end))),angle=Math.acos(cos);
 if(angle<1e-7)return []; // Coincident photo locations need no visible connector.
 let tangent=end.map((v,i)=>v-start[i]*cos) as Vec;
 if(Math.hypot(...tangent)<1e-7){const axis:Vec=Math.abs(start[1])<.9?[0,1,0]:[1,0,0];tangent=cross(axis,start);}
 tangent=unit(tangent);const normal=unit(cross(start,tangent));
 const bend=Math.min(.28,angle*(.16+((dayNumber(day)%7+7)%7)*.012));
 const samples=Math.max(32,Math.min(180,Math.ceil(angle*90)));
 const coordinates:number[][]=[];let previous=a.gpsLon!;
 for(let i=0;i<=samples;i++){
  const t=i/samples,bow=bend*Math.sin(Math.PI*t);
  const base=start.map((v,k)=>v*Math.cos(angle*t)+tangent[k]*Math.sin(angle*t)) as Vec;
  const position=base.map((v,k)=>v*Math.cos(bow)+normal[k]*Math.sin(bow)) as Vec;
  let lng=i===0?a.gpsLon!:i===samples?b.gpsLon!:Math.atan2(position[2],position[0])*180/Math.PI;
  // Unwrap the date line so a short link never travels around the other side.
  while(lng-previous>180)lng-=360;while(lng-previous< -180)lng+=360;
  const lat=i===0?a.gpsLat!:i===samples?b.gpsLat!:Math.asin(Math.max(-1,Math.min(1,position[1])))*180/Math.PI;
  coordinates.push([lng,lat]);previous=lng;
 }
 return coordinates;
}
export function routeGeometry(photos:Photo[]):FeatureCollection<LineString> {
 const features:Feature<LineString>[]=[];
 for(const route of memoryRoutes(photos))for(let i=1;i<route.photos.length;i++){
  const a=route.photos[i-1],b=route.photos[i],coordinates=curvedConnection(a,b,route.day);
  if(coordinates.length)features.push({type:'Feature',id:`${route.day}:${a.id}:${b.id}`,properties:{day:route.day,color:route.color,label:'同日照片位置连线'},geometry:{type:'LineString',coordinates}});
 }
 return {type:'FeatureCollection',features};
}

/** 行程播放时「已走过」的那一段，用来把轨迹逐站点亮。 */
export function routeProgressGeometry(
 route:{day:string;color:string;photos:Photo[]},
 upto:number,
):FeatureCollection<LineString>{
 const features:Feature<LineString>[]=[];
 for(let i=1;i<route.photos.length&&i<=upto;i++){
  const a=route.photos[i-1],b=route.photos[i],coordinates=curvedConnection(a,b,route.day);
  if(coordinates.length)features.push({type:'Feature',properties:{day:route.day,color:route.color},geometry:{type:'LineString',coordinates}});
 }
 return {type:'FeatureCollection',features};
}
