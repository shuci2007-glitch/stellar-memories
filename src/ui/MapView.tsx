import {loadMapAsset} from '../core/mapAssets';
import { installEarthMapSurface } from "../three/EarthMapSurface";
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import * as maplibregl from 'maplibre-gl';
import type {GeoJSONSource,Marker,StyleSpecification} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {tmPhoto,tmThumb,tmVideo,type Photo} from '../core/types';
import {memoryRoutes,validGps,routeGeometry,routeProgressGeometry} from '../core/memoryRoutes';
import {loadMapRoutesEnabled,MAP_ROUTE_SETTINGS_EVENT} from '../core/MapRouteSettings';
import {isTauri} from '../core/env';
import {maplibreZoomForRadius,maplibreRadiusForZoom} from '../core/globeHandoff';
import {ipc} from '../core/db';
import InteractiveMapStarfield from './InteractiveMapStarfield';
import ProvincePhotoWall from './ProvincePhotoWall';
import {MapPhotoStacks,QuickLocationTray,startLocatedPhotoDrag,consumeLocationDragClick,type PhotoPlaceGroup} from './MapPhotoLayers';

/** 地球交接姿态:屏幕半径与经纬度在飞行地球(three)与 maplibre 之间精确互认 */
export interface EarthPose { lat:number; lng:number; screenRadius:number; viewportH:number }
interface EarthHandoffPose extends EarthPose { handoffId:number }

type BoundaryFeature={properties?:{name?:string;center?:number[];centroid?:number[];level?:string;parentProvince?:string};geometry:{type:string;coordinates:unknown}};
function inRing(lng:number,lat:number,ring:number[][]){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if(((a[1]>lat)!==(b[1]>lat))&&(lng<(b[0]-a[0])*(lat-a[1])/((b[1]-a[1])||1e-12)+a[0]))inside=!inside;}return inside;}
function inFeature(lng:number,lat:number,f:BoundaryFeature){const c=f.geometry.coordinates as number[][][]|number[][][][];const polygon=(p:number[][][])=>!!p[0]&&inRing(lng,lat,p[0])&&!p.slice(1).some(r=>inRing(lng,lat,r));if(f.geometry.type==='Polygon')return polygon(c as number[][][]);if(f.geometry.type==='MultiPolygon')return (c as number[][][][]).some(polygon);return false;}

/** 少量主要国家标注(全球层;中文,离线) */
const COUNTRY_LABELS:{name:string;lng:number;lat:number}[]=[
 {name:'中国',lng:104.2,lat:35.9},{name:'俄罗斯',lng:96.4,lat:61.5},{name:'美国',lng:-98.5,lat:39.8},
 {name:'加拿大',lng:-106.3,lat:56.1},{name:'巴西',lng:-51.9,lat:-10.8},{name:'澳大利亚',lng:134.2,lat:-24.5},
 {name:'印度',lng:79.5,lat:22.4},{name:'日本',lng:138.2,lat:36.2},{name:'法国',lng:2.5,lat:46.6},
 {name:'德国',lng:10.4,lat:51.1},{name:'埃及',lng:29.8,lat:26.8},{name:'南非',lng:24.7,lat:-29.0},
];

const globeStyle:StyleSpecification={
 version:8,
 projection:{type:'globe'},
 sources:{
  land:{type:'geojson',data:{type:'FeatureCollection',features:[]},attribution:'Natural Earth / DataV.GeoAtlas · 统一边界'},
  cn:{type:'geojson',data:{type:'FeatureCollection',features:[]},attribution:'DataV.GeoAtlas · 省级行政区划'},
 },
 layers:[
  {id:'water',type:'background',paint:{'background-color':'#0b1220'}},
  {id:'land',type:'fill',source:'land',paint:{'fill-color':'#28324a'}},
  {id:'cn-fill',type:'fill',source:'cn',paint:{'fill-color':'#31405c'}},
  {id:'countries-line',type:'line',source:'land',paint:{'line-color':'#5a6a86','line-width':0.7}},
  {id:'cn-line',type:'line',source:'cn',paint:{'line-color':'#7488ad','line-width':['interpolate',['linear'],['zoom'],3,0.8,6,1.6]}},
 ],
};

export default function MapView({photos,onOpenPhoto,focusPhotoId,active,locationEdit,onLocationDone,onPhotosChanged}:{photos:Photo[];onOpenPhoto:(id:number,source?:HTMLElement)=>void;focusPhotoId?:number|null;active:boolean;locationEdit:{photoId:number;lat:number|null;lon:number|null}|null;onLocationDone:(saved:boolean,place?:string)=>void|Promise<void>;onPhotosChanged:()=>Promise<void>}) {
 const host=useRef<HTMLDivElement>(null),mapRef=useRef<maplibregl.Map|null>(null),sectionRef=useRef<HTMLElement>(null);
 const fadeRef=useRef<HTMLDivElement>(null);
 const [ready,setReady]=useState(false),[error,setError]=useState(''),[day,setDay]=useState(''),[index,setIndex]=useState<number|null>(null),[playing,setPlaying]=useState(false);
 const [routesEnabled,setRoutesEnabled]=useState(false);
 const [speed,setSpeed]=useState(3600);
 const [tripAll,setTripAll]=useState(false);
 // 行程播放的媒体状态：视频/实况要真正播完才进下一站
 const [livePhase,setLivePhase]=useState<'still'|'motion'>('still');
 const [mediaFailed,setMediaFailed]=useState(false);
 const [mediaMuted,setMediaMuted]=useState(true);
 const [imageReady,setImageReady]=useState(false);
 const mediaRef=useRef<HTMLVideoElement>(null);
  useEffect(()=>{
   if(!isTauri())return; // 浏览器回退模式:无后端,不再发起读取
   let live=true,changed=false;
   const update=(e:Event)=>{changed=true;setRoutesEnabled((e as CustomEvent<boolean>).detail);};
   window.addEventListener(MAP_ROUTE_SETTINGS_EVENT,update);
   void loadMapRoutesEnabled().then(value=>{if(live&&!changed)setRoutesEnabled(value);}).catch(()=>{if(live)setError('连线设置读取失败，请在设置中重新选择。');});
   return()=>{live=false;window.removeEventListener(MAP_ROUTE_SETTINGS_EVENT,update);};
  },[]);
 const [groupLevel,setGroupLevel]=useState<'province'|'district'|'site'>('province');
 const [wallKey,setWallKey]=useState<string|null>(null);
 const [nearbyKey,setNearbyKey]=useState<string|null>(null);
 const [quickLocation,setQuickLocation]=useState(false);
 const [savingLocation,setSavingLocation]=useState(false);
 const [draft,setDraft]=useState<{lng:number;lat:number}|null>(null),[place,setPlace]=useState(''),[hoverPlace,setHoverPlace]=useState('');
 const editRef=useRef(locationEdit);editRef.current=locationEdit;const editMarker=useRef<Marker|null>(null);
 const provinceFeatures=useRef<BoundaryFeature[]>([]),cityFeatures=useRef<BoundaryFeature[]>([]);
 const saved=useRef<{center:maplibregl.LngLat;zoom:number;bearing:number;pitch:number}|null>(null);
 const didFit=useRef(false);
 const handoffRef=useRef(false);
 const readyRef=useRef(false);readyRef.current=ready;
 const pendingHandoff=useRef<EarthHandoffPose|null>(null);
 const handoffGeneration=useRef(0);
 const activeHandoffId=useRef(-1);
 const clearFadeEnd=useRef<(()=>void)|null>(null);
 const applyHandoffRef=useRef<(pose:EarthHandoffPose)=>void>(()=>{});
 const located=useMemo(()=>photos.filter(validGps),[photos]);
 const unlocatedPhotos=useMemo(()=>photos.filter(p=>!validGps(p)),[photos]);
 const unlocated=unlocatedPhotos.length;
 const regionAt=(lng:number,lat:number,level=groupLevel)=>{
  const province=provinceFeatures.current.find(f=>inFeature(lng,lat,f));
  const provinceKey=province?.properties?.name;
  const district=level==='province'?null:cityFeatures.current.find(f=>inFeature(lng,lat,f));
  const name=[provinceKey,district?.properties?.name].filter((v,i,a)=>v&&a.indexOf(v)===i).join(' · ');
  if(level==='province'&&provinceKey)return {key:provinceKey,name:provinceKey,provinceKey};
  if(level==='site')return {key:`site:${lng.toFixed(4)}:${lat.toFixed(4)}`,name:name||'拍摄地点',provinceKey};
  if(district?.properties?.name)return {key:`district:${name}`,name,provinceKey};
  const span=level==='province'?2:.25;
  return {key:`${level}:${Math.floor(lng/span)}:${Math.floor(lat/span)}`,name:name||'此处的回忆',provinceKey};
 };
 const groupedPhotos=useMemo(()=>{
  const build=(level:'province'|'district'|'site')=>{
   if(!ready)return [];
   const groups=new Map<string,PhotoPlaceGroup>();
   for(const photo of [...located].sort((a,b)=>a.id-b.id)){
    const region=regionAt(photo.gpsLon!,photo.gpsLat!,level);
    let group=groups.get(region.key);
    if(!group){group={...region,lng:photo.gpsLon!,lat:photo.gpsLat!,photos:[]};groups.set(region.key,group);}
    group.photos.push(photo);
   }
   return [...groups.values()];
  };
  return {province:build('province'),district:build('district'),site:build('site')};
 },[located,ready]);
 const photoGroups=useMemo(()=>groupedPhotos[groupLevel].map(g=>g.photos.some(p=>p.id===focusPhotoId)?{...g,photos:[...g.photos].sort((a,b)=>Number(b.id===focusPhotoId)-Number(a.id===focusPhotoId))}:g),[groupedPhotos,groupLevel,focusPhotoId]);
 const focusedVisit=useRef<string|null>(null);
 const wallGroup=groupedPhotos.province.find(g=>g.key===wallKey);
 useEffect(()=>{
  const map=mapRef.current;if(!map||!ready)return;
  const sync=()=>{const z=map.getZoom();setGroupLevel(level=>{
   if(z>=11.8)return 'site';
   if(level==='site'&&z>11.3)return 'site';
   if(z>=5.8)return 'district';
   if(level!=='province'&&z>5.3)return 'district';
   return 'province';
  });};
  sync();map.on('zoom',sync);return()=>{map.off('zoom',sync);};
 },[ready]);
 const wallShape=provinceFeatures.current.find(p=>p.properties?.name===wallKey);
 const nearby=photoGroups.find(g=>g.key===nearbyKey)?.photos??[];
 const routes=useMemo(()=>memoryRoutes(photos),[photos]);
 const connections=useMemo(()=>routeGeometry(photos),[photos]);
 const route=routes.find(r=>r.day===day)??routes[0]; const selected=index===null?null:route?.photos[index];

 useEffect(()=> {
  if(!host.current)return;
  let disposeSurface: (()=>void)|undefined;
  let dead=false;
  // 省界下载与地图样式初始化并行进行，弱网时减少就绪前的等待
  const provincesPromise=loadMapAsset('china-provinces') as Promise<unknown> as Promise<{features:(BoundaryFeature&{properties:{name:string;centroid?:number[]}})[]}>;
  const map=new maplibregl.Map({container:host.current,center:[105,32],zoom:1.55,maxZoom:17,pixelRatio:Math.min(devicePixelRatio,1.5),attributionControl:false,style:globeStyle});
  mapRef.current=map;
  if(import.meta.env.DEV){
    const w=window as unknown as {__memMaps?:maplibregl.Map[];__memMap?:maplibregl.Map};
    (w.__memMaps ??= []).push(map); w.__memMap=map;
  }

  // 分级 DOM 标注:全球层主要国家(低倍率) / 中国省份(进入区域后)
  const labels:{marker:Marker;kind:'country'|'province'|'city'}[]=[];
  const addLabel=(lng:number,lat:number,text:string,kind:'country'|'province'|'city')=>{
   const el=document.createElement('div');
   el.className=`globe-label ${kind}`;el.textContent=text;
   labels.push({marker:new maplibregl.Marker({element:el}).setLngLat([lng,lat]).addTo(map),kind});
  };
  for(const c of COUNTRY_LABELS) addLabel(c.lng,c.lat,c.name,'country');

  // 分级显隐:国家标注(全球) / 省份标注(区域)。背面遮挡交给 maplibre
  // 原生的 globe marker 淡化——它每帧改写 opacity,不要在这层竞争。
  const syncLabelZoom=()=>{
   const z=map.getZoom();
   for(const {marker,kind} of labels){
    const show=kind==='country'?z<3.4:kind==='province'?z>=3&&z<6.2:z>=5.8;
    marker.getElement().style.display=show?'':'none';
   }
  };

  map.on('load',async()=> {
   if(dead)return;
   disposeSurface=installEarthMapSurface(map);
   map.dragRotate.disable();map.touchZoomRotate.enable({around:"center"});map.touchZoomRotate.disableRotation();map.scrollZoom.enable({around:"center"});
   map.setSky({'sky-color':'#050810','horizon-color':'#0d1522','sky-horizon-blend':0.6,
    'atmosphere-blend':['interpolate',['linear'],['zoom'],0,0.6,4,0.25,6,0]});
   // 省级名称标注(来自边界数据自带的 centroid,离线)
   // 世界轮廓来自内置公有领域数据,离线可用;中国省界需在线获取。
   void loadMapAsset('earth-boundaries').then(data=>{if(!dead)(map.getSource('land') as GeoJSONSource).setData(data);}).catch(()=>{});
   try{
    const cn=await provincesPromise;
    if(dead)return;
    (map.getSource('cn') as GeoJSONSource).setData(cn as never);
    provinceFeatures.current=cn.features;
    for(const f of cn.features){const c=f.properties?.centroid;if(Array.isArray(c)&&c.length>=2)addLabel(c[0],c[1],f.properties.name,'province');}
    syncLabelZoom();
   }catch{setError('中国省界下载失败，已显示世界轮廓；联网后重新进入地图即可加载省界与照片墙。');}
   map.addSource('memories',{type:'geojson',data:{type:'FeatureCollection',features:[]},cluster:true,clusterRadius:48,clusterMaxZoom:14});
   map.addLayer({id:'clusters',type:'circle',source:'memories',filter:['has','point_count'],paint:{'circle-color':'#b3bfce','circle-opacity':0,'circle-radius':['interpolate',['linear'],['get','point_count'],2,7,100,15,1000,20]}});
   map.addLayer({id:'photos',type:'circle',source:'memories',filter:['!', ['has','point_count']],paint:{'circle-color':'#e0e5ed','circle-opacity':0,'circle-radius':4,'circle-stroke-color':'#7f91a8','circle-stroke-opacity':0,'circle-stroke-width':2}});
   map.addSource('route',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
   map.addLayer({id:'route-glow',type:'line',source:'route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':['get','color'],'line-width':5,'line-blur':2,'line-opacity':0,'line-opacity-transition':{duration:420,delay:0}}});
   map.addLayer({id:'route',type:'line',source:'route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':['get','color'],'line-width':1.6,'line-opacity':0,'line-opacity-transition':{duration:420,delay:0}}});
   map.addLayer({id:'route-selected',type:'line',source:'route',filter:['==',['get','day'],''],layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':['get','color'],'line-width':2.2,'line-opacity':0,'line-opacity-transition':{duration:420,delay:0}}});
   // 行程播放：已走过的轨迹逐站点亮
   map.addSource('route-done',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
   map.addLayer({id:'route-done',type:'line',source:'route-done',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':['get','color'],'line-width':2.6,'line-blur':.4,'line-opacity':0,'line-opacity-transition':{duration:240,delay:0}}});
   // 城市边界是可选离线层；数据存在时自动启用，缺失不影响核心地球。
   void (async()=>{try{const cities=await loadMapAsset('china-cities') as {features:BoundaryFeature[]};if(!dead&&cities.features?.length){cityFeatures.current=cities.features;map.addSource('cn-cities',{type:'geojson',data:cities as never});map.addLayer({id:'cn-cities-hit',type:'fill',source:'cn-cities',minzoom:4.8,paint:{'fill-color':'#ffffff','fill-opacity':0}});map.addLayer({id:'cn-cities-line',type:'line',source:'cn-cities',minzoom:4.8,paint:{'line-color':'#657794','line-width':['interpolate',['linear'],['zoom'],5,.45,9,1.15],'line-opacity':.72}});for(const f of cities.features){const c=f.properties?.centroid??f.properties?.center;if(Array.isArray(c)&&c.length>=2&&f.properties?.name)addLabel(c[0],c[1],f.properties.name,'city');}map.on('mousemove','cn-cities-hit',e=>{const p=e.features?.[0]?.properties;setHoverPlace([p?.parentProvince,p?.name].filter(Boolean).join(' · '));});map.on('mouseleave','cn-cities-hit',()=>setHoverPlace(''));syncLabelZoom();}}catch{/* Optional detailed boundaries. */}})();
   map.on('click',e=>{if(!editRef.current)return;const next={lng:e.lngLat.lng,lat:e.lngLat.lat};setDraft(next);editMarker.current?.setLngLat([next.lng,next.lat]);});
   setReady(true);
  });
  // 中国是初始朝向；用户可在任意缩放级别拖动地球，不自动拉回。
  map.dragPan.enable();
  map.on('move',syncLabelZoom);map.on('moveend',syncLabelZoom);
  map.on('error',()=>{if(!dead)setError('底图暂不可用；照片坐标仍可查看。');});
  const ro=new ResizeObserver(()=>map.resize());ro.observe(host.current);
  return()=>{dead=true;disposeSurface?.();setReady(false);ro.disconnect();for(const {marker} of labels)marker.remove();map.stop();map.remove();mapRef.current=null;};
 },[]); // eslint-disable-line react-hooks/exhaustive-deps

 useEffect(()=>{const map=mapRef.current;if(!ready||!map)return;
   (map.getSource('memories') as GeoJSONSource).setData({type:'FeatureCollection',features:located.map(p=>({type:'Feature',properties:{id:p.id},geometry:{type:'Point',coordinates:[p.gpsLon!,p.gpsLat!]}}))});
   // 只在首次就绪时取景一次;之后筛选/数据变化不重置用户镜头
   if(located.length&&!didFit.current&&!handoffRef.current&&map.getZoom()>=3){didFit.current=true;const bounds=new maplibregl.LngLatBounds();located.forEach(p=>bounds.extend([p.gpsLon!,p.gpsLat!]));map.fitBounds(bounds,{padding:{left:350,right:100,top:100,bottom:100},maxZoom:4.5,duration:900});}
 },[ready,located]);
 useEffect(()=>{const map=mapRef.current;if(!ready||!map)return;(map.getSource('route') as GeoJSONSource).setData(connections);},[ready,connections]);
 useEffect(()=>{const map=mapRef.current;if(!ready||!map)return;map.setFilter('route-selected',['==',['get','day'],route?.day??'']);},[ready,route?.day]);
useEffect(()=>{
 const map=mapRef.current;if(!ready||!map||!route)return;
 (map.getSource('route-done') as GeoJSONSource|undefined)?.setData(routeProgressGeometry(route,index===null?0:index+1));
},[ready,route,index]);
 useEffect(()=>{
  const map=mapRef.current;if(!ready||!map)return;
  const visible=routesEnabled&&!locationEdit;
  map.setPaintProperty('route','line-opacity',visible?.55:0);
  map.setPaintProperty('route-glow','line-opacity',visible?.13:0);
  map.setPaintProperty('route-selected','line-opacity',visible?.85:0);
  map.setPaintProperty('route-done','line-opacity',visible?.95:0);
 },[ready,routesEnabled,locationEdit]);
 // 重新显示时校正画布尺寸
 useEffect(()=>{
  const map=mapRef.current;if(!active||!ready||!map)return;
  map.resize();
  // 交接前已经采用最终构图；重新显示时只同步尺寸，绝不再播放横向补位动画。
  map.setPadding({left:Math.min(300,map.getCanvas().clientWidth*.16),right:0,top:0,bottom:0});
 },[active,ready]);
 // —— 地球镜头交接:飞行地球(three)与 maplibre 之间按屏幕半径/朝向精确互认 ——
 applyHandoffRef.current=(pose:EarthHandoffPose)=>{
  const map=mapRef.current,el=fadeRef.current;
  handoffRef.current=true;
  activeHandoffId.current=pose.handoffId;
  if(!readyRef.current||!map||!el){pendingHandoff.current=pose;return;}
  pendingHandoff.current=null;
  const generation=++handoffGeneration.current;
  clearFadeEnd.current?.();clearFadeEnd.current=null;
  el.style.transition='none';el.style.opacity='0';el.style.pointerEvents='none';
  map.resize();
  // 地图仍完全透明时直接落到右侧最终位置，淡入后不会再看见地球横移。
  map.setPadding({left:Math.min(300,map.getCanvas().clientWidth*.16),right:0,top:0,bottom:0});
  map.jumpTo({center:[pose.lng,pose.lat],zoom:maplibreZoomForRadius(pose.screenRadius,pose.viewportH,pose.lat),bearing:0,pitch:0});
  // jumpTo 后等待 MapLibre 真正画出该姿态的第一帧，再开始交叉淡入。
  map.once('render',()=>requestAnimationFrame(()=>{
   if(generation!==handoffGeneration.current||!handoffRef.current)return;
   const started=performance.now();let fadeRaf=0;
   const step=(now:number)=>{
    if(generation!==handoffGeneration.current||!handoffRef.current)return;
    const linear=Math.min(1,(now-started)/620);
    const eased=linear*linear*(3-2*linear);
    el.style.opacity=String(eased);
    if(linear<1){fadeRaf=requestAnimationFrame(step);return;}
    clearFadeEnd.current=null;
    window.dispatchEvent(new CustomEvent('map-handoff-complete',{detail:{handoffId:pose.handoffId}}));
   };
   el.style.transition='none';
   clearFadeEnd.current=()=>cancelAnimationFrame(fadeRaf);
   fadeRaf=requestAnimationFrame(step);
  }));
  map.triggerRepaint();
 };
 useEffect(()=>{
  const setFade=(visible:boolean,fade=true)=>{
    const el=fadeRef.current;if(!el)return;
    if(!visible){handoffGeneration.current++;pendingHandoff.current=null;clearFadeEnd.current?.();clearFadeEnd.current=null;}
    el.style.transition=fade?'opacity 620ms ease':'none';
    el.style.opacity=visible?'1':'0';
    el.style.pointerEvents=visible?'auto':'none';
  };
  setFade(false,false);
  const adopt=(e:Event)=>{
    const pose=(e as CustomEvent<EarthHandoffPose>).detail;if(!pose)return;
    handoffRef.current=true;didFit.current=true;applyHandoffRef.current(pose);
  };
  const query=()=>{
    const map=mapRef.current;if(!map)return;
    const c=map.getCenter();const vh=map.getCanvas().clientHeight;
    window.dispatchEvent(new CustomEvent('map-pose',{detail:{lat:c.lat,lng:c.lng,screenRadius:maplibreRadiusForZoom(map.getZoom(),vh,c.lat),viewportH:vh}}));
  };
  const sync=(e:Event)=>{
    const pose=(e as CustomEvent<EarthHandoffPose>).detail;if(!pose||pose.handoffId!==activeHandoffId.current)return;
    const map=mapRef.current;
    if(!readyRef.current||!map){pendingHandoff.current=pose;return;}
    map.jumpTo({center:[pose.lng,pose.lat],zoom:maplibreZoomForRadius(pose.screenRadius,pose.viewportH,pose.lat),bearing:0,pitch:0});
  };
  const fade=(e:Event)=>{const visible=(e as CustomEvent<{visible:boolean}>).detail?.visible??true;if(!visible){handoffRef.current=false;setFade(false);}else setFade(true);};
  window.addEventListener('map-adopt-pose',adopt);
  window.addEventListener('map-sync-pose',sync);
  window.addEventListener('map-pose-query',query);
  window.addEventListener('map-fade',fade);
  return()=>{handoffGeneration.current++;clearFadeEnd.current?.();window.removeEventListener('map-adopt-pose',adopt);window.removeEventListener('map-sync-pose',sync);window.removeEventListener('map-pose-query',query);window.removeEventListener('map-fade',fade);};
 },[]);
 useEffect(()=>{if(ready&&pendingHandoff.current)applyHandoffRef.current(pendingHandoff.current);},[ready]);
 useEffect(()=>{
  const el=fadeRef.current;if(!el)return;
  el.style.pointerEvents=active?'auto':'none';
  // Active means the map owns the view, including direct entry from photo details.
  if(active&&ready){el.style.opacity='1';mapRef.current?.resize();}
 },[active,ready]);
 useEffect(()=>{const map=mapRef.current;if(!ready||!map||!active)return;editMarker.current?.remove();editMarker.current=null;if(!locationEdit){setDraft(null);setPlace('');return;}
   const next=locationEdit.lat!=null&&locationEdit.lon!=null?{lng:locationEdit.lon,lat:locationEdit.lat}:{lng:map.getCenter().lng,lat:map.getCenter().lat};setDraft(next);
   const marker=new maplibregl.Marker({draggable:true,color:'#f1d09a'}).setLngLat([next.lng,next.lat]).addTo(map);marker.getElement().classList.add('location-edit-marker');marker.on('dragstart',()=>sectionRef.current?.classList.add('is-photo-locating'));marker.on('dragend',()=>sectionRef.current?.classList.remove('is-photo-locating'));marker.on('drag',()=>{const p=marker.getLngLat();setDraft({lng:p.lng,lat:p.lat});});editMarker.current=marker;
   if(locationEdit.lat!=null&&locationEdit.lon!=null)map.flyTo({center:[locationEdit.lon,locationEdit.lat],zoom:Math.max(map.getZoom(),6),duration:900});
   return()=>{sectionRef.current?.classList.remove('is-photo-locating');marker.remove();if(editMarker.current===marker)editMarker.current=null;};
 },[ready,active,locationEdit?.photoId,locationEdit?.lat,locationEdit?.lon]);
 useEffect(()=>{if(!draft){setPlace('');return;}const city=cityFeatures.current.find(f=>inFeature(draft.lng,draft.lat,f));const province=provinceFeatures.current.find(f=>inFeature(draft.lng,draft.lat,f));setPlace([province?.properties?.name,city?.properties?.name].filter((v,i,a)=>v&&a.indexOf(v)===i).join(' · '));},[draft]);
 const focusPhoto=located.find(p=>p.id===focusPhotoId);
 useEffect(()=>{
   const map=mapRef.current;
   if(!active||focusPhotoId==null){focusedVisit.current=null;return;}
   if(!ready||!map||!focusPhoto||locationEdit)return;
   const key=`${focusPhoto.id}:${focusPhoto.gpsLat}:${focusPhoto.gpsLon}`;
   if(focusedVisit.current===key)return;
   focusedVisit.current=key;
   setQuickLocation(false);setWallKey(null);setPlaying(false);setIndex(null);
   setNearbyKey(`site:${focusPhoto.gpsLon!.toFixed(4)}:${focusPhoto.gpsLat!.toFixed(4)}`);
   map.flyTo({center:[focusPhoto.gpsLon!,focusPhoto.gpsLat!],zoom:12.5,bearing:0,pitch:0,duration:1600,essential:true});
 },[active,ready,focusPhotoId,focusPhoto?.gpsLat,focusPhoto?.gpsLon,locationEdit]);
useEffect(()=>{if(!selected)return;const map=mapRef.current;if(!map)return;
  const arrive=Math.min(900,Math.round(speed*.3));
  map.flyTo({center:[selected.gpsLon!,selected.gpsLat!],zoom:12,duration:arrive,essential:true});
  // 停留期间缓慢推近，避免"跳一下然后静止"
  const push=setTimeout(()=>map.easeTo({zoom:13.05,duration:Math.max(1200,speed-arrive),essential:true}),arrive+120);
  return()=>clearTimeout(push);
},[selected?.id,speed]);
// 当前站要播放的视频源：整段视频，或实况进入动态阶段后的内嵌片段
const routeVideoSrc=!selected?'':selected.kind==='video'?tmVideo(selected.id):(selected.liveVideoId!=null&&livePhase==='motion'?tmVideo(selected.liveVideoId):'');
// 换站重置实况阶段与失败标记
useEffect(()=>{setLivePhase('still');setMediaFailed(false);setImageReady(false);},[selected?.id]);
// 原图没加载完先别开始计时，否则大图还没看清就被切走；最多等 2.5 秒兜底
useEffect(()=>{
  if(!selected||routeVideoSrc)return;
  const t=setTimeout(()=>setImageReady(true),2500);
  return()=>clearTimeout(t);
},[selected?.id,routeVideoSrc]);
const advance=useCallback(()=>{
  if(!route)return;
  if(index===null){setIndex(0);return;}
  if(index+1<route.photos.length){setIndex(index+1);return;}
  if(tripAll){
    const at=routes.findIndex(r=>r.day===route.day);
    const next=routes[at+1];
    if(next){setDay(next.day);setIndex(0);return;}
  }
  setPlaying(false);
},[index,route,tripAll,routes]);
// 照片按「每站时长」推进；视频与实况由播放结束事件推进，播到尽头再切
useEffect(()=>{
  if(!playing||!route)return;
  const isVideo=selected?.kind==='video';
  const isLive=selected?.liveVideoId!=null;
  if(isVideo&&!mediaFailed)return;
  if(isLive&&livePhase==='motion'&&!mediaFailed)return;
  // 静帧还没加载完就先不计时，等图出来再开始算这一站
  if(!routeVideoSrc&&!imageReady)return;
  const ms=isLive&&!mediaFailed?1600:speed;
  const timer=setTimeout(()=>{
    if(isLive&&!mediaFailed)setLivePhase('motion');
    else advance();
  },ms);
  return()=>clearTimeout(timer);
},[playing,index,route,speed,selected?.id,selected?.kind,selected?.liveVideoId,livePhase,mediaFailed,advance]);
// 暂停/继续要作用到视频上
useEffect(()=>{
  const v=mediaRef.current;if(!v)return;
  if(playing)void v.play().catch(()=>{});
  else v.pause();
},[playing,livePhase,selected?.id]);
const exit=()=>{setPlaying(false);setIndex(null);setTripAll(false);if(saved.current)mapRef.current?.easeTo({...saved.current,duration:700});saved.current=null;};
 useEffect(()=>{if(!active)return;const key=(e:KeyboardEvent)=>{if((e.target as HTMLElement).matches?.('input,textarea,select'))return;if(e.key==='Escape'){if(wallKey)return;if(editRef.current)onLocationDone(false);else if(quickLocation)setQuickLocation(false);else exit();}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[active,onLocationDone,quickLocation,wallKey]); // eslint-disable-line react-hooks/exhaustive-deps
 const start=()=>{const map=mapRef.current;if(!map||!route)return;setRoutesEnabled(true);if(!saved.current)saved.current={center:map.getCenter(),zoom:map.getZoom(),bearing:map.getBearing(),pitch:map.getPitch()};setIndex(0);setPlaying(true);};
const startAll=()=>{if(!routes.length)return;const map=mapRef.current;setRoutesEnabled(true);if(map&&!saved.current)saved.current={center:map.getCenter(),zoom:map.getZoom(),bearing:map.getBearing(),pitch:map.getPitch()};setTripAll(true);setDay(routes[0].day);setIndex(0);setPlaying(true);};
 const globeCircle=()=>{const map=mapRef.current;if(!map)return null;const canvas=map.getCanvas(),center=map.project(map.getCenter());return{x:center.x,y:center.y,radius:maplibreRadiusForZoom(map.getZoom(),canvas.clientHeight,map.getCenter().lat)};};
 const saveLocation=async()=>{if(!draft||!locationEdit||savingLocation)return;setSavingLocation(true);setError('');try{await ipc.setPhotoLocation(locationEdit.photoId,draft.lat,draft.lng);await onLocationDone(true,place);}catch(e){setError(`位置保存失败：${e}`);}finally{setSavingLocation(false);}};
 const clearLocation=async()=>{if(!locationEdit||savingLocation)return;setSavingLocation(true);setError('');try{await ipc.setPhotoLocation(locationEdit.photoId,null,null);await onLocationDone(true);}catch(e){setError(`位置清除失败：${e}`);}finally{setSavingLocation(false);}};
 return <section ref={sectionRef} className={'memory-map'+(locationEdit?' is-location-edit':'')}><div ref={fadeRef} style={{position:'absolute',inset:0,opacity:0}}>{/* 容器内联定位:maplibregl-map 类会把它改写为 relative,导致高度塌陷 */}<div ref={host} className="map-canvas" style={{position:'absolute',inset:0}}/><InteractiveMapStarfield active={active} globeCircle={globeCircle}/><MapPhotoStacks map={ready?mapRef.current:null} groups={photoGroups} editable={quickLocation} disabled={!!locationEdit} onOpen={g=>setNearbyKey(g.key)} onWall={g=>{const key=g.provinceKey??g.key;if(provinceFeatures.current.some(p=>p.properties?.name===key)){exit();setNearbyKey(null);setWallKey(key);}}}/>{!locationEdit&&quickLocation&&<QuickLocationTray map={ready?mapRef.current:null} photos={unlocatedPhotos} groups={photoGroups} regionKey={(lng,lat)=>regionAt(lng,lat).key} onSaved={onPhotosChanged} onClose={()=>setQuickLocation(false)} active={active}/>}{locationEdit?<aside className="location-editor"><small>为这张照片寻找真实地点</small><h1>{locationEdit.lat!=null?"调整照片位置":"设置照片位置"}</h1><p>旋转并缩放地球，然后单击地点；标记出现后仍可拖动微调。</p><div className="location-readout">{draft?<><b>{place||'正在识别行政区域'}</b><span>{draft.lat.toFixed(5)}°, {draft.lng.toFixed(5)}°</span></>:<span>等待选点</span>}</div><div className="location-actions"><button className="pill-btn primary" disabled={!draft||savingLocation} onClick={saveLocation}>{savingLocation?"正在保存…":"保存位置"}</button><button className="pill-btn" onClick={()=>onLocationDone(false)}>取消 · ESC</button>{locationEdit.lat!=null&&<button className="pill-btn ghost-danger" disabled={savingLocation} onClick={clearLocation}>清除位置</button>}</div>{error&&<p>{error}</p>}</aside>:!quickLocation&&<aside className="map-journal"><small>走过的地方</small><h1>记忆地球</h1><p>{located.length} 张照片 · {routes.length} 个有坐标的日子{unlocated>0&&` · ${unlocated} 张待补充位置`}</p><button className="pill-btn primary map-quick-entry" onClick={()=>{exit();setNearbyKey(null);setQuickLocation(true);}}>快速设置位置 · {unlocated} 张待定位</button><p className="map-note">远看按省叠放 · 放大查看市区与拍摄点 · 双击展开照片墙</p><p className="map-note">同一天的照片以同色弧线相连 · 可在设置中关闭</p>{error&&<p>{error}</p>}
 {routes.length>0?<><p className="map-route-legend"><span style={{background:route?.color}}/> {route?.day} · {routesEnabled?'同日连线已开启':'同日连线已关闭'}</p><select aria-label="旅行日期" value={route?.day} onChange={e=>{exit();setDay(e.target.value);}}>{routes.map(r=><option key={r.day}>{r.day}</option>)}</select><button className="pill-btn" onClick={()=>{setTripAll(false);start();}}>播放这一天 →</button>{routes.length>1&&<button className="pill-btn" onClick={startAll}>{tripAll&&playing?'正在连播全部行程':'连播全部行程 ▶'}</button>}
 <div className="route-stops">{route?.photos.map((p,i)=><button key={p.id} onClick={()=>{if(index===null)start();setPlaying(false);setIndex(i);}}><img src={tmThumb(p.id)} alt=""/><span>{p.captureDate?.slice(11,16)||'时间未知'}<small>{p.filename}</small></span></button>)}</div></>:<p className="map-empty">还没有带 GPS 的照片。可在照片详情手动指定坐标。</p>}

 </aside>}{!locationEdit&&nearby.length>0&&<aside className="map-nearby-panel"><div><span>此处的回忆 · {nearby.length} 张</span><button onClick={()=>setNearbyKey(null)} aria-label="收起此处照片">×</button></div><div className="map-nearby-grid">{nearby.map(p=><button key={p.id} className={p.id===focusPhotoId?"is-focused-photo":""} onPointerDown={e=>{if(quickLocation)startLocatedPhotoDrag(e.nativeEvent,p,e.currentTarget);}} onClick={e=>{if(!consumeLocationDragClick(e.currentTarget))onOpenPhoto(p.id,e.currentTarget);}} title={quickLocation?`${p.filename} · 拖回左侧取消定位`:p.filename}><img src={tmThumb(p.id)} alt={p.filename} loading="lazy"/></button>)}</div></aside>}{!locationEdit&&!quickLocation&&selected&&<div className="route-player">{routeVideoSrc?<video ref={mediaRef} key={routeVideoSrc} className="route-media" src={routeVideoSrc} autoPlay muted={mediaMuted} playsInline onEnded={advance} onError={()=>setMediaFailed(true)}/>:<img className="route-media" src={tmPhoto(selected.id)} alt={selected.filename} onClick={()=>onOpenPhoto(selected.id)} onLoad={()=>setImageReady(true)} onError={e=>{const el=e.currentTarget;setImageReady(true);if(!el.dataset.fb){el.dataset.fb='1';el.src=tmThumb(selected.id);}}}/>}<div className="route-info"><small>{selected.captureDate}</small><p>{selected.filename}</p><div className="route-progress"><i style={{width:`${(((index??0)+1)/(route?.photos.length||1))*100}%`}}/></div><div className="route-meta"><span>第 {(index??0)+1} / {route?.photos.length??0} 站</span><label>每站<select value={speed} onChange={e=>setSpeed(Number(e.target.value))} aria-label="播放速度"><option value={2400}>2.4s</option><option value={3600}>3.6s</option><option value={5500}>5.5s</option></select></label>{tripAll&&<span className="route-mode">连播全部</span>}</div><div className="route-controls"><button disabled={index===0} onClick={()=>{setPlaying(false);setIndex(i=>Math.max(0,(i??0)-1));}}>上一张</button><button onClick={()=>setPlaying(p=>!p)}>{playing?'暂停':'继续'}</button>{routeVideoSrc&&<button onClick={()=>setMediaMuted(m=>!m)} title="实况/视频的声音">{mediaMuted?'声音：关':'声音：开'}</button>}<button disabled={index===(route?.photos.length??1)-1} onClick={()=>{setPlaying(false);setIndex(i=>Math.min((route?.photos.length??1)-1,(i??0)+1));}}>下一张</button><button onClick={exit}>退出播放</button></div></div></div>}{hoverPlace&&<div className="map-hover-place">{hoverPlace}</div>}<div className="map-crosshair" aria-hidden="true"/><div className="map-credit">Solar System Scope · CC BY 4.0 · 昼夜按当前时间 · 夜灯为地理分布模拟 · 拖动旋转 · 滚轮缩放</div></div>{wallGroup&&wallShape&&<ProvincePhotoWall key={wallGroup.key} name={wallGroup.name} shape={wallShape} districts={cityFeatures.current.filter(p=>p.properties?.parentProvince===wallKey)} photos={wallGroup.photos} onClose={()=>setWallKey(null)}/>}</section>;
}
