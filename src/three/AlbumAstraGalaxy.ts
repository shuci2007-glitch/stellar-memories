import * as THREE from "three";
import { makeAstraGalaxyMaterial, makeAstraPathStarMaterial } from "./AstraGalaxyMaterial";

type Layer = { points: THREE.Points; material: THREE.ShaderMaterial; texture?: THREE.Texture; speed: number; travel: number; dust: boolean };

function mulberry32(seed: number) { return () => { let t = seed += 0x6d2b79f5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function hashId(id: number) { let value = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b); value ^= value >>> 13; return value >>> 0; }
function modulo(value: number) { return ((value % 1) + 1) % 1; }

function makeCurve(archetype: number, index: number, count: number, rng: () => number) {
  const points: THREE.Vector3[] = [], phase = index / count * Math.PI * 2, skew = (rng() - .5) * .5;
  for (let k = 0; k < 9; k++) {
    const t = k / 8, centered = t * 2 - 1;
    if (archetype === 0) {
      const radius = .25 + t * (3.7 + index * .38), angle = phase + t * (1.05 + index * .14);
      points.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius * (.42 + index * .035) + Math.sin(t * Math.PI) * skew, Math.sin(t * Math.PI * 1.7 + phase) * .36));
    } else if (archetype === 1) {
      points.push(new THREE.Vector3(centered * (4.15 + index * .2), Math.sin(t * Math.PI * 2 + phase) * (1.05 + index * .24) + centered * skew, Math.cos(t * Math.PI + phase) * (.32 + index * .09)));
    } else if (archetype === 2) {
      const angle = t * Math.PI * 1.72 + phase * .28, radius = 3.15 + Math.sin(t * Math.PI * 3 + phase) * (.55 + index * .12);
      points.push(new THREE.Vector3(Math.cos(angle) * radius * (1 + index * .06), Math.sin(angle) * radius * .56 + (index - count / 2) * .28, Math.sin(angle * 2 + phase) * .42));
    } else {
      points.push(new THREE.Vector3(centered * 4.25, Math.sin(centered * Math.PI * 1.35 + phase) * (1.1 + index * .2), Math.cos(centered * Math.PI + phase) * (.35 + index * .08) + centered * skew));
    }
  }
  return new THREE.CatmullRomCurve3(points, false, "centripetal", .35);
}

function pathTexture(curve: THREE.Curve<THREE.Vector3>) {
  const data = new Float32Array(512 * 4), point = new THREE.Vector3();
  for (let i = 0; i < 512; i++) { curve.getPointAt(i / 511, point); const offset = i * 4; data[offset] = point.x; data[offset + 1] = point.y; data[offset + 2] = point.z; data[offset + 3] = 1; }
  const texture = new THREE.DataTexture(data, 512, 1, THREE.RGBAFormat, THREE.FloatType); texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.NearestFilter; texture.generateMipmaps = false; texture.needsUpdate = true; return texture;
}

function writeColor(target: Float32Array, offset: number, source: THREE.Color, energy: number) { target[offset] = source.r * energy; target[offset + 1] = source.g * energy; target[offset + 2] = source.b * energy; }

function makeMainLayer(curve: THREE.Curve<THREE.Vector3>, palette: THREE.Color[], seedValue: number, pixelRatio: number, strong: boolean) {
  const rng = mulberry32(seedValue), count = strong ? 420 : 330, position = new Float32Array(count * 3), orbit = new Float32Array(count), across = new Float32Array(count), brightness = new Float32Array(count), colors = new Float32Array(count * 3), depth = new Float32Array(count), hero = new Float32Array(count), background = new Float32Array(count), opacity = new Float32Array(count), scale = new Float32Array(count), phase = new Float32Array(count), rate = new Float32Array(count), motionUv = new Float32Array(count * 3);
  const point = new THREE.Vector3(), tangent = new THREE.Vector3(), normal = new THREE.Vector3(); let heroIndex = 0, heroScore = -1;
  for (let i = 0; i < count; i++) { const raw = rng(), progress = modulo(raw + .035 * Math.sin(raw * Math.PI * 2)), envelope = Math.sin(progress * Math.PI); curve.getPointAt(progress, point); curve.getTangentAt(progress, tangent).normalize(); normal.set(-tangent.y, tangent.x, 0).normalize(); const width = (.1 + envelope * .38) * (.24 + rng() * .76), side = (rng() + rng() - 1) * width, z = (rng() + rng() - 1) * width * .74, o = i * 3; point.addScaledVector(normal, side); point.z += z; position[o] = point.x; position[o + 1] = point.y; position[o + 2] = point.z; orbit[i] = raw; across[i] = side; depth[i] = z; const bright = rng() < (strong ? .09 : .055), starScale = bright ? .88 + rng() * 1.5 : .13 + Math.pow(rng(), 2.5) * .72; scale[i] = starScale; brightness[i] = (bright ? 2 + rng() * 1.6 : .58 + rng() * .74) * (strong ? 1 : .88); writeColor(colors, o, palette[Math.floor(rng() * palette.length)], .88 + rng() * .24); opacity[i] = .76 + rng() * .23; phase[i] = rng() * Math.PI * 2; rate[i] = .62 + rng() * .76; const score = starScale * brightness[i]; if (score > heroScore) { heroScore = score; heroIndex = i; } motionUv[o] = motionUv[o + 1] = motionUv[o + 2] = 0; }
  hero[heroIndex] = 1; scale[heroIndex] = Math.max(scale[heroIndex], 2.25); brightness[heroIndex] = Math.max(brightness[heroIndex], 3.15);
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.BufferAttribute(position, 3)); geometry.setAttribute("orbitProgress", new THREE.BufferAttribute(orbit, 1)); geometry.setAttribute("starAcrossOffset", new THREE.BufferAttribute(across, 1)); geometry.setAttribute("starBrightness", new THREE.BufferAttribute(brightness, 1)); geometry.setAttribute("starColor", new THREE.BufferAttribute(colors, 3)); geometry.setAttribute("starDepthOffset", new THREE.BufferAttribute(depth, 1)); geometry.setAttribute("starHero", new THREE.BufferAttribute(hero, 1)); geometry.setAttribute("starBackground", new THREE.BufferAttribute(background, 1)); geometry.setAttribute("starOpacity", new THREE.BufferAttribute(opacity, 1)); geometry.setAttribute("starScale", new THREE.BufferAttribute(scale, 1)); geometry.setAttribute("twinklePhase", new THREE.BufferAttribute(phase, 1)); geometry.setAttribute("twinkleRate", new THREE.BufferAttribute(rate, 1)); geometry.setAttribute("particleMotionUv", new THREE.BufferAttribute(motionUv, 3));
  const texture = pathTexture(curve), material = makeAstraGalaxyMaterial(texture, pixelRatio, true); material.uniforms.uIntroProgress.value = 1; material.uniforms.uBackgroundStarsEnabled.value = 0; material.uniforms.uIntensity.value = strong ? 1.48 : 1.24; material.userData.baseIntensity = material.uniforms.uIntensity.value; const points = new THREE.Points(geometry, material); points.frustumCulled = false; return { points, material, texture, speed: (strong ? .007 : -.005) * (rng() < .5 ? -1 : 1), travel: rng(), dust: false } satisfies Layer;
}

function makeDustLayer(curve: THREE.Curve<THREE.Vector3>, seedValue: number, pixelRatio: number, strong: boolean) {
  const rng = mulberry32(seedValue), count = strong ? 250 : 180, position = new Float32Array(count * 3), driftPhase = new Float32Array(count), driftTangent = new Float32Array(count * 3), orbit = new Float32Array(count), opacity = new Float32Array(count), scale = new Float32Array(count), point = new THREE.Vector3(), tangent = new THREE.Vector3(), normal = new THREE.Vector3();
  for (let i = 0; i < count; i++) { const progress = (i + rng() * .85) / count, envelope = Math.sin(progress * Math.PI); curve.getPointAt(progress, point); curve.getTangentAt(progress, tangent).normalize(); normal.set(-tangent.y, tangent.x, 0).normalize(); const width = (.025 + rng() * .2) * (.35 + envelope * .65); point.addScaledVector(normal, (rng() + rng() - 1) * width); point.z += (rng() - .5) * width; const o = i * 3; position[o] = point.x; position[o + 1] = point.y; position[o + 2] = point.z; driftPhase[i] = rng(); driftTangent[o] = tangent.x; driftTangent[o + 1] = tangent.y; driftTangent[o + 2] = tangent.z; orbit[i] = progress; opacity[i] = (.38 + rng() * .6) * (.4 + envelope * .6); scale[i] = .2 + rng() * .85; }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.BufferAttribute(position, 3)); geometry.setAttribute("driftPhase", new THREE.BufferAttribute(driftPhase, 1)); geometry.setAttribute("driftTangent", new THREE.BufferAttribute(driftTangent, 3)); geometry.setAttribute("orbitProgress", new THREE.BufferAttribute(orbit, 1)); geometry.setAttribute("particleOpacity", new THREE.BufferAttribute(opacity, 1)); geometry.setAttribute("particleScale", new THREE.BufferAttribute(scale, 1));
  const material = makeAstraPathStarMaterial(pixelRatio, strong, rng() < .5 ? -1 : 1); material.uniforms.uIntroProgress.value = 1; material.uniforms.uIntensity.value = strong ? .52 : .38; material.userData.baseIntensity = material.uniforms.uIntensity.value; const points = new THREE.Points(geometry, material); points.frustumCulled = false; return { points, material, speed: strong ? .018 : -.013, travel: rng(), dust: true } satisfies Layer;
}

/** 相册星系复用 Universe 的 Astra 主星/亮星/轨迹尘材质，只替换为相册稳定 seed 生成的异形曲线骨架。 */
export class AlbumAstraGalaxy {
  readonly group = new THREE.Group();
  private readonly layers: Layer[] = [];
  private time = 0;
  constructor(albumId: number, sourcePalette: THREE.Color[], pixelRatio = Math.min(devicePixelRatio, 2)) {
    const seed = hashId(albumId), rng = mulberry32(seed), archetype = seed % 4, count = 3 + (seed % 3);
    const astraFallback = [new THREE.Color("#6dcbf4"), new THREE.Color("#7ab1fe"), new THREE.Color("#f87915"), new THREE.Color("#fa994c"), new THREE.Color("#f5f6fb")];
    const palette = sourcePalette.length ? sourcePalette.map((color, i) => color.clone().lerp(astraFallback[(seed + i) % astraFallback.length], .34)) : astraFallback;
    for (let index = 0; index < count; index++) { const curve = makeCurve(archetype, index, count, rng), strong = index === seed % count, main = makeMainLayer(curve, palette, seed ^ Math.imul(index + 1, 0x9e3779b9), pixelRatio, strong), dust = makeDustLayer(curve, seed ^ Math.imul(index + 7, 0x85ebca6b), pixelRatio, strong); this.layers.push(main, dust); this.group.add(main.points, dust.points); }
    this.group.rotation.set((rng() - .5) * .28, (rng() - .5) * .4, (rng() - .5) * .28);
  }
  update(dt: number, opacity = 1, focus = 0) { this.time += dt; for (const layer of this.layers) { layer.travel = modulo(layer.travel + layer.speed * dt); layer.material.uniforms.uTime.value = this.time; layer.material.uniforms.uIntroProgress.value = 1; layer.material.uniforms.uIntensity.value = (layer.material.userData.baseIntensity as number) * opacity * (1 + focus * .16); if (layer.dust) layer.material.uniforms.uHeadProgress.value = layer.travel; else layer.material.uniforms.uPathOffset.value = layer.travel; } }
  setPixelRatio(value: number) { for (const layer of this.layers) layer.material.uniforms.uPixelRatio.value = Math.min(value, 2); }
  dispose() { for (const layer of this.layers) { layer.points.geometry.dispose(); layer.material.dispose(); layer.texture?.dispose(); } this.layers.length = 0; this.group.clear(); }
}
