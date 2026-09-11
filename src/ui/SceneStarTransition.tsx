import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { ViewMode } from "../core/types";

function mulberry32(seed: number) { return () => { let t = seed += 0x6d2b79f5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/** WebGL 星流接力层。线段来自有深度的星粒子投影，不使用白洞、整屏 blur 或 CSS radial zoom。 */
export default function SceneStarTransition({ from, to }: { from: ViewMode; to: ViewMode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const cvs = canvas.current, scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(58, 1, 0.1, 180);
    camera.position.z = 3;
    const renderer = new THREE.WebGLRenderer({ canvas: cvs, alpha: true, antialias: true, powerPreference: "high-performance" });
    renderer.setClearColor(0x02040a, 0); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    const rng = mulberry32(0x3c6ef372 ^ (from.charCodeAt(0) << 8) ^ to.charCodeAt(0)), count = 620;
    const positions = new Float32Array(count * 6), colors = new Float32Array(count * 6), seeds = Array.from({ length: count }, () => [rng(), rng(), rng(), rng()]);
    for (let i = 0; i < count; i++) { const warm = seeds[i][3] < 0.2, c = warm ? [1, .54, .28] : seeds[i][2] < .42 ? [.43, .7, 1] : [.82, .9, 1]; colors.set(c, i * 6); colors.set(c, i * 6 + 3); }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3)); geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const lines = new THREE.LineSegments(geometry, material); lines.frustumCulled = false; scene.add(lines);
    const start = performance.now(); let raf = 0, dead = false;
    const resize = () => { const width = cvs.clientWidth, height = cvs.clientHeight; renderer.setSize(width, height, false); camera.aspect = width / Math.max(1, height); camera.updateProjectionMatrix(); };
    const observer = new ResizeObserver(resize); observer.observe(cvs); resize();
    const tick = (now: number) => { if (dead) return; raf = requestAnimationFrame(tick); const progress = Math.min(1, (now - start) / 1650), envelope = Math.sin(progress * Math.PI), attr = geometry.getAttribute("position") as THREE.BufferAttribute;
      material.opacity = envelope * .78;
      for (let i = 0; i < count; i++) { const s = seeds[i], side = s[0] < .5 ? -1 : 1, z = -2 - ((s[1] * 115 + progress * (105 + s[2] * 90)) % 115), spread = 3.5 + -z * .36, edge = side * (1.4 + s[2] * spread), y = (s[3] - .5) * spread * 1.1, stretch = (.08 + Math.pow(Math.abs(edge) / Math.max(3, spread), 1.35) * 5.2) * envelope; attr.setXYZ(i * 2, edge, y, z); attr.setXYZ(i * 2 + 1, edge * (1 + stretch * .018), y * (1 + stretch * .018), z + stretch); }
      attr.needsUpdate = true; renderer.render(scene, camera);
    }; raf = requestAnimationFrame(tick);
    return () => { dead = true; cancelAnimationFrame(raf); observer.disconnect(); geometry.dispose(); material.dispose(); renderer.dispose(); scene.clear(); };
  }, [from, to]);
  return <canvas ref={canvas} className="scene-star-transition" aria-hidden="true" />;
}
