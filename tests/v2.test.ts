import {describe,it,expect,vi} from 'vitest';
import {samplePixels} from '../src/three/PhotoParticleSampler';
import {TransitionCoordinator} from '../src/core/TransitionCoordinator';
import {initialViewState,navigateView} from '../src/core/AppViewState';
import {memoryRoutes,routeGeometry,validGps} from '../src/core/memoryRoutes';
import type {Photo} from '../src/core/types';
import {PHOTO_SPHERE_DEFAULTS,normalizePhotoSphereSettings} from '../src/core/PhotoSphereSettings';

describe('V2 reconstruction',()=>{
 it('retains asymmetric image coordinates, colors and bounded depth',()=>{
  const w=64,h=48,rgba=new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const o=(y*w+x)*4;rgba[o]=x<w/2?255:0;rgba[o+1]=y<h/2?180:0;rgba[o+2]=x>=w/2?220:0;rgba[o+3]=255;}
  const c=samplePixels(rgba,w,h,4000);
  expect(c.count).toBeLessThanOrEqual(4000);
  for(let i=0;i<c.count;i++) {const u=c.target[i*2],v=c.target[i*2+1];expect(u).toBeGreaterThanOrEqual(0);expect(u).toBeLessThanOrEqual(1);expect(v).toBeGreaterThanOrEqual(0);expect(v).toBeLessThanOrEqual(1);expect(Math.abs(c.depth![i])).toBeLessThan(.06*w/h);}
  const topLeft=Array.from({length:c.count},(_,i)=>i).find(i=>c.target[i*2]<.2&&c.target[i*2+1]<.2)!;
  expect(c.color[topLeft*3]).toBe(1);expect(c.color[topLeft*3+2]).toBe(0);
  expect(c.alpha![topLeft]).toBe(1);
 });
 it('keeps black regions represented instead of dropping them',()=>{
  const rgba=new Uint8ClampedArray(32*32*4);for(let i=3;i<rgba.length;i+=4)rgba[i]=255;
  const c=samplePixels(rgba,32,32,2000);expect(c.count).toBeGreaterThan(500);expect(c.color.every(v=>v===0)).toBe(true);expect(c.alpha!.every(v=>v===1)).toBe(true);
 });
});
describe('navigation race cancellation',()=>{
 it('only the latest transition can complete, including pending async responses',()=>{
  vi.useFakeTimers();const t=new TransitionCoordinator(),calls:string[]=[];
  const old=t.cancel();t.after(old,1600,()=>calls.push('old photo'));
  const next=t.cancel();t.after(next,360,()=>calls.push('shelf'));vi.advanceTimersByTime(2000);
  expect(calls).toEqual(['shelf']);expect(t.current(old)).toBe(false);vi.useRealTimers();
 });
 it('every main navigation clears detail, including same tab',()=>{
  for(const mainView of ['galaxy','timeline','map','shelf'] as const){const s=navigateView({...initialViewState,content:'photo_detail',detail:{} as never,exiting:true},mainView);expect(s.detail).toBeNull();expect(s.content).toBe('overview');expect(s.exiting).toBe(false);}
 });
});
describe('geographic memory routes',()=>{
 const p=(id:number,date:string,lat:number|null,lon:number|null)=>({id,captureDate:date,gpsLat:lat,gpsLon:lon}) as Photo;
 it('accepts zero coordinates, rejects missing and invalid; sorts within days',()=>{
  expect(validGps(p(1,'',0,0))).toBe(true);expect(validGps(p(1,'',91,0))).toBe(false);expect(validGps(p(1,'',null,0))).toBe(false);
  const r=memoryRoutes([p(2,'2025-09-06 13:00:00',1,2),p(1,'2025-09-06 09:00:00',1,3)]);expect(r[0].photos.map(p=>p.id)).toEqual([1,2]);
 });
 it('crosses the dateline by the short direction',()=>{
  const f=routeGeometry([p(1,'2025-09-06 09:00:00',10,179),p(2,'2025-09-06 10:00:00',10,-179)]).features[0];if(f.geometry.type!=='LineString')throw Error();expect(Math.abs(f.geometry.coordinates.at(-1)![0]-f.geometry.coordinates[0][0])).toBe(2);
 });
});
describe('photo sphere settings',()=>{
 it('keeps the reference sphere defaults independent and clamps highlight brightness',()=>{
  expect(PHOTO_SPHERE_DEFAULTS.radius).toBe(1.58);
  expect(PHOTO_SPHERE_DEFAULTS.brightness).toBe(.68);
  expect(normalizePhotoSphereSettings({brightness:99}).brightness).toBe(1.25);
  expect(normalizePhotoSphereSettings({brightness:0}).brightness).toBe(.25);
 });
});
