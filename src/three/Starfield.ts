import * as THREE from "three";

/**
 * 无边界星野:三个尺度共同覆盖镜头的全部运动范围。
 *  - 远景球壳(aLayer=0):以原点为中心的多层球壳分布,任何旋转/平移方向都有星;
 *    保持世界方向关系,不贴屏。
 *  - 中景星群(aLayer=1):世界坐标中的球形星海,提供视差与空间地标。
 *  - 近景星尘(aLayer=2):以相机为中心的整数缠绕体积,飞行时近处掠过;
 *    由 shader 用 uCamPos 取模回绕,跨块后星位置稳定,不重新随机。
 * 分布全部使用固定种子,resize/拖动不会重排。
 */

export const STAR_VERT = /* glsl */ `
precision highp float;

attribute vec3 aSeed;    // 稳定随机 0..1
attribute float aLayer;  // 0=远景球壳 1=中景星群 2=近景星尘
attribute float aScatter; // 登录汇聚散开系数
attribute float aTwinkle;

uniform float uTime;
uniform float uPixelRatio;
uniform float uOpacity;
uniform float uGather;   // 0=散开 1=归位(登录入场,只影响远景/中景)
uniform vec3 uCamPos;
uniform float uNearBox;  // 近景缠绕盒边长
uniform float uGentle;
uniform vec3 uTint;      // 形态染色(球状星云 = 贾维斯蓝)
uniform float uTintMix;  // 0 = 原色, 1 = 全染
uniform float uGain;     // 整体亮度增益
uniform vec4 uSpin;      // 宇宙自旋四元数;让点云图形(球状/环状等)像星系一样旋转
uniform float uSpinEnabled;
uniform vec3 uTrailOrigins[16];
uniform vec3 uTrailDirs[16];
uniform float uTrailWeights[16];

varying vec3 vColor;
varying float vAlpha;
varying float vFade;     // 近景盒边缘软衰减

float easeOut(float t) { return 1.0 - pow(1.0 - t, 3.0); }

void main() {
  vec3 p = position;

  // 点云图形(球状/环状等)跟随宇宙自旋旋转:只对中景/远景层生效,
  // 近景星尘是围着相机回绕的,不旋转(否则会和 uCamPos 回绕打架)。
  float spinnable = (1.0 - step(1.5, aLayer)) * uSpinEnabled;
  if (spinnable > 0.5) {
    vec3 q = uSpin.xyz;
    float w = uSpin.w;
    p = p + 2.0 * cross(q, cross(q, p) + w * p);
  }
  // 旋转后的基准位置:后面入场归位要用它,不能用原始 position,否则旋转会被覆盖掉。
  vec3 base = p;

  float layerNear = step(1.5, aLayer);

  // —— 所有星星的缓慢漂移:seed 决定方向与节奏,永不重排 ——
  float driftPhase = aSeed.x * 6.2831 + aSeed.y * 12.566;
  float driftAmp = mix(5.0, 1.6, step(0.5, 1.0 - aLayer));
  p += vec3(
    sin(uTime * (0.031 + aSeed.z * 0.05) + driftPhase),
    cos(uTime * (0.026 + aSeed.x * 0.04) + driftPhase * 1.7),
    sin(uTime * (0.037 + aSeed.y * 0.045) + driftPhase * 0.6)
  ) * driftAmp * (1.0 - layerNear);

  // —— 登录入场:远景/中景从四散缓慢归位(逐星错峰);近景不参与 ——
  float g = clamp(uGather * 1.6 - aSeed.x * 0.6, 0.0, 1.0);
  g = easeOut(g);
  vec3 scattered = base * (1.6 + aScatter * 1.4) + (aSeed - 0.5) * 120.0;
  p = mix(scattered, base, g * (1.0 - layerNear));

  // 先回绕到实际显示位置，再计算局部扰动，避免近景星受到远处射线影响。
  vec3 rel = p - uCamPos;
  vec3 wrapped = mod(rel + uNearBox * 0.5, uNearBox) - uNearBox * 0.5;
  p = mix(p, uCamPos + wrapped, layerNear);

  // 两个界面共用缓入缓出。以屏幕距离判定，所有深度的星点都有相同触发范围。
  vec4 baseClip=projectionMatrix*modelViewMatrix*vec4(p,1.);
  vec2 screenScale=vec2(projectionMatrix[1][1]/projectionMatrix[0][0],1.);
  vec2 displacement=vec2(0.);
  float pushRadius=mix(.19,.25,uGentle);
  if(baseClip.w>0.){
    for(int i=0;i<16;i++){
      vec4 rayClip=projectionMatrix*viewMatrix*vec4(uTrailOrigins[i]+uTrailDirs[i]*100.,1.);
      if(rayClip.w<=0.)continue;
      vec2 radial=(baseClip.xy/baseClip.w-rayClip.xy/rayClip.w)*screenScale;
      float distanceToRay=length(radial);
      float influence=1.-smoothstep(0.,pushRadius,distanceToRay);
      // 边缘速度比中心更低，并在中心平滑换向，不突然翻转排斥方向。
      displacement+=radial/max(distanceToRay,pushRadius*.28)
        *pow(influence,mix(2.,1.35,uGentle))*uTrailWeights[i]*pushRadius*mix(.42,.65,uGentle);
    }
    displacement/=1.+length(displacement)/(pushRadius*mix(.2,.28,uGentle));
  }

  // 近景边缘软衰减:在回绕边界前淡出,避免粒子墙
  float edge = uNearBox * 0.5;
  float dmax = max(max(abs(wrapped.x), abs(wrapped.y)), abs(wrapped.z));
  vFade = mix(1.0, 1.0 - smoothstep(edge * 0.62, edge * 0.98, dmax), layerNear);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float twinkle = 0.72 + 0.28 * sin(uTime * (0.5 + aTwinkle * 1.4) + aSeed.y * 6.28);
  float size = (1.0 + aSeed.z * 2.05) * (1.0 - aLayer * 0.14);
  gl_PointSize = uPixelRatio * size * clamp(240.0 / max(1.0, -mv.z), 0.35, 3.2);
  gl_Position = projectionMatrix * mv;
  gl_Position.xy+=displacement/screenScale*gl_Position.w;

  // 冷暖微差:大部分冷白,少量暖橙/冰蓝
  vec3 cold = vec3(0.78, 0.85, 1.0);
  vec3 warm = vec3(1.0, 0.78, 0.55);
  vec3 blue = vec3(0.55, 0.72, 1.0);
  float pick = fract(aSeed.x * 7.31);
  vColor = pick < 0.14 ? warm : pick < 0.34 ? blue : cold;
  float distFade = layerNear > 0.5
    ? vFade
    : mix(1.0, clamp(1.6 - length(p) / 2200.0, 0.35, 1.0), step(0.5, 1.0 - aLayer));
  float layerGain = aLayer < 0.5 ? 0.82 : (aLayer < 1.5 ? 0.88 : 0.72);
  vAlpha = uOpacity * twinkle * (0.34 + aSeed.y * 0.5) * distFade * layerGain;
  vColor *= 0.8 + aTwinkle * 0.35;
  vColor = mix(vColor, uTint, uTintMix);
  vAlpha *= uGain;
}
`;

export const STAR_FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float r = length(uv);
  if (r > 0.5) discard;
  float core = 1.0 - smoothstep(0.04, 0.5, r);
  float glow = exp(-r * r * 9.0);
  float a = (core * 0.85 + glow * 0.4) * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * (0.65 + core * 0.5), a);
}
`;

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export class Starfield {
  readonly points: THREE.Points;
  private mat: THREE.ShaderMaterial;
  private geo: THREE.BufferGeometry;
  private gatherCur = 1;
  private gatherTarget = 1;
  private shellCount: number;
  private midCount: number;
  /** 原始星野坐标,用于换回旋臂星系时还原 */
  private basePos: Float32Array;

  constructor(shellCount = 2400, midCount = 3400, nearCount = 6500) {
    const rng = mulberry32(0x51ed270b);
    this.shellCount = shellCount;
    this.midCount = midCount;
    const total = shellCount + midCount + nearCount;
    const pos = new Float32Array(total * 3);
    const seed = new Float32Array(total * 3);
    const layer = new Float32Array(total);
    const scatter = new Float32Array(total);
    const twinkle = new Float32Array(total);

    let i = 0;
    // 远景球壳:2.5 层,半径 950..1750,覆盖任何朝向;半径越大密度越低
    for (let k = 0; k < shellCount; k++, i++) {
      const t = k / shellCount;
      const shell = 950 + Math.floor(t * 2.999) * 270 + rng() * 60;
      const u = rng() * 2 - 1;
      const phi = rng() * Math.PI * 2;
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      pos[i * 3] = Math.cos(phi) * s * shell;
      pos[i * 3 + 1] = u * shell;
      pos[i * 3 + 2] = Math.sin(phi) * s * shell;
      layer[i] = 0;
      seed[i * 3] = rng(); seed[i * 3 + 1] = rng(); seed[i * 3 + 2] = rng();
      scatter[i] = rng();
      twinkle[i] = rng();
    }
    // 中景星群:绕银河的完整球形体积,填补薄盘上下方的空间。
    for (let k = 0; k < midCount; k++, i++) {
      const u = rng() * 2 - 1;
      const ang = rng() * Math.PI * 2;
      const r = 45 + Math.pow(rng(), 0.76) * 610;
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      pos[i * 3] = Math.cos(ang) * s * r;
      pos[i * 3 + 1] = u * r;
      pos[i * 3 + 2] = Math.sin(ang) * s * r;
      layer[i] = 1;
      seed[i * 3] = rng(); seed[i * 3 + 1] = rng(); seed[i * 3 + 2] = rng();
      scatter[i] = rng();
      twinkle[i] = rng();
    }
    // 近景星尘:世界坐标占位(实际位置在 shader 内相对相机回绕)
    const nearBox = 380;
    for (let k = 0; k < nearCount; k++, i++) {
      pos[i * 3] = (rng() - 0.5) * nearBox;
      pos[i * 3 + 1] = (rng() - 0.5) * nearBox;
      pos[i * 3 + 2] = (rng() - 0.5) * nearBox;
      layer[i] = 2;
      seed[i * 3] = rng(); seed[i * 3 + 1] = rng(); seed[i * 3 + 2] = rng();
      scatter[i] = rng();
      twinkle[i] = rng();
    }

    this.basePos = pos.slice();

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 3));
    this.geo.setAttribute("aLayer", new THREE.BufferAttribute(layer, 1));
    this.geo.setAttribute("aScatter", new THREE.BufferAttribute(scatter, 1));
    this.geo.setAttribute("aTwinkle", new THREE.BufferAttribute(twinkle, 1));

    this.mat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        uOpacity: { value: 1 },
        uGather: { value: 1 },
        uCamPos: { value: new THREE.Vector3() },
        uNearBox: { value: nearBox },
        uGentle: { value: 0 },
        uTint: { value: new THREE.Color("#3fa6ff") },
        uTintMix: { value: 0 },
        uGain: { value: 1 },
        uSpin: { value: new THREE.Vector4(0, 0, 0, 1) },
        uSpinEnabled: { value: 1 },
        uTrailOrigins: { value: this.trail.map(sample=>sample.origin) },
        uTrailDirs: { value: this.trail.map(sample=>sample.dir) },
        uTrailWeights: { value: new Float32Array(16) },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = -10;
  }

  setOpacity(o: number) {
    this.mat.uniforms.uOpacity.value = o;
  }

  /** 宇宙自旋四元数:让点云图形随星系一起旋转 */
  setSpin(q: THREE.Quaternion) {
    const u = this.mat.uniforms.uSpin.value as THREE.Vector4;
    u.set(q.x, q.y, q.z, q.w);
  }

  /** 是否让点云图形跟随自旋(旋臂星系用 galaxy 当主体,星野保持稳定) */
  setSpinEnabled(on: boolean) {
    this.mat.uniforms.uSpinEnabled.value = on ? 1 : 0;
  }

  /** 形态染色:传 null 恢复原本的冷暖星色 */
  setLook(tint: THREE.Color | null, gain = 1, mixAmount = 0.9) {
    const u = this.mat.uniforms;
    if (tint) {
      (u.uTint.value as THREE.Color).copy(tint);
      u.uTintMix.value = mixAmount;
    } else {
      u.uTintMix.value = 0;
    }
    u.uGain.value = gain;
  }

  /**
   * 让星野跟着页面「图形」变形。
   *
   * 只重排远景(球壳)与中景(星群)两层——近景那层是围着相机回绕的星尘,
   * 位置由 shader 用 uCamPos 取模算出来,改坐标没有意义。
   * 传 null 恢复成原始星野(旋臂星系用)。
   */
  applyShape(
    layout: ((i: number, total: number) => { x: number; y: number; z: number }) | null
  ) {
    const attr = this.geo.getAttribute("position") as THREE.BufferAttribute;
    const pos = attr.array as Float32Array;
    if (!layout) {
      pos.set(this.basePos);
      attr.needsUpdate = true;
      return;
    }
    const seed = (this.geo.getAttribute("aSeed") as THREE.BufferAttribute).array as Float32Array;
    const mid = this.midCount;

    // 中景:形态本体。抖动取每颗星自己的稳定 seed,切换图形时不会跳闪。
    for (let i = 0; i < mid; i++) {
      const p = layout(i, mid);
      const o = (this.shellCount + i) * 3;
      pos[o] = p.x + (seed[o] - 0.5) * 7;
      pos[o + 1] = p.y + (seed[o + 1] - 0.5) * 7;
      pos[o + 2] = p.z + (seed[o + 2] - 0.5) * 7;
    }
    // 远景:同一形态放大三倍,作为轮廓的纵深回声
    for (let i = 0; i < this.shellCount; i++) {
      const p = layout(i, this.shellCount);
      const o = i * 3;
      const far = 3.1;
      pos[o] = p.x * far + (seed[o] - 0.5) * 90;
      pos[o + 1] = p.y * far + (seed[o + 1] - 0.5) * 90;
      pos[o + 2] = p.z * far + (seed[o + 2] - 0.5) * 90;
    }
    attr.needsUpdate = true;
  }

  /** 登录入场:立即散开,然后星点缓慢归位 */
  startGather() {
    this.gatherCur = 0;
    this.gatherTarget = 1;
    this.mat.uniforms.uGather.value = 0;
  }

  private pointerEnabled = true;
  private trail = Array.from({length:16},()=>({origin:new THREE.Vector3(),dir:new THREE.Vector3(0,0,-1),age:3,strength:0}));
  private trailIndex=0;
  private sampleAge=1;
  private pendingStrength=0;
  private pendingOrigin=new THREE.Vector3();
  private pendingDir=new THREE.Vector3(0,0,-1);
  setGentleInteraction(gentle: boolean) {
    this.mat.uniforms.uGentle.value=gentle?1:0;
  }
  setPointerEnabled(enabled: boolean) {
    this.pointerEnabled=enabled;
    if(!enabled){this.pendingStrength=0;this.trail.forEach(sample=>{sample.age=3;sample.strength=0;});}
  }

  /** 指针射线(世界坐标)与瞬时强度:星星被光标推开 */
  setPointerRay(origin: THREE.Vector3, dir: THREE.Vector3, strength: number) {
    if(!this.pointerEnabled)return;
      this.pendingOrigin.copy(origin);
      this.pendingDir.copy(dir).normalize();
      this.pendingStrength=Math.min(.7,this.pendingStrength+strength);
  }

  update(dt: number, time: number, camera?: THREE.Camera) {
    this.sampleAge+=dt;
    if(this.pointerEnabled&&this.pendingStrength>0&&this.sampleAge>=.16){
      const sample=this.trail[this.trailIndex];
      sample.origin.copy(this.pendingOrigin);sample.dir.copy(this.pendingDir);
      sample.age=0;
      // 慢速扫过也有可辨认的响应；缓入曲线仍控制速度，不直接跳位移。
      const ready=this.mat.uniforms.uGentle.value>.5;
      sample.strength=ready?Math.min(.9,.22+this.pendingStrength*1.6):this.pendingStrength;
      this.trailIndex=(this.trailIndex+1)%this.trail.length;
      this.pendingStrength=0;this.sampleAge=0;
    }
    const weights=this.mat.uniforms.uTrailWeights.value as Float32Array;
    this.trail.forEach((sample,index)=>{
      sample.age+=dt;
      weights[index]=this.pointerEnabled?sample.strength
        *THREE.MathUtils.smoothstep(sample.age,0,.28)
        *(1-THREE.MathUtils.smoothstep(sample.age,.35,2.4)):0;
    });
    if (this.gatherCur !== this.gatherTarget) {
      this.gatherCur += (this.gatherTarget - this.gatherCur) * Math.min(1, dt * 1.9);
      if (Math.abs(this.gatherTarget - this.gatherCur) < 0.002) this.gatherCur = this.gatherTarget;
      this.mat.uniforms.uGather.value = this.gatherCur;
    }
    this.mat.uniforms.uTime.value = time;
    if (camera) (this.mat.uniforms.uCamPos.value as THREE.Vector3).copy(camera.position);
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}
