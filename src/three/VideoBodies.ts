import * as THREE from "three";
import {
  GALAXY_ARMS,
  GALAXY_BAND_K,
  GALAXY_BAND_POW,
  GALAXY_CORE,
  GALAXY_INNER,
  GALAXY_MAX_H,
  GALAXY_OUTER,
  GALAXY_SWIRL,
  GALAXY_TILT,
  HALO_CORE,
  HALO_OUTER,
  HALO_RING_HALF,
  HALO_RINGS,
  HALO_TILT,
  KNOT_CURVES,
  haloRingRadius,
  knotPoint,
} from "../core/bodyMath";
import { glowSprite, planetMesh } from "./bodyPrimitives";
import type { BodyHandle } from "./SpaceBody";

/**
 * 三种来自参考视频的「纯网格」天体。一个粒子都不用。
 *
 * 参数不是拍脑袋定的，来自对视频帧的像素级测量：
 *   - 光带结：主体 479×384px，亮脊 5px / 90 分位 18px → 绸带宽度取结半径的 16–22%
 *   - 同心光环：每扇区中位 19 条环带，占空比 0.571 → 19 条独立环带
 *   - 螺旋星盘：中位 7 条主带，占空比 0.360，色阶 #b9e9f3 → #6091b9
 */

// ------------------------------------------------------------------ 通用

function bodyGroups(tilt: number) {
  const group = new THREE.Group();
  const tiltGroup = new THREE.Group();
  tiltGroup.rotation.x = -Math.asin(tilt);
  group.add(tiltGroup);
  const spinner = new THREE.Group();
  tiltGroup.add(spinner);
  return { group, tiltGroup, spinner };
}

// ------------------------------------------------------------------ 一、光带结（真绸带）

/**
 * 沿曲线生成一条扁绸带。
 *
 * 关键在于标架：只用切线 T 无法确定带宽方向，必须用「平行输运」把上一站的
 * 法线沿曲线搬过来（绕 prevT×T 转），再让宽度向量 W 绕 T 旋转扭转角 θ(u)。
 * 顶点取 P ± W·(w/2) —— 于是带宽随 cos θ 变化，侧对镜头时收成一条线，
 * 这正是视频里绸带忽宽忽窄、正反面交替反光的原因。圆管永远做不到这一点。
 */
function ribbonGeometry(
  curve: THREE.Curve<THREE.Vector3>,
  segments: number,
  width: number,
  twist: number,
) {
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const uvs = new Float32Array((segments + 1) * 2 * 2);
  const indices: number[] = [];

  const T = new THREE.Vector3();
  const N = new THREE.Vector3();
  const B = new THREE.Vector3();
  const W = new THREE.Vector3();
  const prevT = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const p = new THREE.Vector3();

  curve.getTangentAt(0, T);
  N.set(0, 1, 0);
  if (Math.abs(N.dot(T)) > 0.9) N.set(1, 0, 0);
  N.addScaledVector(T, -N.dot(T)).normalize();
  prevT.copy(T);

  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    curve.getPointAt(u, p);
    curve.getTangentAt(u, T);

    axis.crossVectors(prevT, T);
    const len = axis.length();
    if (len > 1e-7) {
      axis.divideScalar(len);
      const ang = Math.acos(THREE.MathUtils.clamp(prevT.dot(T), -1, 1));
      N.applyAxisAngle(axis, ang);
    }
    // 正交化，防止浮点漂移
    N.addScaledVector(T, -N.dot(T));
    if (N.lengthSq() < 1e-8) N.set(0, 1, 0).addScaledVector(T, -T.y);
    N.normalize();
    B.crossVectors(T, N).normalize();
    prevT.copy(T);

    const theta = twist * Math.PI * 2 * u;
    W.copy(N).multiplyScalar(Math.cos(theta)).addScaledVector(B, Math.sin(theta)).normalize();

    const hw = width * 0.5;
    positions[i * 6 + 0] = p.x + W.x * hw;
    positions[i * 6 + 1] = p.y + W.y * hw;
    positions[i * 6 + 2] = p.z + W.z * hw;
    positions[i * 6 + 3] = p.x - W.x * hw;
    positions[i * 6 + 4] = p.y - W.y * hw;
    positions[i * 6 + 5] = p.z - W.z * hw;

    uvs[i * 4 + 0] = u;
    uvs[i * 4 + 1] = 0;
    uvs[i * 4 + 2] = u;
    uvs[i * 4 + 3] = 1;

    if (i < segments) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = (i + 1) * 2;
      const d = (i + 1) * 2 + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

const RIBBON_VERT = `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

/**
 * 绸带着色：
 *   edge —— 带宽方向两端各一条亮脊（实测亮脊只占带宽的一成多）
 *   face —— 带面正对镜头时整片透亮，侧过去只剩亮脊
 *   两者叠加才有「丝绸」的通透感，而不是一根发光的塑料管
 */
const RIBBON_FRAG = `
uniform float uTime;
uniform float uSeed;
uniform float uOpacity;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColTip;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;

void main() {
  float u = vUv.x;
  float across = vUv.y;

  float d = min(across, 1.0 - across);
  float edge = 1.0 - smoothstep(0.0, 0.17, d);

  float face = abs(dot(normalize(vN), normalize(vV)));

  float flow = 0.5 + 0.5 * sin(u * 9.0 - uTime * 0.9 + uSeed * 3.1);
  float flow2 = 0.5 + 0.5 * sin(u * 3.4 + uTime * 0.5 + uSeed * 1.7);
  vec3 col = mix(uColA, uColB, flow);
  col = mix(col, uColTip, smoothstep(0.55, 1.0, flow2) * 0.45);

  float a = (0.050 + 0.22 * edge + 0.16 * face) * uOpacity;
  vec3 outCol = col * (0.30 + 0.72 * edge + 0.55 * face);
  gl_FragColor = vec4(outCol, a);
}`;

function buildKnot(): BodyHandle {
  const { group, spinner } = bodyGroups(0);

  const timeUniforms: { value: number }[] = [];
  const meshes: THREE.Mesh[] = [];

  // 实测色阶：#e3e4e7 高光 / #c3cacf 中间调 / #a8b2bb 暗部，
  // 主调是冷白偏蓝，暖色只作点缀（原先的珊瑚色过重）
  const palettes: [string, string, string][] = [
    ["#dce9f4", "#f2f6fb", "#ffd8c2"],
    ["#c9dcee", "#eef5fb", "#ffe2cc"],
    ["#e2eef8", "#ffffff", "#ffcfae"],
  ];

  for (let k = 0; k < KNOT_CURVES.length; k++) {
    const spec = KNOT_CURVES[k];

    const pts: THREE.Vector3[] = [];
    const SEG = 200;
    for (let s = 0; s < SEG; s++) {
      const t = (s / SEG) * Math.PI * 2;
      const p = knotPoint(k, t);
      pts.push(new THREE.Vector3(p.x, p.y, p.z));
    }
    const curve = new THREE.CatmullRomCurve3(pts, true, "centripetal");

    const palette = palettes[k % palettes.length];

    const makeRibbon = (width: number, opacity: number, seed: number) => {
      const uniforms = {
        uTime: { value: 0 },
        uSeed: { value: seed },
        uOpacity: { value: opacity },
        uColA: { value: new THREE.Color(palette[0]) },
        uColB: { value: new THREE.Color(palette[1]) },
        uColTip: { value: new THREE.Color(palette[2]) },
      };
      timeUniforms.push(uniforms.uTime);
      const mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: RIBBON_VERT,
        fragmentShader: RIBBON_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(ribbonGeometry(curve, 280, width, spec.twist), mat);
      mesh.frustumCulled = false;
      spinner.add(mesh);
      meshes.push(mesh);
      return mesh;
    };

    // 主绸带 + 一层 2.6 倍宽的薄雾带（仍是网格，不是粒子），做出空气感
    const main = makeRibbon(spec.width, 1, k * 1.37);
    main.renderOrder = -3;
    const veil = makeRibbon(spec.width * 2.6, 0.055, k * 1.37 + 4.0);
    veil.renderOrder = -5;
  }

  spinner.add(glowSprite("rgba(155,205,255,0.9)", 0.05, 230));

  return {
    group,
    spinner,
    tick: (dt: number) => {
      for (const u of timeUniforms) u.value += dt;
      spinner.rotation.y += dt * 0.05;
      spinner.rotation.x = Math.sin(timeUniforms[0].value * 0.22) * 0.06;
    },
    dispose: () => {
      for (const m of meshes) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    },
  };
}

// ------------------------------------------------------------------ 二、同心光环（19 条环带）

/** 一条平面圆环带，uv.x = 角向，uv.y = 带宽方向（0 内缘 / 1 外缘） */
function annulusGeometry(rIn: number, rOut: number, segments: number) {
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const uvs = new Float32Array((segments + 1) * 2 * 2);
  const indices: number[] = [];

  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    positions[i * 6 + 0] = ca * rIn;
    positions[i * 6 + 1] = 0;
    positions[i * 6 + 2] = sa * rIn;
    positions[i * 6 + 3] = ca * rOut;
    positions[i * 6 + 4] = 0;
    positions[i * 6 + 5] = sa * rOut;

    uvs[i * 4 + 0] = i / segments;
    uvs[i * 4 + 1] = 0;
    uvs[i * 4 + 2] = i / segments;
    uvs[i * 4 + 3] = 1;

    if (i < segments) {
      const a0 = i * 2;
      const b0 = i * 2 + 1;
      const c0 = (i + 1) * 2;
      const d0 = (i + 1) * 2 + 1;
      indices.push(a0, c0, b0, b0, c0, d0);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

const RING_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const RING_FRAG = `
uniform float uTime;
uniform float uSeed;
uniform vec3 uColIn;
uniform vec3 uColOut;
varying vec2 vUv;

void main() {
  float ang = vUv.x;
  float across = vUv.y;

  // 两条边各一道亮脊，中间半透明 —— 与绸带同一套语言
  float d = min(across, 1.0 - across);
  float edge = 1.0 - smoothstep(0.0, 0.22, d);

  // 角向极细纹理（实测环带有细密纵向纤维感）
  float fibre = 0.78 + 0.22 * sin(ang * 1256.0 + uSeed * 7.0);
  // 长周期明暗，避免整圈一样亮
  float drift = 0.72 + 0.28 * sin(ang * 6.283 + uSeed * 2.3 + uTime * 0.15);

  // 长弧高光：像光扫过丝绸的一段，是「浓淡」的主要来源
  float sweep = pow(0.5 + 0.5 * sin(ang * 2.0 + uSeed * 1.9 + uTime * 0.25), 6.0);

  vec3 col = mix(uColIn, uColOut, across);
  float body = 0.50 + 0.50 * edge + 1.70 * sweep;
  float a = (0.24 + 0.26 * edge + 0.55 * sweep) * fibre * drift;
  gl_FragColor = vec4(col * body * fibre * drift, clamp(a, 0.0, 1.0));
}`;

function buildHalo(): BodyHandle {
  const { group, tiltGroup, spinner } = bodyGroups(HALO_TILT);

  const rings: THREE.Mesh[] = [];
  const materials: THREE.Material[] = [];

  // 实测：19 条环带、占空比 0.571；环带在高度上做极小的错位（±0.7），
  // 让掠射角下能看出「一叠绸带」而不是一张贴图
  for (let i = 0; i < HALO_RINGS; i++) {
    const r = haloRingRadius(i);
    const geo = annulusGeometry(r - HALO_RING_HALF, r + HALO_RING_HALF, 320);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSeed: { value: i * 1.73 },
        uColIn: { value: new THREE.Color("#fff8e3") },
        uColOut: { value: new THREE.Color("#d3c1ab") },
      },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = (i / (HALO_RINGS - 1) - 0.5) * 1.4;
    mesh.renderOrder = -4;
    spinner.add(mesh);
    rings.push(mesh);
    materials.push(mat);
  }

  const core = planetMesh(
    HALO_CORE,
    new THREE.Color(0.99, 0.90, 0.74),
    new THREE.Color(0.12, 0.08, 0.04),
    new THREE.Color(1.0, 0.84, 0.56),
    0.7,
    0.35,
  );
  tiltGroup.add(core);

  // 参考视频里环外那层很淡的经纬球壳
  const gridUniforms = {
    uColor: { value: new THREE.Color(0.80, 0.88, 1.0) },
    uOpacity: { value: 0.045 },
  };
  const gridMat = new THREE.ShaderMaterial({
    uniforms: gridUniforms,
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float fx = abs(fract(vUv.x * 36.0) - 0.5);
        float fy = abs(fract(vUv.y * 18.0) - 0.5);
        float line = smoothstep(0.458, 0.5, max(fx, fy));
        float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 1.4);
        gl_FragColor = vec4(uColor, line * uOpacity * (0.30 + 0.95 * fres));
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const grid = new THREE.Mesh(new THREE.SphereGeometry(HALO_OUTER * 1.06, 64, 40), gridMat);
  grid.renderOrder = -6;
  spinner.add(grid);

  spinner.add(glowSprite("rgba(255,236,200,0.85)", 0.10, 340));

  return {
    group,
    spinner,
    tick: (dt: number) => {
      for (const m of materials) {
        (m as THREE.ShaderMaterial).uniforms.uTime.value += dt;
      }
      spinner.rotation.y += dt * 0.038;
    },
    dispose: () => {
      for (const m of rings) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      grid.geometry.dispose();
      gridMat.dispose();
    },
  };
}

// ------------------------------------------------------------------ 三、螺旋星盘

/**
 * 「厚透镜」盘体：上下两片曲面 + 边缘收拢，得到真实厚度。
 * 相比一块平面，掠射角下不会缩成一条纸片，也更接近视频里的蓬松星盘。
 */
function thickDiscGeometry(
  inner: number,
  outer: number,
  radialSteps: number,
  angularSteps: number,
  maxHalfHeight: number,
) {
  const cols = angularSteps + 1;
  const rows = radialSteps + 1;
  const positions = new Float32Array(rows * cols * 2 * 3);

  const halfHeight = (t: number) =>
    maxHalfHeight *
    Math.pow(Math.max(0, Math.sin(Math.PI * t)), 0.75) *
    (0.45 + 0.55 * Math.exp(-Math.pow((t - 0.24) / 0.17, 2)));

  let p = 0;
  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? 1 : -1;
    for (let i = 0; i < rows; i++) {
      const t = i / radialSteps;
      const r = inner + (outer - inner) * t;
      const h = halfHeight(t) * sign;
      for (let j = 0; j < cols; j++) {
        const a = (j / angularSteps) * Math.PI * 2;
        positions[p++] = Math.cos(a) * r;
        positions[p++] = h;
        positions[p++] = Math.sin(a) * r;
      }
    }
  }

  const indices: number[] = [];
  const topBase = 0;
  const botBase = rows * cols;
  const pushQuad = (base: number, i: number, j: number, flip: boolean) => {
    const a = base + i * cols + j;
    const b = base + i * cols + j + 1;
    const c = base + (i + 1) * cols + j;
    const d = base + (i + 1) * cols + j + 1;
    if (!flip) indices.push(a, c, b, b, c, d);
    else indices.push(a, b, c, b, d, c);
  };
  for (let i = 0; i < radialSteps; i++) {
    for (let j = 0; j < angularSteps; j++) {
      pushQuad(topBase, i, j, false);
      pushQuad(botBase, i, j, true);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

const DISC_VERT = `
varying vec3 vPos;
varying vec3 vN;
varying vec3 vV;
void main() {
  vPos = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const DISC_FRAG = `
uniform float uInner;
uniform float uOuter;
uniform float uTime;
uniform float uMaxH;
uniform float uArms;
uniform float uSwirl;
uniform float uBandK;
uniform float uBandPow;
uniform vec3 uColCore;
uniform vec3 uColMid;
uniform vec3 uColRim;
varying vec3 vPos;
varying vec3 vN;
varying vec3 vV;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  float r = length(vPos.xz);
  float t = clamp((r - uInner) / max(1e-4, uOuter - uInner), 0.0, 1.0);
  float ang = atan(vPos.z, vPos.x);

  // 对数螺旋相位：与 core/bodyMath.ts 的 galaxyPhase 完全同源
  float phase = uArms * ang - uArms * uSwirl * log(max(r, 1.0) / 45.0) + uTime * 0.22;
  float spiral = pow(0.5 + 0.5 * sin(phase), 2.2);

  // 同心亮带（实测约 7–9 条，占空比 0.36 → 指数取 2.6 让带变窄）
  float rings = pow(0.5 + 0.5 * sin(r * uBandK - uTime * 0.30 + sin(ang * 5.0) * 0.8), uBandPow);

  float env = smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.74, 0.99, t));
  float edge = smoothstep(0.935, 0.972, t) * (1.0 - smoothstep(0.992, 1.0, t));

  float thick = 1.0 - clamp(abs(vPos.y) / max(1.0, uMaxH), 0.0, 1.0) * 0.5;
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 1.5);

  float bright = env * (0.34 + 0.78 * spiral + 0.85 * rings * (0.35 + 0.65 * spiral));
  bright += edge * 0.45;
  bright *= thick * (0.72 + 0.55 * fres);

  float n = hash(vec2(floor(r * 1.15), floor(ang * 64.0 + uTime * 0.4)));
  bright *= 0.86 + 0.28 * n;

  vec3 col = mix(uColCore, uColMid, smoothstep(0.0, 0.52, t));
  col = mix(col, uColRim, smoothstep(0.58, 1.0, t));
  gl_FragColor = vec4(col * bright * 1.02, clamp(bright, 0.0, 1.0));
}`;

function buildGalaxy(): BodyHandle {
  const { group, tiltGroup, spinner } = bodyGroups(GALAXY_TILT);

  const uniforms = {
    uInner: { value: GALAXY_INNER },
    uOuter: { value: GALAXY_OUTER },
    uTime: { value: 0 },
    uMaxH: { value: GALAXY_MAX_H },
    uArms: { value: GALAXY_ARMS },
    uSwirl: { value: GALAXY_SWIRL },
    uBandK: { value: GALAXY_BAND_K },
    uBandPow: { value: GALAXY_BAND_POW },
    // 实测色阶：#b9e9f3 高光 / #6baace 中间调 / #6091b9 暗部（比原先的电光蓝去饱和）
    uColCore: { value: new THREE.Color("#123a63") },
    uColMid: { value: new THREE.Color("#6baace") },
    uColRim: { value: new THREE.Color("#b9e9f3") },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: DISC_VERT,
    fragmentShader: DISC_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  const geo = thickDiscGeometry(GALAXY_INNER, GALAXY_OUTER, 96, 200, GALAXY_MAX_H);
  const disc = new THREE.Mesh(geo, mat);
  disc.renderOrder = -4;
  spinner.add(disc);

  const core = planetMesh(
    GALAXY_CORE,
    new THREE.Color("#5aa3d4"),
    new THREE.Color("#061428"),
    new THREE.Color("#b9e9f3"),
    1.35,
    0.85,
  );
  tiltGroup.add(core);

  spinner.add(glowSprite("rgba(120,180,230,0.75)", 0.08, GALAXY_OUTER * 2.0));

  return {
    group,
    spinner,
    tick: (dt: number) => {
      uniforms.uTime.value += dt;
      spinner.rotation.y += dt * 0.032;
      core.rotation.y += dt * 0.08;
    },
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}

// ------------------------------------------------------------------ 导出

export const VIDEO_BODY_BUILDERS = {
  knot: buildKnot,
  halo: buildHalo,
  galaxy: buildGalaxy,
} as const;

export type VideoBodyKind = keyof typeof VIDEO_BODY_BUILDERS;

export function buildVideoBody(kind: VideoBodyKind): BodyHandle {
  return VIDEO_BODY_BUILDERS[kind]();
}
