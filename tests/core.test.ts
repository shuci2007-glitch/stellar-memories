import { describe, expect, it } from "vitest";
import { parseSpc } from "../src/three/ParticlePhoto";
import { tmParticles, tmPhoto, tmThumb, tmPreview } from "../src/core/types";

/** 构造一个最小合法 .spc 缓存:2 个粒子,4x4 图 */
function makeSpcBuffer(): ArrayBuffer {
  const count = 2;
  const buf = new ArrayBuffer(20 + count * 8);
  const v = new DataView(buf);
  v.setUint32(0, 0x434d5342, true); // magic "SMPC"
  v.setUint32(4, 1, true); // version
  v.setUint32(8, count, true);
  v.setUint32(12, 4, true); // width
  v.setUint32(16, 4, true); // height
  // 粒子 1: 位置(0.5, 0.25), 颜色(255, 128, 0), size=8/15, imp=10/15
  v.setUint16(20, 32768, true);
  v.setUint16(22, 16384, true);
  v.setUint8(24, 255);
  v.setUint8(25, 128);
  v.setUint8(26, 0);
  v.setUint8(27, (8 << 4) | 10);
  // 粒子 2
  v.setUint16(28, 65535, true);
  v.setUint16(30, 0, true);
  v.setUint8(32, 10);
  v.setUint8(33, 20);
  v.setUint8(34, 30);
  v.setUint8(35, (12 << 4) | 15);
  return buf;
}

describe("parseSpc 粒子缓存解析", () => {
  it("解析头部与记录", () => {
    const c = parseSpc(makeSpcBuffer());
    expect(c.count).toBe(2);
    expect(c.width).toBe(4);
    expect(c.height).toBe(4);
    expect(c.target[0]).toBeCloseTo(0.5, 3);
    expect(c.target[1]).toBeCloseTo(0.25, 3);
    expect(c.color[0]).toBeCloseTo(1.0, 3);
    expect(c.color[1]).toBeCloseTo(128 / 255, 3);
    expect(c.color[2]).toBeCloseTo(0, 3);
    // size 高 4 位 / importance 低 4 位
    expect(c.data[0]).toBeCloseTo(8 / 15, 3);
    expect(c.data[1]).toBeCloseTo(10 / 15, 3);
  });

  it("拒绝非法魔数", () => {
    const buf = makeSpcBuffer();
    new DataView(buf).setUint32(0, 0xdeadbeef, true);
    expect(() => parseSpc(buf)).toThrow();
  });
});
describe("tm:// 资源 URL", () => {
  it("生成各类资源地址", () => {
    expect(tmThumb(7)).toBe("http://tm.localhost/thumb/7.jpg");
    expect(tmPreview(7)).toBe("http://tm.localhost/preview/7.jpg");
    expect(tmParticles(7)).toBe("http://tm.localhost/particles/7.spc");
    expect(tmPhoto(7)).toBe("http://tm.localhost/photo/7");
  });
});
