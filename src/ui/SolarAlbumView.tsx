import {useEffect,useMemo,useRef,useState} from 'react';
import * as THREE from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import {ipc} from '../core/db';
import {tmThumb,type Album,type GalaxyPhoto} from '../core/types';
import {Starfield} from '../three/Starfield';
import {STELLAR_BLEND,STELLAR_FILTER_GLSL,STELLAR_FRAGMENT} from '../three/starMaterial';
import {useToast} from '../core/toast';

type Planet={album:Album;root:THREE.Group;spin:THREE.Group;sphere:THREE.Mesh;angle:number;speed:number;orbit:number;tilt:number};

const PHOTO_PARTICLE_VERT=/* glsl */`
 attribute vec2 aUv;attribute float aSeed;uniform float uTime;uniform float uDpr;varying vec2 vUv;varying float vSeed;
 void main(){vUv=aUv;vSeed=aSeed;vec3 p=position+normal*(sin(uTime*.55+aSeed*18.)*.0025);vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;gl_PointSize=clamp((2.05+aSeed*.9)*uDpr*(8./max(-mv.z,1.)),1.25,3.4*uDpr);}`;
const PHOTO_PARTICLE_FRAG=/* glsl */`
 precision highp float;uniform sampler2D uMap;uniform float uOpacity;varying vec2 vUv;varying float vSeed;
 ${STELLAR_FILTER_GLSL}
 void main(){vec4 photo=texture2D(uMap,vUv);if(photo.a<.08)discard;vec2 point=(gl_PointCoord-vec2(.5))*2.;float disc=stellarDisc(point);float core=pow(max(0.,1.-length(point)),2.);vec3 color=photo.rgb*(.88+core*.32);float alpha=photo.a*disc*uOpacity*(.72+vSeed*.28);if(alpha<.025)discard;gl_FragColor=vec4(color*alpha,alpha);}`;

function photoParticlePatch(radius:number,lon:number,lat:number,aspect:number,texture:THREE.Texture){
 const cols=46,rows=Math.max(24,Math.round(cols/THREE.MathUtils.clamp(aspect,.65,1.8)));const width=1.02;const height=width/THREE.MathUtils.clamp(aspect,.65,1.8);
 const pos=new Float32Array(cols*rows*3),normal=new Float32Array(cols*rows*3),uv=new Float32Array(cols*rows*2),seed=new Float32Array(cols*rows);
 let n=0;for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){
  const u=(x+.5)/cols,v=(y+.5)/rows,a=lon+(u-.5)*width,b=lat+(v-.5)*height,cb=Math.cos(b);const px=cb*Math.cos(a),py=Math.sin(b),pz=cb*Math.sin(a);
  pos[n*3]=radius*px;pos[n*3+1]=radius*py;pos[n*3+2]=radius*pz;normal[n*3]=px;normal[n*3+1]=py;normal[n*3+2]=pz;uv[n*2]=u;uv[n*2+1]=1-v;seed[n]=(Math.sin((n+1)*91.713)*43758.5453)%1;seed[n]=Math.abs(seed[n]);n++;
 }
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(pos,3));geometry.setAttribute('normal',new THREE.BufferAttribute(normal,3));geometry.setAttribute('aUv',new THREE.BufferAttribute(uv,2));geometry.setAttribute('aSeed',new THREE.BufferAttribute(seed,1));
 const material=new THREE.ShaderMaterial({vertexShader:PHOTO_PARTICLE_VERT,fragmentShader:PHOTO_PARTICLE_FRAG,transparent:true,depthWrite:false,depthTest:true,toneMapped:false,...STELLAR_BLEND,uniforms:{uMap:{value:texture},uTime:{value:0},uDpr:{value:Math.min(devicePixelRatio,1.5)},uOpacity:{value:.96}}});
 return new THREE.Points(geometry,material);
}

function makeSun(){
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0],3));
 const v=`uniform float uTime;varying vec3 vColor;varying float vAlpha;varying float vBrightness;varying float vRay;varying float vDiam;
 void main(){vec4 mv=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*mv;float p=18.+sin(uTime*.8)*2.;gl_PointSize=p;vDiam=p;vColor=vec3(1.,.78,.48);vAlpha=.95;vBrightness=2.7;vRay=1.;}`;
 const m=new THREE.ShaderMaterial({vertexShader:v,fragmentShader:STELLAR_FRAGMENT,transparent:true,depthWrite:false,toneMapped:false,...STELLAR_BLEND,uniforms:{uTime:{value:0}}});
 return new THREE.Points(g,m);
}

/** 相册不是卡片网格，而是同一记忆宇宙的近距离行星系统。 */
export default function SolarAlbumView({albums,photos,onOpenPhoto,onChanged}:{albums:Album[];photos:GalaxyPhoto[];onOpenPhoto:(id:number)=>void;onChanged:()=>void}){
 const host=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null),labels=useRef(new Map<number,HTMLButtonElement>());
 const callback=useRef(onOpenPhoto);callback.current=onOpenPhoto;
 const [focused,setFocused]=useState<number|null>(null);const focusRef=useRef<number|null>(null);focusRef.current=focused;
 const [renaming,setRenaming]=useState<number|null>(null),[name,setName]=useState('');const toast=useToast();
 const albumPhotos=useMemo(()=>{const m=new Map<number,GalaxyPhoto[]>();for(const p of photos)if(p.albumId!=null){const a=m.get(p.albumId)??[];a.push(p);m.set(p.albumId,a);}return m;},[photos]);

 useEffect(()=>{
  if(!canvas.current||!host.current)return;const cvs=canvas.current,scene=new THREE.Scene();
  const renderer=new THREE.WebGLRenderer({canvas:cvs,alpha:true,antialias:true,powerPreference:'high-performance'});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.setClearColor(0x05070b,0);
  const camera=new THREE.PerspectiveCamera(44,1,.1,260);camera.position.set(0,15,34);
  const controls=new OrbitControls(camera,cvs);controls.enableDamping=true;controls.dampingFactor=.07;controls.minDistance=5;controls.maxDistance=92;controls.maxPolarAngle=Math.PI*.82;controls.target.set(0,0,0);
  const ambient=new THREE.HemisphereLight(0xc9ddff,0x17110b,1.5),key=new THREE.PointLight(0xffd9a8,48,80,1.5);key.position.set(0,0,0);scene.add(ambient,key);
  const stars=new Starfield(2200);stars.points.scale.setScalar(.3);stars.setOpacity(.86);scene.add(stars.points);
  const sun=makeSun();scene.add(sun);
  const core=new THREE.Mesh(new THREE.SphereGeometry(1.1,48,32),new THREE.MeshStandardMaterial({color:0xdab878,emissive:0xb97532,emissiveIntensity:2.3,roughness:.72}));scene.add(core);
  const halo=new THREE.Mesh(new THREE.SphereGeometry(1.62,32,20),new THREE.MeshBasicMaterial({color:0xd9b06f,transparent:true,opacity:.065,side:THREE.BackSide,depthWrite:false}));scene.add(halo);
  const clickable:THREE.Object3D[]=[];const planets:Planet[]=[];const disposables:THREE.Material[]=[];const loader=new THREE.TextureLoader();
  albums.forEach((album,i)=>{
   const orbit=6+(i%12)*2.05+Math.floor(i/12)*.42;const angle=i*2.399+Math.floor(i/12)*.7;const tilt=((i%5)-2)*.045;
   const ringPts:THREE.Vector3[]=[];for(let k=0;k<160;k++){const a=k/159*Math.PI*2;ringPts.push(new THREE.Vector3(Math.cos(a)*orbit,Math.sin(a*2+i)*tilt*orbit,Math.sin(a)*orbit));}
   const ringGeo=new THREE.BufferGeometry().setFromPoints(ringPts);const ringMat=new THREE.LineBasicMaterial({color:0x647086,transparent:true,opacity:.16,depthWrite:false});scene.add(new THREE.LineLoop(ringGeo,ringMat));disposables.push(ringMat);
   const root=new THREE.Group(),spin=new THREE.Group();root.add(spin);scene.add(root);
   const radius=THREE.MathUtils.clamp(1.05+Math.log2(album.photoCount+1)*.16,1.05,2.05);
   const hue=(i*.083+album.id*.017)%1;const color=new THREE.Color().setHSL(.52+hue*.18,.3,.12+.025*(i%3));
   const mat=new THREE.MeshStandardMaterial({color,roughness:.96,metalness:.02,transparent:true,opacity:.22,depthWrite:true,emissive:color.clone().multiplyScalar(.12)});disposables.push(mat);
   const sphere=new THREE.Mesh(new THREE.SphereGeometry(radius,40,28),mat);sphere.userData={albumId:album.id,kind:'planet'};spin.add(sphere);clickable.push(sphere);
   const aps=albumPhotos.get(album.id)??[];const shown=aps.slice(0,Math.min(16,Math.max(1,aps.length)));
   shown.forEach((p,j)=>{
    const ga=Math.PI*(3-Math.sqrt(5));const lat=Math.asin(-1+2*(j+.5)/Math.max(1,shown.length));const lon=j*ga;
    const tex=loader.load(tmThumb(p.id));tex.colorSpace=THREE.SRGBColorSpace;tex.minFilter=THREE.LinearMipmapLinearFilter;
    const patch=photoParticlePatch(radius*1.025,lon,lat,p.width/Math.max(1,p.height),tex);patch.userData={photoId:p.id,albumId:album.id,kind:'photo-particles'};spin.add(patch);clickable.push(patch);
   });
   planets.push({album,root,spin,sphere,angle,speed:.035+(i%7)*.004,orbit,tilt});
  });
  const ray=new THREE.Raycaster(),pointer=new THREE.Vector2();ray.params.Points!.threshold=.12;let down={x:0,y:0};let raf=0,last=performance.now(),dead=false;
  const hit=(ev:PointerEvent|MouseEvent)=>{const r=cvs.getBoundingClientRect();pointer.set((ev.clientX-r.left)/r.width*2-1,-(ev.clientY-r.top)/r.height*2+1);ray.setFromCamera(pointer,camera);return ray.intersectObjects(clickable,false)[0]?.object;};
  const onMove=(e:PointerEvent)=>{const h=hit(e);cvs.style.cursor=h?'pointer':'grab';};
  const onDown=(e:PointerEvent)=>{down={x:e.clientX,y:e.clientY};};
  const onUp=(e:PointerEvent)=>{if(Math.hypot(e.clientX-down.x,e.clientY-down.y)>5)return;const h=hit(e);const id=h?.userData.photoId;if(typeof id==='number')callback.current(id);};
  const onDbl=(e:MouseEvent)=>{const h=hit(e);const id=h?.userData.albumId as number|undefined;if(id!=null)setFocused(id);};
  const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape'&&focusRef.current!=null)setFocused(null);};
  cvs.addEventListener('pointermove',onMove);cvs.addEventListener('pointerdown',onDown);cvs.addEventListener('pointerup',onUp);cvs.addEventListener('dblclick',onDbl);window.addEventListener('keydown',onKey);
  const resize=()=>{if(!host.current)return;const w=host.current.clientWidth,h=host.current.clientHeight;renderer.setSize(w,h,false);camera.aspect=w/Math.max(1,h);camera.updateProjectionMatrix();};const ro=new ResizeObserver(resize);ro.observe(host.current);resize();
  const tick=(now:number)=>{if(dead)return;raf=requestAnimationFrame(tick);const dt=Math.min(.05,(now-last)/1000);last=now;stars.update(dt,now/1000);(sun.material as THREE.ShaderMaterial).uniforms.uTime.value=now/1000;halo.scale.setScalar(1+.035*Math.sin(now*.0007));for(const p of planets)for(const c of p.spin.children)if(c instanceof THREE.Points&&c.userData.kind==='photo-particles')(c.material as THREE.ShaderMaterial).uniforms.uTime.value=now/1000;
   const f=focusRef.current;for(const p of planets){if(f!==p.album.id)p.angle+=dt*p.speed;p.root.position.set(Math.cos(p.angle)*p.orbit,Math.sin(p.angle*2+p.album.id)*p.tilt*p.orbit,Math.sin(p.angle)*p.orbit);p.spin.rotation.y+=dt*.075;const el=labels.current.get(p.album.id);if(el){const v=p.root.position.clone().project(camera);const visible=v.z<1;el.style.transform=`translate(${(v.x*.5+.5)*renderer.domElement.clientWidth}px,${(-v.y*.5+.5)*renderer.domElement.clientHeight}px)`;el.style.opacity=visible?'1':'0';}}
   const targetPlanet=f==null?null:planets.find(p=>p.album.id===f);const desiredTarget=targetPlanet?.root.position??new THREE.Vector3();const desiredPos=targetPlanet?desiredTarget.clone().add(new THREE.Vector3(0,2.4,6.8)):new THREE.Vector3(0,15,34);const k=1-Math.exp(-dt*3.2);controls.target.lerp(desiredTarget,k);if(targetPlanet)camera.position.lerp(desiredPos,k);controls.enabled=!targetPlanet;controls.update();renderer.render(scene,camera);
  };raf=requestAnimationFrame(tick);
  return()=>{dead=true;cancelAnimationFrame(raf);ro.disconnect();cvs.removeEventListener('pointermove',onMove);cvs.removeEventListener('pointerdown',onDown);cvs.removeEventListener('pointerup',onUp);cvs.removeEventListener('dblclick',onDbl);window.removeEventListener('keydown',onKey);controls.dispose();stars.dispose();for(const p of planets){p.sphere.geometry.dispose();for(const c of p.spin.children)if(c instanceof THREE.Points&&c.userData.kind==='photo-particles'){c.geometry.dispose();const m=c.material as THREE.ShaderMaterial;(m.uniforms.uMap.value as THREE.Texture).dispose();m.dispose();}}for(const o of scene.children)if(o instanceof THREE.Line)o.geometry.dispose();sun.geometry.dispose();(sun.material as THREE.Material).dispose();core.geometry.dispose();(core.material as THREE.Material).dispose();halo.geometry.dispose();(halo.material as THREE.Material).dispose();for(const m of disposables)m.dispose();renderer.dispose();scene.clear();};
 },[albums,albumPhotos]);

 const saveRename=async(id:number)=>{if(name.trim()){await ipc.renameAlbum(id,name.trim());await onChanged();toast('行星已重命名');}setRenaming(null);};
 const focusAlbum=albums.find(a=>a.id===focused);
 return <section className="solar-view" ref={host}><canvas ref={canvas} aria-label="记忆行星系统"/>
  <div className="solar-heading"><small>MEMORY ORBIT</small><h1>{albums.length?'记忆行星系':'等待第一颗记忆行星'}</h1><p>拖动观察 · 滚轮缩放 · 双击行星靠近 · ESC 返回轨道</p></div>
  <div className="solar-labels">{albums.map(a=><button key={a.id} ref={el=>{if(el)labels.current.set(a.id,el);else labels.current.delete(a.id);}} onDoubleClick={()=>setFocused(a.id)}><b>{a.name}</b><small>{a.photoCount} 张记忆</small></button>)}</div>
  {albums.length>0&&focused==null&&<nav className="solar-orbit-index" aria-label="行星目录">{albums.map(a=><button key={a.id} onClick={()=>setFocused(a.id)}><span>{a.name}</span><small>{a.photoCount}</small></button>)}</nav>}
  {focusAlbum&&<aside className="planet-panel"><small>正在靠近</small>{renaming===focusAlbum.id?<input autoFocus value={name} onChange={e=>setName(e.target.value)} onBlur={()=>saveRename(focusAlbum.id)} onKeyDown={e=>e.key==='Enter'&&saveRename(focusAlbum.id)}/>:<h2>{focusAlbum.name}</h2>}<p>{focusAlbum.photoCount} 张照片贴附在这颗行星表面</p><button onClick={()=>{setRenaming(focusAlbum.id);setName(focusAlbum.name);}}>重命名</button><button onClick={()=>setFocused(null)}>返回行星系 · ESC</button></aside>}
  {albums.length===0&&<div className="solar-empty"><span>✦</span><p>导入照片并建立相册后，记忆会在这里凝成行星。</p></div>}
 </section>;
}
