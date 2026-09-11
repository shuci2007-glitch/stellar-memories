import * as THREE from 'three';
import {SVGLoader} from 'three/examples/jsm/loaders/SVGLoader.js';
import {ASTRA_MAIN_VERTEX,ASTRA_SIM_FRAGMENT,makeAstraGalaxyMaterial,makeAstraPathStarMaterial} from './AstraGalaxyMaterial';

const SVG_PATHS=[
 'M128.472 2.36011C65.4727 24.3601 10.7725 93.1601 9.97246 162.36C8.97246 248.86 79.4138 262.86 87.9725 262.86C116.973 262.86 135.973 244.36 135.973 221.36C135.973 189.86 102.973 193.86 102.973 209.36',
 'M224.973 31.8602C132.473 3.86011 29.9727 75.8601 29.9727 159.86C29.9727 247.86 98.4726 259.86 126.473 247.86',
 'M126.473 215.359C124.639 222.692 117.073 237.159 101.473 236.359C89.1905 235.729 76.0585 219.995 76.4724 195.859C76.4724 165.859 100.473 142.859 132.473 142.859C171.973 142.859 213.473 171.36 213.473 231.36C213.473 276.36 170.473 328.36 85.9727 316.86',
 'M106.973 237.36C81.9727 240.36 61.4727 222.86 61.4727 184.86C61.4727 153.36 91.9727 123.36 132.473 123.36C172.973 123.36 227.973 149.86 227.973 225.36C227.973 287.36 168.473 322.36 121.473 322.36C53.4727 322.36 10.9727 264.86 2.47266 208.36',
 'M114.973 211.36C114.973 225.86 92.4727 226.86 92.4727 205.36C92.4727 183.86 109.938 175.36 127.973 175.36C146.008 175.36 174.473 195.86 174.473 230.86C174.473 264.36 148.473 281.86 133.973 287.36C119.473 292.86 81.6727 296.56 54.4727 269.36',
];
const SVG=`<svg viewBox="0 0 231 325" xmlns="http://www.w3.org/2000/svg">${SVG_PATHS.map(d=>`<path d="${d}"/>`).join('')}</svg>`;

export const ASTRA_ARM_CONFIG=[
 {depth:.62,phase:.16,speed:.025,strong:true},
 {depth:-.46,phase:.72,speed:-.018,strong:false},
 {depth:.78,phase:.38,speed:.021,strong:true},
 {depth:-.70,phase:.58,speed:-.016,strong:false},
 {depth:.42,phase:.08,speed:.030,strong:true},
] as const;

const PALETTE=['#6DCBF4','#7AB1FE','#F87915','#FA994C','#F5F6FB'].map(v=>new THREE.Color(v));
const SECONDARY_COLOR_SEEDS=[.08,.58,.22,.68,.44];
const DENSITY=4,SIZE=2.05,SCATTER=.4,DENSITY_FALLOFF=.22,SIZE_FALLOFF=.45;

class AstraCurve extends THREE.Curve<THREE.Vector3>{
 constructor(private source:THREE.CurvePath<THREE.Vector2>,private depth:number,private rotationDepth:number,private depthPhase:number){super();this.arcLengthDivisions=640;}
 getPoint(t:number,target=new THREE.Vector3()){
  const r=THREE.MathUtils.clamp(t,0,1),p=this.source.getPointAt(r),envelope=Math.sin(r*Math.PI);
  const z=Math.sin(r*Math.PI*1.35+this.depthPhase)*this.depth*this.rotationDepth*envelope;
  return target.set((p.x-114.973)*(9.7/325),(211.36-p.y)*(9.7/325),z);
 }
}

function mulberry32(value:number){let seed=value>>>0;return()=>{let t=seed+=0x6d2b79f5;t=Math.imul(t^(t>>>15),1|t);return(((t^=t+Math.imul(t^(t>>>7),61|t))^(t>>>14))>>>0)/0x100000000;};}
function positiveModulo(v:number,m=1){return((v%m)+m)%m;}
function densityProgress(v:number){const p=positiveModulo(v);return p+DENSITY_FALLOFF*Math.sin(p*Math.PI*2)/(Math.PI*2);}
function sizeFalloff(progress:number){const middle=Math.sin(THREE.MathUtils.clamp(progress,0,1)*Math.PI);return THREE.MathUtils.lerp(1,.14+.86*Math.pow(Math.max(middle,0),.68),SIZE_FALLOFF);}
function tipFade(progress:number){return THREE.MathUtils.smoothstep(progress,0,.055)*(1-THREE.MathUtils.smoothstep(progress,.945,1));}
function starColor(seed:number,colorMode=true){
 if(!colorMode)return new THREE.Color(1,1,1);
 return seed<.36?PALETTE[0]:seed<.52?PALETTE[1]:seed<.64?PALETTE[2]:seed<.74?PALETTE[3]:PALETTE[4];
}
function writeStarColor(array:Float32Array,offset:number,seed:number,colorMode=true){const c=starColor(seed,colorMode);array[offset]=c.r;array[offset+1]=c.g;array[offset+2]=c.b;}
function makePathTexture(curve:AstraCurve){
 const data=new Float32Array(2048),point=new THREE.Vector3();
 for(let i=0;i<512;i++){curve.getPointAt(i/511,point);const o=i*4;data[o]=point.x;data[o+1]=point.y;data[o+2]=point.z;data[o+3]=1;}
 const texture=new THREE.DataTexture(data,512,1,THREE.RGBAFormat,THREE.FloatType);texture.magFilter=THREE.NearestFilter;texture.minFilter=THREE.NearestFilter;texture.generateMipmaps=false;texture.wrapS=texture.wrapT=THREE.ClampToEdgeWrapping;texture.needsUpdate=true;
 return texture;
}
function motionMass(brightness:number,scale:number){return THREE.MathUtils.lerp(.65,2.4,THREE.MathUtils.smoothstep(brightness*scale,1,14));}

interface PendingMotion{previous:THREE.Vector2;current:THREE.Vector2;impulse:THREE.Vector2}

class ParticleMotionState{
 private current:THREE.WebGLRenderTarget;private next:THREE.WebGLRenderTarget;private scene=new THREE.Scene();private simPoints:THREE.Points;
 private material:THREE.ShaderMaterial;private initialized=false;age=99;
 constructor(private display:THREE.Points,private displayMaterial:THREE.ShaderMaterial,count:number){
  const side=Math.ceil(Math.sqrt(count)),options:THREE.RenderTargetOptions={format:THREE.RGBAFormat,type:THREE.FloatType,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:false,stencilBuffer:false};
  this.current=new THREE.WebGLRenderTarget(side,side,options);this.next=new THREE.WebGLRenderTarget(side,side,options);
  this.material=new THREE.ShaderMaterial({vertexShader:ASTRA_MAIN_VERTEX,fragmentShader:ASTRA_SIM_FRAGMENT,defines:{ASTRA_PARTICLE_SIMULATION:1},uniforms:displayMaterial.uniforms,depthTest:false,depthWrite:false,blending:THREE.NoBlending});
  this.simPoints=new THREE.Points(display.geometry,this.material);this.simPoints.frustumCulled=false;this.simPoints.matrixAutoUpdate=false;this.scene.add(this.simPoints);
 }
 private init(renderer:THREE.WebGLRenderer){if(this.initialized)return;const old=renderer.getRenderTarget(),alpha=renderer.getClearAlpha(),color=renderer.getClearColor(new THREE.Color());renderer.setClearColor(0,0);for(const rt of[this.current,this.next]){renderer.setRenderTarget(rt);renderer.clear(true,false,false);}renderer.setRenderTarget(old);renderer.setClearColor(color,alpha);this.displayMaterial.uniforms.uParticleMotionTexture.value=this.current.texture;this.initialized=true;}
 step(dt:number){this.age=Math.min(99,this.age+dt);this.displayMaterial.uniforms.uParticleMotionAge.value=this.age;}
 impulse(renderer:THREE.WebGLRenderer,camera:THREE.Camera,pending:PendingMotion,aspect:number){
  this.init(renderer);this.display.updateMatrixWorld(true);this.simPoints.matrix.copy(this.display.matrixWorld);
  const u=this.displayMaterial.uniforms;u.uParticleMotionEnabled.value=1;u.uParticleMotionAge.value=this.age;u.uParticleMotionPrevious.value.copy(pending.previous);u.uParticleMotionPointer.value.copy(pending.current);u.uParticleMotionImpulse.value.copy(pending.impulse);u.uViewportAspect.value=aspect;u.uParticleMotionTexture.value=this.current.texture;
  const old=renderer.getRenderTarget();renderer.setRenderTarget(this.next);renderer.clear();renderer.render(this.scene,camera);renderer.setRenderTarget(old);
  [this.current,this.next]=[this.next,this.current];u.uParticleMotionTexture.value=this.current.texture;this.age=0;u.uParticleMotionAge.value=0;
 }
 dispose(){this.current.dispose();this.next.dispose();this.material.dispose();this.scene.clear();}
}

interface Layer{points:THREE.Points;material:THREE.ShaderMaterial;texture?:THREE.Texture;motion?:ParticleMotionState;speed:number;travel:number;dust?:boolean}

function addMotionUv(geometry:THREE.BufferGeometry,count:number,brightness:Float32Array,scale:Float32Array){
 const side=Math.ceil(Math.sqrt(count)),uv=new Float32Array(count*3);
 for(let i=0;i<count;i++){uv[i*3]=(i%side+.5)/side;uv[i*3+1]=(Math.floor(i/side)+.5)/side;uv[i*3+2]=motionMass(brightness[i],scale[i]);}
 geometry.setAttribute('particleMotionUv',new THREE.BufferAttribute(uv,3));
}

function makeArmLayer(curve:AstraCurve,index:number,mainCount:number,backgroundCount:number,pixelRatio:number){
 const cfg=ASTRA_ARM_CONFIG[index],count=mainCount+backgroundCount,rng=mulberry32((0x243f6a88^Math.imul(index+1,0x9e3779b9))>>>0),colorRng=mulberry32((0xa4093822^Math.imul(index+1,0x299f31d0))>>>0);
 const position=new Float32Array(count*3),orbit=new Float32Array(count),across=new Float32Array(count),brightness=new Float32Array(count),colors=new Float32Array(count*3),depth=new Float32Array(count),hero=new Float32Array(count),background=new Float32Array(count),opacity=new Float32Array(count),scale=new Float32Array(count),phase=new Float32Array(count),rate=new Float32Array(count);
 const point=new THREE.Vector3(),tangent=new THREE.Vector3(),acrossDir=new THREE.Vector3();let heroIndex=0,heroScale=-Infinity;
 for(let i=0;i<count;i++){
  const raw=rng(),progress=densityProgress(raw),middle=Math.sin(progress*Math.PI);curve.getPointAt(progress,point);curve.getTangentAt(progress,tangent).normalize();acrossDir.set(-tangent.y,tangent.x,0).normalize();
  const width=SCATTER*THREE.MathUtils.lerp(.3,1,middle)*(.22+.78*rng()),side=(rng()+rng()-1)*width,z=(rng()+rng()-1)*width*.65;
  point.addScaledVector(acrossDir,side);point.z+=z;const brightChance=THREE.MathUtils.lerp((cfg.strong?.085:.055)*.22,cfg.strong?.085:.055,middle),bright=rng()<brightChance;
  const starScale=(bright?.85+1.25*rng():.12+Math.pow(rng(),2.4)*.68)*SIZE;
  const starBrightness=(bright?2+1.5*rng():.56+.78*rng())*(cfg.strong?1:.82),o=i*3;
  position[o]=point.x;position[o+1]=point.y;position[o+2]=point.z;orbit[i]=raw;across[i]=side;brightness[i]=starBrightness;writeStarColor(colors,o,colorRng(),true);depth[i]=z;opacity[i]=.82+.16*rng();scale[i]=starScale;phase[i]=rng()*Math.PI*2;rate[i]=.65+.7*rng();background[i]=i>=mainCount?1:0;
  if(i<mainCount&&starScale>heroScale){heroScale=starScale;heroIndex=i;}
 }
 scale[heroIndex]=Math.max(scale[heroIndex],(cfg.strong?2.2:2.05)*SIZE);brightness[heroIndex]=Math.max(brightness[heroIndex],cfg.strong?3.35:2.85);hero[heroIndex]=1;writeStarColor(colors,heroIndex*3,SECONDARY_COLOR_SEEDS[index],true);
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(position,3));geometry.setAttribute('orbitProgress',new THREE.BufferAttribute(orbit,1));geometry.setAttribute('starAcrossOffset',new THREE.BufferAttribute(across,1));geometry.setAttribute('starBrightness',new THREE.BufferAttribute(brightness,1));geometry.setAttribute('starColor',new THREE.BufferAttribute(colors,3));geometry.setAttribute('starDepthOffset',new THREE.BufferAttribute(depth,1));geometry.setAttribute('starHero',new THREE.BufferAttribute(hero,1));geometry.setAttribute('starBackground',new THREE.BufferAttribute(background,1));geometry.setAttribute('starOpacity',new THREE.BufferAttribute(opacity,1));geometry.setAttribute('starScale',new THREE.BufferAttribute(scale,1));geometry.setAttribute('twinklePhase',new THREE.BufferAttribute(phase,1));geometry.setAttribute('twinkleRate',new THREE.BufferAttribute(rate,1));addMotionUv(geometry,count,brightness,scale);
 const texture=makePathTexture(curve),material=makeAstraGalaxyMaterial(texture,pixelRatio,true),points=new THREE.Points(geometry,material);points.frustumCulled=false;points.renderOrder=40+index;
 return{points,material,texture,speed:cfg.speed,travel:cfg.phase};
}

function makeDustLayer(curve:AstraCurve,index:number,count:number,pixelRatio:number){
 const cfg=ASTRA_ARM_CONFIG[index],rng=mulberry32((0x9e3779b9^Math.imul(index+1,0x85ebca6b))>>>0),position=new Float32Array(count*3),driftPhase=new Float32Array(count),driftTangent=new Float32Array(count*3),orbit=new Float32Array(count),opacity=new Float32Array(count),scale=new Float32Array(count),point=new THREE.Vector3(),tangent=new THREE.Vector3(),across=new THREE.Vector3();
 for(let i=0;i<count;i++){const raw=(i+.92*rng())/count,average=(rng()+rng()+rng())/3,progress=rng()<DENSITY_FALLOFF?average:raw,middle=Math.sin(progress*Math.PI),envelope=sizeFalloff(progress);curve.getPointAt(progress,point);curve.getTangentAt(progress,tangent).normalize();across.set(-tangent.y,tangent.x,0).normalize();const tight=rng()<.68,width=(tight?.035:.4)*envelope;point.addScaledVector(across,(rng()+rng()-1)*width);point.z+=(rng()+rng()-1)*width*.7;const o=i*3;position[o]=point.x;position[o+1]=point.y;position[o+2]=point.z;driftPhase[i]=rng();driftTangent[o]=tangent.x;driftTangent[o+1]=tangent.y;driftTangent[o+2]=tangent.z;orbit[i]=progress;scale[i]=rng()*(tight?1:.72)*envelope;opacity[i]=tipFade(progress)*(tight?1:.72)*(.38+.58*rng())*THREE.MathUtils.lerp(1,.3+.7*middle,SIZE_FALLOFF);}
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(position,3));geometry.setAttribute('driftPhase',new THREE.BufferAttribute(driftPhase,1));geometry.setAttribute('driftTangent',new THREE.BufferAttribute(driftTangent,3));geometry.setAttribute('orbitProgress',new THREE.BufferAttribute(orbit,1));geometry.setAttribute('particleOpacity',new THREE.BufferAttribute(opacity,1));geometry.setAttribute('particleScale',new THREE.BufferAttribute(scale,1));
 const material=makeAstraPathStarMaterial(pixelRatio,cfg.strong,Math.sign(cfg.speed)),points=new THREE.Points(geometry,material);points.frustumCulled=false;points.renderOrder=70+index;return{points,material,speed:cfg.speed,travel:cfg.phase,dust:true};
}

function makeCore(count:number,pixelRatio:number){
 const rng=mulberry32(0xb7e15162),colorRng=mulberry32(0xc0ac29b7),position=new Float32Array(count*3),orbit=new Float32Array(count),across=new Float32Array(count),brightness=new Float32Array(count),colors=new Float32Array(count*3),depth=new Float32Array(count),hero=new Float32Array(count),background=new Float32Array(count),opacity=new Float32Array(count),scale=new Float32Array(count),phase=new Float32Array(count),rate=new Float32Array(count);let heroIndex=0,best=-Infinity;
 for(let i=0;i<count;i++){const radius=Math.pow(rng(),2.4)*.42,angle=rng()*Math.PI*2,o=i*3;position[o]=Math.cos(angle)*radius;position[o+1]=Math.sin(angle)*radius*.72;position[o+2]=(rng()-.5)*.16;const center=1-radius/.42;brightness[i]=1.2+2.8*center+.6*rng();writeStarColor(colors,o,center>.74?.99:colorRng(),true);opacity[i]=.62+.38*center;scale[i]=(.28+1.45*center+.45*rng())*SIZE*.8;const score=brightness[i]*scale[i];if(score>best){best=score;heroIndex=i;}phase[i]=rng()*Math.PI*2;rate[i]=.55+.45*rng();}
 hero[heroIndex]=1;const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(position,3));geometry.setAttribute('orbitProgress',new THREE.BufferAttribute(orbit,1));geometry.setAttribute('starAcrossOffset',new THREE.BufferAttribute(across,1));geometry.setAttribute('starBrightness',new THREE.BufferAttribute(brightness,1));geometry.setAttribute('starColor',new THREE.BufferAttribute(colors,3));geometry.setAttribute('starDepthOffset',new THREE.BufferAttribute(depth,1));geometry.setAttribute('starHero',new THREE.BufferAttribute(hero,1));geometry.setAttribute('starBackground',new THREE.BufferAttribute(background,1));geometry.setAttribute('starOpacity',new THREE.BufferAttribute(opacity,1));geometry.setAttribute('starScale',new THREE.BufferAttribute(scale,1));geometry.setAttribute('twinklePhase',new THREE.BufferAttribute(phase,1));geometry.setAttribute('twinkleRate',new THREE.BufferAttribute(rate,1));addMotionUv(geometry,count,brightness,scale);
 const material=makeAstraGalaxyMaterial(null,pixelRatio,false);material.uniforms.uIntensity.value=1.35*1.22;material.userData.baseIntensity=1.35*1.22;const points=new THREE.Points(geometry,material);points.frustumCulled=false;points.renderOrder=100;return{points,material,speed:0,travel:0};
}

/** dev A/B renderer and future production adapter. Every random sequence and distribution mirrors generateAstraField. */
export class AstraReferenceGalaxy{
 readonly group=new THREE.Group();readonly points=this.group;private layers:Layer[]=[];private curves:AstraCurve[]=[];private intro=0;private introTarget=1;private introRate=1.45;private time=0;private previousPointer=new THREE.Vector2();private pointerValid=false;private pending:PendingMotion|null=null;
 constructor(pixelRatio=Math.min(devicePixelRatio,2),worldScale=1){
  this.curves=new SVGLoader().parse(SVG).paths.map(p=>p.subPaths[0]).map((p,i)=>new AstraCurve(p,ASTRA_ARM_CONFIG[i].depth,1.4,.82*i));
  this.curves.forEach((curve,i)=>{const cfg=ASTRA_ARM_CONFIG[i],main=Math.max(8,Math.round((cfg.strong?220:170)*DENSITY)),background=Math.ceil(.12*main/.88),dust=Math.max(1,Math.round((cfg.strong?150:90)*DENSITY));const arm=makeArmLayer(curve,i,main,background,pixelRatio),dustLayer=makeDustLayer(curve,i,dust,pixelRatio);this.layers.push(arm,dustLayer);this.group.add(arm.points,dustLayer.points);});
  const core=makeCore(Math.max(18,Math.round(24*DENSITY)),pixelRatio);this.layers.push(core);this.group.add(core.points);
  this.group.position.set(0,-.62*worldScale,0);this.group.rotation.set(.08,-.06,-.025);this.group.scale.setScalar(worldScale);
 }
 get converge(){return this.intro;}
 /** Astra 可视旋臂上的精确世界坐标，供照片星辰共享同一骨架。 */
 armWorldPoint(arm:number,progress:number,out=new THREE.Vector3()){
  const curve=this.curves[((arm%this.curves.length)+this.curves.length)%this.curves.length];
  curve.getPointAt(THREE.MathUtils.clamp(progress,0,1),out);
  this.group.updateMatrixWorld(true);
  return this.group.localToWorld(out);
 }
 setIntroProgress(value:number){this.intro=this.introTarget=THREE.MathUtils.clamp(value,0,1);}
 playIntro(){this.intro=0;this.introTarget=1;}
 setConvergeTarget(value:number,rate?:number){this.introTarget=THREE.MathUtils.clamp(value,0,1);if(rate)this.introRate=rate;}
 interact(_point:THREE.Vector3|null){}
  setPointer(ndc:THREE.Vector2|null){
  if(!ndc){this.pointerValid=false;this.pending=null;return;}
  if(this.pointerValid){
    const impulse=ndc.clone().sub(this.previousPointer);
    if(impulse.length()>.00001){
      const ready=this.intro>.985;
      const local=impulse.clone().clampLength(0,ready?.025:.035);
      this.pending={previous:ndc.clone().sub(local),current:ndc.clone(),impulse:local.multiplyScalar(ready?.48:.65)};
    }
  }
  this.previousPointer.copy(ndc);this.pointerValid=true;
  }
  /** 背景散星只在 intro 使用矩形分布；范围随当前视锥和宽高比扩展，避免拉远后露出固定方框。 */
  private updateScatterFrustum(camera:THREE.Camera,aspect:number){
   if(!(camera instanceof THREE.PerspectiveCamera))return;
   const center=this.group.getWorldPosition(new THREE.Vector3()),scale=this.group.getWorldScale(new THREE.Vector3());
   const distance=Math.max(.1,camera.position.distanceTo(center));
   const visibleHeight=2*Math.tan(THREE.MathUtils.degToRad(camera.fov)*.5)*distance/Math.max(.0001,scale.y);
   const height=Math.max(12,visibleHeight*1.45),width=Math.max(12,height*Math.max(1,aspect));
   for(const layer of this.layers){const scatter=layer.material.uniforms.uScatterSize;if(scatter)scatter.value.set(width,height);}
  }
  tick(dt:number,renderer:THREE.WebGLRenderer,camera:THREE.Camera,aspect:number,opacity=1,backgroundRotation?:THREE.Quaternion){
   this.time+=dt;this.intro+=(this.introTarget-this.intro)*(1-Math.exp(-dt*this.introRate));if(Math.abs(this.introTarget-this.intro)<.0005)this.intro=this.introTarget;
   this.group.updateMatrixWorld(true);this.updateScatterFrustum(camera,aspect);
   const stableMatrix=new THREE.Matrix4().compose(this.group.position,backgroundRotation??this.group.quaternion,this.group.scale).premultiply(camera.matrixWorldInverse);
   for(const layer of this.layers){
     if(layer.dust)continue;
     const uniforms=layer.material.uniforms;
     uniforms.uStableBackgroundModelView??={value:new THREE.Matrix4()};
     uniforms.uStableBackgroundModelView.value.copy(stableMatrix);
     uniforms.uPointerRepelRadius.value=THREE.MathUtils.lerp(.28,.18,THREE.MathUtils.smoothstep(this.intro,.9,1));
   }
  for(const layer of this.layers){layer.travel=positiveModulo(layer.travel+layer.speed*dt);layer.material.uniforms.uTime.value=this.time;layer.material.uniforms.uIntroProgress.value=this.intro;layer.material.uniforms.uIntensity.value=(layer.material.userData.baseIntensity as number)*opacity;if(layer.dust)layer.material.uniforms.uHeadProgress.value=layer.travel;else layer.material.uniforms.uPathOffset.value=layer.travel;if(layer.motion)layer.motion.step(dt);}
  if(this.pending){for(const layer of this.layers){if(layer.dust)continue;if(!layer.motion)layer.motion=new ParticleMotionState(layer.points,layer.material,layer.points.geometry.getAttribute('position').count);layer.motion.impulse(renderer,camera,this.pending,aspect);}this.pending=null;}
 }
 dispose(){for(const layer of this.layers){layer.motion?.dispose();layer.points.geometry.dispose();layer.material.dispose();layer.texture?.dispose();if(!layer.texture&&!layer.dust)(layer.material.uniforms.uPathTexture.value as THREE.Texture)?.dispose();}this.layers=[];this.group.clear();}
}
