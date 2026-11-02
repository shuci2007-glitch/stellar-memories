import { describe, it, expect } from 'vitest';
import { SHAPES, DEFAULT_SHAPE, shapeOf } from '../src/core/spaces';

describe('页面图形注册表', () => {
  it('只保留 6 种形态，顺序固定', () => {
    expect(SHAPES.map((s) => s.id)).toEqual([
      'spiral', 'sphere', 'ring', 'saturn', 'golden', 'nebula',
    ]);
  });

  it('提供多个可切换图形且 id 唯一', () => {
    expect(SHAPES.length).toBeGreaterThanOrEqual(4);
    expect(new Set(SHAPES.map((s) => s.id)).size).toBe(SHAPES.length);
    for (const s of SHAPES) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.cameraScale).toBeGreaterThan(0);
    }
  });

  it('任意数量下都给出有限、有界、可复现的坐标', () => {
    for (const shape of SHAPES) {
      for (const total of [1, 7, 120, 2000]) {
        for (const i of [0, Math.floor(total / 2), total - 1]) {
          const p = shape.layout(i, total);
          expect(Number.isFinite(p.x)).toBe(true);
          expect(Number.isFinite(p.y)).toBe(true);
          expect(Number.isFinite(p.z)).toBe(true);
          // 不能飞出星系可视范围,否则相机默认视角会看不到照片
          expect(Math.abs(p.x)).toBeLessThan(400);
          expect(Math.abs(p.y)).toBeLessThan(400);
          expect(Math.abs(p.z)).toBeLessThan(400);
          // 同一个下标必须稳定,否则每次进页面布局都会跳
          expect(shape.layout(i, total)).toEqual(p);
        }
      }
    }
  });

  it('未知图形回落到默认图形而不是崩掉', () => {
    expect(shapeOf('not-a-shape').id).toBe(DEFAULT_SHAPE);
    expect(shapeOf(null).id).toBe(DEFAULT_SHAPE);
    expect(shapeOf(undefined).id).toBe(DEFAULT_SHAPE);
  });

  it('已移除的旧形态映射到保留形态', () => {
    expect(shapeOf('knot').id).toBe('spiral');
    expect(shapeOf('halo').id).toBe('ring');
    expect(shapeOf('galaxy').id).toBe('spiral');
    expect(shapeOf('imgalaxy').id).toBe('spiral');
    expect(shapeOf('imgalaxyv').id).toBe('spiral');
    expect(shapeOf('imgring').id).toBe('ring');
  });
});
