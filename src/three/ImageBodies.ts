import * as THREE from "three";
import { glowSprite } from "./bodyPrimitives";
import type { BodyHandle } from "./SpaceBody";

/**
 * 从正面 2D 参考图反推出的 3D 天体。
 *
 * 反推管线（%TEMP%/rebuild3d.py，全部由像素级测量得出）
 * -------------------------------------------------------
 * 1. 椭圆拟合：用「支撑函数」对致密主体做最小二乘，得到长轴方向与长短半轴。
 *    ratio = B/A = cos(倾角)。实测：蓝盘 0.30（倾角 72.7°）、金环 0.86（31°）。
 * 2. 去倾斜：沿长轴/短轴做基变换，把源图还原成**正圆盘俯视图**（*-top.png）。
 * 3. 行星：球体正交投影恒为圆 → 从原图抠出圆盘 → 反投影成球面等距柱状贴图
 *    （*-planet.png），背面半球用正面模糊暗版补齐。
 * 4. 散景碎点：原图里按饱和度检测彩色 bokeh，反投影到盘面坐标 + 伪深度。
 *
 * 呈现上的三个关键处理
 * ---------------------
 * a. **HDR 输出**：贴图峰值只有 1.0，直接送进场景会被 bloom 阈值(1.15)全部滤掉，
 *    星系会显得"死"。这里把亮度乘上 HDR 系数并减去阈值，让真正的亮部越过阈值，
 *    辉光才会出现。
 * b. **高度场浮雕**：俯视图的 alpha×亮度 = 盘面密度。把它当高度场做顶点位移，
 *    旋臂会真的隆起、有体积，而不是一张贴了图的薄平面。
 * c. **实体行星**：用反推出的球面贴图贴在真实球体上，带边缘光与晨昏线。
 */

export type ImageBodyKind = "imgalaxy" | "imgring" | "imgalaxyv";

interface ImageBodySpec {
  /** 俯视贴图（去倾斜后的正圆盘） */
  texture: string;
  /** 高度场（低通密度图，Python 侧预烘焙） */
  heightTexture: string;
  /** 行星的球面等距柱状贴图 */
  planetTexture: string;
  radius: number;
  /** 盘面起伏幅度（高度场位移） */
  relief: number;
  /** 行星：盘面归一化坐标与半径（盘半径 = 1） */
  planet: { ux: number; uy: number; r: number; lit: string; dark: string; lift: number };
  /** 卫星（小月牙） */
  moon?: { ux: number; uy: number; r: number; lit: string; dark: string };
  /** 长轴方位角（弧度）：把反推时归一化的长轴转回原 2D 的屏幕方向 */
  baseRot: number;
  /** HDR 增益：贴图峰值 × 该系数要越过场景 bloom 阈值 */
  hdr: number;
  /** 同色相环境提亮：把盘面的暗部按自身色相补一点亮度，去灰、让颜色更鲜，
   *  不会把亮部推成白（区别于整体乘增益） */
  amb: number;
  rim: string;
  rimStrength: number;
  glow: string;
  glowOpacity: number;
  spin: number;
}

const SPECS: Record<ImageBodyKind, ImageBodySpec> = {
  // 静态图反推的蓝盘：ratio 0.304（倾角 72.3°），大暗色蚀日行星 + 左上小卫星
  imgalaxy: {
    texture: "/extracted/blue-top.png",
    heightTexture: "/extracted/blue-height.png",
    planetTexture: "/extracted/blue-planet.png",
    radius: 170,
    relief: 15,
    planet: { ux: -0.187, uy: 0.432, r: 0.149, lit: "#7cbeeb", dark: "#0a0e19", lift: 2 },
    moon: { ux: -0.498, uy: 1.272, r: 0.034, lit: "#6b7a8f", dark: "#0a1226" },
    baseRot: 129.3 * (Math.PI / 180),
    hdr: 1.0,
    amb: 0.06,
    rim: "#dff2ff",
    rimStrength: 0.7,
    glow: "rgba(110,175,235,0.8)",
    glowOpacity: 0.18,
    spin: 0.03,
  },
  // 视频帧反推的蓝盘：素材质量更高，行星是鲜艳的青蓝（与参考视频同一渲染）
  imgalaxyv: {
    texture: "/extracted/bluev-top.png",
    heightTexture: "/extracted/bluev-height.png",
    planetTexture: "/extracted/bluev-planet.png",
    radius: 170,
    relief: 15,
    planet: { ux: -0.104, uy: 0.247, r: 0.147, lit: "#24c0fe", dark: "#050e1d", lift: 2 },
    moon: { ux: -0.392, uy: 1.596, r: 0.043, lit: "#6b7076", dark: "#0a1226" },
    baseRot: 127.4 * (Math.PI / 180),
    hdr: 1.0,
    amb: 0.06,
    rim: "#eaf8ff",
    rimStrength: 0.7,
    glow: "rgba(110,190,255,0.85)",
    glowOpacity: 0.18,
    spin: 0.03,
  },
  // 金色光环：ratio 0.858（倾角 30.9°），环心带环形山的行星
  imgring: {
    texture: "/extracted/gold-top.png",
    heightTexture: "/extracted/gold-height.png",
    planetTexture: "/extracted/gold-planet.png",
    radius: 130,
    relief: 16,
    planet: { ux: -0.036, uy: -0.097, r: 0.129, lit: "#f9efc8", dark: "#171110", lift: 1 },
    baseRot: 26.9 * (Math.PI / 180),
    hdr: 1.18,
    amb: 0.34,
    rim: "#ffe9b8",
    rimStrength: 1.0,
    glow: "rgba(255,225,170,0.8)",
    glowOpacity: 0.18,
    spin: 0.035,
  },
};

/**
 * 带高度场位移的圆盘几何。
 *
 * 网格是「极坐标环形」结构（半径 × 角度），顶点在 GPU 上按俯视贴图的
 * 密度（alpha×亮度）沿法线方向抬起 —— 于是旋臂真的隆起成浮雕，
 * 盘面有厚度和体积感，而不是一块贴了图的薄片。
 *
 * UV：u = x/(2R)+0.5，v = z/(2R)+0.5，与俯视贴图一一对应。
 */
function reliefDiscGeometry(R: number, radialSteps: number, angularSteps: number) {
  const cols = angularSteps + 1;
  const rows = radialSteps + 1;
  const positions = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);
  const indices: number[] = [];

  let p = 0;
  let q = 0;
  for (let i = 0; i < rows; i++) {
    const t = i / radialSteps;
    const r = R * t;
    for (let j = 0; j < cols; j++) {
      const a = (j / angularSteps) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      positions[p++] = x;
      positions[p++] = 0;
      positions[p++] = z;
      uvs[q++] = x / (2 * R) + 0.5;
      uvs[q++] = z / (2 * R) + 0.5;
    }
  }
  for (let i = 0; i < radialSteps; i++) {
    for (let j = 0; j < angularSteps; j++) {
      const a = i * cols + j;
      const b = i * cols + j + 1;
      const c = (i + 1) * cols + j;
      const d = (i + 1) * cols + j + 1;
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

/**
 * 盘体着色器。
 *
 * 关键点：
 * - 顶点阶段按高度图位移（真正的 3D 浮雕）
 * - 片元阶段输出 HDR 亮度（× hdr），让亮部越过场景 bloom 阈值
 * - 边缘用贴图 alpha 羽化，避免硬切边
 */
const DISC_VERT = `
uniform sampler2D uMap;
uniform sampler2D uHeight;
uniform float uRelief;
uniform float uR;
varying vec2 vUv;
varying float vDensity;
varying vec3 vN;
varying vec3 vV;

void main() {
  vUv = uv;
  // 高度场：Python 侧预烘焙的低通密度图（只保留大尺度起伏，
  // 避免高频细节把盘面顶成锯齿白瓷）
  float density = texture2D(uHeight, uv).r;
  vDensity = density;
  // 边缘处平滑收拢，避免盘沿出现硬边
  float r = length(uv - 0.5) * 2.0;
  float falloff = smoothstep(1.0, 0.80, r);
  vec3 pos = position;
  pos.y += density * uRelief * falloff;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const DISC_FRAG = `
uniform sampler2D uMap;
uniform float uHdr;
uniform float uAmb;
uniform vec3 uRim;
uniform float uRimStrength;
varying vec2 vUv;
varying float vDensity;
varying vec3 vN;
varying vec3 vV;

void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a;
  if (a < 0.004) discard;
  vec3 base = t.rgb;
  // 统一的 HDR 增益：把贴图整体抬到略高于场景 bloom 阈值(1.15)，
  // 让亮部被 bloom 捕捉产生辉光；其余交给色调映射自然收束，不会裁成纯白。
  vec3 col = base * uHdr;
  // 同色相环境提亮：只补「暗部」（低亮度的按自身色相抬升），
  // 让盘面不发灰、金环能读成金色，同时不把亮部推向纯白。
  float lum = dot(base, vec3(0.299, 0.587, 0.114));
  col += uAmb * base * (1.0 - smoothstep(0.05, 0.72, lum));
  // 高光膝：只把「真正的白色高光」推过 bloom 阈值(1.15)产生辉光，
  // 蓝色/金色主体保持在源图亮度，不会被整体拉爆成白瓷。
  col += vec3(0.30) * smoothstep(0.88, 1.0, lum);
  // 边缘菲涅尔辉光：盘沿掠射角下的淡光边
  float fres = pow(1.0 - max(dot(normalize(vN), normalize(vV)), 0.0), 2.6);
  col += uRim * fres * uRimStrength * (0.25 + 0.75 * vDensity);
  gl_FragColor = vec4(col, a);
}`;

/**
 * 带真实表面纹理的行星球体。
 * 贴图是反推出来的球面等距柱状图，直接用球面 UV 贴到球上。
 */
const PLANET_TEX_VERT = `
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

const PLANET_TEX_FRAG = `
uniform sampler2D uMap;
uniform vec3 uLit;
uniform vec3 uDark;
uniform vec3 uRim;
uniform float uRimStrength;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  vec3 tex = texture2D(uMap, vUv).rgb;
  // 提对比 + 轻微增饱和：把贴图向自身亮度两侧拉开，让云带/斑纹显形，
  // 否则低对比的球面贴图会被读成一颗光滑的"奶球"。
  float l0 = dot(tex, vec3(0.299, 0.587, 0.114));
  tex = (tex - l0) * 1.32 + l0;
  float l1 = dot(tex, vec3(0.299, 0.587, 0.114));
  tex = mix(vec3(l1), tex, 1.25);
  vec3 n = normalize(vN);
  vec3 lightDir = normalize(vec3(-0.55, 0.42, 0.72));
  float lam = max(dot(n, lightDir), 0.0);
  // 晨昏线：受光侧尽量保留贴图细节（不压太狠），背光侧压暗突出立体感
  float shade = 0.30 + 0.78 * pow(lam, 0.7);
  vec3 col = tex * shade;
  // 边缘光（大气辉光），很弱，只是为了不出现硬边
  float fres = pow(1.0 - max(dot(n, normalize(vV)), 0.0), 3.2);
  col += uRim * fres * uRimStrength * 0.14;
  gl_FragColor = vec4(col, 1.0);
}`;

function buildImageBody(kind: ImageBodyKind): BodyHandle {
  const spec = SPECS[kind];
  const group = new THREE.Group();
  const tiltGroup = new THREE.Group();
  group.add(tiltGroup);
  const spinner = new THREE.Group();
  spinner.rotation.y = spec.baseRot; // 长轴转回原 2D 的屏幕方向
  tiltGroup.add(spinner);

  const loader = new THREE.TextureLoader();

  // ---------------------------------------------------------- 盘体（浮雕）
  const tex = loader.load(spec.texture);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false; // 俯视贴图行 0 = 盘面 -R，与 UV 公式对应
  tex.anisotropy = 16;

  // 预烘焙的高度场（低通密度图）：盘面起伏由此驱动
  const htex = loader.load(spec.heightTexture);
  htex.flipY = false;
  htex.minFilter = THREE.LinearFilter;
  htex.magFilter = THREE.LinearFilter;
  htex.generateMipmaps = false;

  const geo = reliefDiscGeometry(spec.radius, 140, 320);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: tex },
      uHeight: { value: htex },
      uRelief: { value: spec.relief },
      uHdr: { value: spec.hdr },
      uAmb: { value: spec.amb },
      uRim: { value: new THREE.Color(spec.rim) },
      uRimStrength: { value: spec.rimStrength },
      uR: { value: spec.radius },
    },
    vertexShader: DISC_VERT,
    fragmentShader: DISC_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
  });
  const disc = new THREE.Mesh(geo, mat);
  disc.renderOrder = -4;
  spinner.add(disc);

  // ---------------------------------------------------------- 行星（真实纹理）
  const ptex = loader.load(spec.planetTexture);
  ptex.colorSpace = THREE.SRGBColorSpace;
  ptex.anisotropy = 8;
  const pmat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: ptex },
      uLit: { value: new THREE.Color(spec.planet.lit) },
      uDark: { value: new THREE.Color(spec.planet.dark) },
      uRim: { value: new THREE.Color(spec.rim) },
      uRimStrength: { value: spec.rimStrength },
    },
    vertexShader: PLANET_TEX_VERT,
    fragmentShader: PLANET_TEX_FRAG,
  });
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(spec.planet.r * spec.radius, 64, 40),
    pmat,
  );
  core.position.set(
    spec.planet.ux * spec.radius,
    spec.planet.lift + spec.relief * 0.55,
    spec.planet.uy * spec.radius,
  );
  core.renderOrder = -3;
  tiltGroup.add(core);

  // ---------------------------------------------------------- 卫星
  // 与行星共用同一张球面贴图：同一 URL 重复 loader.load 会产生两份独立纹理与 mipmap。
  let moonMesh: THREE.Mesh | null = null;
  let mmat: THREE.ShaderMaterial | null = null;
  if (spec.moon) {
    const m = spec.moon;
    mmat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: ptex },
        uLit: { value: new THREE.Color(m.lit) },
        uDark: { value: new THREE.Color(m.dark) },
        uRim: { value: new THREE.Color("#bcd6f0") },
        uRimStrength: { value: 2.2 },
      },
      vertexShader: PLANET_TEX_VERT,
      fragmentShader: PLANET_TEX_FRAG,
    });
    moonMesh = new THREE.Mesh(
      new THREE.SphereGeometry(m.r * spec.radius, 40, 24),
      mmat,
    );
    moonMesh.position.set(m.ux * spec.radius, spec.radius * 0.34, m.uy * spec.radius);
    moonMesh.renderOrder = -3;
    tiltGroup.add(moonMesh);
  }

  // ---------------------------------------------------------- 外围辉光
  const glow = glowSprite(spec.glow, spec.glowOpacity, spec.radius * 2.3);
  spinner.add(glow);

  // 注：原图里的彩色散景（bokeh）已经随俯视贴图烘焙进盘面，无需再叠加
  // 独立精灵——那样会看起来像散落的粒子（用户明确禁用粒子渲染）。

  return {
    group,
    spinner,
    tick: (dt: number) => {
      spinner.rotation.y += dt * spec.spin;
      core.rotation.y += dt * 0.06;
    },
    dispose: () => {
      geo.dispose();
      mat.dispose();
      tex.dispose();
      htex.dispose();
      // 以下资源原先漏释放：切换形态时行星/卫星贴图、球体几何、辉光精灵会一直累积。
      ptex.dispose();
      pmat.dispose();
      core.geometry.dispose();
      if (moonMesh) {
        moonMesh.geometry.dispose();
        mmat?.dispose();
      }
      const gm = glow.material as THREE.SpriteMaterial;
      gm.map?.dispose();
      gm.dispose();
    },
  };
}

export const IMAGE_BODY_BUILDERS: Record<ImageBodyKind, () => BodyHandle> = {
  imgalaxy: () => buildImageBody("imgalaxy"),
  imgalaxyv: () => buildImageBody("imgalaxyv"),
  imgring: () => buildImageBody("imgring"),
};

export function isImageBodyKind(id: string | null | undefined): id is ImageBodyKind {
  return id === "imgalaxy" || id === "imgring" || id === "imgalaxyv";
}

export function buildImageBodyByKind(kind: ImageBodyKind): BodyHandle {
  return IMAGE_BODY_BUILDERS[kind]();
}
