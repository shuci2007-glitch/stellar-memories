/**
 * 地球交接的屏幕尺寸匹配。
 * maplibre 球体投影(v6 VerticalPerspectiveTransform)是标准针孔模型:
 *   globeRadiusPx = worldSize / (2π) / cos(lat),worldSize = 512·2^zoom
 *   cameraToCenterDistance = (H/2)/tan(fov/2)(像素),globe 圆心距相机 = C + globeRadiusPx
 *   screenRadius = (H/2)/tan(fov/2) · tan(asin(R/(C+R)))
 * 由此在 three.js 飞行地球与 maplibre 之间互相解出 zoom/距离,交接时不跳尺寸。
 */

export const MAPLIBRE_FOV_DEG = 36.87;
const TILE = 512;

const pxPerTan = (viewportH: number) => viewportH / 2 / Math.tan((MAPLIBRE_FOV_DEG * Math.PI) / 360);
const cameraToCenter = (viewportH: number) => pxPerTan(viewportH);

/** 已知 maplibre zoom → 球体屏幕半径(px) */
export function maplibreRadiusForZoom(zoom: number, viewportH: number, lat: number): number {
  const worldSize = TILE * Math.pow(2, zoom);
  const r = worldSize / (2 * Math.PI) / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const c = cameraToCenter(viewportH);
  const ratio = r / (c + r);
  return pxPerTan(viewportH) * Math.tan(Math.asin(Math.min(0.999, ratio)));
}

/** 已知目标屏幕半径(px) → maplibre zoom(二分,单调) */
export function maplibreZoomForRadius(screenRadius: number, viewportH: number, lat: number): number {
  let lo = -1, hi = 14;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (maplibreRadiusForZoom(mid, viewportH, lat) < screenRadius) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
