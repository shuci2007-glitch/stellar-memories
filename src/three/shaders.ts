import { STELLAR_FILTER_GLSL } from './starMaterial';

/* Photo coordinates stay tied to the original pixels; motion is local and reversible. */
export const PARTICLE_VERT = /* glsl */ `
precision highp float;
attribute vec2 aTarget;attribute vec3 aColor;attribute vec2 aData;attribute vec4 aRand;
attribute float aDepth;attribute float aAlpha;
uniform float uMorph;uniform float uTime;uniform float uAspect;uniform float uSizeScale;uniform float uReferenceDistance;uniform float uDrift;uniform float uCollapse;
uniform vec2 uMouseVel;
uniform vec4 uTrail[10]; // x, y, energy, path angle
varying vec3 vColor;varying float vAlpha;varying float vSoft;varying float vDiam;varying float vRay;
// Divergence-free idle breeze from a stream function: neighbours share one flow.
vec2 wind(vec2 p,float t){
 vec2 v=vec2(0.);
 vec2 c=vec2(3.1*p.x+1.7*p.y-.33*t); v+=vec2(1.7,-3.1)*cos(c)*.0022;
 c=vec2(1.3*p.x-2.9*p.y-.21*t+2.1);  v+=vec2(-2.9,-1.3)*cos(c)*.0016;
 c=vec2(-2.2*p.x+.9*p.y+.17*t+4.4);  v+=vec2(.9,2.2)*cos(c)*.0011;
 return v;
}
void main(){
 float release=clamp((uMorph-aRand.w*.22)/.78,0.,1.);
 float m=release*release*(3.-2.*release);
 vec2 xy=vec2((aTarget.x-.5)*uAspect,.5-aTarget.y);
 vec3 pos=vec3(xy*(1.-aDepth/uReferenceDistance),aDepth);
 // 静置:围绕照片中心的微漩涡(振荡不累积,主体稳、边缘自由) + 细碎闪烁
 float r=length(xy);
 vec2 tang=vec2(-xy.y,xy.x)/max(r,.05);
 float swirl=sin(uTime*.15+aRand.x*6.283)*(.0045+.011*aRand.y)*smoothstep(.06,.5,r);
 pos.xy+=tang*swirl*uDrift*(.45+.55*(1.-aData.y));
 pos.xy+=wind(xy,uTime+aRand.z*.9)*(.75+.5*aRand.y)*(1.-aData.y*.5)*uDrift;
 pos.z+=sin(uTime*.36+aRand.x*6.28)*.006*(1.-aData.y*.5)*uDrift;
 // 尾迹风流:粒子沿鼠标路径被带走,并抬向镜头(变大变虚 = 景深光斑),没有圆形笔刷
 vec3 flow=vec3(0.);float wsum=0.;
 for(int i=0;i<10;i++){
  float e=uTrail[i].z;if(e<.002)continue;
  vec2 d=xy-uTrail[i].xy;
  float f=exp(-dot(d,d)/.02)*e;
  vec2 dir=vec2(cos(uTrail[i].w),sin(uTrail[i].w));
  flow.xy+=(dir*.030+vec2(-dir.y,dir.x)*.014+d*.14)*f;
  flow.z+=(.045+.03*aRand.z)*f;
  wsum+=f;
 }
 pos+=flow/max(1.,wsum*.85);
 // 告别:共享阵风带走种子,非径向爆炸
 vec3 gust=vec3(.20+aRand.x*.13,.08+aRand.y*.11,(aRand.z-.4)*.12);
 pos+=m*gust*uDrift;
 pos+=m*vec3(wind(xy*.7,uTime*.8+aRand.x*3.1)*6.,0.)*uDrift;
 pos.z+=m*m*.09;
 // 收回:整云缩回星辰点
 float cc=uCollapse*uCollapse*(3.-2.*uCollapse);
 pos=mix(pos,vec3(0.),cc);
 vec4 mv=modelViewMatrix*vec4(pos,1.);gl_Position=projectionMatrix*mv;
 // 景深 bokeh:越靠近镜头越大越虚
 float defocus=max(pos.z,0.)*16.;
 vSoft=clamp(1.-defocus*.45,.3,1.);
 float size=aData.x*(.86+aRand.y*.22)*(1.-.32*m)*(1.+defocus*.85);
 gl_PointSize=clamp(size*uSizeScale*(uReferenceDistance/max(.1,-mv.z/length(modelMatrix[0].xyz))),.85,9.0);
 vDiam=gl_PointSize;vRay=smoothstep(.78,1.,aData.y)*.10;
 vColor=aColor;
 float twinkle=.86+.14*sin(uTime*(1.2+aRand.y*2.4)+aRand.x*40.);
 vAlpha=aAlpha*(1.-smoothstep(.28,1.,release))*(1.-cc)*(mix(.5,1.,vSoft)*twinkle);
}
`;
export const PARTICLE_FRAG = /* glsl */ `
precision highp float;varying vec3 vColor;varying float vAlpha;varying float vSoft;varying float vDiam;varying float vRay;
${STELLAR_FILTER_GLSL}
void main(){
 vec2 pixel=(gl_PointCoord-.5)*max(vDiam,4.);vec2 point=pixel*2./max(vDiam,.0001);
 float core=stellarDisc(point),rays=stellarRays(point,vRay);
 float resolved=smoothstep(2.,4.,vDiam);
 float coverage=mix(stellarFilteredCore(pixel,.150904,vDiam),max(core,rays),resolved)*mix(.65,1.,vSoft);
 if(coverage<=0.)discard;
 // 保留原图颜色；只有极少高重要性粒子获得克制白芯/星芒。
 vec3 emission=mix(vColor,vec3(1.),core*vRay*.16);
 gl_FragColor=vec4(emission,vAlpha*coverage);
}
`;

// ---------------- 星野(背景星辰) ----------------
// position: 世界位置(大盒子内), aSeed: 随机, aLayer: 0远 1中 2近
export const STAR_VERT = /* glsl */ `
precision highp float;

attribute vec3 aSeed;
attribute float aLayer;
attribute float aScatter; // 登录汇聚:散开系数

uniform float uTime;
uniform vec2 uParallax;
uniform float uPixelRatio;
uniform float uOpacity;
uniform float uGather; // 0=散开 1=归位

varying vec3 vColor;varying float vAlpha;varying float vBrightness;varying float vRay;varying float vDiam;

float easeOut(float t) {
  return 1.0 - pow(1.0 - t, 3.0);
}

void main() {
  // 登录入场:星点从四散缓慢归位(逐星错峰)
  float g = clamp(uGather * 1.6 - aSeed.x * 0.6, 0.0, 1.0);
  g = easeOut(g);
  vec3 scattered = position * (1.6 + aScatter * 1.4);
  scattered.y += (aSeed.y - 0.5) * 90.0;
  vec3 p = mix(scattered, position, g);

  // 层深视差:远层动得少
  float depth = 0.35 + aLayer * 0.55;
  p.xy += uParallax * depth * 18.0;
  // 极缓慢漂移
  p.x += sin(uTime * 0.05 + aSeed.x * 12.0) * 2.0 * depth;
  p.y += cos(uTime * 0.04 + aSeed.y * 12.0) * 1.6 * depth;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float size = (0.7 + aSeed.z * 1.2) * (0.6 + aLayer * 0.5);
  // 距离衰减 + 上限钳制:纯黑负空间里只允许极克制的远尘
  float ps = size * uPixelRatio * (140.0 / max(-mv.z, 1.0)) * (1.0 + (1.0 - g) * 0.6);
  gl_PointSize = clamp(ps, 0.5, 1.9);

  // 呼吸:低频亮度起伏(比高频闪烁更"活着")
  float breathe = 0.78 + 0.22 * sin(uTime * (0.28 + aSeed.x * 0.7) + aSeed.y * 20.0);
  vAlpha = breathe * uOpacity * (0.14 + aLayer * 0.14) * (0.4 + 0.6 * g);
  float big = step(0.82, aSeed.z);
  // 星野不是单色噪点：大部分是冷白与冰蓝，极少量暖橙负责空间层次。
  if (aSeed.z < 0.10) {
    vColor = vec3(1.0, 0.57 + aSeed.y * 0.18, 0.30 + aSeed.x * 0.16);
  } else if (aSeed.z < 0.46) {
    vColor = vec3(0.38 + aSeed.x * 0.14, 0.70 + aSeed.y * 0.18, 1.0);
  } else {
    vColor = vec3(0.82 + aSeed.x * 0.16, 0.88 + aSeed.y * 0.10, 0.98);
  }
  vBrightness = .68 + big*.5;
  vRay = big*.32;
  vDiam = ps;
}

`;

export const STAR_FRAG = '';

// ---------------- 星团节点(照片=一颗星) ----------------
// aColor: 相册平均色
export const NODE_VERT = /* glsl */ `
precision highp float;

attribute vec3 aColor;
attribute vec2 aData; // size, seed
attribute float aReveal; // 照片球加载后，普通节点平滑让位
uniform float uTime;
uniform float uPixelRatio;
uniform float uSizeScale;
uniform float uOpacity;

varying vec3 vColor;
varying float vAlpha;

void main() {
  vec4 mv0 = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv0;
  // 每颗记忆星缓慢浮动(空间生命感)
  vec3 p = position;
  p.y += sin(uTime * (0.35 + aData.y * 0.5) + aData.y * 40.0) * 0.4;
  p.x += cos(uTime * (0.25 + aData.y * 0.4) + aData.y * 30.0) * 0.22;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.75 + 0.25 * sin(uTime * (0.6 + aData.y * 1.4) + aData.y * 30.0);
  float ps = aData.x * uSizeScale * uPixelRatio * (90.0 / max(-mv.z, 0.5));
  gl_PointSize = clamp(ps, 1.4, 34.0);
  vColor = aColor;
  vAlpha = tw * uOpacity * aReveal;
}
`;

export const NODE_FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float core = smoothstep(0.28, 0.0, d);
  float glow = smoothstep(0.5, 0.08, d);
  float a = (core + glow * 0.55) * vAlpha;
  if (a < 0.01) discard;
  // 中心偏白、边缘照片色,像一颗发光的记忆星
  gl_FragColor = vec4(vColor * glow * 1.35 + vec3(1.0) * core * 0.85, a);
}
`;

// ---------------- 星尘环(相册簇周围的公转微尘) ----------------
// position: 未用(填 0);aCenter: 簇心;aData: (半径, 速度);aSeed: (相位, 大小, 颜色亮, _)
export const DUST_VERT = /* glsl */ `
precision highp float;

attribute vec3 aCenter;
attribute vec2 aData; // radius, speed
attribute vec4 aSeed; // phase, size, bright, _

uniform float uTime;
uniform float uPixelRatio;
uniform float uOpacity;

varying float vAlpha;
varying float vBright;

void main() {
  float ang = aSeed.x + uTime * aData.y;
  float r = aData.x;
  vec3 p = aCenter + vec3(cos(ang) * r, sin(ang * 0.8 + aSeed.x) * r * 0.18, sin(ang) * r);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float ps = aSeed.y * uPixelRatio * (90.0 / max(-mv.z, 0.5));
  gl_PointSize = clamp(ps, 0.5, 2.2);
  float tw = 0.6 + 0.4 * sin(uTime * (0.4 + aSeed.z) + aSeed.x * 30.0);
  vAlpha = tw * uOpacity;
  vBright = aSeed.z;
}
`;

export const DUST_FRAG = /* glsl */ `
precision highp float;
varying float vAlpha;
varying float vBright;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float soft = smoothstep(0.5, 0.1, d);
  vec3 col = mix(vec3(0.62, 0.70, 0.86), vec3(0.86, 0.80, 0.92), vBright);
  gl_FragColor = vec4(col, soft * vAlpha * 0.55);
}
`;

// ---------------- 连线 ----------------
export const LINE_VERT = /* glsl */ `
precision highp float;
attribute float aAlpha;
attribute float aSeed;
uniform float uTime;
uniform float uGlobal;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.85 + 0.15 * sin(uTime * 0.8 + aSeed * 12.0);
  vAlpha = aAlpha * tw * uGlobal;
}
`;

export const LINE_FRAG = /* glsl */ `
precision highp float;
varying float vAlpha;
void main() {
  if (vAlpha < 0.005) discard;
  gl_FragColor = vec4(vec3(0.62, 0.70, 0.86), vAlpha);
}
`;
