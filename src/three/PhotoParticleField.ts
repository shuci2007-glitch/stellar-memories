import type { QualityTier } from "../core/types";

export interface PhotoParticleFieldData {
  count: number;
  width: number;
  height: number;
  plane: Float32Array;
  sphere: Float32Array;
  color: Float32Array;
  seeds: Float32Array;
  sizes: Float32Array;
  brightness: Float32Array;
  starts: Float32Array;
  scatterDirs: Float32Array;
  reactivity: Float32Array;
  centerWeights: Float32Array;
}

export const V14_PLANE_WIDTH = 4.42;
export const V14_MAX_WIDTH = 350;
const QUALITY_STEP: Record<QualityTier, number> = { low: 4, medium: 2, high: 2, ultra: 1 };

function hash2(x: number, y: number) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function rgba(raw: Uint8ClampedArray, width: number, height: number, x: number, y: number) {
  const px = Math.max(0, Math.min(width - 1, x | 0));
  const py = Math.max(0, Math.min(height - 1, y | 0));
  const i = (py * width + px) * 4;
  return [raw[i] / 255, raw[i + 1] / 255, raw[i + 2] / 255, raw[i + 3] / 255] as const;
}

function edgeAt(raw: Uint8ClampedArray, width: number, height: number, x: number, y: number) {
  const lum = (px: number, py: number) => {
    const [r, g, b] = rgba(raw, width, height, px, py);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const gx = -lum(x - 1, y - 1) - 2 * lum(x - 1, y) - lum(x - 1, y + 1) + lum(x + 1, y - 1) + 2 * lum(x + 1, y) + lum(x + 1, y + 1);
  const gy = -lum(x - 1, y - 1) - 2 * lum(x, y - 1) - lum(x + 1, y - 1) + lum(x - 1, y + 1) + 2 * lum(x, y + 1) + lum(x + 1, y + 1);
  return Math.min(1, Math.hypot(gx, gy) * 1.45);
}

export function v14DepthGuess(r: number, g: number, b: number, nx: number, ny: number, edge: number) {
  const sky = Math.max(0, b - (r + g) * 0.52) * (0.78 + 0.22 * (1 - ny));
  const warm = Math.max(0, r - b * 0.72) * (0.42 + Math.max(r, g, b) - Math.min(r, g, b));
  const dark = 1 - (r + g + b) / 3;
  const nearBottom = Math.pow(Math.max(0, (ny - 0.64) / 0.36), 1.45) * dark;
  const side = Math.max(0, Math.abs(nx - 0.5) - 0.38) * 4.1 * dark;
  return -sky * 0.82 + warm * 0.24 + nearBottom * 0.7 + side * 0.22 + edge * 0.12;
}

export function sampleV14Pixels(raw: Uint8ClampedArray, width: number, height: number, step = 2): PhotoParticleFieldData {
  const planeHeight = V14_PLANE_WIDTH * (height / width);
  const plane: number[] = [], sphere: number[] = [], color: number[] = [], seeds: number[] = [];
  const sizes: number[] = [], brightness: number[] = [], starts: number[] = [], scatterDirs: number[] = [], reactivity: number[] = [], centerWeights: number[] = [];
  for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) {
    const nx = x / Math.max(1, width - 1), ny = y / Math.max(1, height - 1);
    const rr = 0.055, ax = Math.abs(nx - 0.5), ay = Math.abs(ny - 0.5), hx = 0.5 - rr, hy = 0.5 - rr;
    if (Math.hypot(Math.max(ax - hx, 0), Math.max(ay - hy, 0)) > rr) continue;
    const [r, g, b, a] = rgba(raw, width, height, x, y);
    if (a < 0.05) continue;
    const edge = edgeAt(raw, width, height, x, y);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const saturation = Math.max(r, g, b) - Math.min(r, g, b);
    plane.push((nx - 0.5) * V14_PLANE_WIDTH, (0.5 - ny) * planeHeight, v14DepthGuess(r, g, b, nx, ny, edge));
    sphere.push(0, 0, 0);
    color.push(Math.min(1, r * 1.05), Math.min(1, g * 1.05), Math.min(1, b * 1.05));
    const s0 = hash2(x, y), s1 = hash2(x + 17.3, y + 9.1), s2 = hash2(x + 41.7, y + 23.9), s3 = hash2(x + 71.1, y + 61.2);
    seeds.push(s0, s1, s2, s3);
    sizes.push(0.68 + lum * 0.9 + edge * 0.48 + saturation * 0.2 + s2 * 0.08);
    brightness.push(0.62 + lum * 0.62 + edge * 0.14 + saturation * 0.08);
    const border = Math.min(nx, 1 - nx, ny, 1 - ny) * 2, edgeFirst = 1 - Math.max(0, Math.min(1, border));
    starts.push(0.03 + (1 - edgeFirst) * 0.44 + s0 * 0.12);
    const theta = s2 * Math.PI * 2, phi = Math.acos(2 * s3 - 1), radius = 0.7 + s0 * 0.8;
    scatterDirs.push(radius * Math.sin(phi) * Math.cos(theta), radius * Math.cos(phi), radius * Math.sin(phi) * Math.sin(theta));
    reactivity.push(Math.pow(s2, 1.08));
    centerWeights.push(1 - Math.min(1, Math.hypot((nx - 0.5) * 2, (ny - 0.5) * 2)) * 0.34);
  }
  return {
    count: plane.length / 3, width, height,
    plane: new Float32Array(plane), sphere: new Float32Array(sphere), color: new Float32Array(color), seeds: new Float32Array(seeds),
    sizes: new Float32Array(sizes), brightness: new Float32Array(brightness), starts: new Float32Array(starts), scatterDirs: new Float32Array(scatterDirs),
    reactivity: new Float32Array(reactivity), centerWeights: new Float32Array(centerWeights),
  };
}

export function wrapV14FieldToSphere(field: PhotoParticleFieldData, radius: number, centerLon = Math.PI / 2, centerLat = 0, angularWidth = Math.PI * 2, angularHeight = Math.PI) {
  const planeHeight = V14_PLANE_WIDTH * field.height / field.width;
  for (let i = 0; i < field.count; i++) {
    const u = field.plane[i * 3] / V14_PLANE_WIDTH;
    const v = field.plane[i * 3 + 1] / planeHeight;
    const lon = centerLon + u * angularWidth;
    // 完整照片球用等面积纬度，避免极区挤成亮点，并保证任何视角都是完整圆形轮廓。
    const lat = angularHeight >= Math.PI * .99
      ? centerLat + Math.asin(Math.max(-1, Math.min(1, v * 2)))
      : centerLat + v * angularHeight;
    const c = Math.cos(lat);
    field.sphere[i * 3] = radius * c * Math.cos(lon);
    field.sphere[i * 3 + 1] = radius * Math.sin(lat);
    field.sphere[i * 3 + 2] = radius * c * Math.sin(lon);
  }
  return field;
}

export async function samplePhotoV14(url: string, tier: QualityTier = "medium", signal?: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`照片读取失败 (${response.status})`);
  const bitmap = await createImageBitmap(await response.blob(), { imageOrientation: "from-image" });
  try {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const scale = Math.min(1, V14_MAX_WIDTH / bitmap.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(2, Math.round(bitmap.width * scale));
    canvas.height = Math.max(2, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return sampleV14Pixels(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, QUALITY_STEP[tier]);
  } finally { bitmap.close(); }
}
