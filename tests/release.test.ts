import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {parseSpc} from '../src/three/ParticlePhoto';
import {routeGeometry} from '../src/core/memoryRoutes';
import type {Photo} from '../src/core/types';

describe('release regression checks',()=>{
 it('rejects truncated headers and inflated record counts before allocating',()=>{
  expect(()=>parseSpc(new ArrayBuffer(4))).toThrow();
  const buffer=new ArrayBuffer(20),v=new DataView(buffer);
  v.setUint32(0,0x434d5342,true);v.setUint32(4,1,true);v.setUint32(8,0xffffffff,true);v.setUint32(12,10,true);v.setUint32(16,10,true);
  expect(()=>parseSpc(buffer)).toThrow();
 });
 it('does not connect photos from separate days',()=>{
  const photos=[{id:1,captureDate:'2026-01-01',gpsLat:10,gpsLon:20},{id:2,captureDate:'2026-01-02',gpsLat:20,gpsLon:30}] as Photo[];
  expect(routeGeometry(photos).features).toHaveLength(0);
 });
 it('bundles a valid public-domain world outline with China markers',()=>{
  const data=JSON.parse(readFileSync('public/maps/world-countries.geojson','utf-8')) as {type:string;features:{properties:{ADM0_A3?:string;adcode?:number}}[]};
  expect(data.type).toBe('FeatureCollection');
  expect(data.features.length).toBeGreaterThan(150);
  const codes=new Set(data.features.map(f=>f.properties?.ADM0_A3));
  expect(codes.has('CHN')).toBe(true);
  expect(codes.has('TWN')).toBe(true);
  // The world outline stays pure Natural Earth; China geometry lives in the DataV files.
  expect(data.features.every(f=>f.properties?.adcode===undefined)).toBe(true);
 });
 it('ships offline boundary data so the map works without network',()=>{
  for(const name of ['china-provinces','china-cities','earth-boundaries']){
   const data=JSON.parse(readFileSync(`public/maps/${name}.geojson`,'utf-8')) as {type:string;features:unknown[]};
   expect(data.type).toBe('FeatureCollection');
   expect(data.features.length).toBeGreaterThan(0);
  }
 });
});
