/**
 * 离线预览图形布局:把某个图形的照片点阵投影成 2D 图,输出 PNG。
 *
 * 为什么需要它:本机跑不了 three.js / WebGL 截图,但图形的参数方程是纯数学,
 * 可以直接算出点坐标投影成图,一眼就能看出形状对不对(莫比乌斯有没有拧对、
 * 绸带有没有绕成结),比等 WebGL 快得多。
 *
 * 用法:
 *   npx esbuild src/core/spaces.ts --bundle --format=esm --outfile=scripts/.tmp-spaces.mjs
 *   node scripts/render-shapes.mjs [形状id...]
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHAPES } from "./.tmp-spaces.mjs";

const W = 960;
const H = 640;
const N = 5000;

const wanted = process.argv.slice(2);
const shapes = (wanted.length ? wanted : ["mobius", "ribbon"]).filter((id) =>
  SHAPES.some((s) => s.id === id),
);
if (!shapes.length) {
  console.error("没有可渲染的形状。可用:", SHAPES.map((s) => s.id).join(", "));
  process.exit(1);
}

const PW = W / shapes.length;
const img = new Uint8Array(W * H * 3).fill(10);

function put(px, py, r, g, b) {
  const x = Math.round(px);
  const y = Math.round(py);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const o = (y * W + x) * 3;
  img[o] = Math.min(255, img[o] + r);
  img[o + 1] = Math.min(255, img[o + 1] + g);
  img[o + 2] = Math.min(255, img[o + 2] + b);
}

shapes.forEach((id, idx) => {
  const shape = SHAPES.find((s) => s.id === id);
  const ox = idx * PW;
  // 三个投影:俯视(XZ)、正视(XY)、斜视(绕 Y 转 35° 再压扁)
  const cosA = Math.cos((35 * Math.PI) / 180);
  const sinA = Math.sin((35 * Math.PI) / 180);
  const views = [
    { cx: ox + PW * 0.2, cy: H * 0.5, map: (p) => [p.x, p.z] },
    { cx: ox + PW * 0.5, cy: H * 0.5, map: (p) => [p.x, p.y] },
    {
      cx: ox + PW * 0.8,
      cy: H * 0.5,
      map: (p) => [p.x * cosA - p.z * sinA, p.y * 0.72 + (p.x * sinA + p.z * cosA) * 0.5],
    },
  ];
  for (let i = 0; i < N; i++) {
    const p = shape.layout(i, N);
    for (const v of views) {
      const [a, b] = v.map(p);
      const px = v.cx + a * 0.85;
      const py = v.cy - b * 0.85;
      put(px, py, 60, 120, 200);
      put(px + 1, py, 30, 60, 100);
      put(px, py + 1, 30, 60, 100);
    }
  }
});

const ppm = Buffer.concat([
  Buffer.from(`P6\n${W} ${H}\n255\n`),
  Buffer.from(img),
]);
const out = join(tmpdir(), `shapes-${shapes.join("-")}.ppm`);
writeFileSync(out, ppm);
console.log(out);
