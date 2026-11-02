/**
 * 页面形态(图形)注册表。
 *
 * 每个「页面」除了自己的照片集合,还带一个图形:它决定照片在宇宙里排成什么样子。
 * 要加新图形,只需要在 SHAPES 里加一条:layout 返回第 i / total 个点的三维坐标,
 * 场景会自动把照片按这个形状铺开。用户选定具体图形后,替换这里的占位实现即可。
 *
 * 莫比乌斯环 / 流动绸带已按计划移除(用户将另行实现),本文件不再注册这两个图形。
 */

import {
  GALAXY_ARMS,
  GALAXY_INNER,
  GALAXY_OUTER,
  GALAXY_R0,
  GALAXY_SWIRL,
  GALAXY_TILT,
  HALO_BANDS,
  HALO_TILT,
  KNOT_CURVES,
  knotPoint,
} from "./bodyMath";

export interface ShapePoint {
  x: number;
  y: number;
  z: number;
}

export interface SpaceShape {
  id: string;
  name: string;
  hint: string;
  /** 相机距离系数:形状越大,镜头退得越远 */
  cameraScale: number;
  layout: (i: number, total: number) => ShapePoint;
}

/** 稳定的伪随机,保证每次进入同一个页面时布局不变 */
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};


export const SHAPES: SpaceShape[] = [
  {
    id: "spiral",
    name: "旋臂星系",
    hint: "三条旋臂向外展开,照片沿臂分布",
    cameraScale: 1,
    layout: (i, total) => {
      const t = total <= 1 ? 0 : i / (total - 1);
      const arm = i % 3;
      const angle = t * Math.PI * 5.2 + (arm * Math.PI * 2) / 3;
      const r = 10 + t * 74;
      return {
        x: Math.cos(angle) * r + (hash(i) - 0.5) * 5,
        y: (hash(i * 1.7) - 0.5) * (9 - t * 4),
        z: Math.sin(angle) * r + (hash(i * 2.3) - 0.5) * 5,
      };
    },
  },
  {
    id: "sphere",
    name: "球状星云",
    hint: "蓝色球状光点，像贾维斯手里的全息地球仪",
    cameraScale: 1.2,
    layout: (i, total) => {
      const n = Math.max(1, total);
      const k = i + 0.5;
      const phi = Math.acos(1 - (2 * k) / n);
      const theta = Math.PI * (1 + Math.sqrt(5)) * k;
      const r = 72 + (hash(i) - 0.5) * 10;
      return {
        x: r * Math.sin(phi) * Math.cos(theta),
        y: r * Math.cos(phi),
        z: r * Math.sin(phi) * Math.sin(theta),
      };
    },
  },
  {
    id: "ring",
    name: "环状",
    hint: "一圈环带,适合年度或主题回顾",
    cameraScale: 1.05,
    layout: (i, total) => {
      const u = (i / Math.max(1, total)) * Math.PI * 2;
      const v = (i * 2.399963) % (Math.PI * 2);
      const R = 66;
      const r = 14;
      return {
        x: (R + r * Math.cos(v)) * Math.cos(u),
        y: r * Math.sin(v) + (hash(i) - 0.5) * 3,
        z: (R + r * Math.cos(v)) * Math.sin(u),
      };
    },
  },
  {
    id: "saturn",
    name: "环带行星",
    hint: "球体 + 三层粒子环，照片沿环铺开（有行星时才完整）",
    cameraScale: 1.15,
    layout: (i, _total) => {
      const bands: [number, number][] = [
        [50, 62],
        [66, 92],
        [96, 116],
      ];
      const band = bands[i % bands.length];
      const r = band[0] + (band[1] - band[0]) * hash(i * 3.3);
      const a = i * 2.399963 + hash(i) * 0.04;
      const tilt = 0.28;
      return {
        x: Math.cos(a) * r,
        y: Math.sin(a) * r * tilt,
        z: Math.sin(a) * r,
      };
    },
  },
  {
    id: "golden",
    name: "金色光环",
    hint: "一圈细亮光环 + 中心小行星，照片落在环上",
    cameraScale: 1.15,
    layout: (i, _total) => {
      const a = i * 2.399963;
      const r = 104 + (hash(i * 5.1) - 0.5) * 5;
      const tilt = 0.32;
      return {
        x: Math.cos(a) * r,
        y: Math.sin(a) * r * tilt,
        z: Math.sin(a) * r,
      };
    },
  },
  {
    id: "nebula",
    name: "粒子星云",
    hint: "两条旋臂，照片与星尘混在一起（最吃显卡）",
    cameraScale: 1.2,
    layout: (i, total) => {
      const arm = i % 2;
      const t = total <= 1 ? 0 : i / (total - 1);
      const a = arm * Math.PI + t * 2.7 + (hash(i) - 0.5) * 0.3;
      const r = 55 + t * 75 + (hash(i * 2.7) - 0.5) * 10;
      return {
        x: Math.cos(a) * r,
        y: (hash(i * 4.1) - 0.5) * (10 + 22 * t),
        z: Math.sin(a) * r,
      };
    },
  },
  // ---------------------------------------------------------------- 以下三种
  // 来自用户提供的三段参考视频，主视觉全部是实体网格（零粒子），
  // 照片布局与 three/VideoBodies.ts 的几何共用 core/bodyMath.ts 的常数。
  {
    id: "knot",
    name: "光带结",
    hint: "九条发光绸带缠绕成结，照片沿光带分布（纯网格，无粒子）",
    cameraScale: 1.12,
    layout: (i, total) => {
      const k = i % KNOT_CURVES.length;
      const t = ((i / Math.max(1, total)) * Math.PI * 2 + k * 0.41) % (Math.PI * 2);
      const p = knotPoint(k, t);
      // 沿「从圆心向外」的方向推出约 5 个单位，让照片贴在光管外壁而不是埋进管心
      const len = Math.hypot(p.x, p.y, p.z) || 1;
      const push = 1 + 5 / len;
      return {
        x: p.x * push + (hash(i) - 0.5) * 2.4,
        y: p.y * push + (hash(i * 1.9) - 0.5) * 2.4,
        z: p.z * push + (hash(i * 3.1) - 0.5) * 2.4,
      };
    },
  },
  {
    id: "halo",
    name: "同心光环",
    hint: "几十层细环叠成盘面，中心一颗小行星，照片落在亮环上（纯网格）",
    cameraScale: 1.15,
    layout: (i) => {
      const r = HALO_BANDS[i % HALO_BANDS.length] + (hash(i * 5.3) - 0.5) * 3.2;
      const a = i * 2.399963 + hash(i) * 0.05;
      return {
        x: Math.cos(a) * r,
        y: Math.sin(a) * r * HALO_TILT,
        z: Math.sin(a) * r,
      };
    },
  },
  {
    id: "galaxy",
    name: "螺旋星盘",
    hint: "厚盘 + 三条对数旋臂，中心蓝色行星，照片沿旋臂铺开（纯网格）",
    cameraScale: 1.3,
    layout: (i, total) => {
      const arm = i % GALAXY_ARMS;
      const t = total <= 1 ? 0 : i / (total - 1);
      const r = GALAXY_INNER + 10 + t * (GALAXY_OUTER - GALAXY_INNER - 28);
      const a = (arm * Math.PI * 2) / GALAXY_ARMS + GALAXY_SWIRL * Math.log(r / GALAXY_R0);
      return {
        x: Math.cos(a) * r,
        y: Math.sin(a) * r * GALAXY_TILT + (hash(i * 2.7) - 0.5) * 5,
        z: Math.sin(a) * r,
      };
    },
  },
  // ---------------------------------------------------------------- 以下两种
  // 由用户提供的正面 2D 图反推：椭圆拟合出倾角，图像反投影成俯视贴图，
  // 贴到带厚度的 3D 盘体上，行星按反推位置用真实球体还原（见 three/ImageBodies.ts）。
  {
    id: "imgalaxy",
    name: "星盘·图反推",
    hint: "参考图反推的 3D 星盘（含蚀日行星），照片沿盘面散布",
    cameraScale: 1.3,
    layout: (i, total) => {
      const t = total <= 1 ? 0 : i / (total - 1);
      const a = i * 2.399963;
      const r = 170 * (0.30 + 0.65 * t);
      return {
        x: Math.cos(a) * r,
        y: Math.sin(a) * r * 0.06 + (hash(i * 2.7) - 0.5) * 4,
        z: Math.sin(a) * r,
      };
    },
  },
  {
    id: "imgalaxyv",
    name: "星盘·视频帧反推",
    hint: "由参考视频帧反推的 3D 星盘（鲜艳蓝行星 + 卫星），照片沿盘面散布",
    cameraScale: 1.3,
    layout: (i, total) => {
      const t = total <= 1 ? 0 : i / (total - 1);
      const a = i * 2.399963;
      const r = 170 * (0.30 + 0.65 * t);
      return {
        x: Math.cos(a) * r,
        y: Math.sin(a) * r * 0.06 + (hash(i * 2.7) - 0.5) * 4,
        z: Math.sin(a) * r,
      };
    },
  },
  {
    id: "imgring",
    name: "光环·图反推",
    hint: "参考图反推的 3D 光环（含新月行星），照片落在光环带上",
    cameraScale: 1.15,
    layout: (i) => {
      const a = i * 2.399963;
      const r = 130 * 0.72 + (hash(i * 5.3) - 0.5) * 6;
      return {
        x: Math.cos(a) * r,
        y: Math.sin(a) * r * 0.05,
        z: Math.sin(a) * r,
      };
    },
  },
];

export const DEFAULT_SHAPE = SHAPES[0].id;

/**
 * 已按计划移除的图形(mobius / ribbon)。历史数据库里仍可能存着这些 shape 的旧页面,
 * 这里显式映射到现有图形,避免 `shapeOf` 静默回退到 spiral 造成"图形错位"。
 */
const LEGACY_SHAPE_FALLBACK: Record<string, string> = {
  mobius: "spiral",
  ribbon: "spiral",
};

export function shapeOf(id: string | null | undefined): SpaceShape {
  const resolved = id ? (LEGACY_SHAPE_FALLBACK[id] ?? id) : undefined;
  return SHAPES.find((s) => s.id === resolved) ?? SHAPES[0];
}

export interface Space {
  id: number;
  name: string;
  shape: string;
  /** shared = 所有照片都在这一页;own = 只有放进来的照片 */
  scope: "shared" | "own" | string;
  backgroundPhotoId: number | null;
  /** 存在感 0-100 */
  backgroundStrength: number;
  sortOrder: number;
  photoCount: number;
}
