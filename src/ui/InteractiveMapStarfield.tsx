import { useEffect, useRef } from "react";

interface GlobeScreenCircle { x: number; y: number; radius: number }
interface Star {
  x: number;
  y: number;
  ox: number;
  oy: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  phase: number;
  warmth: number;
}

function seeded(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

/** 地图外层的轻量交互星野：只避开地球实际圆盘，不制造额外空环。 */
export default function InteractiveMapStarfield({
  active,
  globeCircle,
}: {
  active: boolean;
  globeCircle: () => GlobeScreenCircle | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  const circleRef = useRef(globeCircle);
  activeRef.current = active;
  circleRef.current = globeCircle;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let width = 1, height = 1, raf = 0, previous = performance.now();
    let stars: Star[] = [];
    const pointer = { x: -9999, y: -9999, inside: false };

    const rebuild = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width); height = Math.max(1, rect.height);
      const dpr = Math.min(devicePixelRatio, 1.5);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const random = seeded((Math.round(width) * 73856093) ^ (Math.round(height) * 19349663) ^ 0x51a7f13d);
      const count = Math.max(120, Math.min(340, Math.round(width * height / 10500)));
      stars = Array.from({ length: count }, () => ({
        x: random() * width,
        y: random() * height,
        ox: 0, oy: 0, vx: 0, vy: 0,
        size: 0.45 + Math.pow(random(), 2.8) * 1.15,
        alpha: 0.22 + random() * 0.56,
        phase: random() * Math.PI * 2,
        warmth: random(),
      }));
    };
    rebuild();
    const resize = new ResizeObserver(rebuild); resize.observe(canvas);

    const move = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left; pointer.y = event.clientY - rect.top;
      pointer.inside = pointer.x >= 0 && pointer.y >= 0 && pointer.x <= rect.width && pointer.y <= rect.height;
    };
    const leave = () => { pointer.inside = false; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerleave", leave);

    const frame = (now: number) => {
      const dt = Math.min(2, Math.max(0.25, (now - previous) / 16.667)); previous = now;
      ctx.clearRect(0, 0, width, height);
      const circle = circleRef.current();
      for (const star of stars) {
        const sx = star.x + star.ox, sy = star.y + star.oy;
        if (activeRef.current && pointer.inside) {
          const dx = sx - pointer.x, dy = sy - pointer.y;
          const distance = Math.hypot(dx, dy), radius = 92;
          if (distance > 0.1 && distance < radius) {
            const force = Math.pow(1 - distance / radius, 2) * 0.72 * dt;
            star.vx += dx / distance * force;
            star.vy += dy / distance * force;
          }
        }
        star.vx += -star.ox * 0.012 * dt;
        star.vy += -star.oy * 0.012 * dt;
        const damping = Math.pow(0.9, dt);
        star.vx *= damping; star.vy *= damping;
        star.ox += star.vx * dt; star.oy += star.vy * dt;
        const x = star.x + star.ox, y = star.y + star.oy;
        // 地球本身会遮住背景；只裁掉真实圆盘，多余空白不再出现。
        if (circle && Math.hypot(x - circle.x, y - circle.y) < circle.radius + 1) continue;
        const twinkle = 0.76 + 0.24 * Math.sin(now * 0.00055 + star.phase);
        const color = star.warmth > 0.86 ? "236,218,190" : star.warmth < 0.16 ? "145,181,226" : "205,220,240";
        ctx.beginPath(); ctx.arc(x, y, star.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${color},${star.alpha * twinkle})`; ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf); resize.disconnect();
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerleave", leave);
    };
  }, []);

  return <canvas ref={canvasRef} className="map-starfield" aria-hidden="true" />;
}
