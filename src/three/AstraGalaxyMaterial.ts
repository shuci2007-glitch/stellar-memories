import * as THREE from 'three';

/** Astra 主星系专用材质。刻意不与锁屏、照片或 Solar 星点共用。 */
const FILTERED_CORE=/* glsl */`
varying float vParticleDiameter;
float astraCubicCoverage(float coordinate){
 float x=abs(coordinate);if(x<1.)return(4.-6.*x*x+3.*x*x*x)/6.;
 float tail=max(2.-x,0.);return tail*tail*tail/6.;
}
float astraFilteredCore(vec2 pixel,float area){return astraCubicCoverage(pixel.x)*astraCubicCoverage(pixel.y)*area*vParticleDiameter*vParticleDiameter;}
`;

export const ASTRA_COAST_GLSL=/* glsl */`
vec4 astraCoast(vec4 state,float mass,float age){
 float drag=2.3/sqrt(mass);float velocityDecay=exp(-drag*age);float returnDecay=exp(-age);
 state.xy=state.xy*returnDecay+state.zw*(returnDecay-velocityDecay)/(drag-1.);
 state.zw*=velocityDecay;return state;
}`;

const MOTION=/* glsl */`
attribute vec3 particleMotionUv;uniform sampler2D uParticleMotionTexture;uniform float uParticleMotionEnabled;
uniform float uParticleMotionAge;uniform vec2 uParticleMotionPointer;uniform vec2 uParticleMotionPrevious;
uniform vec2 uParticleMotionImpulse;uniform float uPointerRepelRadius;uniform float uViewportAspect;
varying vec4 vParticleMotionState;
${ASTRA_COAST_GLSL}
void astraParticleMotion(inout vec4 clipPosition,float interaction){
 float readyBackground=1.-step(.9,interaction);
 // 背景已经通过惯性减速，不再把冲量与显示位移各压低一次。
 float motionGain=mix(interaction,1.,readyBackground);
 float calm=max(1.-smoothstep(.9,1.,uIntroProgress),1.-step(.9,interaction));
 float settleRate=mix(1.,.32,calm);
 if(uParticleMotionEnabled<.5)return;
 // 背景统一较缓的惯性，避免暗小星点因质量过低被同一阵风突然甩开。
 float mass=mix(particleMotionUv.z,mix(1.65,2.4,smoothstep(.65,2.4,particleMotionUv.z)),calm);
 // 过期只清空旧状态，不能跳过首次冲量和模拟纹理写入。
 vec4 state=vec4(0.);
 if(uParticleMotionAge*settleRate<6.)state=astraCoast(texture2D(uParticleMotionTexture,particleMotionUv.xy),mass,uParticleMotionAge*settleRate);
 #ifdef ASTRA_PARTICLE_SIMULATION
  float aspect=max(uViewportAspect,.0001);vec2 scale=vec2(aspect,1.);
  vec2 current=(clipPosition.xy/clipPosition.w+state.xy*motionGain)*scale;vec2 start=uParticleMotionPrevious*scale;
  vec2 segment=(uParticleMotionPointer-uParticleMotionPrevious)*scale;
  float t=clamp(dot(current-start,segment)/max(dot(segment,segment),.000001),0.,1.);
  float radius=max(uPointerRepelRadius*mix(.68,1.3,readyBackground),.025);
  float weight=pow(1.-smoothstep(0.,radius,length(current-start-segment*t)),mix(2.,1.35,readyBackground))*motionGain;
  vec2 impulse=uParticleMotionImpulse*scale;impulse*=min(1.,.18/max(length(impulse),.00001));
  state.zw+=impulse/scale*weight*7.2/mass;float speed=length(state.zw*scale);
  state.zw*=min(1.,mix(.5,.25,readyBackground)/max(speed,.00001));vParticleMotionState=state;
  gl_PointSize=1.;clipPosition=vec4(particleMotionUv.xy*2.-1.,0.,1.);
 #else
  clipPosition.xy+=state.xy*clipPosition.w*motionGain;
 #endif
}`;

const INTRO=/* glsl */`
vec3 astraIntroMotion(vec3 position,vec3 scattered,float progress,float seed,float travelSeed,float time){
 if(progress>=1.)return position;float start=.14+seed*.18;float duration=.58+travelSeed*.1;
 float local=clamp((progress-start)/duration,0.,1.);
 float smoothPull=local*local*local*(local*(local*6.-15.)+10.);
 float pull=mix(smoothPull,sin(smoothPull*3.14159265359*.5),.5);
 float angle=sin(pull*3.14159265359)*(.44+seed*.22);float c=cos(angle),s=sin(angle);
 vec3 orbiting=vec3(scattered.x*c-scattered.y*s,scattered.x*s+scattered.y*c,scattered.z);
 // 未解锁的散星缓慢漂移;汇聚开始后随 pull 平滑收敛
 orbiting+=vec3(sin(time*.11+seed*43.7),cos(time*.09+travelSeed*39.1),sin(time*.07+seed*17.3))*.24*(1.-pull);
 return mix(orbiting,position,pull);
}
float astraParticleRevealProgress(float progress,float seed){float delay=seed*.015;return smoothstep(delay,.14+delay,progress)*mix(.2,1.,smoothstep(.2,1.,progress));}
`;

export const ASTRA_MAIN_VERTEX=/* glsl */`
precision highp float;
attribute float orbitProgress;attribute float starAcrossOffset;attribute float starBrightness;attribute vec3 starColor;
attribute float starDepthOffset;attribute float starHero;attribute float starBackground;attribute float starOpacity;
attribute float starScale;attribute float twinklePhase;attribute float twinkleRate;
uniform float uIntensity;uniform float uIntroProgress;uniform float uBackgroundStarsEnabled;uniform float uDensityFalloff;
uniform mat4 uStableBackgroundModelView;
uniform float uPathMotion;uniform float uPathOffset;uniform float uPathSampleCount;uniform float uPixelRatio;
uniform float uSizeFalloff;uniform float uTime;uniform float uTwinkleSpeed;uniform vec2 uScatterSize;
uniform sampler2D uPathTexture;
varying float vBrightness;varying vec3 vColor;varying float vOpacity;varying float vRayStrength;varying float vParticleDiameter;
${MOTION}${INTRO}
vec3 samplePath(float progress){
 float scaled=clamp(progress,0.,1.)*(uPathSampleCount-1.);float lo=floor(scaled),hi=min(lo+1.,uPathSampleCount-1.);float f=fract(scaled);
 vec3 a=texture2D(uPathTexture,vec2((lo+.5)/uPathSampleCount,.5)).xyz;
 vec3 b=texture2D(uPathTexture,vec2((hi+.5)/uPathSampleCount,.5)).xyz;return mix(a,b,f);
}
void main(){
 float pathPhase=fract(orbitProgress+uPathOffset);
 float progress=pathPhase+uDensityFalloff*sin(pathPhase*6.28318530718)/6.28318530718;
 float middleWeight=sin(clamp(progress,0.,1.)*3.14159265359);
 float sizeEnvelope=mix(1.,.14+.86*pow(max(middleWeight,0.),.68),uSizeFalloff);
 float endpointVisibility=smoothstep(0.,.055,progress)*(1.-smoothstep(.945,1.,progress));
 vec3 animatedPosition=position;
 if(uPathMotion>.5){
  float stepSize=1./max(uPathSampleCount-1.,1.);vec3 pathPosition=samplePath(progress);
  vec3 before=samplePath(max(progress-stepSize,0.)),after=samplePath(min(progress+stepSize,1.));
  vec3 tangent=normalize(after-before);vec3 across=normalize(vec3(-tangent.y,tangent.x,0.));
  animatedPosition=pathPosition+across*starAcrossOffset+vec3(0.,0.,starDepthOffset);
 }else{sizeEnvelope=1.;endpointVisibility=1.;}
 float scatterX=fract(sin(dot(vec2(orbitProgress,twinklePhase),vec2(127.1,311.7)))*43758.5453);
 float scatterY=fract(sin(dot(vec2(twinklePhase,starScale),vec2(269.5,183.3)))*43758.5453);
 float scatterZ=fract(sin(dot(vec2(orbitProgress,starBrightness),vec2(419.2,371.9)))*43758.5453);
 // 锁屏散星必须是有纵深的体积；极薄 z 会在偏转时暴露成一张星点平面。
 vec3 introScattered=vec3((scatterX-.5)*uScatterSize.x,(fract(scatterY)-.5)*uScatterSize.y,(scatterZ-.5)*uScatterSize.y*.72);
 float backgroundStar=starBackground*uBackgroundStarsEnabled;
 animatedPosition=mix(animatedPosition,introScattered,backgroundStar);
 animatedPosition=astraIntroMotion(animatedPosition,introScattered,mix(uIntroProgress,1.,backgroundStar),scatterZ,scatterY,uTime);
 float twinkle=.86+.14*sin(twinklePhase+uTime*uTwinkleSpeed*twinkleRate);
 vBrightness=uIntensity*starBrightness*twinkle;vColor=starColor;
 vOpacity=starOpacity*endpointVisibility*(.92+twinkle*.08);
 float introLocal=astraParticleRevealProgress(uIntroProgress,scatterZ);
 // 散开态(未解锁)保持可见:底亮度/底尺寸,汇聚时收拢并提亮
 vOpacity*=mix(.55,1.,smoothstep(0.,.2,introLocal));vOpacity*=mix(1.,uBackgroundStarsEnabled,starBackground);
 float introScale=mix(.8,1.,introLocal);
 gl_PointSize=uPixelRatio*(.35+starScale*sizeEnvelope*endpointVisibility*3.8)*(.97+twinkle*.03)*introScale;
 float stableBackground=backgroundStar*smoothstep(.9,1.,uIntroProgress);
 vec4 viewPosition=mix(modelViewMatrix*vec4(animatedPosition,1.),uStableBackgroundModelView*vec4(animatedPosition,1.),stableBackground);vec4 clipPosition=projectionMatrix*viewPosition;
 vRayStrength=smoothstep(1.45,2.8,starBrightness);vParticleDiameter=gl_PointSize;gl_PointSize=max(gl_PointSize,4.);
 astraParticleMotion(clipPosition,1.-stableBackground*.58);gl_Position=clipPosition;
}`;

export const ASTRA_MAIN_FRAGMENT=/* glsl */`
precision highp float;varying float vBrightness;varying vec3 vColor;varying float vOpacity;varying float vRayStrength;
${FILTERED_CORE}
void main(){
 vec2 pixel=(gl_PointCoord-vec2(.5))*max(vParticleDiameter,4.);vec2 point=pixel*2./max(vParticleDiameter,.0001);
 float distanceToCenter=length(point);float disc=1.-smoothstep(.08,1.,distanceToCenter);float core=pow(disc,2.2);
 float horizontalRay=exp(-abs(point.y)*28.)*(1.-smoothstep(.18,1.,abs(point.x)));
 float verticalRay=exp(-abs(point.x)*28.)*(1.-smoothstep(.18,1.,abs(point.y)));
 float rays=max(horizontalRay,verticalRay)*.28*vRayStrength;float resolved=smoothstep(2.,4.,vParticleDiameter);
 float alpha=mix(astraFilteredCore(pixel,.150904),max(core,rays),resolved)*vOpacity;if(alpha<=0.)discard;
 float whiteCore=mix(.59228,core,resolved)*smoothstep(.9,2.8,vBrightness)*.82;
 float colorEnergy=1.-min(vColor.r,min(vColor.g,vColor.b));
 vec3 emission=mix(vColor,vec3(1.),whiteCore)*vBrightness*(1.+colorEnergy*.42);
 gl_FragColor=vec4(emission,alpha);
}`;

export const ASTRA_SIM_FRAGMENT=/* glsl */`precision highp float;varying vec4 vParticleMotionState;void main(){gl_FragColor=vParticleMotionState;}`;

export const ASTRA_BLEND:Pick<THREE.ShaderMaterialParameters,'blending'|'blendEquation'|'blendSrc'|'blendDst'|'blendEquationAlpha'|'blendSrcAlpha'|'blendDstAlpha'>={
 blending:THREE.CustomBlending,blendEquation:THREE.AddEquation,blendSrc:THREE.SrcAlphaFactor,blendDst:THREE.OneFactor,
 blendEquationAlpha:THREE.AddEquation,blendSrcAlpha:THREE.OneFactor,blendDstAlpha:THREE.OneMinusSrcAlphaFactor,
};

export function makeAstraGalaxyMaterial(pathTexture:THREE.Texture|null,pixelRatio:number,pathMotion=true){
 const empty=pathTexture??new THREE.DataTexture(new Float32Array([0,0,0,1]),1,1,THREE.RGBAFormat,THREE.FloatType);
 if(!pathTexture)empty.needsUpdate=true;
 const material=new THREE.ShaderMaterial({vertexShader:ASTRA_MAIN_VERTEX,fragmentShader:ASTRA_MAIN_FRAGMENT,transparent:true,depthTest:false,depthWrite:false,toneMapped:false,...ASTRA_BLEND,
  uniforms:{uIntensity:{value:1.35},uIntroProgress:{value:0},uBackgroundStarsEnabled:{value:1},uDensityFalloff:{value:.22},uPathMotion:{value:Number(pathMotion)},uPathOffset:{value:0},uPathSampleCount:{value:pathMotion?512:1},uPixelRatio:{value:pixelRatio},uSizeFalloff:{value:.45},uTime:{value:0},uTwinkleSpeed:{value:.62},uScatterSize:{value:new THREE.Vector2(12,12)},uPathTexture:{value:empty},uParticleMotionTexture:{value:null},uParticleMotionEnabled:{value:0},uParticleMotionAge:{value:99},uParticleMotionPointer:{value:new THREE.Vector2()},uParticleMotionPrevious:{value:new THREE.Vector2()},uParticleMotionImpulse:{value:new THREE.Vector2()},uPointerRepelRadius:{value:.36},uViewportAspect:{value:1}}});
 material.userData.baseIntensity=1.35;return material;
}

/** 官方 path-star 系统：只负责轨道尘与被 flare 照亮的尾迹，不参与主星调色。 */
export const ASTRA_PATH_VERTEX=/* glsl */`
precision highp float;attribute float driftPhase;attribute vec3 driftTangent;attribute float orbitProgress;
attribute float particleOpacity;attribute float particleScale;uniform float uDirection;uniform float uDriftDistance;
uniform float uDriftSpeed;uniform float uHeadProgress;uniform float uIntensity;uniform float uIntroProgress;
uniform float uLightReach;uniform float uPixelRatio;uniform float uStarBrightness;uniform float uTime;
uniform float uTrailLength;uniform vec2 uScatterSize;varying float vBrightness;varying float vOpacity;varying float vParticleDiameter;
${INTRO}
void main(){
 float distanceToStar=abs(orbitProgress-uHeadProgress);float illumination=1.-smoothstep(uLightReach*.08,uLightReach,distanceToStar);
 illumination*=illumination;float behind=uDirection>0.?uHeadProgress-orbitProgress:orbitProgress-uHeadProgress;if(behind<0.)behind+=1.;
 float trail=1.-smoothstep(0.,max(uTrailLength,.0001),behind);illumination=max(illumination,trail*trail*.68);
 vBrightness=uIntensity*(.16+illumination*uStarBrightness*3.6);vOpacity=particleOpacity*(.22+illumination*.78);
 float driftActive=step(.0001,uDriftSpeed),cycle=fract(driftPhase+uTime*uDriftSpeed);
 vOpacity*=mix(1.,smoothstep(0.,.1,cycle)*(1.-smoothstep(.9,1.,cycle)),driftActive);
 vec3 animatedPosition=position+driftTangent*(cycle-.5)*uDriftDistance*uDirection*driftActive;
 float scatterX=fract(sin(dot(vec2(orbitProgress,driftPhase),vec2(127.1,311.7)))*43758.5453);
 float scatterY=fract(sin(dot(vec2(driftPhase,particleScale),vec2(269.5,183.3)))*43758.5453);
 float scatterZ=fract(sin(dot(vec2(orbitProgress,particleOpacity),vec2(419.2,371.9)))*43758.5453);
 vec3 scattered=vec3((scatterX-.5)*uScatterSize.x,(scatterY-.5)*uScatterSize.y,(scatterZ-.5)*uScatterSize.y*.72);
 animatedPosition=astraIntroMotion(animatedPosition,scattered,uIntroProgress,scatterZ,scatterY,uTime);
 float introLocal=astraParticleRevealProgress(uIntroProgress,scatterZ);vOpacity*=mix(.4,1.,smoothstep(0.,.2,introLocal));
 gl_PointSize=uPixelRatio*(1.+particleScale*1.35+illumination*1.25)*sqrt(introLocal);
 vec4 viewPosition=modelViewMatrix*vec4(animatedPosition,1.);vParticleDiameter=gl_PointSize;gl_PointSize=max(gl_PointSize,4.);gl_Position=projectionMatrix*viewPosition;
}`;

export const ASTRA_PATH_FRAGMENT=/* glsl */`
precision highp float;varying float vBrightness;varying float vOpacity;${FILTERED_CORE}
void main(){vec2 pixel=(gl_PointCoord-vec2(.5))*max(vParticleDiameter,4.);float distanceToCenter=length(pixel)*2./max(vParticleDiameter,.0001);
 float disc=1.-smoothstep(.22,1.,distanceToCenter);float core=mix(astraFilteredCore(pixel,.256408),pow(disc,1.5),smoothstep(2.,4.,vParticleDiameter));
 float alpha=core*vOpacity;if(alpha<=0.)discard;gl_FragColor=vec4(vec3(vBrightness),alpha);}`;

export function makeAstraPathStarMaterial(pixelRatio:number,strong:boolean,direction:number){
 const material=new THREE.ShaderMaterial({vertexShader:ASTRA_PATH_VERTEX,fragmentShader:ASTRA_PATH_FRAGMENT,transparent:true,depthTest:false,depthWrite:false,toneMapped:false,...ASTRA_BLEND,
  uniforms:{uDirection:{value:direction},uDriftDistance:{value:.16},uDriftSpeed:{value:.28},uHeadProgress:{value:0},uIntensity:{value:.66},uIntroProgress:{value:0},uLightReach:{value:.12*(strong?1.15:1)},uPixelRatio:{value:pixelRatio},uStarBrightness:{value:strong?1:.62},uTime:{value:0},uTrailLength:{value:.18},uScatterSize:{value:new THREE.Vector2(12,12)}}});
 material.userData.baseIntensity=.66;return material;
}
