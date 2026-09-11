import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Album, GalaxyPhoto, QualityTier } from "../core/types";
import { tmThumb } from "../core/types";
import { ipc } from "../core/db";
import { useToast } from "../core/toast";
import {
  PHOTO_SPHERE_DEFAULTS,
  PHOTO_SPHERE_SETTINGS_EVENT,
  loadPhotoSphereSettings,
  type PhotoSphereSettings,
} from "../core/PhotoSphereSettings";
import { PhotoParticleSphere } from "../three/PhotoParticleSphere";
import { AlbumAstraGalaxy } from "../three/AlbumAstraGalaxy";

type ViewPhase = "index" | "warp" | "detail" | "photo";
type AlbumNode = { album: Album; root: THREE.Group; visual: AlbumAstraGalaxy; proxy: THREE.Mesh; position: THREE.Vector3; phase: number };
type PhotoNode = { photo: GalaxyPhoto; root: THREE.Group; particles: PhotoParticleSphere; proxy: THREE.Mesh; home: THREE.Vector3; phase: number };

function hashString(input: string) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) hash = Math.imul(hash ^ input.charCodeAt(i), 16777619);
  return hash >>> 0;
}
function mulberry32(seed: number) { return () => { let t = seed += 0x6d2b79f5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function ease(t: number) { return t * t * (3 - 2 * t); }
function parseColor(value: string | null, fallback: THREE.Color) { try { return value ? new THREE.Color(value) : fallback.clone(); } catch { return fallback.clone(); } }

function makeAlbumGalaxy(album: Album, colors: THREE.Color[], index: number): AlbumNode {
  const rng = mulberry32(hashString(`album:${album.id}`)), visual = new AlbumAstraGalaxy(album.id, colors), root = visual.group;
  const proxy = new THREE.Mesh(new THREE.SphereGeometry(4.8, 18, 12), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, colorWrite: false, depthWrite: false })); proxy.userData = { albumId: album.id, kind: "album" }; root.add(proxy);
  const golden = Math.PI * (3 - Math.sqrt(5)), layer = Math.floor(index / 7), radius = 12 + layer * 11 + (index % 3) * 1.6;
  const position = new THREE.Vector3(Math.cos(index * golden) * radius, ((index * 3) % 7 - 3) * 2.2, Math.sin(index * golden) * radius - layer * 5);
  if (index === 0) position.set(-10, 0, 1); if (index === 1) position.set(7, 7, -7); if (index === 2) position.set(12, -2, -16); if (index === 3) position.set(-1, -9, -21);
  root.position.copy(position); root.rotation.z = (rng() - 0.5) * 0.75; root.scale.setScalar(1.18);
  return { album, root, visual, proxy, position, phase: rng() * Math.PI * 2 };
}

function makeEnvironment() {
  const rng = mulberry32(0x6a09e667), count = 1900, pos = new Float32Array(count * 3), colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const z = -18 - rng() * 190, spread = 16 + -z * 0.75, side = rng() < 0.5 ? -1 : 1, o = i * 3;
    pos[o] = side * (3 + rng() * spread); pos[o + 1] = (rng() - 0.5) * spread * 0.9; pos[o + 2] = z;
    const warm = rng() < 0.14; colors[o] = warm ? 0.92 : 0.45; colors[o + 1] = warm ? 0.58 : 0.7; colors[o + 2] = warm ? 0.34 : 1;
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3)); geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({ size: 0.065, vertexColors: true, transparent: true, opacity: 0.52, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
  const points = new THREE.Points(geometry, material); points.frustumCulled = false; return points;
}

function makeWarpStream(camera: THREE.PerspectiveCamera) {
  const rng = mulberry32(0xbb67ae85), count = 360, positions = new Float32Array(count * 6), colors = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) { const warm = rng() < 0.23, c = warm ? [1, 0.56, 0.3] : [0.42, 0.72, 1]; for (let k = 0; k < 2; k++) colors.set(c, i * 6 + k * 3); }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3)); geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const lines = new THREE.LineSegments(geometry, material); lines.frustumCulled = false; lines.renderOrder = 120; camera.add(lines);
  const seeds = Array.from({ length: count }, () => [rng(), rng(), rng(), rng()]);
  return { lines, geometry, material, update(progress: number, time: number) { material.opacity = Math.sin(Math.PI * progress) * 0.72; const attr = geometry.getAttribute("position") as THREE.BufferAttribute; for (let i = 0; i < count; i++) { const s = seeds[i], side = s[0] < 0.5 ? -1 : 1, z = -2 - ((s[1] * 75 + time * (18 + s[2] * 28)) % 75), edge = 1.8 + s[2] * 22, x = side * edge, y = (s[3] - 0.5) * (8 + -z * 0.35), length = (0.08 + Math.pow(Math.abs(x) / 24, 1.4) * 2.5) * (0.2 + progress * 2.4); attr.setXYZ(i * 2, x, y, z); attr.setXYZ(i * 2 + 1, x * (1 + length * 0.018), y * (1 + length * 0.018), z + length); } attr.needsUpdate = true; }, dispose() { camera.remove(lines); geometry.dispose(); material.dispose(); } };
}

export default function AlbumGalaxyView({ albums, photos, onOpenPhoto, onChanged, resolvePhotoUrl = tmThumb }: { albums: Album[]; photos: GalaxyPhoto[]; onOpenPhoto: (id: number) => void; onChanged: () => void; resolvePhotoUrl?: (id: number) => string }) {
  const host = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), labels = useRef(new Map<number, HTMLButtonElement>()), callback = useRef(onOpenPhoto);
  callback.current = onOpenPhoto;
  const toast = useToast();
  const [selected, setSelected] = useState<number | null>(null), [phase, setPhase] = useState<ViewPhase>("index"), [renaming, setRenaming] = useState(false), [name, setName] = useState("");
  const photoMap = useMemo(() => { const map = new Map<number, GalaxyPhoto[]>(); for (const photo of photos) if (photo.albumId !== null) { const list = map.get(photo.albumId) ?? []; list.push(photo); map.set(photo.albumId, list); } return map; }, [photos]);
  const selectedAlbum = albums.find((album) => album.id === selected) ?? null;

  useEffect(() => {
    if (!canvas.current || !host.current) return;
    const cvs = canvas.current, container = host.current, scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(48, 1, 0.1, 800);
    camera.position.set(0, 4, 38); scene.add(camera);
    const renderer = new THREE.WebGLRenderer({ canvas: cvs, alpha: true, antialias: true, powerPreference: "high-performance" }); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7)); renderer.setClearColor(0x02040a, 1);
    const controls = new OrbitControls(camera, cvs); controls.enableDamping = true; controls.dampingFactor = 0.075; controls.minDistance = 8; controls.maxDistance = 90; controls.target.set(0, 0, -5);
    const environment = makeEnvironment(); scene.add(environment);
    const albumNodes = albums.map((album, index) => { const palette = (photoMap.get(album.id) ?? []).slice(0, 8).map((photo) => parseColor(photo.avgColor, new THREE.Color(0.48, 0.7, 1))); if (!palette.length) palette.push(new THREE.Color(index % 2 ? 0.96 : 0.42, index % 2 ? 0.54 : 0.72, index % 2 ? 0.31 : 1)); const node = makeAlbumGalaxy(album, palette, index); scene.add(node.root); return node; });
    const clickables: THREE.Object3D[] = albumNodes.map((node) => node.proxy), photoNodes: PhotoNode[] = [];
    const detailRoot = new THREE.Group(); detailRoot.visible = false; scene.add(detailRoot);
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), local = new THREE.Vector3(); let currentAlbum: AlbumNode | null = null, activePhoto: PhotoNode | null = null;
    let currentPhase: ViewPhase = "index", selectedId: number | null = null, warpProgress = 0, photoProgress = 0, last = performance.now(), raf = 0, dead = false, downX = 0, downY = 0;
    let settings: PhotoSphereSettings = { ...PHOTO_SPHERE_DEFAULTS }, abort: AbortController | null = null, tier: QualityTier = "medium";
    const stream = makeWarpStream(camera);

    const applySettings = (next: PhotoSphereSettings) => { settings = { ...next }; for (const node of photoNodes) { node.particles.applySettings(settings); node.proxy.scale.setScalar(settings.radius / PHOTO_SPHERE_DEFAULTS.radius); } };
    void loadPhotoSphereSettings().then((next) => { if (!dead) applySettings(next); }).catch(() => applySettings({ ...PHOTO_SPHERE_DEFAULTS }));
    void ipc.getSetting("particle_tier").then((value) => { if (value === "low" || value === "medium" || value === "high" || value === "ultra") tier = value; }).catch(() => { tier = "medium"; });
    const settingsListener = (event: Event) => { const detail = (event as CustomEvent<Partial<PhotoSphereSettings> & { key?: keyof PhotoSphereSettings; value?: number }>).detail; if (detail?.key && typeof detail.value === "number") applySettings({ ...settings, [detail.key]: detail.value }); else applySettings({ ...settings, ...detail }); };
    window.addEventListener(PHOTO_SPHERE_SETTINGS_EVENT, settingsListener);

    const clearPhotoNodes = () => { for (const node of photoNodes) { detailRoot.remove(node.root); node.particles.dispose(); node.proxy.geometry.dispose(); (node.proxy.material as THREE.Material).dispose(); const at = clickables.indexOf(node.proxy); if (at >= 0) clickables.splice(at, 1); } photoNodes.length = 0; };
    const loadDetail = async (albumId: number) => {
      abort?.abort(); abort = new AbortController(); clearPhotoNodes();
      const list = (photoMap.get(albumId) ?? []).slice(0, 24), galaxy = albumNodes.find((node) => node.album.id === albumId); if (!galaxy) return;
      detailRoot.position.copy(galaxy.position);
      await Promise.all(list.map(async (photo, index) => { try { const particles = await PhotoParticleSphere.load(resolvePhotoUrl(photo.id), tier, settings, abort!.signal); if (dead || abort?.signal.aborted || selectedId !== albumId) { particles.dispose(); return; } particles.setCurvature(1); const root = new THREE.Group(), golden = Math.PI * (3 - Math.sqrt(5)), band = index * golden, distance = 2.8 + Math.sqrt(index + 1) * 1.5; const home = new THREE.Vector3(Math.cos(band) * distance, Math.sin(band * 1.37) * (1.4 + index * 0.08), Math.sin(band) * distance * 0.58 - index * 0.32); root.position.copy(home); root.rotation.set((index % 4 - 1.5) * 0.08, -band * 0.08, (index % 5 - 2) * 0.08); root.scale.setScalar(0.72); root.add(particles.points); const proxy = new THREE.Mesh(new THREE.SphereGeometry(1.8, 14, 10), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, colorWrite: false, depthWrite: false })); proxy.scale.setScalar(settings.radius / PHOTO_SPHERE_DEFAULTS.radius); proxy.userData = { photoId: photo.id, kind: "photo" }; root.add(proxy); const node = { photo, root, particles, proxy, home, phase: (hashString(String(photo.id)) % 628) / 100 }; photoNodes.push(node); clickables.push(proxy); detailRoot.add(root); } catch (error) { if ((error as Error).name !== "AbortError") console.warn("photo particle sphere load failed", photo.id, error); } }));
    };

    const selectAlbum = (id: number) => { if (currentPhase !== "index") return; if (selectedId === id) { currentAlbum = albumNodes.find((node) => node.album.id === id) ?? null; if (!currentAlbum) return; currentPhase = "warp"; setPhase("warp"); controls.enabled = false; warpProgress = 0; return; } selectedId = id; setSelected(id); currentAlbum = albumNodes.find((node) => node.album.id === id) ?? null; void loadDetail(id); };
    const back = () => { if (currentPhase === "detail" || currentPhase === "photo") { currentPhase = "index"; setPhase("index"); activePhoto = null; photoProgress = 0; detailRoot.visible = false; for (const node of albumNodes) node.root.visible = true; camera.position.set(0, 4, 38); controls.target.set(0, 0, -5); controls.enabled = true; } else if (selectedId !== null) { selectedId = null; currentAlbum = null; setSelected(null); } };
    const hit = (event: PointerEvent | MouseEvent) => { const rect = cvs.getBoundingClientRect(); ndc.set((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height * 2 - 1)); ray.setFromCamera(ndc, camera); return ray.intersectObjects(clickables, false)[0]; };
    const pointerMove = (event: PointerEvent) => { const intersection = hit(event); cvs.style.cursor = intersection ? "pointer" : "grab"; for (const node of photoNodes) node.particles.setPointer(null); if (intersection?.object.userData.kind === "photo") { const node = photoNodes.find((item) => item.proxy === intersection.object); if (node) { local.copy(intersection.point); node.root.worldToLocal(local); node.particles.setPointer(local.clone().normalize()); } } };
    const pointerDown = (event: PointerEvent) => { downX = event.clientX; downY = event.clientY; };
    const pointerUp = (event: PointerEvent) => { if (Math.hypot(event.clientX - downX, event.clientY - downY) > 5) return; const intersection = hit(event); if (!intersection) return; if (intersection.object.userData.kind === "album") selectAlbum(intersection.object.userData.albumId); else if (currentPhase === "detail") { activePhoto = photoNodes.find((item) => item.proxy === intersection.object) ?? null; if (activePhoto) { currentPhase = "photo"; setPhase("photo"); photoProgress = 0; controls.enabled = false; } } };
    const doubleClick = (event: MouseEvent) => { const intersection = hit(event); if (intersection?.object.userData.kind === "album") { const id = Number(intersection.object.userData.albumId); selectedId = id; setSelected(id); currentAlbum = albumNodes.find((node) => node.album.id === id) ?? null; void loadDetail(id); currentPhase = "warp"; setPhase("warp"); controls.enabled = false; warpProgress = 0; } };
    const externalSelect = (event: Event) => { const detail = (event as CustomEvent<{ id: number; confirm?: boolean }>).detail; if (!detail) return; if (detail.confirm) { if (selectedId !== detail.id) selectAlbum(detail.id); selectAlbum(detail.id); } else selectAlbum(detail.id); };
    const keyDown = (event: KeyboardEvent) => { if (event.key === "Escape") back(); };
    cvs.addEventListener("pointermove", pointerMove); cvs.addEventListener("pointerdown", pointerDown); cvs.addEventListener("pointerup", pointerUp); cvs.addEventListener("dblclick", doubleClick); window.addEventListener("keydown", keyDown); window.addEventListener("album-galaxy-select", externalSelect);

    const resize = () => { const width = container.clientWidth, height = container.clientHeight; renderer.setSize(width, height, false); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7)); camera.aspect = width / Math.max(1, height); camera.updateProjectionMatrix(); for (const node of photoNodes) node.particles.setPixelRatio(devicePixelRatio); };
    const observer = new ResizeObserver(resize); observer.observe(container); resize();
    const cameraStart = new THREE.Vector3(), cameraEnd = new THREE.Vector3(), targetStart = new THREE.Vector3(), targetEnd = new THREE.Vector3();
    const tick = (now: number) => { if (dead) return; raf = requestAnimationFrame(tick); const dt = Math.min(0.033, (now - last) / 1000); last = now; const time = now / 1000;
      (environment.material as THREE.PointsMaterial).opacity = 0.42 + Math.sin(time * 0.19) * 0.04;
      for (const node of albumNodes) { const focused = selectedId === node.album.id, opacity = selectedId === null || focused ? 1 : .25; node.visual.update(dt, opacity, Number(focused)); node.root.rotation.y += dt * (0.006 + node.phase * 0.0005); }
      if (currentPhase === "index" && currentAlbum) { const desired = currentAlbum.position.clone(); controls.target.lerp(desired, 1 - Math.exp(-dt * 2.6)); }
      if (currentPhase === "warp" && currentAlbum) { if (warpProgress === 0) { cameraStart.copy(camera.position); targetStart.copy(controls.target); cameraEnd.copy(currentAlbum.position).add(new THREE.Vector3(0, 1.4, 10.5)); targetEnd.copy(currentAlbum.position); } warpProgress = Math.min(1, warpProgress + dt / 1.85); const t = ease(warpProgress), arc = Math.sin(Math.PI * t); camera.position.lerpVectors(cameraStart, cameraEnd, t).add(new THREE.Vector3(arc * 2.4, arc * 0.8, 0)); controls.target.lerpVectors(targetStart, targetEnd, t); stream.update(t, time); if (warpProgress > 0.54) { detailRoot.visible = true; for (const node of albumNodes) node.root.visible = node === currentAlbum; } if (warpProgress >= 1) { currentPhase = "detail"; setPhase("detail"); currentAlbum.root.visible = false; stream.update(0, time); controls.enabled = true; controls.target.copy(currentAlbum.position); controls.minDistance = 6; controls.maxDistance = 34; } }
      if (currentPhase !== "warp") stream.update(0, time);
      for (const node of photoNodes) { node.particles.update(dt, time); if (currentPhase === "detail") { node.root.position.y = node.home.y + Math.sin(time * (0.12 + (node.phase % 1) * 0.05) + node.phase) * 0.08; node.root.rotation.y += dt * (0.018 + (node.phase % 1) * 0.01); } }
      if (currentPhase === "photo" && activePhoto) { photoProgress = Math.min(1, photoProgress + dt / 0.9); const t = ease(photoProgress); activePhoto.particles.setCurvature(1 - t); activePhoto.root.scale.setScalar(0.72 + t * 1.15); activePhoto.root.position.lerpVectors(activePhoto.home, new THREE.Vector3(0, 0, 5.8), t); if (photoProgress >= 1) { callback.current(activePhoto.photo.id); currentPhase = "detail"; setPhase("detail"); activePhoto.particles.setCurvature(1); activePhoto.root.position.copy(activePhoto.home); activePhoto.root.scale.setScalar(0.72); activePhoto = null; controls.enabled = true; } }
      controls.update(); renderer.render(scene, camera);
      for (const node of albumNodes) { const element = labels.current.get(node.album.id); if (!element || currentPhase !== "index") { if (element) element.style.opacity = "0"; continue; } const point = node.position.clone().project(camera); element.style.transform = `translate(${(point.x * .5 + .5) * cvs.clientWidth}px,${(-point.y * .5 + .5) * cvs.clientHeight}px)`; element.style.opacity = point.z < 1 ? "1" : "0"; element.dataset.selected = String(selectedId === node.album.id); }
    }; raf = requestAnimationFrame(tick);
    return () => { dead = true; abort?.abort(); cancelAnimationFrame(raf); observer.disconnect(); window.removeEventListener(PHOTO_SPHERE_SETTINGS_EVENT, settingsListener); window.removeEventListener("keydown", keyDown); window.removeEventListener("album-galaxy-select", externalSelect); cvs.removeEventListener("pointermove", pointerMove); cvs.removeEventListener("pointerdown", pointerDown); cvs.removeEventListener("pointerup", pointerUp); cvs.removeEventListener("dblclick", doubleClick); controls.dispose(); stream.dispose(); clearPhotoNodes(); environment.geometry.dispose(); (environment.material as THREE.Material).dispose(); for (const node of albumNodes) { node.visual.dispose(); node.proxy.geometry.dispose(); (node.proxy.material as THREE.Material).dispose(); } renderer.dispose(); scene.clear(); };
  }, [albums, photoMap, resolvePhotoUrl]);

  const saveRename = async () => { if (!selectedAlbum || !name.trim()) { setRenaming(false); return; } await ipc.renameAlbum(selectedAlbum.id, name.trim()); await onChanged(); toast("相册已重命名"); setRenaming(false); };
  return <section className="album-galaxy-view" ref={host} data-phase={phase}>
    <canvas ref={canvas} aria-label="相册星系选择空间" />
    <header className="album-galaxy-heading"><small>{phase === "index" ? "ALBUM CONSTELLATIONS" : phase === "warp" ? "TRAVERSING MEMORY" : "ALBUM GALAXY"}</small><h1>{phase === "index" ? (albums.length ? "相册星系" : "等待第一座相册星系") : selectedAlbum?.name}</h1><p>{phase === "index" ? "单击预选 · 再次单击或双击进入 · 拖动观察" : phase === "warp" ? "沿星尘穿越，正在显露照片粒子" : "选择一颗照片天体 · ESC 返回相册星系"}</p></header>
    <div className="album-galaxy-labels">{albums.map((album) => <button key={album.id} ref={(element) => { if (element) labels.current.set(album.id, element); else labels.current.delete(album.id); }} onClick={() => window.dispatchEvent(new CustomEvent("album-galaxy-select", { detail: { id: album.id } }))}><b>{album.name}</b><small>{album.photoCount} 张记忆</small></button>)}</div>
    {phase === "index" && albums.length > 0 && <nav className="album-galaxy-index" aria-label="相册目录">{albums.map((album) => <button key={album.id} className={selected === album.id ? "active" : ""} onClick={() => window.dispatchEvent(new CustomEvent("album-galaxy-select", { detail: { id: album.id } }))} onDoubleClick={() => window.dispatchEvent(new CustomEvent("album-galaxy-select", { detail: { id: album.id, confirm: true } }))}><span>{album.name}</span><small>{album.photoCount}</small></button>)}</nav>}
    {selectedAlbum && phase === "index" && <aside className="album-selection-panel"><small>已选相册星系</small>{renaming ? <input autoFocus value={name} onChange={(event) => setName(event.target.value)} onBlur={saveRename} onKeyDown={(event) => event.key === "Enter" && void saveRename()} /> : <h2>{selectedAlbum.name}</h2>}<p>{selectedAlbum.photoCount} 张照片将在内部形成不规则粒子星群</p><button onClick={() => { setRenaming(true); setName(selectedAlbum.name); }}>重命名</button><span>再次选择画面中的星系进入</span></aside>}
    {!albums.length && <div className="solar-empty"><span>✦</span><p>导入照片并建立相册后，每个相册会在这里形成一座独立星系。</p></div>}
  </section>;
}
