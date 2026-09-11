import * as THREE from "three";
import { PARTICLE_FRAG, PARTICLE_VERT } from "./shaders";
import { tmParticles } from "../core/types";
import { STELLAR_BLEND } from './starMaterial';

export interface ParticleCloudData {
  depth?: Float32Array;
  alpha?: Float32Array;
  edgeStrength?: Float32Array;
  luminance?: Float32Array;
  count: number;
  width: number;
  height: number;
  target: Float32Array; // 2 * n
  color: Float32Array; // 3 * n
  data: Float32Array; // 2 * n (size, importance)
  rand: Float32Array; // 4 * n
}

/** 解析 .spc 粒子缓存(Rust 重要性采样输出) */
export function parseSpc(buf: ArrayBuffer): ParticleCloudData {
  if(buf.byteLength<20) throw new Error("truncated particle cache");
  const view = new DataView(buf);
  const magic = view.getUint32(0, true);
  if (magic !== 0x434d5342) throw new Error("invalid particle cache");
  const count = view.getUint32(8, true);
  const w = view.getUint32(12, true);
  const h = view.getUint32(16, true);
  if(view.getUint32(4,true)!==1 || !w || !h || count>1000000 || count>(buf.byteLength-20)/8) throw new Error("invalid particle cache header");
  const rec = new DataView(buf, 20);

  const target = new Float32Array(count * 2);
  const color = new Float32Array(count * 3);
  const data = new Float32Array(count * 2);
  const rand = new Float32Array(count * 4);

  for (let i = 0; i < count; i++) {
    const o = i * 8;
    const x = rec.getUint16(o, true) / 65535;
    const y = rec.getUint16(o + 2, true) / 65535;
    target[i * 2] = x;
    target[i * 2 + 1] = y;
    color[i * 3] = rec.getUint8(o + 4) / 255;
    color[i * 3 + 1] = rec.getUint8(o + 5) / 255;
    color[i * 3 + 2] = rec.getUint8(o + 6) / 255;
    const sizeBits = rec.getUint8(o + 7) >> 4;
    const impBits = rec.getUint8(o + 7) & 0x0f;
    data[i * 2] = sizeBits / 15;
    data[i * 2 + 1] = impBits / 15;
    rand[i * 4] = Math.random();
    rand[i * 4 + 1] = Math.random();
    rand[i * 4 + 2] = Math.random();
    rand[i * 4 + 3] = Math.random();
  }
  return { count, width: w, height: h, target, color, data, rand };
}

/** 拉取照片粒子缓存(带内存缓存) */
const cloudCache = new Map<number, ParticleCloudData>();
export async function loadCloud(photoId: number): Promise<ParticleCloudData> {
  const hit = cloudCache.get(photoId);
  if (hit) return hit;
  const res = await fetch(tmParticles(photoId));
  if (!res.ok) throw new Error(`粒子缓存不存在 (${res.status})`);
  const data = parseSpc(await res.arrayBuffer());
  cloudCache.set(photoId, data);
  // 内存保护:最多缓存 12 张
  if (cloudCache.size > 12) {
    const first = cloudCache.keys().next().value;
    if (first !== undefined) cloudCache.delete(first);
  }
  return data;
}

export function dropCloud(photoId: number) {
  cloudCache.delete(photoId);
}

const TRAIL_N = 10;

/** 一张照片的粒子云:静置微漩涡 + 尾迹风流 + 景深光斑 + 告别/收回 */
export class ParticlePhoto {
  readonly points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  readonly aspect: number;
  private morphTarget = 0;
  private morphCur = 1;
  private assembleRate: number;
  private collapseTarget = 0;
  private collapseCur = 0;
  private trail = Array.from({ length: TRAIL_N }, () => new THREE.Vector4(0, 0, 0, 0));
  private trailIndex = 0;

  readonly count: number;

  constructor(cloud: ParticleCloudData, drift: number, assembleRate = 2.2) {
    this.count = cloud.count;
    this.assembleRate = assembleRate;
    this.aspect = cloud.width / cloud.height;

    this.geo = new THREE.BufferGeometry();
    const pos = new Float32Array(cloud.count * 3); // 初始 = 散开态
    for (let i = 0; i < cloud.count; i++) {
      const ang = cloud.rand[i * 4] * Math.PI * 2;
      const rad = 0.35 + cloud.rand[i * 4 + 1] * 0.9;
      pos[i * 3] = Math.cos(ang) * rad * this.aspect;
      pos[i * 3 + 1] = Math.sin(ang) * rad * 0.85;
      pos[i * 3 + 2] = (cloud.rand[i * 4 + 2] - 0.5) * 1.6;
    }
    this.geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute("aTarget", new THREE.BufferAttribute(cloud.target, 2));
    this.geo.setAttribute("aDepth", new THREE.BufferAttribute(cloud.depth ?? new Float32Array(cloud.count), 1));
    this.geo.setAttribute("aAlpha", new THREE.BufferAttribute(cloud.alpha ?? new Float32Array(cloud.count).fill(1), 1));
    this.geo.setAttribute("aColor", new THREE.BufferAttribute(cloud.color, 3));
    this.geo.setAttribute("aData", new THREE.BufferAttribute(cloud.data, 2));
    this.geo.setAttribute("aRand", new THREE.BufferAttribute(cloud.rand, 4));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6);

    this.mat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uMorph: { value: 1 },
        uMouseVel: { value: new THREE.Vector2(0, 0) },
        uTrail: { value: this.trail },
        uAspect: { value: this.aspect },
        uSizeScale: { value: 800.0 },
        uReferenceDistance: { value: 1.67 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        uDrift: { value: drift },
        uCollapse: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
      ...STELLAR_BLEND,
    });

    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
  }

  /** 目标形态:0=照片 1=散开 */
  setMorph(t: number) {
    this.morphTarget = THREE.MathUtils.clamp(t, 0, 1);
  }

  setMorphImmediate(t: number) { this.morphTarget = this.morphCur = t; this.mat.uniforms.uMorph.value = t; }

  get morph() {
    return this.morphCur;
  }

  /** 收回(整云缩回星辰点),duration 秒完成 */
  collapse(duration = 0.7) {
    this.collapseTarget = 1;
    this.collapseRate = 1 / Math.max(0.2, duration);
  }
  private collapseRate = 1 / 0.7;
  get collapsed() {
    return this.collapseCur > 0.985;
  }

  /** 依据画布高度标定粒子尺寸(透视相机下换算每世界单位的物理像素) */
  setViewportHeight(cssH: number, scale: number, dist: number, fovDeg: number) {
    const pr = Math.min(window.devicePixelRatio, 1.5);
    const pxPerWorld = (cssH * pr) / (2 * Math.tan((fovDeg * Math.PI) / 360) * dist);
    (this.mat.uniforms.uSizeScale.value as number) = pxPerWorld * scale;
    this.mat.uniforms.uReferenceDistance.value = dist / scale;
  }

  /** 尾迹采样:局部坐标 + 路径方向 + 能量(有界,自动衰减) */
  setTrail(x: number, y: number, dx: number, dy: number, energy: number) {
    this.trail[this.trailIndex].set(x, y, THREE.MathUtils.clamp(energy, 0, 1), Math.atan2(dy, dx));
    this.trailIndex = (this.trailIndex + 1) % TRAIL_N;
  }

  update(dt: number, time: number) {
    for (const t of this.trail) t.z *= Math.exp(-dt * 2.4);
    const speed = this.morphTarget === 1 ? 1.15 : this.assembleRate;
    const diff = this.morphTarget - this.morphCur;
    this.morphCur += diff * Math.min(1, dt * speed * 1.6);
    if (Math.abs(diff) < 0.001) this.morphCur = this.morphTarget;

    const cd = this.collapseTarget - this.collapseCur;
    this.collapseCur += cd * Math.min(1, dt * this.collapseRate * 1.8);

    this.mat.uniforms.uTime.value = time;
    this.mat.uniforms.uMorph.value = this.morphCur;
    this.mat.uniforms.uCollapse.value = this.collapseCur;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}
