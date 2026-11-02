/**
 * 页面形态(图形)注册表。
 *
 * 每个「页面」除了自己的照片集合,还带一个图形:它决定照片在宇宙里排成什么样子。
 * 要加新图形,只需要在 SHAPES 里加一条:layout 返回第 i / total 个点的三维坐标,
 * 场景会自动把照片按这个形状铺开。
 *
 * 当前只保留 6 种形态：旋臂星系 / 球状星云 / 环状 / 环带行星 / 金色光环 / 粒子星云。
 * 光带结、同心光环、螺旋星盘、三种图反推形态已从切换器中移除（代码保留，便于日后恢复）。
 */

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
];

export const DEFAULT_SHAPE = SHAPES[0].id;

/**
 * 已移除图形的兼容映射。历史数据库里的旧页面仍然存在，直接回退到第一个图形会让你
 * 以为"点错了"，这里按形态语义映射到最接近的保留形态。
 */
const LEGACY_SHAPE_FALLBACK: Record<string, string> = {
  mobius: "spiral",
  ribbon: "spiral",
  knot: "spiral",
  halo: "ring",
  galaxy: "spiral",
  imgalaxy: "spiral",
  imgalaxyv: "spiral",
  imgring: "ring",
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
