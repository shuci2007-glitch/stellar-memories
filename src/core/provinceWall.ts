import type {Photo} from './types';

export interface ProvinceShape {properties?:{name?:string};geometry:{type:string;coordinates:unknown}}
export interface WallLandmark {province:string;name:string;lng:number;lat:number;source:string}
export interface ProvinceWallNotes {wallText:string;photoNotes:Record<string,string>;photoPositions?:Record<string,[number,number]>;photoScales?:Record<string,number>}
export const emptyWallNotes=():ProvinceWallNotes=>({wallText:'',photoNotes:{},photoPositions:{},photoScales:{}});

type Point={x:number;y:number};
const halfWidth=86,halfHeight=86; // Includes card rotation, knot, tall icons and wrapped labels.
const ringContains=(p:Point,ring:Point[])=>{
 let inside=false;
 for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const a=ring[i],b=ring[j];
  if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
 }
 return inside;
};
const cross=(a:Point,b:Point,c:Point)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const intersects=(a:Point,b:Point,c:Point,d:Point)=>cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0;

export function buildProvinceWall(shape:ProvinceShape,photos:Photo[],landmarks:WallLandmark[]=[]) {
 const polygons=shape.geometry.type==='Polygon'?[shape.geometry.coordinates as number[][][]]:shape.geometry.coordinates as number[][][][];
 const points=polygons.flat(2);
 const minLng=Math.min(...points.map(p=>p[0])),maxLng=Math.max(...points.map(p=>p[0]));
 const minLat=Math.min(...points.map(p=>p[1])),maxLat=Math.max(...points.map(p=>p[1]));
 const lngScale=Math.cos((minLat+maxLat)/2*Math.PI/180);
 const ordered=[...photos].sort((a,b)=>a.id-b.id);
 // Grow the geographic map itself when a dense area needs more room; never put
 // overflow cards outside the province or shrink all photographs to unreadable dots.
 let width=Math.max(2400,Math.ceil(Math.sqrt(photos.length))*560);
 for(;;width=Math.ceil(width*1.22)){
  const height=Math.max(1920,Math.ceil(width*.84));
  const scale=Math.min((width-240)/Math.max(.01,(maxLng-minLng)*lngScale),(height-260)/Math.max(.01,maxLat-minLat));
  const project=(lng:number,lat:number)=>({x:width/2+(lng-(minLng+maxLng)/2)*lngScale*scale,y:height/2-(lat-(minLat+maxLat)/2)*scale});
  const projected=polygons.map(p=>p.map(r=>r.map(([lng,lat])=>project(lng,lat))));
  const inside=(p:Point)=>projected.some(poly=>ringContains(p,poly[0])&&!poly.slice(1).some(r=>ringContains(p,r)));
  const edges=projected.flatMap(poly=>poly.flatMap(r=>r.map((a,i)=>[a,r[(i+1)%r.length]] as const)));
  const fits=(x:number,y:number,hw=halfWidth,hh=halfHeight)=>{
   if(x<hw+30||x>width-hw-30||y<hh+110||y>height-hh-30)return false;
   const corners=[{x:x-hw,y:y-hh},{x:x+hw,y:y-hh},{x:x+hw,y:y+hh},{x:x-hw,y:y+hh}];
   if(!corners.every(inside))return false;
   // Corner-only checks miss concave coastlines and holes: test crossing edges too.
   return !edges.some(([a,b])=>Math.max(a.x,b.x)>=x-hw&&Math.min(a.x,b.x)<=x+hw&&Math.max(a.y,b.y)>=y-hh&&Math.min(a.y,b.y)<=y+hh&&(
    (a.x>x-hw&&a.x<x+hw&&a.y>y-hh&&a.y<y+hh)||corners.some((c,i)=>intersects(c,corners[(i+1)%4],a,b))));
  };
  const reserved:{x:number;y:number;hw:number;hh:number;photo?:boolean}[]=[];
  let placingPhoto=false;
  const free=(x:number,y:number,hw=halfWidth,hh=halfHeight)=>!reserved.some(r=>placingPhoto&&r.photo?Math.abs(r.x-x)<146*.94&&Math.abs(r.y-y)<122*.94:Math.abs(r.x-x)<r.hw+hw+16&&Math.abs(r.y-y)<r.hh+hh+16);
  const candidates:Point[]=[];
  const seen=new Set<string>();
  // Index land only. Scanning the entire sea between distant islands would do
  // unnecessary polygon work each time a crowded map grows.
  for(const [outer] of projected){
   const left=Math.min(...outer.map(p=>p.x)),right=Math.max(...outer.map(p=>p.x));
   const top=Math.min(...outer.map(p=>p.y)),bottom=Math.max(...outer.map(p=>p.y));
   if(right-left<halfWidth*2||bottom-top<halfHeight*2)continue;
   for(let y=190+Math.ceil((top+halfHeight-190)/94)*94;y<bottom-halfHeight;y+=94)for(let x=120+Math.ceil((left+halfWidth-120)/104)*104;x<right-halfWidth;x+=104){
    const key=`${x},${y}`;if(seen.has(key))continue;seen.add(key);
    const jx=x+Math.sin(y*.04+x*.03)*13,jy=y+Math.sin(x*.02)*11;
    if(fits(jx,jy))candidates.push({x:jx,y:jy});
   }
  }
  const place=(pin:Point,seed:number)=>{
   if(fits(pin.x,pin.y)&&free(pin.x,pin.y))return {...pin};
   // Prefer a smooth local arrangement; the grid is only a fallback candidate index.
   for(let k=1;k<=850;k++){
    const radius=14*Math.sqrt(k),angle=seed+k*2.399963229728653;
    const at={x:pin.x+Math.cos(angle)*radius,y:pin.y+Math.sin(angle)*radius};
    if(free(at.x,at.y)&&fits(at.x,at.y))return at;
   }
   let best:Point|undefined,distance=Infinity;
   for(const at of candidates){const d=(at.x-pin.x)**2+(at.y-pin.y)**2;if(d<distance&&free(at.x,at.y)){best=at;distance=d;}}
   return best;
  };
  const landmarkPlacements=[];
  let failed=false;
  for(const landmark of landmarks){
   const pin=project(landmark.lng,landmark.lat),at=place(pin,landmark.lng);
   if(!at){failed=true;break;}
   reserved.push({...at,hw:halfWidth,hh:halfHeight});
   landmarkPlacements.push({...landmark,pin,...at});
  }
  if(failed)continue;
  placingPhoto=true;
  const cards:{photo:Photo;pin:Point;x:number;y:number;tilt:number}[]=[];
  for(const photo of ordered){
   const pin=project(photo.gpsLon!,photo.gpsLat!);
   const phase=((Math.imul(photo.id,2654435761)>>>0)%6283)/1000;
   const at=place(pin,phase);
   if(!at){failed=true;break;}
   reserved.push({...at,hw:halfWidth,hh:halfHeight});
   reserved[reserved.length-1].photo=true;
   cards.push({photo,pin,...at,tilt:Math.sin(photo.id*1.72)*2.2});
  }
  if(failed)continue;
  // A few local pairs, with at most one rope touching each card. No spanning web.
  const links:[number,number][]=[];
  const paired=new Set<number>();
  const budget=Math.floor(cards.length/3);
  const possible:{a:number;b:number;d:number}[]=[];
  for(let i=0;i<cards.length;i++)for(let j=i+1;j<cards.length;j++){
   const a=cards[i],b=cards[j],d=Math.hypot(a.x-b.x,a.y-b.y);
   if(d<330&&!cards.some((c,k)=>k!==i&&k!==j&&Math.abs(c.x-(a.x+b.x)/2)<halfWidth&&Math.abs(c.y-(a.y+b.y)/2)<halfHeight))possible.push({a:i,b:j,d});
  }
  possible.sort((a,b)=>a.d-b.d);
  for(const edge of possible){
   if(links.length>=budget)break;
   if(paired.has(edge.a)||paired.has(edge.b))continue;
   const a=cards[edge.a],b=cards[edge.b];
   if(links.some(([i,j])=>intersects(a,b,cards[i],cards[j])))continue;
   paired.add(edge.a);paired.add(edge.b);links.push([edge.a,edge.b]);
  }
  const paths=projected.map(p=>p.map(r=>r.map((q,i)=>`${i?'L':'M'}${q.x.toFixed(2)},${q.y.toFixed(2)}`).join(' ')+' Z').join(' '));
  const unproject=(x:number,y:number):[number,number]=>[(x-width/2)/(lngScale*scale)+(minLng+maxLng)/2,(height/2-y)/scale+(minLat+maxLat)/2];
  return {width,height,project,unproject,fits,candidates,paths,cards,links,landmarkPlacements,bounds:{minLng,maxLng,minLat,maxLat}};
 }
}
