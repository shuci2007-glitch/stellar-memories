/**
 * 图形布局自检:验证每股丝带是否连续、闭合,以及整体尺寸是否合理。
 *
 * 用法:
 *   npx esbuild src/core/spaces.ts --bundle --format=esm --outfile=scripts/.tmp-spaces.mjs
 *   node scripts/check-shapes.mjs
 */
import { SHAPES } from "./.tmp-spaces.mjs";

const N = 4000;
/** 与 spaces.ts 里各图形的股数保持一致 */
const STRANDS = { mobius: 18, ribbon: 16 };

for (const id of Object.keys(STRANDS)) {
  const shape = SHAPES.find((x) => x.id === id);
  if (!shape) {
    console.log(`${id}: 图形不存在`);
    continue;
  }
  const K = STRANDS[id];
  const per = Math.ceil(N / K);
  let worstStep = 0;
  let worstClose = 0;
  for (let k = 0; k < K; k++) {
    const pts = [];
    for (let m = 0; m < per; m++) {
      const i = k + m * K;
      if (i >= N) break;
      pts.push(shape.layout(i, N));
    }
    for (let j = 1; j < pts.length; j++) {
      const d = Math.hypot(
        pts[j].x - pts[j - 1].x,
        pts[j].y - pts[j - 1].y,
        pts[j].z - pts[j - 1].z,
      );
      if (d > worstStep) worstStep = d;
    }
    const a = pts[0];
    const b = pts[pts.length - 1];
    const c = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    if (c > worstClose) worstClose = c;
  }
  const mn = { x: 1e9, y: 1e9, z: 1e9 };
  const mx = { x: -1e9, y: -1e9, z: -1e9 };
  for (let i = 0; i < N; i++) {
    const p = shape.layout(i, N);
    mn.x = Math.min(mn.x, p.x);
    mn.y = Math.min(mn.y, p.y);
    mn.z = Math.min(mn.z, p.z);
    mx.x = Math.max(mx.x, p.x);
    mx.y = Math.max(mx.y, p.y);
    mx.z = Math.max(mx.z, p.z);
  }
  console.log(
    `${id}: 股内最大相邻间距=${worstStep.toFixed(2)}  首尾最大不闭合=${worstClose.toFixed(2)}`,
  );
  console.log(
    `   包围盒 x[${mn.x.toFixed(0)},${mx.x.toFixed(0)}] y[${mn.y.toFixed(0)},${mx.y.toFixed(0)}] z[${mn.z.toFixed(0)},${mx.z.toFixed(0)}]`,
  );
}
