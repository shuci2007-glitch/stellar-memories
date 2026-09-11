import * as THREE from 'three';
import { ARM_PATHS, ARM_PATH_SAMPLES } from './armPaths';
import { STELLAR_BLEND, STELLAR_FRAGMENT } from './starMaterial';

/**
 * 记忆星系 v3 —— 按 OpenAI Astra 页面的真实架构实现(学习其原理,代码原创):
 *  - 5 条手绘螺旋臂烘焙成路径纹理,星星沿臂流动(每臂独立速度)而非整体刚性旋转;
 *  - 撒星遵循官方分布:密度聚集 warp、三角横向散布、双层亮度(hero 每臂一颗)、低频闪烁;
 *  - 指针交互 = NDC 透镜(放大 + 抬深 + 增亮),不是圆形笔刷;
 *  - 片元 = ≥4px 超采样 + 小点亚像素覆盖近似 + 亮星十字光芒 + 亮度白芯;
 *  - 每颗星仍带 aScatter:锁屏散云 ↔ 银河同 buffer morph。
 */
const ARMS=ARM_PATHS.length;

const DENSITY_FALLOFF=0.55;   // sin 聚集强度
const ACROSS_SCATTER=5.2;     // 横向散布(官方 clamp ≤.45,×场景尺度 13)
const ARM_DEPTH=15;           // 臂的 Z 起伏幅度
const CORE_SIGMA=13;          // 核球半径
const GLOBAL_SIZE=1.35;       // starScale 全局倍率(官方 size 配置 clamp .25~3)

/** 取第 arm 条臂上 progress 处的世界坐标(相册星簇锚点用) */
export function armPoint(arm:number,progress:number,out=new THREE.Vector3()){
 const p=ARM_PATHS[arm%ARMS];
 const t=THREE.MathUtils.clamp(progress,0,1)*(ARM_PATH_SAMPLES-1);
 const lo=Math.floor(t),hi=Math.min(lo+1,ARM_PATH_SAMPLES-1),f=t-lo;
 const x=p[lo*2]+(p[hi*2]-p[lo*2])*f;
 const y=p[lo*2+1]+(p[hi*2+1]-p[lo*2+1])*f;
 const z=Math.sin(t/ (ARM_PATH_SAMPLES-1) *Math.PI*1.35+.82*(arm%ARMS))*ARM_DEPTH;
 return out.set(x,y,z);
}

const VERTEX=`
attribute vec4 aData;   // progress, across, depth, seed
attribute vec4 aMeta;   // brightness, scale, opacity, hero
attribute float aMode;  // 0 core · 1..5 arm · 6 dust
attribute vec3 color;
attribute float aAlpha;
attribute vec3 aScatter;
uniform float uOpacity;uniform float uConverge;uniform float uDpr;uniform float uTime;
uniform sampler2D uPathTex;uniform float uPathSamples;uniform float uArms;
uniform float uDensityFalloff;uniform float uArmDepth;uniform float uArmSpeeds[5];
uniform vec2 uLensPointer;uniform float uLensActive;uniform float uLensRadius;
uniform float uLensMagnification;uniform float uLensDepth;uniform float uLensIllumination;
uniform vec4 uCoast[8];uniform float uCoastAge[8];
varying vec3 vColor;varying float vAlpha;varying float vBrightness;varying float vRay;varying float vDiam;

vec2 sampleArm(float arm,float progress,out float z){
 float s=clamp(progress,0.,1.)*(uPathSamples-1.);
 float lo=floor(s),hi=min(lo+1.,uPathSamples-1.);float f=fract(s);
 vec2 a=texture2D(uPathTex,vec2((lo+.5)/uPathSamples,(arm+.5)/uArms)).xy;
 vec2 b=texture2D(uPathTex,vec2((hi+.5)/uPathSamples,(arm+.5)/uArms)).xy;
 z=sin(clamp(progress,0.,1.)*3.14159*1.35+.82*arm)*uArmDepth;
 return mix(a,b,f);
}
float shimmer(float seed,float t){return .72+.28*sin(t*(1.5+seed*2.)+seed*50.);}

void main(){
 float intro=clamp(uConverge,0.,1.);
 float mode=aMode;
 vec3 gal;float envelope=1.;float endpoint=1.;
 if(mode>5.5){
  // 臂间散尘:走臂路径,横向更宽,更暗
  float arm=mod(mode,6.)-1.;
  float phase=fract(aData.x+uTime*uArmSpeeds[int(arm)]*.7);
  float warped=clamp(phase+uDensityFalloff*sin(phase*6.28318)/6.28318,0.,1.);
  float z;vec2 p=sampleArm(arm,warped,z);
  float zt;vec2 zb;vec2 za;
  zb=sampleArm(arm,clamp(warped-.002,0.,1.),zt);
  za=sampleArm(arm,clamp(warped+.002,0.,1.),zt);
  vec2 tang=normalize(za-zb+vec2(1e-4,0.));
  gal=vec3(p+vec2(-tang.y,tang.x)*aData.y,z*.6+aData.z);
  endpoint=smoothstep(0.,.04,warped)*(1.-smoothstep(.96,1.,warped));
 }else if(mode>.5){
  // 臂星:沿臂流动 + 密度聚集 + 切向横向散布 + 官方端点/包络
  float arm=mode-1.;
  float phase=fract(aData.x+uTime*uArmSpeeds[int(arm)]);
  float warped=clamp(phase+uDensityFalloff*sin(phase*6.28318)/6.28318,0.,1.);
  float mid=sin(warped*3.14159);
  envelope=mix(1.,.14+.86*pow(max(mid,0.),.68),.6);
  endpoint=smoothstep(0.,.055,warped)*(1.-smoothstep(.945,1.,warped));
  float z;vec2 p=sampleArm(arm,warped,z);
  float zt;vec2 zb;vec2 za;
  zb=sampleArm(arm,clamp(warped-.002,0.,1.),zt);
  za=sampleArm(arm,clamp(warped+.002,0.,1.),zt);
  vec2 tang=normalize(za-zb+vec2(1e-4,0.));
  vec2 acrossDir=vec2(-tang.y,tang.x);
  float zc=sin(warped*3.14159*1.35+.82*arm)*uArmDepth*mid;
  gal=vec3(p+acrossDir*aData.y,zc+aData.z*.75);
 }else{
  gal=position; // 核球:构造时写入 position
 }
 // Astra converge-tilt:逐星 delay / duration / smootherstep / 轨道弧线。
 vec3 sc=aScatter;
 sc.x+=sin(uTime*.05+sc.y*.04+aData.w*6.283)*3.2;
 sc.y+=cos(uTime*.04+sc.z*.045+aData.w*9.4)*2.4;
 sc.z+=sin(uTime*.045+sc.x*.04+aData.w*4.2)*3.2;
 float start=.14+aData.w*.18;
 float duration=.58+fract(aData.x+aData.z)*.1;
 float local=clamp((intro-start)/duration,0.,1.);
 float smoothPull=local*local*local*(local*(local*6.-15.)+10.);
 float pull=mix(smoothPull,sin(smoothPull*3.14159265*.5),.5);
 float angle=sin(pull*3.14159265)*(.44+aData.w*.22);
 float ca=cos(angle),sa=sin(angle);
 vec3 orbiting=vec3(sc.x*ca-sc.y*sa,sc.x*sa+sc.y*ca,sc.z);
 vec3 p=mix(orbiting,gal,pull);
 vec4 view=modelViewMatrix*vec4(p,1.);
 vec4 clip=projectionMatrix*view;
 // 指针透镜(NDC):放大 + 抬深 + 增亮
 float twinkle=.86+.14*sin(uTime*(.65+aData.z*.7)+aData.x*6.283);
 vec2 ndc=clip.xy/max(clip.w,1e-4);
 // Astra coast 的解析形式：扫过只注入动量，之后指数滑行并回到原位。
 // 每颗星由亮度/尺寸得到质量，Hero 星更重，不会整片同步移动。
 float mass=mix(.65,2.4,smoothstep(1.,14.,aMeta.x*aMeta.y));
 mass=max(mass,mix(mass,3.2,aMeta.w));
 vec2 coastOffset=vec2(0.);
 for(int i=0;i<8;i++){
  float age=uCoastAge[i];if(age>=6.)continue;
  vec2 delta=ndc-uCoast[i].xy;
  float weight=pow(1.-smoothstep(0.,.20,length(delta)),2.);
  float drag=2.3/sqrt(mass);
  float vd=exp(-drag*age),rd=exp(-age);
  coastOffset+=uCoast[i].zw*(rd-vd)/max(drag-1.,.025)*weight/mass;
 }
 clip.xy+=coastOffset*clip.w;
 ndc=clip.xy/max(clip.w,1e-4);
 float lens=(1.-smoothstep(0.,uLensRadius,length(ndc-uLensPointer)))*uLensActive;
 view.z+=lens*uLensDepth;
 clip=projectionMatrix*view;
 clip.xy=uLensPointer*clip.w+(clip.xy-uLensPointer*clip.w)*(1.+lens*uLensMagnification);
 vColor=color;
 vBrightness=aMeta.x*twinkle*(1.+lens*uLensIllumination);
 vRay=smoothstep(1.45,2.8,vBrightness);
 float introScale=sqrt(max(.08,.1+.9*pull));
 float diam=uDpr*(0.3+aMeta.y*envelope*endpoint*2.6)*(0.97+twinkle*.03);
 diam*=1.+lens*uLensMagnification*.7;
 diam*=introScale;
 vDiam=diam;
 gl_PointSize=max(diam,3.0);
 vAlpha=aAlpha*uOpacity*mix(.55*shimmer(aData.w,uTime),1.,pull)*endpoint;
 gl_Position=clip;
}`;

export class MemoryGalaxy {
 readonly points:THREE.Points;
 private material:THREE.ShaderMaterial;
 private geometry:THREE.BufferGeometry;
 private age=0;
 private convergeTarget=0;
 private convergeCur=0;
 private convergeRate=1.05;
 private pointer=new THREE.Vector2(9,9);
 private pointerTarget=new THREE.Vector2(9,9);
 private pointerSample=new THREE.Vector2();
 private pointerSampleValid=false;
 private lensActive=0;
 private lensTarget=0;
 private coast=Array.from({length:8},()=>new THREE.Vector4(0,0,0,0));
 private coastAge=new Float32Array(8).fill(99);
 private coastIndex=0;
 get converge(){return this.convergeCur;}
 setConvergeTarget(t:number,rate?:number){this.convergeTarget=THREE.MathUtils.clamp(t,0,1);if(rate)this.convergeRate=rate;}
 /** NDC 指针(透镜中心);离开画布传 null */
 setPointer(ndc:THREE.Vector2|null){
  if(ndc){
   if(this.pointerSampleValid){
    const delta=ndc.clone().sub(this.pointerSample);const len=delta.length();
    if(len>.004){
     delta.multiplyScalar(Math.min(1,.18/len));
     const slot=this.coastIndex;this.coastIndex=(slot+1)%this.coast.length;
     this.coast[slot].set((ndc.x+this.pointerSample.x)*.5,(ndc.y+this.pointerSample.y)*.5,delta.x*5.4,delta.y*5.4);
     this.coastAge[slot]=0;
    }
   }
   this.pointerSample.copy(ndc);this.pointerSampleValid=true;
   this.pointerTarget.copy(ndc);this.lensTarget=1;
  }else{this.lensTarget=0;this.pointerSampleValid=false;}
 }
 constructor(count=110000) {
  let seed=0x243f6a88;const rng=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const gaussian=()=>Math.sqrt(-2*Math.log(Math.max(.00001,rng())))*Math.cos(6.283*rng());

  // ---- 路径纹理:5 臂 × 512 采样(RG=世界 xy;z 在着色器里由 progress 算) ----
  const texData=new Float32Array(ARM_PATH_SAMPLES*ARMS*4);
  for(let a=0;a<ARMS;a++){const p=ARM_PATHS[a];
   for(let i=0;i<ARM_PATH_SAMPLES;i++){const o=(a*ARM_PATH_SAMPLES+i)*4;texData[o]=p[i*2];texData[o+1]=p[i*2+1];texData[o+3]=1;}}
  const pathTex=new THREE.DataTexture(texData,ARM_PATH_SAMPLES,ARMS);
  pathTex.format=THREE.RGBAFormat;pathTex.type=THREE.FloatType;
  pathTex.minFilter=THREE.LinearFilter;pathTex.magFilter=THREE.LinearFilter;pathTex.wrapS=THREE.ClampToEdgeWrapping;pathTex.needsUpdate=true;

  // ---- 撒星(官方分布) ----
  const armCount=Math.floor(count*.86);
  const perArm=Math.floor(armCount/ARMS);
  const coreCount=Math.floor(count*.055);
  const dustCount=count-armCount-coreCount;
  const total=perArm*ARMS+coreCount+dustCount;

  const position=new Float32Array(total*3);
  const scatter=new Float32Array(total*3);
  const data=new Float32Array(total*4);   // progress, across, depth, seed
  const meta=new Float32Array(total*4);   // brightness, scale, opacity, hero
  const modes=new Float32Array(total);    // 0 core · 1..5 arm · 6 dust
  const colors=new Float32Array(total*3);
  const alpha=new Float32Array(total);
  const armSpeeds=[.0052,-.0061,.0046,-.0055,.0066];

  let i=0;
  const put=(mode:number)=>{modes[i]=mode;return i++;};

  for(let a=0;a<ARMS;a++){
   for(let k=0;k<perArm;k++){
    const id=put(1+a);
    const pr=Math.pow(rng(),1.12);
    const mid=Math.sin(pr*Math.PI);
    const u=ACROSS_SCATTER*THREE.MathUtils.lerp(.3,1,mid)*(.22+.78*rng());
    const across=(rng()+rng()-1)*u;
    const depth=(rng()+rng()-1)*u*.65;
    const brightP=rng()<THREE.MathUtils.lerp(.055*.22,.055,mid);
    const scale=(brightP?.85+1.25*rng():.12+Math.pow(rng(),2.4)*.68)*GLOBAL_SIZE;
    const brightness=brightP?2+1.5*rng():(.56+.78*rng());
    data[id*4]=pr;data[id*4+1]=across;data[id*4+2]=depth;data[id*4+3]=rng();
    meta[id*4]=brightness;meta[id*4+1]=scale;meta[id*4+2]=.82+.16*rng();meta[id*4+3]=0;
    alpha[id]=.6+.25*rng();
    const w=rng();let cr:number,cg:number,cb:number;
    // 色彩按旋臂形成可读的局部群落，避免高密度随机叠加后重新混成一片白。
    const warmArm=a===1||a===4,coolArm=a===0||a===2;
    if((warmArm&&w<.56)||w<.08){cr=1;cg=.34+rng()*.2;cb=.08+rng()*.14;}
    else if((coolArm&&w<.72)||w<.48){cr=.12+rng()*.14;cg=.48+rng()*.2;cb=1;}
    else{cr=.76+rng()*.16;cg=.86+rng()*.1;cb=1;}
    colors[id*3]=cr;colors[id*3+1]=cg;colors[id*3+2]=cb;
   }
   let heroId=-1,best=-1;
   for(let k=0;k<perArm;k++){const id=a*perArm+k;if(meta[id*4+1]>best){best=meta[id*4+1];heroId=id;}}
   if(heroId>=0){meta[heroId*4+1]=Math.max(meta[heroId*4+1],2.2*GLOBAL_SIZE);meta[heroId*4]=Math.max(meta[heroId*4],3.35);meta[heroId*4+3]=1;colors[heroId*3]=.96;colors[heroId*3+1]=.98;colors[heroId*3+2]=1;}
  }
  for(let k=0;k<coreCount;k++){
   const id=put(0);
   const cx=gaussian()*CORE_SIGMA,cz=gaussian()*CORE_SIGMA;
   position[id*3]=cx;position[id*3+1]=gaussian()*1.5;position[id*3+2]=cz;
   scatter[id*3]=cx;scatter[id*3+1]=position[id*3+1];scatter[id*3+2]=cz;
   meta[id*4]=.9+rng()*.9;meta[id*4+1]=.5+rng()*.8;meta[id*4+2]=.85;
   alpha[id]=.75+rng()*.25;
   const t2=rng();colors[id*3]=.95+t2*.05;colors[id*3+1]=.94+t2*.05;colors[id*3+2]=.9+t2*.06;
  }
  for(let k=0;k<dustCount;k++){
   const id=put(6);
   const a2=Math.floor(rng()*ARMS);
   void a2;
   const u=ACROSS_SCATTER*1.6*(.3+.7*rng());
   data[id*4]=rng();data[id*4+1]=(rng()+rng()-1)*u;data[id*4+2]=(rng()+rng()-1)*u*.8;data[id*4+3]=rng();
   meta[id*4]=.4+rng()*.5;meta[id*4+1]=.35+rng()*.45;
   alpha[id]=.2+rng()*.25;
   const w=rng();
   if(w<.16){colors[id*3]=1;colors[id*3+1]=.3+rng()*.18;colors[id*3+2]=.08+rng()*.12;}
   else if(w<.62){colors[id*3]=.12+rng()*.16;colors[id*3+1]=.46+rng()*.2;colors[id*3+2]=1;}
   else{colors[id*3]=.72+rng()*.18;colors[id*3+1]=.82+rng()*.14;colors[id*3+2]=1;}
  }
  for(let id=0;id<total;id++){
   if(modes[id]<.5)continue;
   const depth=rng();
   let sr:number,sy:number;
   if(depth<.45){sr=90+rng()*150;sy=(rng()-.5)*110;}
   else if(depth<.8){sr=40+rng()*90;sy=(rng()-.5)*70;}
   else{sr=8+rng()*40;sy=(rng()-.5)*24;}
   const sa=rng()*Math.PI*2;
   scatter[id*3]=Math.cos(sa)*sr+gaussian()*7;
   scatter[id*3+1]=sy+Math.sin(sr*.05+seed*.001)*7;
   scatter[id*3+2]=Math.sin(sa)*sr+gaussian()*7;
  }

  this.geometry=new THREE.BufferGeometry();
  this.geometry.setAttribute('position',new THREE.BufferAttribute(position,3));
  this.geometry.setAttribute('aScatter',new THREE.BufferAttribute(scatter,3));
  this.geometry.setAttribute('aData',new THREE.BufferAttribute(data,4));
  this.geometry.setAttribute('aMeta',new THREE.BufferAttribute(meta,4));
  this.geometry.setAttribute('aMode',new THREE.BufferAttribute(modes,1));
  this.geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
  this.geometry.setAttribute('aAlpha',new THREE.BufferAttribute(alpha,1));
  this.material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,depthTest:false,toneMapped:false,...STELLAR_BLEND,
   uniforms:{
    uOpacity:{value:1},uTime:{value:0},uConverge:{value:0},uDpr:{value:Math.min(devicePixelRatio,1.5)},
    uPathTex:{value:pathTex},uPathSamples:{value:ARM_PATH_SAMPLES},uArms:{value:ARMS},
    uDensityFalloff:{value:DENSITY_FALLOFF},uArmDepth:{value:ARM_DEPTH},
    uArmSpeeds:{value:armSpeeds},
    uLensPointer:{value:this.pointer},uLensActive:{value:0},uLensRadius:{value:.3},
    uLensMagnification:{value:.22},uLensDepth:{value:.7},uLensIllumination:{value:.9},
    uCoast:{value:this.coast},uCoastAge:{value:this.coastAge},
   },
   vertexShader:VERTEX,fragmentShader:STELLAR_FRAGMENT});
  this.points=new THREE.Points(this.geometry,this.material);this.points.frustumCulled=false;
 }
 /** 兼容旧调用(世界坐标交互已由透镜取代) */
 interact(_point:THREE.Vector3|null){}
 update(dt:number,opacity:number){
  this.age+=dt;
  const direction=Math.sign(this.convergeTarget-this.convergeCur);
  this.convergeCur=THREE.MathUtils.clamp(this.convergeCur+direction*dt*this.convergeRate,0,1);
  if(Math.abs(this.convergeTarget-this.convergeCur)<.002)this.convergeCur=this.convergeTarget;
  for(let i=0;i<this.coastAge.length;i++)this.coastAge[i]=Math.min(99,this.coastAge[i]+dt);
  this.pointer.lerp(this.pointerTarget,1-Math.exp(-dt*10));
  this.lensActive+=(this.lensTarget-this.lensActive)*(1-Math.exp(-dt*8));
  const u=this.material.uniforms;
  u.uTime.value=this.age;u.uConverge.value=this.convergeCur;u.uOpacity.value=opacity;
  u.uLensPointer.value=this.pointer;u.uLensActive.value=this.lensActive;
  u.uCoastAge.value=this.coastAge;
 }
 dispose(){this.geometry.dispose();this.material.dispose();}
}
