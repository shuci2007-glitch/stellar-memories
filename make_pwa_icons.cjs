// 生成 PWA 图标（纯 Node，无依赖）
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

let crcTable = null;
function makeCrcTable() {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}
function crc32(buf) {
  if (!crcTable) crcTable = makeCrcTable();
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, c]);
}
function encodePng(size, pixelFn) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const px = pixelFn(x, y);
      const o = row + 1 + x * 4;
      raw[o] = px[0];
      raw[o + 1] = px[1];
      raw[o + 2] = px[2];
      raw[o + 3] = px[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const smooth = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};
function hash(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// 星点（固定位置，避免每次生成不同）
const STARS = Array.from({ length: 46 }, (_, i) => ({
  x: hash(i * 3 + 1) * 2 - 1,
  y: hash(i * 3 + 2) * 2 - 1,
  r: 0.008 + hash(i * 3 + 3) * 0.014,
  a: 0.35 + hash(i * 7) * 0.65,
}));

function draw(size) {
  return (px, py) => {
    const nx = ((px + 0.5) / size) * 2 - 1;
    const ny = ((py + 0.5) / size) * 2 - 1;
    const d = Math.hypot(nx, ny);

    // 背景：深空径向渐变
    let col = mix([5, 6, 14], [24, 30, 66], clamp(1 - d * 0.95, 0, 1) ** 1.4);

    // 星点
    for (const s of STARS) {
      const dd = Math.hypot(nx - s.x, ny - s.y);
      if (dd < s.r) {
        const t = (1 - dd / s.r) * s.a;
        col = mix(col, [235, 245, 255], t * 0.9);
      }
    }

    // 星环（椭圆，倾斜），先画，球体覆盖前部
    const ang = -0.42;
    const rxx = nx * Math.cos(ang) - ny * Math.sin(ang);
    const ryy = nx * Math.sin(ang) + ny * Math.cos(ang);
    const er = Math.hypot(rxx / 0.80, ryy / 0.235);
    const ringBand = smooth(1.10, 1.02, er) * smooth(0.86, 0.94, er);
    if (ringBand > 0.001) {
      const glow = 0.55 + 0.45 * (1 - Math.abs(er - 1) / 0.12);
      const ringCol = mix([120, 200, 255], [200, 170, 255], clamp((nx + 1) / 2, 0, 1));
      col = mix(col, ringCol, clamp(ringBand * glow * 0.95, 0, 1));
    }

    // 星球
    const sr = 0.435;
    const dx = nx;
    const dy = ny + 0.02;
    const dist = Math.hypot(dx, dy);
    if (dist < sr + 0.02) {
      const inside = smooth(sr, sr - 0.015, dist);
      const z = Math.sqrt(Math.max(0, sr * sr - dist * dist));
      const n3 = [dx / sr, dy / sr, z / sr];
      // 光照来自左上
      const L = [-0.48, -0.62, 0.62];
      const lam = clamp(n3[0] * L[0] + n3[1] * L[1] + n3[2] * L[2], 0, 1);
      let base = mix([26, 40, 96], [126, 226, 255], lam ** 0.85);
      // 右下补一点紫
      base = mix(base, [122, 96, 240], clamp((nx * 0.5 + ny * 0.5) * 0.85, 0, 1) * 0.55);
      // 边缘辉光
      const rim = smooth(sr * 0.72, sr, dist) * 0.55;
      base = mix(base, [150, 235, 255], rim * 0.6);
      col = mix(col, base, inside);
    }

    // 球体外的柔和光晕
    if (dist > sr && dist < sr + 0.20) {
      const halo = (1 - (dist - sr) / 0.20) ** 2.4 * 0.30;
      col = mix(col, [110, 200, 255], halo);
    }

    return [Math.round(clamp(col[0], 0, 255)), Math.round(clamp(col[1], 0, 255)), Math.round(clamp(col[2], 0, 255)), 255];
  };
}

const outDir = process.argv[2];
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512, 180]) {
  const buf = encodePng(size, draw(size));
  const name = size === 180 ? "apple-touch-icon.png" : `icon-${size}.png`;
  fs.writeFileSync(path.join(outDir, name), buf);
  console.log(`${name}  ${size}x${size}  ${buf.length} bytes`);
}
