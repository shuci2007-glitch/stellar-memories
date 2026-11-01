import * as THREE from "three";

/**
 * 页面主视觉天体（与 preview/render_planet.py 的预览同一套数学）：
 *   - 行星：着色球体，纬度条带 + 朝向光源的明暗 + 受光侧大气边缘光
 *   - 环  ：连续环带。用一块圆盘网格 + 片元着色器逐像素反算半径，
 *           径向剖面（含卡西尼缝）和角向碎屑纹理与 Python 版完全一致
 *   - 星云：两条旋臂的粒子云（星云本身就是"由星组成"，点是对的表达方式）
 *
 * 坐标约定：环放在 XZ 平面，由外层 group 绕 X 轴倾斜 tilt（asin 值），
 * 照片布局（core/spaces.ts）用同一个 tilt 公式，两边严丝合缝。
 */
export type BodyKind = "saturn" | "golden" | "nebula";

export const BODY_KINDS: BodyKind[] = ["saturn", "golden", "nebula"];

export function isBodyKind(id: string | null | undefined): id is BodyKind {
  return (
    id === "saturn" ||
    id === "golden" ||
    id === "nebula"
  );
}

/** 环面倾角的 sin 值；core/spaces.ts 的照片布局必须用同一个值 */
export const BODY_TILT: Record<BodyKind, number> = {
  saturn: 0.28,
  golden: 0.32,
  nebula: 0,
};

export interface BodyHandle {
  group: THREE.Group;
  spinner: THREE.Group;
  /** 每帧推进：光带流动 + 缓慢自转。 */
  tick: (dt: number, camera?: THREE.Camera) => void;
  dispose: () => void;
}

function dotTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.6)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function glowSprite(color: string, opacity: number, scale: number): THREE.Sprite {
  const size = 256;
  // 解析 "rgba(r,g,b,a)" / "rgb(r,g,b)"（兼容空格），不再用脆弱的正则替换末位 alpha
  const m = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
  const rgb = m ? `${m[1]},${m[2]},${m[3]}` : "255,255,255";
  const centerA = m && m[4] !== undefined ? Number(m[4]) : 1;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, `rgba(${rgb},${centerA})`);
  g.addColorStop(0.45, `rgba(${rgb},0.28)`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  sprite.scale.setScalar(scale);
  sprite.renderOrder = -8;
  return sprite;
}

/**
 * 天体的层级:
 *   group  —— 外层,承载「宇宙自旋」(鼠标拖动带动整个天体转)
 *   └ tilt —— 固定倾角(环面不是正对着镜头)
 *     └ spinner —— 自身缓慢自转(环面纹理流动)
 * 自旋必须作用在最外层,所以倾角不能直接写在 group 上,否则会被覆盖。
 */
function bodyGroup(tilt: number) {
  const group = new THREE.Group();
  const tiltGroup = new THREE.Group();
  tiltGroup.rotation.x = -Math.asin(tilt);
  group.add(tiltGroup);
  const spinner = new THREE.Group();
  tiltGroup.add(spinner);
  return { group, tiltGroup, spinner };
}

// ------------------------------------------------------------------ 行星球体

const PLANET_VERT = `
varying vec3 vNormal;
varying vec3 vViewPos;
varying float vLat;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vLat = position.y;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const PLANET_FRAG = `
uniform vec3 uLit;
uniform vec3 uDark;
uniform vec3 uRim;
uniform float uRimStrength;
uniform float uRadius;
uniform float uBands;
varying vec3 vNormal;
varying vec3 vViewPos;
varying float vLat;
void main() {
  vec3 n = normalize(vNormal);
  vec3 lightDir = normalize(vec3(-0.60, 0.30, 0.74));
  float lam = max(dot(n, lightDir), 0.0);
  // 纬度条带：几个不同频率的正弦叠加，像大气环流
  float lat = clamp(vLat / uRadius, -1.0, 1.0);
  float stripe = 1.0 + uBands * (0.10 * sin(lat * 26.0 + sin(lat * 5.0) * 1.6));
  vec3 col = mix(uDark, uLit, pow(lam, 0.85)) * stripe;
  float fres = pow(1.0 - max(dot(n, normalize(-vViewPos)), 0.0), 3.0);
  col += uRim * fres * uRimStrength * (0.25 + 0.75 * lam);
  gl_FragColor = vec4(col, 1.0);
}`;

function planetMesh(radius: number, lit: THREE.Color, dark: THREE.Color, rim: THREE.Color, rimStrength: number, bands: number) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uLit: { value: lit },
      uDark: { value: dark },
      uRim: { value: rim },
      uRimStrength: { value: rimStrength },
      uRadius: { value: radius },
      uBands: { value: bands },
    },
    vertexShader: PLANET_VERT,
    fragmentShader: PLANET_FRAG,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 56, 36), material);
  mesh.renderOrder = -6;
  return mesh;
}

// ------------------------------------------------------------------ 连续环带

const RING_VERT = `
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const RING_FRAG = `
uniform float uInner;
uniform float uOuter;
uniform vec4 uBands[6];
uniform float uSpeckle;
uniform float uTime;
uniform vec3 uColIn;
uniform vec3 uColOut;
varying vec2 vLocal;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  float r = length(vLocal);
  float t = (r - uInner) / max(1e-4, uOuter - uInner);
  if (t < 0.0 || t > 1.0) discard;
  float bright = 0.0;
  for (int i = 0; i < 6; i++) {
    vec4 b = uBands[i];
    if (b.z <= 0.0) continue;
    float edge = min(smoothstep(b.x, b.x + b.w, t), 1.0 - smoothstep(b.y - b.w, b.y, t));
    bright = max(bright, b.z * edge);
  }
  if (bright <= 0.004) discard;
  // 径向细纹理（与 Python 版同一公式）
  float radial = 0.86 + 0.14 * (0.5 * sin(t * 190.0 + 11.0) + 0.5 * sin(t * 71.0 + 22.0));
  // 角向碎屑纹理，随时间缓慢流动
  float theta = atan(vLocal.y, vLocal.x) + uTime * 0.12;
  float n1 = hash(vec2(floor(r * 0.7), floor(theta * 60.0)));
  float n2 = hash(vec2(floor(r * 0.13), floor(theta * 9.0)));
  float speck = 1.0 - uSpeckle + uSpeckle * (0.55 * n1 + 0.45 * n2);
  float a = bright * radial * speck;
  vec3 col = mix(uColIn, uColOut, t);
  gl_FragColor = vec4(col * a * 1.25, clamp(a, 0.0, 1.0));
}`;

function ringDisc(
  inner: number,
  outer: number,
  bands: [number, number, number, number][],
  colIn: THREE.Color,
  colOut: THREE.Color,
  speckle: number,
) {
  const uniforms = {
    uInner: { value: inner },
    uOuter: { value: outer },
    uBands: {
      value: [0, 1, 2, 3, 4, 5].map((i) => {
        const b = bands[i];
        return new THREE.Vector4(b ? b[0] : 0, b ? b[1] : 0, b ? b[2] : 0, b ? b[3] : 0);
      }),
    },
    uSpeckle: { value: speckle },
    uTime: { value: 0 },
    uColIn: { value: colIn },
    uColOut: { value: colOut },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: RING_VERT,
    fragmentShader: RING_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const size = outer * 2.02;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
  mesh.rotation.x = -Math.PI / 2; // 铺到 XZ 平面
  mesh.renderOrder = -4;
  return { mesh, uniforms };
}

// ------------------------------------------------------------------ 碎屑粒子

function debrisPoints(radius: number, count: number, seed: number, spread: number) {
  const positions: number[] = [];
  const colors: number[] = [];
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2;
    const r = radius * (1.04 + rand() * spread);
    positions.push(Math.cos(a) * r, (rand() - 0.5) * 3.2, Math.sin(a) * r);
    const v = rand() ** 2 * 0.85 + 0.12;
    colors.push(0.5 * v, 0.72 * v, 1.0 * v);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const points = new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      size: 2.1,
      map: dotTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    }),
  );
  points.frustumCulled = false;
  return points;
}

// ------------------------------------------------------------------ 三种天体

function buildSaturn(): BodyHandle {
  const { group, tiltGroup, spinner } = bodyGroup(BODY_TILT.saturn);

  tiltGroup.add(glowSprite("rgba(70,150,255,0.85)", 0.5, 460));

  const rp = 34;
  const inner = rp * 1.3;
  const outer = rp * 3.05;
  const bands: [number, number, number, number][] = [
    [0.0, 0.3, 0.55, 0.03],
    [0.31, 0.335, 0.05, 0.01], // 卡西尼缝
    [0.34, 0.62, 0.95, 0.02],
    [0.63, 0.66, 0.12, 0.01], // 恩克缝
    [0.67, 0.88, 0.62, 0.03],
    [0.89, 1.0, 0.28, 0.06],
  ];
  const { mesh, uniforms } = ringDisc(
    inner,
    outer,
    bands,
    new THREE.Color(0.55, 0.78, 1.0),
    new THREE.Color(0.3, 0.52, 0.86),
    0.42,
  );
  spinner.add(mesh);

  const planet = planetMesh(
    rp,
    new THREE.Color(0.3, 0.64, 0.92),
    new THREE.Color(0.02, 0.06, 0.16),
    new THREE.Color(0.35, 0.72, 1.0),
    0.9,
    1.0,
  );
  tiltGroup.add(planet);

  const debris = debrisPoints(outer, 1400, 20261, 0.42);
  spinner.add(debris);

  return {
    group,
    spinner,
    tick: (dt: number) => {
      uniforms.uTime.value += dt;
      spinner.rotation.y += dt * 0.05;
    },
    dispose: () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      planet.geometry.dispose();
      (planet.material as THREE.Material).dispose();
      debris.geometry.dispose();
      (debris.material as THREE.Material).dispose();
    },
  };
}

function buildGolden(): BodyHandle {
  const { group, tiltGroup, spinner } = bodyGroup(BODY_TILT.golden);

  tiltGroup.add(glowSprite("rgba(255,190,110,0.8)", 0.38, 420));

  const R = 104;
  const inner = 78;
  const outer = 120;
  const bands: [number, number, number, number][] = [
    [0.0, 0.42, 0.08, 0.2], // 稀薄内雾
    [0.52, 0.6, 0.4, 0.05], // 内侧细环
    [0.6, 0.74, 1.0, 0.05], // 主环
    [0.78, 0.9, 0.28, 0.1],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const { mesh, uniforms } = ringDisc(
    inner,
    outer,
    bands,
    new THREE.Color(1.0, 0.82, 0.5),
    new THREE.Color(1.0, 0.55, 0.22),
    0.35,
  );
  spinner.add(mesh);

  const planet = planetMesh(
    13,
    new THREE.Color(0.98, 0.85, 0.62),
    new THREE.Color(0.14, 0.09, 0.05),
    new THREE.Color(1.0, 0.78, 0.45),
    0.55,
    0.0,
  );
  tiltGroup.add(planet);

  const dust = debrisPoints(R, 900, 777, 0.28);
  (dust.material as THREE.PointsMaterial).color = new THREE.Color(1.0, 0.72, 0.4);
  spinner.add(dust);

  return {
    group,
    spinner,
    tick: (dt: number) => {
      uniforms.uTime.value += dt;
      spinner.rotation.y += dt * 0.045;
    },
    dispose: () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      planet.geometry.dispose();
      (planet.material as THREE.Material).dispose();
      dust.geometry.dispose();
      (dust.material as THREE.Material).dispose();
    },
  };
}

function buildNebula(): BodyHandle {
  const { group, tiltGroup, spinner } = bodyGroup(BODY_TILT.nebula);

  const positions: number[] = [];
  const colors: number[] = [];
  let s = 77 >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let arm = 0; arm < 2; arm++) {
    for (let i = 0; i < 8500; i++) {
      const t = rand() ** 0.85;
      const a = arm * Math.PI + t * 2.7 + (rand() - 0.5) * 0.34;
      const r = 55 + t * 620 * 0.19 + (rand() - 0.5) * (14 + 26 * t);
      positions.push(Math.cos(a) * r, (rand() - 0.5) * (10 + 26 * t), Math.sin(a) * r);
      let cr = 1.0, cg = 0.88, cb = 0.72;
      if (t < 0.22) { cr = 1.0; cg = 0.88; cb = 0.72; }
      else if (t < 0.46) { cr = 0.95; cg = 0.38; cb = 0.68; }
      else if (t < 0.72) { cr = 0.5; cg = 0.38; cb = 0.94; }
      else { cr = 0.36; cg = 0.77; cb = 0.94; }
      const v = (0.05 + rand() * 0.38) * (1 - 0.5 * t) * (rand() < 0.02 ? 2.2 : 1);
      colors.push(cr * v, cg * v, cb * v);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const cloud = new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      size: 1.5,
      map: dotTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    }),
  );
  cloud.frustumCulled = false;
  spinner.add(cloud);
  tiltGroup.add(glowSprite("rgba(150,110,255,0.6)", 0.32, 380));

  return {
    group,
    spinner,
    tick: (dt: number) => {
      spinner.rotation.y -= dt * 0.028;
    },
    dispose: () => {
      cloud.geometry.dispose();
      (cloud.material as THREE.Material).dispose();
    },
  };
}

export function buildBody(kind: BodyKind): BodyHandle {
  if (kind === "saturn") return buildSaturn();
  if (kind === "golden") return buildGolden();
  return buildNebula();
}

/**
 * 释放整个天体子树:几何体、材质,以及材质引用的所有纹理(glow 光晕、碎屑点
 * 的 CanvasTexture 等)。原先只在各 buildX 里 dispose 了主网格,光晕 Sprite 与
 * 碎屑 Points 的纹理会随切页累积泄漏,这里用遍历统一兜底。
 */
export function disposeBody(handle: BodyHandle | null) {
  if (!handle) return;
  handle.dispose();
  handle.group.traverse((obj) => {
    const node = obj as unknown as {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    if (node.geometry) node.geometry.dispose();
    const mats = node.material
      ? Array.isArray(node.material)
        ? node.material
        : [node.material]
      : [];
    for (const material of mats) {
      for (const key of Object.keys(material)) {
        const value = (material as unknown as Record<string, unknown>)[key];
        if (value && (value as THREE.Texture).isTexture) {
          (value as THREE.Texture).dispose();
        }
      }
      material.dispose();
    }
  });
  handle.group.clear();
}
