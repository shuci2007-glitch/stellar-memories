import * as THREE from "three";
import type { QualityTier } from "../core/types";
import { PHOTO_SPHERE_DEFAULTS, type PhotoSphereSettings } from "../core/PhotoSphereSettings";

const SPHERE_BUDGET: Record<QualityTier, number> = { low: 12000, medium: 28000, high: 42000, ultra: 60000 };

const VERTEX = /* glsl */ `
precision highp float;
attribute vec3 aColor;
attribute vec3 aNormal;
attribute float aSize;
attribute float aBrightness;
attribute float aAlpha;
uniform float uDpr;
uniform float uPointSize;
uniform float uCurvature;
uniform float uPlaneHeight;
uniform float uOpacity;
varying vec3 vColor;
varying float vAlpha;
varying float vBrightness;
void main() {
  vec3 planePosition = vec3(aNormal.x * 2.21, aNormal.y * uPlaneHeight * .5, 0.);
  vec3 p = mix(planePosition, position, uCurvature);
  vec4 mv = modelViewMatrix * vec4(p, 1.);
  gl_Position = projectionMatrix * mv;
  float perspective = clamp(4.8 / max(-mv.z, .001), .45, 2.9);
  gl_PointSize = uDpr * uPointSize * aSize * perspective;
  float frontFacing = smoothstep(-.32, .48, (normalMatrix * aNormal).z);
  float curvedAlpha = mix(.22, 1., frontFacing);
  vColor = aColor;
  vAlpha = aAlpha * uOpacity * mix(smoothstep(-.12, .12, aNormal.z), curvedAlpha, uCurvature);
  vBrightness = aBrightness;
}`;
const FRAGMENT = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;
varying float vBrightness;
uniform float uGlow;
uniform float uExposure;
void main() {
  vec2 p = gl_PointCoord - .5;
  float r = length(p);
  float core = 1. - smoothstep(.06, .43, r);
  float lum = dot(vColor, vec3(.2126, .7152, .0722));
  float brightHot = smoothstep(.68, 1., lum);
  float localGlow = uGlow * (1. - brightHot * .42);
  float halo = exp(-r * r * 10.4) * localGlow * .56;
  float alpha = max(core * .9, halo) * vAlpha;
  if (alpha < .012) discard;
  vec3 color = vColor * vBrightness * (1. - brightHot * .16);
  float exposure = mix(uExposure, uExposure * uExposure, brightHot);
  color *= exposure;
  gl_FragColor = vec4(color, alpha * .88);
}`;

function hash(value: number) { return Math.sin(value * 127.1) * 43758.5453123; }
function fract(value: number) { return value - Math.floor(value); }
function fibonacciSphere(index: number, count: number) { const offset = 2 / count, y = index * offset - 1 + offset / 2, radius = Math.sqrt(Math.max(0, 1 - y * y)), phi = index * Math.PI * (3 - Math.sqrt(5)); return [Math.cos(phi) * radius, y, Math.sin(phi) * radius] as const; }

interface SphereField { texture: THREE.Texture; count: number; aspect: number; normals: Float32Array; colors: Float32Array; sizes: Float32Array; brightness: Float32Array; seeds: Float32Array; scatterDirs: Float32Array; reactivity: Float32Array; }

async function sampleSphereField(url: string, tier: QualityTier, signal?: AbortSignal): Promise<SphereField> {
  const response = await fetch(url, { signal }); if (!response.ok) throw new Error(`照片读取失败 (${response.status})`);
  const bitmap = await createImageBitmap(await response.blob(), { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, 320 / bitmap.width), width = Math.max(2, Math.round(bitmap.width * scale)), height = Math.max(2, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; const context = canvas.getContext("2d", { willReadFrequently: true })!; context.drawImage(bitmap, 0, 0, width, height); const raw = context.getImageData(0, 0, width, height).data;
    const rgba = (x: number, y: number) => { const px = Math.max(0, Math.min(width - 1, x | 0)), py = Math.max(0, Math.min(height - 1, y | 0)), offset = (py * width + px) * 4; return [raw[offset] / 255, raw[offset + 1] / 255, raw[offset + 2] / 255] as const; };
    const luminance = (x: number, y: number) => { const [r, g, b] = rgba(x, y); return .2126 * r + .7152 * g + .0722 * b; };
    const edgeAt = (x: number, y: number) => { const gx = -luminance(x - 1, y - 1) - 2 * luminance(x - 1, y) - luminance(x - 1, y + 1) + luminance(x + 1, y - 1) + 2 * luminance(x + 1, y) + luminance(x + 1, y + 1), gy = -luminance(x - 1, y - 1) - 2 * luminance(x, y - 1) - luminance(x + 1, y - 1) + luminance(x - 1, y + 1) + 2 * luminance(x, y + 1) + luminance(x + 1, y + 1); return Math.min(1, Math.hypot(gx, gy) * 1.45); };
    const count = SPHERE_BUDGET[tier], normals = new Float32Array(count * 3), colors = new Float32Array(count * 3), sizes = new Float32Array(count), brightness = new Float32Array(count), seeds = new Float32Array(count * 4), scatterDirs = new Float32Array(count * 3), reactivity = new Float32Array(count);
    for (let i = 0; i < count; i++) { const [nx, ny, nz] = fibonacciSphere(i, count), o = i * 3, s = i * 4; normals[o] = nx; normals[o + 1] = ny; normals[o + 2] = nz; const px = Math.max(0, Math.min(1, .5 + nx * .5)) * (width - 1), py = Math.max(0, Math.min(1, .5 - ny * .5)) * (height - 1), [r, g, b] = rgba(px, py), edge = edgeAt(px, py), lum = .2126 * r + .7152 * g + .0722 * b, saturation = Math.max(r, g, b) - Math.min(r, g, b); colors[o] = Math.min(1, r * 1.05); colors[o + 1] = Math.min(1, g * 1.05); colors[o + 2] = Math.min(1, b * 1.05); sizes[i] = .76 + lum * .96 + edge * .56 + saturation * .18 + fract(hash(i + 33)) * .08; brightness[i] = .62 + lum * .58 + edge * .18 + saturation * .08; const s0 = fract(hash(i * 1.17 + .3)), s1 = fract(hash(i * 1.91 + 1.3)), s2 = fract(hash(i * 2.57 + 2.1)), s3 = fract(hash(i * 3.41 + 5.7)); seeds[s] = s0; seeds[s + 1] = s1; seeds[s + 2] = s2; seeds[s + 3] = s3; scatterDirs[o] = nx * (.8 + s0 * .4) + (s1 - .5) * .25; scatterDirs[o + 1] = ny * (.8 + s0 * .4) + (s2 - .5) * .25; scatterDirs[o + 2] = nz * (.8 + s0 * .4) + (s3 - .5) * .25; reactivity[i] = Math.pow(s2, 1.05); }
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    return { texture, count, aspect: width / height, normals, colors, sizes, brightness, seeds, scatterDirs, reactivity };
  } finally { bitmap.close(); }
}

/** 用户提供的 Photo Particle Sphere V1 工程化迁移。 */
export class PhotoParticleSphere {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly count: number;
  get photoTexture() { return this.field.texture; }
  get aspect() { return this.field.aspect; }
  private settings: PhotoSphereSettings;
  private readonly field: SphereField;
  private readonly positions: Float32Array;
  private readonly offsets: Float32Array;
  private readonly targets: Float32Array;
  private pointer = new THREE.Vector3(1e6, 1e6, 1e6);
  private pointerActive = false;
  private pointerGain = 1;
  private scatter = 0;
  private scatterTarget = 0;

  static async load(url: string, tier: QualityTier = "medium", settings: PhotoSphereSettings = { ...PHOTO_SPHERE_DEFAULTS }, signal?: AbortSignal) { return new PhotoParticleSphere(await sampleSphereField(url, tier, signal), settings); }
  private constructor(field: SphereField, settings: PhotoSphereSettings) {
    this.field = field; this.count = field.count; this.settings = { ...settings }; this.scatter = this.scatterTarget = settings.scatter; this.positions = new Float32Array(field.count * 3); this.offsets = new Float32Array(field.count * 3); this.targets = new Float32Array(field.count * 3);
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3)); geometry.setAttribute("aNormal", new THREE.BufferAttribute(field.normals, 3)); geometry.setAttribute("aColor", new THREE.BufferAttribute(field.colors, 3)); geometry.setAttribute("aSize", new THREE.BufferAttribute(field.sizes, 1)); geometry.setAttribute("aBrightness", new THREE.BufferAttribute(field.brightness, 1)); geometry.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(field.count).fill(1), 1)); geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);
    const material = new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, uniforms: { uDpr: { value: Math.min(devicePixelRatio, 2) }, uPointSize: { value: settings.size }, uGlow: { value: settings.glow }, uExposure: { value: settings.brightness }, uCurvature: { value: 1 }, uPlaneHeight: { value: 4.42 / field.aspect }, uOpacity: { value: 1 } } });
    this.points = new THREE.Points(geometry, material); this.points.frustumCulled = false; this.points.renderOrder = 70; this.update(.016, 0);
  }
  applySettings(settings: PhotoSphereSettings) { this.settings = { ...settings }; this.scatterTarget = settings.scatter; this.points.material.uniforms.uPointSize.value = settings.size; this.points.material.uniforms.uGlow.value = settings.glow; this.points.material.uniforms.uExposure.value = settings.brightness; }
  setCurvature(value: number) { this.points.material.uniforms.uCurvature.value = THREE.MathUtils.clamp(value, 0, 1); }
  setOpacity(value: number) { this.points.material.uniforms.uOpacity.value = THREE.MathUtils.clamp(value, 0, 1); }
  setPixelRatio(value: number) { this.points.material.uniforms.uDpr.value = Math.min(value, 2); }
  setPointerGain(value: number) { this.pointerGain = value; }
  setPointer(direction: THREE.Vector3 | null) { this.pointerActive = !!direction; if (direction) this.pointer.copy(direction).normalize(); }
  update(dt: number, time: number) {
    this.scatter += (this.scatterTarget - this.scatter) * (1 - Math.exp(-2.7 * dt)); this.targets.fill(0);
    if (this.pointerActive && Math.abs(this.pointer.x) < 1e5) for (let i = 0; i < this.count; i++) { const o = i * 3, s = i * 4, nx = this.field.normals[o], ny = this.field.normals[o + 1], nz = this.field.normals[o + 2], dx = nx - this.pointer.x, dy = ny - this.pointer.y, dz = nz - this.pointer.z, distance = Math.sqrt(dx * dx + dy * dy + dz * dz); if (distance >= this.settings.disturbRadius * Math.sqrt(this.pointerGain) || this.field.reactivity[i] < .06) continue; const w = 1 - distance / (this.settings.disturbRadius * Math.sqrt(this.pointerGain)), smooth = w * w * (3 - 2 * w), gate = .58 + .42 * Math.max(0, Math.sin(time * 1.85 + this.field.seeds[s] * 9)), amplitude = Math.min(.38, this.settings.disturbStrength * this.pointerGain) * smooth * this.field.reactivity[i] * gate; this.targets[o] = nx * amplitude; this.targets[o + 1] = ny * amplitude; this.targets[o + 2] = nz * amplitude; }
    const rise = 1 - Math.exp(-this.settings.disturbRise * dt), fall = 1 - Math.exp(-this.settings.disturbFall * dt); for (let i = 0; i < this.offsets.length; i++) { const target = this.targets[i], k = Math.abs(target) > Math.abs(this.offsets[i]) ? rise : fall; this.offsets[i] += (target - this.offsets[i]) * k; }
    const scatter = this.scatter * this.scatter * (3 - 2 * this.scatter);
    for (let i = 0; i < this.count; i++) { const o = i * 3, s = i * 4, nx = this.field.normals[o], ny = this.field.normals[o + 1], nz = this.field.normals[o + 2]; let radius = this.settings.radius; radius += Math.sin(time * .72 + this.field.seeds[s] * 18) * this.settings.breathe * (.35 + this.field.seeds[s + 1] * .65); radius += (Math.sin(time * .58 + nx * 2.2 + ny * 1.4) * .68 + Math.cos(time * .44 - nx * 1.2 + nz * 1.8) * .32) * this.settings.wave; this.positions[o] = nx * radius + this.field.scatterDirs[o] * scatter * .38 + this.offsets[o]; this.positions[o + 1] = ny * radius + this.field.scatterDirs[o + 1] * scatter * .38 + this.offsets[o + 1]; this.positions[o + 2] = nz * radius + this.field.scatterDirs[o + 2] * scatter * .38 + this.offsets[o + 2]; }
    (this.points.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }
  dispose() { this.field.texture.dispose(); this.points.geometry.dispose(); this.points.material.dispose(); }
}
