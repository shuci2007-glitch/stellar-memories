/// 力导向模拟(Worker):照片节点物理关系
/// 稳定性设计:空间网格斥力、速度阻尼、maxSpeed、动能 sleep、拖动 pin。

export interface WNode {
  id: number;
  album: number; // 相册序号(-1 无)
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  pinned: boolean;
}

export interface WEdge {
  a: number; // 节点索引
  b: number;
  strength: number;
}

interface InitMsg {
  type: "init";
  nodes: { id: number; album: number; x: number; y: number; z: number }[];
  edges: { a: number; b: number; strength: number }[];
  albumCenters: { x: number; y: number; z: number }[];
}

type InMsg =
  | InitMsg
  | { type: "wake" }
  | { type: "drag"; index: number; x: number; y: number; z: number }
  | { type: "release"; index: number }
  | { type: "stop" };

let nodes: WNode[] = [];
let edges: WEdge[] = [];
let albumCenters: { x: number; y: number; z: number }[] = [];
let sleeping = true;
let timer: ReturnType<typeof setInterval> | null = null;
let sleepCounter = 0;
let tickCount = 0;

const CELL = 26;
const DAMPING = 0.86;
const MAX_SPEED = 2.6;
const REPULSION = 420;
const SPRING = 0.028;
const ALBUM_GRAVITY = 0.012;
const FLATTEN = 0.004;

function restLength(strength: number) {
  return Math.max(24, Math.min(64, 52 / Math.sqrt(Math.max(strength, 0.08))));
}

function step() {
  if (sleeping || nodes.length === 0) return;
  const n = nodes.length;

  // --- 空间网格斥力 ---
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const p = nodes[i];
    const key = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)},${Math.floor(p.z / CELL)}`;
    const arr = grid.get(key);
    if (arr) arr.push(i);
    else grid.set(key, [i]);
  }
  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    if (a.pinned) continue;
    const cx = Math.floor(a.x / CELL);
    const cy = Math.floor(a.y / CELL);
    const cz = Math.floor(a.z / CELL);
    for (let ox = -1; ox <= 1; ox++)
      for (let oy = -1; oy <= 1; oy++)
        for (let oz = -1; oz <= 1; oz++) {
          const arr = grid.get(`${cx + ox},${cy + oy},${cz + oz}`);
          if (!arr) continue;
          for (const j of arr) {
            if (j <= i) continue;
            const b = nodes[j];
            let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
            let d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > CELL * CELL * 3) continue;
            if (d2 < 1e-4) {
              dx = (Math.random() - 0.5) * 0.5;
              dy = (Math.random() - 0.5) * 0.5;
              dz = (Math.random() - 0.5) * 0.5;
              d2 = dx * dx + dy * dy + dz * dz;
            }
            const d = Math.sqrt(d2);
            const f = REPULSION / (d2 + 60);
            const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f;
            a.vx += fx; a.vy += fy; a.vz += fz;
            if (!b.pinned) { b.vx -= fx; b.vy -= fy; b.vz -= fz; }
          }
        }
  }

  // --- 弹簧(边) ---
  for (const e of edges) {
    const a = nodes[e.a];
    const b = nodes[e.b];
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-4;
    const L = restLength(e.strength);
    const f = SPRING * (d - L) * (0.4 + e.strength * 0.6);
    const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f;
    if (!a.pinned) { a.vx += fx; a.vy += fy; a.vz += fz; }
    if (!b.pinned) { b.vx -= fx; b.vy -= fy; b.vz -= fz; }
  }

  // --- 相册引力 + 整理 ---
  let energy = 0;
  for (const p of nodes) {
    if (p.pinned) { p.vx = p.vy = p.vz = 0; continue; }
    if (p.album >= 0 && albumCenters[p.album]) {
      const c = albumCenters[p.album];
      p.vx += (c.x - p.x) * ALBUM_GRAVITY;
      p.vy += (c.y - p.y) * ALBUM_GRAVITY * 1.4;
      p.vz += (c.z - p.z) * ALBUM_GRAVITY;
    }
    p.vy -= p.y * FLATTEN; // 轻微压平,贴合星盘
    p.vx *= DAMPING; p.vy *= DAMPING; p.vz *= DAMPING;
    const sp = Math.sqrt(p.vx ** 2 + p.vy ** 2 + p.vz ** 2);
    if (sp > MAX_SPEED) {
      const k = MAX_SPEED / sp;
      p.vx *= k; p.vy *= k; p.vz *= k;
    }
    p.x += p.vx; p.y += p.vy; p.z += p.vz;
    energy += p.vx * p.vx + p.vy * p.vy + p.vz * p.vz;
  }

  // --- 休眠检测 ---
  if (energy / n < 0.0015) {
    if (++sleepCounter > 50) {
      sleeping = true;
      if (timer) { clearInterval(timer); timer = null; }
      (self as unknown as Worker).postMessage({ type: "sleep" });
      // 最后发一次精确位置
      sendPositions(true);
      return;
    }
  } else {
    sleepCounter = 0;
  }

  tickCount++;
  if (tickCount % 2 === 0) sendPositions(false);
}

let outBuf: Float32Array = new Float32Array(0);
function sendPositions(final: boolean) {
  if (outBuf.length !== nodes.length * 3) outBuf = new Float32Array(nodes.length * 3);
  for (let i = 0; i < nodes.length; i++) {
    outBuf[i * 3] = nodes[i].x;
    outBuf[i * 3 + 1] = nodes[i].y;
    outBuf[i * 3 + 2] = nodes[i].z;
  }
  const copy = outBuf.slice();
  (self as unknown as Worker).postMessage(
    { type: "tick", buf: copy.buffer, final },
    [copy.buffer],
  );
}

function wake() {
  if (sleeping) {
    sleeping = false;
    sleepCounter = 0;
    if (!timer) timer = setInterval(step, 50); // 20Hz
  }
}

self.onmessage = (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    nodes = msg.nodes.map((p) => ({ ...p, vx: 0, vy: 0, vz: 0, pinned: false }));
    edges = msg.edges.map((e) => ({ ...e }));
    albumCenters = msg.albumCenters;
    sleeping = false;
    sleepCounter = 0;
    tickCount = 0;
    if (timer) clearInterval(timer);
    timer = setInterval(step, 50);
  } else if (msg.type === "wake") {
    wake();
  } else if (msg.type === "drag") {
    const p = nodes[msg.index];
    if (p) {
      p.x = msg.x; p.y = msg.y; p.z = msg.z;
      p.vx = p.vy = p.vz = 0;
      p.pinned = true;
      wake();
    }
  } else if (msg.type === "release") {
    const p = nodes[msg.index];
    if (p) p.pinned = false;
  } else if (msg.type === "stop") {
    if (timer) { clearInterval(timer); timer = null; }
    sleeping = true;
  }
};
