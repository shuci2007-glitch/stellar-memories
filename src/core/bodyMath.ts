/**
 * 三种视频图案的共享几何参数（纯数学，不依赖 three）。
 *
 * 数值来自对参考视频帧的像素级测量（径向剖面 + 分扇区峰值检测）：
 *   v1 光带：主体 479×384，亮脊宽度中位 5px、90 分位 18px
 *   v2 光环：每扇区中位 19 条环带，占空比 0.571，色阶 #fff8e3 → #d3c1ab
 *   v3 星盘：中位 7 条主带，占空比 0.360，色阶 #b9e9f3 → #6091b9
 *
 * core/spaces.ts 的照片布局与 three/VideoBodies.ts 的网格几何都读这里的常数，
 * 两边必须严丝合缝：照片要正好落在绸带上、环上、旋臂上，而不是飘在旁边。
 */

export interface P3 {
  x: number;
  y: number;
  z: number;
}

// ---------------------------------------------------------------- 光带结

export interface KnotCurve {
  /** 三个方向的频率，必须都是整数，曲线才能在 2π 内首尾闭合 */
  a: number;
  b: number;
  c: number;
  px: number;
  py: number;
  pz: number;
  ax: number;
  ay: number;
  az: number;
  /** 绸带宽度（实测约为结半径的 16%–22%） */
  width: number;
  /** 沿整条曲线的扭转圈数 */
  twist: number;
}

/**
 * 九条闭合 Lissajous 曲线。频率组合刻意错开（2,3,1 / 3,2,2 / 1,2,3 …），
 * 缠绕起来才不会重合成一个规整的环，而是视频里那种「球状乱结」。
 */
export const KNOT_CURVES: KnotCurve[] = [
  { a: 2, b: 3, c: 1, px: 0.00, py: 1.10, pz: 2.40, ax: 50, ay: 46, az: 52, width: 17, twist: 1.1 },
  { a: 3, b: 2, c: 2, px: 0.70, py: 2.30, pz: 0.40, ax: 48, ay: 52, az: 44, width: 14, twist: 1.5 },
  { a: 1, b: 2, c: 3, px: 1.90, py: 0.35, pz: 1.75, ax: 52, ay: 44, az: 48, width: 18, twist: 0.9 },
  { a: 2, b: 1, c: 3, px: 2.60, py: 1.60, pz: 0.90, ax: 45, ay: 50, az: 50, width: 13, twist: 1.7 },
  { a: 3, b: 1, c: 2, px: 0.30, py: 2.80, pz: 1.35, ax: 50, ay: 47, az: 46, width: 16, twist: 1.3 },
  { a: 1, b: 3, c: 2, px: 1.20, py: 0.80, pz: 2.90, ax: 47, ay: 51, az: 45, width: 15, twist: 1.4 },
  { a: 2, b: 2, c: 3, px: 2.10, py: 1.95, pz: 0.20, ax: 52, ay: 45, az: 50, width: 19, twist: 1.0 },
  { a: 3, b: 3, c: 1, px: 0.95, py: 0.50, pz: 1.10, ax: 46, ay: 49, az: 51, width: 15, twist: 1.6 },
  { a: 2, b: 3, c: 3, px: 1.55, py: 2.55, pz: 0.65, ax: 51, ay: 48, az: 47, width: 16, twist: 1.2 },
];

export function knotPoint(k: number, t: number): P3 {
  const c = KNOT_CURVES[k % KNOT_CURVES.length];
  return {
    x: c.ax * Math.sin(c.a * t + c.px),
    y: c.ay * Math.sin(c.b * t + c.py),
    z: c.az * Math.sin(c.c * t + c.pz),
  };
}

// ---------------------------------------------------------------- 同心光环

/**
 * 环面倾角 sin 值。应用初始相机仰角约 34°，倾角取近零时盘面正好以 34° 呈现，
 * 接近实测的 33°；此前取 0.34，负数倾角与相机仰角相互抵消，盘面被压成一条线。
 */
export const HALO_TILT = 0.05;
/** 环带条数（实测每扇区中位 19） */
export const HALO_RINGS = 19;
export const HALO_INNER = 28;
export const HALO_OUTER = 122;
/** 单条环带的宽度 / 环间距（实测占空比 0.571） */
export const HALO_DUTY = 0.571;
/** 中心小行星半径 */
export const HALO_CORE = 16;

export function haloRingRadius(i: number): number {
  const spacing = (HALO_OUTER - HALO_INNER) / (HALO_RINGS - 1);
  return HALO_INNER + spacing * i;
}

/** 环带半宽 */
export const HALO_RING_HALF =
  ((HALO_OUTER - HALO_INNER) / (HALO_RINGS - 1)) * HALO_DUTY * 0.5;

/** 四条承载照片的主环（按环带序号均匀取） */
export const HALO_BANDS = [3, 8, 13, 17].map((i) => haloRingRadius(i));

// ---------------------------------------------------------------- 螺旋星盘

export const GALAXY_TILT = 0.06;
export const GALAXY_INNER = 38;
export const GALAXY_OUTER = 176;
export const GALAXY_ARMS = 3;
/** 对数螺旋缠绕系数：θ = θ0 + SWIRL · ln(r / R0) */
export const GALAXY_SWIRL = 1.6;
export const GALAXY_R0 = 45;
export const GALAXY_CORE = 26;
/** 盘面最大半厚度 */
export const GALAXY_MAX_H = 20;
/** 同心亮带的空间频率：整个盘面约 9 条（实测中位 7，留一点余量） */
export const GALAXY_BAND_K = 0.41;
/** 亮带锐度：指数越大带越窄（实测占空比 0.36） */
export const GALAXY_BAND_POW = 2.6;

/**
 * 旋臂相位。着色器里用它算亮带，照片布局用它算角度：
 *   phase = ARMS · θ - ARMS · SWIRL · ln(r / R0)
 * 照片按 θ = θ0 + SWIRL · ln(r / R0) 摆放，代进去正好是常数 → 永远落在亮带上。
 */
export function galaxyPhase(r: number, angle: number): number {
  return GALAXY_ARMS * (angle - GALAXY_SWIRL * Math.log(Math.max(r, 1e-3) / GALAXY_R0));
}
