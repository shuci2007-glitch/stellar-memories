/**
 * 临时调试图（不参与生产构建）：
 *   /body-lab.html            → 三联展示 光带结 / 同心光环 / 螺旋星盘
 *   /body-lab.html?kind=knot  → 单看某一个
 * 用来实际编译着色器、肉眼确认三种纯网格天体是否渲染正常。
 */
import * as THREE from "three";
import { buildBody, type BodyKind } from "../three/SpaceBody";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

const params = new URLSearchParams(location.search);
const requested = params.get("kind");
const kinds: BodyKind[] =
  requested && requested !== "all" ? [requested as BodyKind] : ["knot", "halo", "galaxy"];

const NAMES: Record<string, string> = {
  knot: "光带结 · 扁平绸带（含扭转）",
  halo: "同心光环 · 环盘 + 网格球壳",
  galaxy: "螺旋星盘 · 厚盘 + 对数旋臂",
};

const root = document.createElement("div");
root.style.cssText =
  "display:flex;width:100vw;height:100vh;gap:1px;background:#0a0d18;font:12px/1.6 system-ui,sans-serif";
document.body.appendChild(root);

let shaderErrorCount = 0;

for (const kind of kinds) {
  const cell = document.createElement("div");
  cell.style.cssText = "position:relative;flex:1 1 0;min-width:0;background:#05060c;overflow:hidden";
  root.appendChild(cell);

  const label = document.createElement("div");
  label.style.cssText =
    "position:absolute;left:12px;top:10px;z-index:2;color:#cfe4ff;letter-spacing:.05em;text-shadow:0 0 8px #000";
  label.textContent = NAMES[kind] ?? kind;
  cell.appendChild(label);

  try {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(0x05060c, 1);
    // 与应用本体同一套 HDR 管线：Neutral 色调映射 + bloom + OutputPass，
    // 这样调试图的观感与正式页面一致（Neutral 保色相、不把高亮去色成白）。
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.05;
    cell.appendChild(renderer.domElement);

    renderer.debug.checkShaderErrors = true;
    renderer.debug.onShaderError = (gl, _program, vs, fs) => {
      shaderErrorCount++;
      const vsLog = String(gl.getShaderInfoLog(vs) ?? "");
      const fsLog = String(gl.getShaderInfoLog(fs) ?? "");
      label.textContent = `${NAMES[kind] ?? kind}  ⚠ 着色器错误`;
      label.style.color = "#ff9a9a";
      const pre = document.createElement("pre");
      pre.style.cssText =
        "position:absolute;left:12px;bottom:10px;right:12px;z-index:3;color:#ffb4b4;font-size:10px;white-space:pre-wrap;max-height:45%;overflow:auto";
      pre.textContent = `${vsLog}\n${fsLog}`.trim().slice(0, 600);
      cell.appendChild(pre);
    };

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);
    const body = buildBody(kind);
    scene.add(body.group);

    // 每种形态尺寸差异很大，按包围球自动取景
    body.group.updateMatrixWorld(true);
    const sphere = new THREE.Box3().setFromObject(body.group).getBoundingSphere(new THREE.Sphere());
    // 图反推天体含远处散景碎点，包围球远大于盘体，取景时只按盘体半径
    const R = Math.max(40, sphere.radius * (kind.startsWith("im") ? 0.6 : 1));
    if (params.get("view") === "recon") {
      // 反推视角：视线与盘面的夹角 = arcsin(ratio) = 90° - 倾角，
      // 此角度下椭圆比 = ratio，与抠出的 2D 一致
      const el = kind === "imgalaxy" ? 55.5 : kind === "imgalaxyv" ? 58.4 : kind === "imgring" ? 59.4 : 55;
      const e = (el * Math.PI) / 180;
      camera.position.set(0, R * 1.45 * Math.sin(e), R * 1.45 * Math.cos(e));
    } else {
      // 与应用初始相机同方向 (65,112,150)，仰角约 34°，保证预览即所得
      const dir = new THREE.Vector3(65, 112, 150).normalize();
      camera.position.copy(dir.multiplyScalar(R * 1.45));
    }
    camera.lookAt(0, 0, 0);

    // 与应用一致的后期：bloom 阈值 1.15、强度 0.22、半径 0.18
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.18, 1.15));
    composer.addPass(new OutputPass());

    const resize = () => {
      const w = cell.clientWidth;
      const h = cell.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = `${w}px`;
      renderer.domElement.style.height = `${h}px`;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      composer.setSize(w, h);
    };
    resize();
    new ResizeObserver(resize).observe(cell);

    const clock = new THREE.Clock();
    const loop = () => {
      requestAnimationFrame(loop);
      body.tick(Math.min(0.05, clock.getDelta()));
      composer.render();
    };
    loop();
  } catch (err) {
    label.textContent = `${NAMES[kind] ?? kind}  ⚠ ${(err as Error).message}`;
    label.style.color = "#ff9a9a";
  }
}

window.setTimeout(() => {
  document.title = shaderErrorCount ? `shader-errors:${shaderErrorCount}` : "shaders-ok";
}, 1500);
