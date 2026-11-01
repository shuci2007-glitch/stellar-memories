import { albumGalaxyConfig } from "../core/types";
import { DEFAULT_SHAPE, shapeOf } from "../core/spaces";
import { buildBody, disposeBody, isBodyKind, type BodyHandle, type BodyKind } from "./SpaceBody";
import { SpherePhotoBridge, setSpherePhotoBridge, getSpherePhotoBridge, clearSpherePhotoBridge } from "./SpherePhotoBridge";
import { prewarmDetailPhoto } from "./DetailPhotoResources";
import * as THREE from "three";
import { AstraReferenceGalaxy } from './AstraReferenceGalaxy';
import { CameraRig } from "./CameraRig";
import { Starfield } from "./Starfield";
import { TexturePool } from "./TexturePool";
import { ParticlePhoto, type ParticleCloudData } from "./ParticlePhoto";
import { samplePhoto } from "./PhotoParticleSampler";
import { AstraWatercolorBackdrop } from './AstraWatercolorBackdrop';
import { JourneyController, type JourneyDestination, type JourneyPhase } from "./JourneyController";
import { EarthGlobe } from "./EarthGlobe";
import { TimeTunnel } from "./TimeTunnel";
import { PhotoParticleSphere } from "./PhotoParticleSphere";
import { PHOTO_SPHERE_DEFAULTS, type PhotoSphereSettings, loadPhotoSphereSettings } from "../core/PhotoSphereSettings";
import {EffectComposer} from 'three/examples/jsm/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/examples/jsm/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ipc } from "../core/db";
import type { QualityTier } from "../core/types";
import {
  NODE_FRAG,
  NODE_VERT,
  LINE_FRAG,
  LINE_VERT,
  DUST_FRAG,
  DUST_VERT,
} from "./shaders";
import type { Album, Connection, GalaxyPhoto } from "../core/types";

interface Cluster {
  albumId: number; // -1 = 无相册
  name: string;
  center: THREE.Vector3;
  color: THREE.Color;
  nodeIndexes: number[];
  glow: THREE.Sprite;
  labelEl: HTMLDivElement | null;
  arm: number;
  armProgress: number;
}

export type SceneStateName =
  | "lock"
  | "enter"
  | "overview"
  | "cluster"
  | "detail"
  | "ambient";

interface StateProfile {
  stars: number;
  nebula: number;
  dust: number;
  nodes: number;
  lines: number;
  heart: number;
}

const PROFILES: Record<SceneStateName, StateProfile> = {
  lock: { stars: 1.05, nebula: 0, dust: 0, nodes: 0, lines: 0, heart: 0 },
  enter: { stars: 1, nebula: 0, dust: 0.9, nodes: 0.9, lines: 0.9, heart: 0.6 },
  overview: { stars: 1, nebula: 0, dust: 1, nodes: 1, lines: 1, heart: 0.5 },
  cluster: { stars: 0.82, nebula: 0, dust: 1.2, nodes: 1.2, lines: 1.1, heart: 0.35 },
  detail: { stars: 0.18, nebula: 0, dust: 0, nodes: 0.1, lines: 0, heart: 0 },
  ambient: { stars: 0.4, nebula: 0, dust: 0.35, nodes: 0.25, lines: 0.25, heart: 0.2 },
};

export interface GalaxySceneEvents {
  onHoverPhoto?: (id: number | null) => void;
  onSelectPhoto?: (id: number) => void;
  onFps?: (fps: number) => void;
  onPhotoStarFormed?: (id: number) => void;
  onPhotoStarFail?: (id: number) => void;
  /** 汇聚真正完成(进度>98.5%),由渲染帧判定,UI 不得用定时器替代 */
  onEnterComplete?: () => void;
  /** 旅程生命周期:转向/推进/巡航/减速/到达,以及地球交接时刻 */
  onJourneyEvent?: (event: JourneyEvent) => void;
  /** 相册目录页:单击预选相册星系 */
  onAlbumClick?: (albumId: number) => void;
  /** 相册目录页:双击/确认进入相册 */
  onAlbumEnter?: (albumId: number) => void;
}

export type AuthPhase = "locked" | "converging" | "locking";

export type JourneyEvent =
  | { type: "started"; destination: JourneyDestination }
  | { type: "phase"; destination: JourneyDestination; phase: JourneyPhase }
  | { type: "near"; destination: JourneyDestination }
  | { type: "earth-ready"; lat: number; lng: number; screenRadius: number; viewportH: number }
  | { type: "earth-pose"; lat: number; lng: number; screenRadius: number; viewportH: number }
  | { type: "earth-arrived" }
  | { type: "earth-left" }
  | { type: "arrived"; destination: JourneyDestination; albumId?: number | null }
  | { type: "interrupted" };

const GALAXY_CORE = new THREE.Vector3(0, -13, 0); // Astra 主银河的中心(视觉核心)
const GALAXY_VIEW_TARGET = new THREE.Vector3(0, -13, 0); // 全景相机对准 Astra 真实亮核
/** 地球是 Astra 内部沿偏心轨道运行的小星球，不占据亮核本体。 */
const EARTH_RADIUS = 1.8;
const EARTH_ORBIT_X = 52;
const EARTH_ORBIT_Y = 32;
const EARTH_ORBIT_Z = 8;
const ALBUM_REGION = new THREE.Vector3(-26, 9, -4);




/** 记忆宇宙主场景 */
export class GalaxyScene {
  private renderer!: THREE.WebGLRenderer;
  private composer!:EffectComposer;
  private scene = new THREE.Scene();
  private rig!: CameraRig;
  private galaxy!: AstraReferenceGalaxy;
  private starfield!: Starfield;
  private backdrop!: AstraWatercolorBackdrop;
  private canvas!: HTMLCanvasElement;
  private labelContainer: HTMLDivElement | null = null;

  private photos: GalaxyPhoto[] = [];
  /** 最近一次 setData 的入参:切页面形态时用它原地重建 */
  private lastData: [GalaxyPhoto[], Album[], Connection[]] | null = null;
  private indexById = new Map<number, number>();
  private clusters: Cluster[] = [];
  private clusterByAlbum = new Map<number, Cluster>();

  // 点云(远 LOD)
  private nodeGeo!: THREE.BufferGeometry;
  private nodeMat!: THREE.ShaderMaterial;
  private nodePoints!: THREE.Points;

  // 近 LOD 卡片
  private texPool = new TexturePool(150);
  private cards = new Map<number, THREE.Mesh>();
  private cardGroup = new THREE.Group();

  // 连线
  private lineGeo!: THREE.BufferGeometry;
  private lineMat!: THREE.ShaderMaterial;
  private lines!: THREE.LineSegments;
  private edgeList: { a: number; b: number; strength: number }[] = [];

  private worker: Worker | null = null;
  private positions: Float32Array | null = null;

  // 氛围:记忆之心 / 星云 / 星尘
  private heart: THREE.Sprite | null = null;
  private nebulae: THREE.Sprite[] = [];
  private dustGeo: THREE.BufferGeometry | null = null;
  private dustMat: THREE.ShaderMaterial | null = null;
  private dustPoints: THREE.Points | null = null;

  // 状态机(阻尼过渡,天然可中断)
  private stateCur: StateProfile = { ...PROFILES.lock };
  private stateTarget: StateProfile = { ...PROFILES.lock };

  // 宇宙状态:LOCKED_SCATTERED → CONVERGING → GALAXY_READY(锁定时回到散开)
  private universe: "locked" | "converging" | "ready" = "locked";

  // 星辰→照片 morph(同一场景内完成,不销毁场景)
  private photoCloud: ParticlePhoto | null = null;
  private photoStarId = -1;
  private photoPlane = new THREE.Plane();
  private photoCamPose: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private photoLastLocal = new THREE.Vector2(9, 9);
  private photoCloudCache = new Map<number, ParticleCloudData>();


  // 交互状态
  private raycaster = new THREE.Raycaster();
  private photoPointerOnCanvas = false;
  private pointerNdc = new THREE.Vector2(-10, -10);
  private photoBackdrop = 1;
  private hovered = -1;
  private hoverCardId = -1;
  private hoveredAlbum = -1;
  private hoveredProxyPhoto = -1;
  private dragIndex = -1;
  private dragPlane = new THREE.Plane();
  private downPos = { x: 0, y: 0 };
  private orbiting = false;
  private galaxyDragging = false;
  private galaxyDragLast = { x: 0, y: 0 };
  private universeSpin = new THREE.Quaternion();
  private galaxyBaseQuaternion = new THREE.Quaternion();
  /** 空闲自转:只作用于点云图形与体积星云,不影响照片星系 */
  private shapeSpin = new THREE.Quaternion();
  /** universeSpin × shapeSpin,给点云图形用 */
  private combinedSpin = new THREE.Quaternion();

  // ---------- 旅程系统:同一宇宙内的连续镜头 ----------
  private journey = new JourneyController();
  private earth: EarthGlobe | null = null;
  private earthStar: THREE.Sprite | null = null;
  private tunnel: TimeTunnel | null = null;
  private tunnelRide: { t: number; endT: number; duration: number; elapsed: number } | null = null;
  private tunnelPhotoIds: { id: number; aspect: number }[] = [];
  private tunnelTexRefresh = 0;
  /** 旅程位姿栈:[0]=宇宙出发位姿,其后为目录层位姿;返回时逐层恢复 */
  private poseStack: { place: string; pos: THREE.Vector3; target: THREE.Vector3 }[] = [];
  /** 相机当前所在的地点(不是 React 页面) */
  private place: "universe" | "earth" | "shelf" | "timeline" | "album" = "universe";
  private albumFocus: number | null = null;
  private shelfViewQuaternion = new THREE.Quaternion();
  private pendingAlbumParticles = new Map<THREE.Group, PhotoParticleSphere>();
  private handoffLatLng = { lat: 32, lng: 105 };
  private earthAnchor = GALAXY_CORE.clone();
  private earthOrbitAngle = 0.15;
  /** 本次地球接近轴：取用户当前视角到轨道地球的直线，避免任意视角起航时绕弯。 */
  private earthViewAxis = new THREE.Vector3(0, 0, 1);
  private earthViewUp = new THREE.Vector3(0, 1, 0);
  /** 地图最终构图中，地球中心位于画面中心右侧约 8%。 */
  private earthFrameRight = new THREE.Vector3(1, 0, 0);
  private lastJourneyPhase: JourneyPhase = "arrived";

  // 相册区域:每座星系直接由该相册的照片粒子球排布而成
  private albumNodes: { albumId: number; root: THREE.Group; proxy: THREE.Mesh; position: THREE.Vector3; labelEl: HTMLDivElement | null }[] = [];
  private albumRegionGroup = new THREE.Group();
  // 相册内部:照片粒子球群
  private albumPhotoNodes: { photoId: number; albumId: number; particles: PhotoParticleSphere | null; root: THREE.Group; proxy: THREE.Mesh; lod: THREE.Sprite; home: THREE.Vector3; offset: THREE.Vector3; velocity: THREE.Vector3; hoverTarget: THREE.Vector3; phase: number }[] = [];

  // Universe 照片粒子球(近 LOD):photoId → 实体
  private photoSpheres = new Map<number, { sphere: PhotoParticleSphere; proxy: THREE.Mesh; loadToken: number; offset: THREE.Vector3; velocity: THREE.Vector3; hoverTarget: THREE.Vector3 }>();
  private photoSphereSettings: PhotoSphereSettings = { ...PHOTO_SPHERE_DEFAULTS };
  private photoSphereTier: QualityTier = "medium";
  private photoSphereLoadsThisFrame = 0;

  private raf = 0;
  private clock = new THREE.Clock();
  private time = 0;
  private fpsAcc = 0;
  private fpsN = 0;
  private running = false;
  private events: GalaxySceneEvents;
  private cardMat: THREE.MeshBasicMaterial;
  /** 只有宇宙是当前页面时,场景才响应键盘与指针语义 */
  private active = true;
  /** 帧率上限(毫秒/帧),0 = 不限。桌面壁纸常驻渲染时需要让出 GPU。 */
  private minFrameMs = 0;
  private lastFrameTs = 0;
  /** 当前页面形态;默认旋臂走原本的 Astra 布局 */
  private shapeId = DEFAULT_SHAPE;
  /** Astra 参考银河的显隐(0..1)。只有「旋臂星系」用它,其它形态收起来让位给星野自己成形。 */
  private galaxyFade = 1;
  private galaxyFadeTarget = 1;

  /** 形态星尘:照片稀少时用暗淡点云勾勒页面形态，否则选了什么图形都看不出来 */
  private shapeDust:
    | { points: THREE.Points; geom: THREE.BufferGeometry; mat: THREE.PointsMaterial }
    | null = null;
  private dustShapeId: string | null = null;
  /** 背景照片的呈现:plate 半透明图板 / nebula 整页粒子 */
  private backdropKey = "";
  private backdropUrl: string | null = null;
  private backdropStrength = 42;
  private backdropMesh: THREE.Mesh | null = null;
  private backdropTexture: THREE.Texture | null = null;
  /** 页面主视觉天体（环带行星 / 金色光环 / 粒子星云） */
  private body: BodyHandle | null = null;
  /** 当前挂的是哪个天体;切换图形时据此判断要不要真的重建 */
  private bodyKind: BodyKind | null = null;

  constructor(events: GalaxySceneEvents = {}) {
    this.events = events;
    this.cardMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
  }

  /** 主银河可轻微偏转，但背景星野保持稳定，避免把整个宇宙看成一张薄平面。 */
  private universeWorldPoint(local: THREE.Vector3, out = new THREE.Vector3()) {
    return out.copy(local).sub(GALAXY_VIEW_TARGET).applyQuaternion(this.universeSpin).add(GALAXY_VIEW_TARGET);
  }

  private applyUniverseObjectSpin(object: THREE.Object3D | null | undefined) {
    if (!object) return;
    object.quaternion.copy(this.universeSpin);
    object.position.copy(GALAXY_VIEW_TARGET).sub(GALAXY_VIEW_TARGET.clone().applyQuaternion(this.universeSpin));
  }

  private applyUniverseSpin() {
    if (!this.galaxy) return;
    this.galaxy.points.quaternion.copy(this.universeSpin).multiply(this.galaxyBaseQuaternion);
    this.applyUniverseObjectSpin(this.nodePoints);
    this.applyUniverseObjectSpin(this.dustPoints);
    this.applyUniverseObjectSpin(this.lines);
    this.applyUniverseObjectSpin(this.cardGroup);
    for (const cluster of this.clusters) cluster.glow.position.copy(this.universeWorldPoint(cluster.center));
    for (const entry of this.photoSpheres.values()) {
      const index = this.indexById.get(entry.proxy.userData.photoId as number);
      if (index === undefined) continue;
      const world = this.universeWorldPoint(this.nodePosition(index));
      world.add(entry.offset.clone().applyQuaternion(this.universeSpin));
      entry.proxy.position.copy(world);
      entry.proxy.quaternion.copy(this.universeSpin);
      if (entry.sphere) {
        entry.sphere.points.position.copy(world);
        entry.sphere.points.quaternion.copy(this.rig.camera.quaternion);
      }
    }
  }

  /**
   * 每帧推进图形自旋。
   *
   * 两路自旋分开:
   *  - universeSpin:拖动产生的,只作用于星系和照片星(保持原行为,照片不会被自动转走);
   *  - shapeSpin:空闲时的极慢自转,只作用于点云图形(球状/环状等)和体积星云,
   *    这样每个图形看上去都会自己在转。
   */
  private tickUniverseSpin(dt: number) {
    const axis = new THREE.Vector3(0.16, 1, 0.07).normalize();
    this.shapeSpin
      .premultiply(new THREE.Quaternion().setFromAxisAngle(axis, dt * 0.05))
      .normalize();
    this.combinedSpin.copy(this.universeSpin).multiply(this.shapeSpin);
    this.starfield.setSpin(this.combinedSpin);
    // 旋臂星系用 galaxy.points 当主体,星野保持稳定(和原设计一致)
    const spinShape = this.shapeId !== "spiral";
    this.starfield.setSpinEnabled(spinShape);
    // 形态星尘是独立点云,得跟图形一起转,否则轮廓和点云会对不上
    if (spinShape && this.shapeDust) this.shapeDust.points.quaternion.copy(this.combinedSpin);
    // 天体(环带行星/金色光环/莫比乌斯环/流动绸带…)整体跟随自旋:
    // 拖动时整个星球被带动,而不只是粒子在转。
    if (this.body) this.body.group.quaternion.copy(this.combinedSpin);
  }

  // ---------- 生命周期 ----------

  // ---------- 旅程:从当前镜头出发的连续空间航行 ----------

  private emitJourney(event: JourneyEvent) {
    this.events.onJourneyEvent?.(event);
  }

  private emitEarthPose(type: "earth-ready" | "earth-pose") {
    if (!this.earth) return;
    // Export the globe after applying this frame's camera and right-side framing,
    // including the final arrival frame, rather than last frame's globe pose.
    this.placeEarthInMapFrame(1);
    const viewportH = this.canvas.clientHeight;
    this.emitJourney({
      type,
      lat: this.handoffLatLng.lat,
      lng: this.handoffLatLng.lng,
      screenRadius: this.earth.screenRadiusFor(this.rig.camera, viewportH),
      viewportH,
    });
  }

  private saveOriginPose() {
    this.poseStack = [{
      place: "universe",
      pos: this.rig.camera.position.clone(),
      target: this.rig.controls.target.clone(),
    }];
  }

  private pushPose(place: string) {
    this.poseStack.push({
      place,
      pos: this.rig.camera.position.clone(),
      target: this.rig.controls.target.clone(),
    });
  }

  private popPose(): { place: string; pos: THREE.Vector3; target: THREE.Vector3 } {
    return this.poseStack.pop() ?? {
      place: "universe",
      pos: new THREE.Vector3(65, 112, 150),
      target: GALAXY_VIEW_TARGET.clone(),
    };
  }

  /**
   * 统一旅程入口:任何地点之间的移动都从这里出发。
   * 打断安全:永远从相机此刻的真实位置/朝向重新起航,旧旅程 token 立即作废。
   */
  travelTo(destination: "earth" | "shelf" | "timeline", opts: { lat?: number; lng?: number; albumId?: number | null } = {}) {
    if (this.universe === "locked") return;
    if (opts.lat !== undefined && opts.lng !== undefined) this.handoffLatLng = { lat: opts.lat, lng: opts.lng };
    if (this.photoFocusActive) void this.collapsePhotoStar(true);
    this.clearAlbumRibbon();
    this.clearTunnelRide(false);
    const fromPlace = this.place;
    if (fromPlace === "universe") this.saveOriginPose();
    const from = this.rig.camera.position.clone();

    if (destination === "earth") {
      if (this.earthStar) this.earthStar.visible = false;
      this.albumRegionGroup.visible = false;
      for (const entry of this.photoSpheres.values()) {
        entry.proxy.visible = false;
        if (entry.sphere) entry.sphere.points.visible = false;
      }
      // 点击时冻结地球此刻的轨道位置；镜头追向这颗小星球，而不是飞往银河亮核。
      this.earthAnchor.copy(this.earth!.group.position);
      const toCamera = new THREE.Vector3().subVectors(from, this.earthAnchor);
      if (toCamera.lengthSq() < 1) toCamera.set(0.05, 0.12, 1);
      this.earthViewAxis.copy(toCamera).normalize();
      this.earthViewUp.copy(this.rig.camera.up).addScaledVector(this.earthViewAxis, -this.rig.camera.up.dot(this.earthViewAxis));
      if (this.earthViewUp.lengthSq() < 1e-4) this.earthViewUp.set(0, 1, 0);
      this.earthViewUp.normalize();
      this.earth!.setOrientation(this.handoffLatLng.lat, this.handoffLatLng.lng, this.earthViewAxis, this.earthViewUp);
      this.earth!.setOpacity(0);
      this.earth!.group.visible = true;
      const arrive = this.earthApproachPose(2.9);
      // 所有航点都位于“当前视角 → Astra 亮核”同一条轴上：主星辰持续放大，不产生 S 弯。
      const startDistance = from.distanceTo(this.earthAnchor);
      const arrivalDistance = arrive.pos.distanceTo(this.earthAnchor);
      const entryDistance = Math.max(arrivalDistance + 8, Math.min(54, startDistance * 0.62));
      const revealDistance = Math.max(arrivalDistance + 4, Math.min(30, entryDistance - 4));
      const waypoints: THREE.Vector3[] = [];
      if (startDistance > entryDistance + 2) waypoints.push(this.earthAnchor.clone().addScaledVector(this.earthViewAxis, entryDistance));
      if (startDistance > revealDistance + 1) waypoints.push(this.earthAnchor.clone().addScaledVector(this.earthViewAxis, revealDistance));
      waypoints.push(arrive.pos);
      this.beginJourney({
        destination,
        waypoints,
        focus: this.earthAnchor.clone(),
        lookAt: this.earthAnchor.clone(),
        focusBlend: 0.42,
        speed: 105,
        minDuration: 2.45,
        maxDuration: 4.2,
        onNear: () => {
          if (this.tunnel) this.tunnel.group.visible = false;
          this.setState("ambient");
          this.emitJourney({ type: "near", destination: "earth" });
          // 减速尚在继续时便让 MapLibre 从当前 Three 位姿开始接入。
          this.emitEarthPose("earth-ready");
        },
        onArrive: () => {
          this.place = "earth";
          this.emitEarthPose("earth-pose");
          this.emitJourney({ type: "earth-arrived" });
        },
      });
      return;
    }

    if (destination === "shelf") {
      this.albumRegionGroup.visible = true;
      for (const node of this.albumNodes) node.root.scale.setScalar(1);
      const bounds = new THREE.Box3();
      for (const node of this.albumNodes) {
        bounds.expandByPoint(node.position.clone().addScalar(10));
        bounds.expandByPoint(node.position.clone().addScalar(-10));
      }
      const center = bounds.isEmpty() ? ALBUM_REGION.clone() : bounds.getCenter(new THREE.Vector3());
      const size = bounds.isEmpty() ? new THREE.Vector3(20,20,20) : bounds.getSize(new THREE.Vector3());
      const halfFov = THREE.MathUtils.degToRad(45) / 2;
      const distance = Math.max(size.y / .55, size.x / (.72 * this.rig.camera.aspect)) / (2 * Math.tan(halfFov)) + size.z / 2;
      const fromEarth = fromPlace === "earth";
      const approachAxis = fromEarth ? this.rig.camera.getWorldDirection(new THREE.Vector3()).negate() : new THREE.Vector3(0,0,1);
      const arrive = center.clone().addScaledVector(approachAxis,distance);
      for (const node of this.albumNodes) {
        if(fromEarth) node.root.quaternion.copy(this.rig.camera.quaternion);
        else node.root.quaternion.identity();
      }
      this.beginJourney({
        destination,
        waypoints: [from.clone().lerp(arrive,.6), arrive],
        startFocus: fromEarth ? this.earthAnchor.clone() : null,
        focus: center.clone(),
        lookAt: center.clone(),
        speed: fromEarth ? 120 : 215,
        minDuration: fromEarth ? 3 : undefined,
        onNear: () => {
          if (this.earth) this.earth.group.visible = false;
          if (this.tunnel) this.tunnel.group.visible = false;
        },
        onArrive: () => {
          this.place = "shelf";
          this.albumFocus = null;
          for (const node of this.albumNodes) node.root.quaternion.copy(this.rig.camera.quaternion);
          this.rig.controls.enabled = true;
          this.rig.controls.maxDistance = 620;
          JourneyController.handBack(this.rig.controls, center);
          this.setState("ambient");
          this.emitJourney({ type: "arrived", destination: "shelf" });
        },
      });
      return;
    }

    if (destination !== "timeline") return; // 未知目的地:忽略,不误飞
    // timeline:隧道在当前相机位置与朝向原地生成，第一帧就从当前星野开始扭曲。
    const tunnel = this.tunnel!;
    this.journey.cancel();
    this.rig.cancel();
    const forward = this.rig.camera.getWorldDirection(new THREE.Vector3());
    tunnel.placeAt(this.rig.camera.position, forward, this.rig.camera.up);
    tunnel.group.visible = true;
    this.ensureTunnelPhotos();
    if (this.earth) this.earth.group.visible = false;
    this.albumRegionGroup.visible = false;
    this.place = "timeline";
    this.rig.controls.enabled = false;
    // Stay on the near side of the galaxy. A fixed 620-unit flight crossed the core
    // and left the return camera on the far side of the entire scene.
    const coreDistance = this.rig.camera.position.distanceTo(this.universeWorldPoint(GALAXY_CORE));
    const travelDistance = Math.min(tunnel.length * 0.16, coreDistance * 0.55);
    this.tunnelRide = { t: 0, endT: travelDistance / tunnel.length, duration: 3.2, elapsed: 0 };
    this.setState("ambient");
    this.emitJourney({ type: "started", destination: "timeline" });
    this.emitJourney({ type: "phase", destination: "timeline", phase: "accelerate" });
  }

  /** 相册区域内部:进入指定相册星系 */
  enterAlbum(albumId: number) {
    if (this.place !== "shelf" || this.journey.activeDestination || this.photoFocusActive) return;
    const node = this.albumNodes.find((n) => n.albumId === albumId);
    if (!node) return;
    this.pushPose("shelf");
    this.shelfViewQuaternion.copy(this.rig.camera.quaternion);
    this.albumFocus = albumId;
    const camera = this.rig.camera;
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const target = node.root.getWorldPosition(new THREE.Vector3());
    const distance = camera.position.distanceTo(target);
    const viewingDistance = THREE.MathUtils.clamp(distance * .42, 18, 26);
    // 同时推进与横向平移，把星系中心移到当前视线轴上。
    // 相机朝向保持不变，终点 -Z 射线精确穿过星系中心，无末帧转头。
    const arrive = target.clone().addScaledVector(forward, -viewingDistance);
    this.beginJourney({
      destination: "album",
      waypoints: [arrive],
      preserveView: true,
      speed: 90,
      minDuration: 1.6,
      maxDuration: 2.6,
      onArrive: () => {
        this.place = "album";
        this.rig.controls.minDistance = 6;
        this.rig.controls.maxDistance = 620;
        this.rig.controls.target.copy(target);
        this.rig.controls.enabled = true;
        this.emitJourney({ type: "arrived", destination: "album", albumId });
      },
    });
  }

  /** 相册内部 → 相册目录:恢复进入前的目录浏览位姿 */
  exitAlbum() {
    if(this.albumRibbon){this.albumRibbon.closing=true;return;}
    if (this.place !== "album" || this.journey.activeDestination) return;
    const pose = this.popPose();
    this.beginJourney({
      destination: "shelf",
      waypoints: [pose.pos.clone()],
      preserveView: true,
      endQuaternion: this.shelfViewQuaternion.clone(),
      speed: 130,
      minDuration: 1.5,
      onArrive: () => {
        this.place = "shelf";
        this.albumFocus = null;
        this.rig.controls.enabled = true;
        this.rig.controls.minDistance = 6;
        this.rig.controls.maxDistance = 620;
        this.rig.controls.target.copy(pose.target);
        this.emitJourney({ type: "arrived", destination: "shelf" });
      },
    });
  }

  /** 回到出发锚点:恢复离开宇宙时的确切位姿 */
  travelBack() {
    if (this.photoFocusActive) void this.collapsePhotoStar(true);
    this.clearAlbumRibbon();
    this.clearTunnelRide(true);
    this.poseStack = this.poseStack.slice(0, 1); // 只恢复宇宙出发位姿
    const pose = this.poseStack[0] ?? { pos: new THREE.Vector3(65, 112, 150), target: GALAXY_VIEW_TARGET.clone() };
    const from = this.rig.camera.position.clone();
    const returningFromEarth = this.place === "earth";
    const returningFromShelf = this.place === "shelf" || this.place === "album";
    const returningFromTimeline = this.place === "timeline";
    const pullBack = returningFromEarth || returningFromShelf || returningFromTimeline;
    const departureFocus = this.rig.controls.target.clone();
    this.albumFocus = null;
    this.beginJourney({
      destination: "overview",
      // 地球返回采用共线航点：只后退拉远，不再绕弧线或转身朝向运动方向。
      waypoints: pullBack
        ? [from.clone().lerp(pose.pos, 0.55), pose.pos.clone()]
        : [this.cruiseMidpoint(from, pose.pos, 90), pose.pos.clone()],
      startFocus: returningFromEarth ? this.earthAnchor.clone() : (returningFromShelf || returningFromTimeline) ? departureFocus : null,
      focus: pullBack ? pose.target.clone() : null,
      lookAt: pose.target.clone(),
      speed: pullBack ? 150 : 235,
      minDuration: pullBack ? 2.7 : undefined,
      onNear: () => {
        // 返回宇宙时让地球自然缩小到星海里，而不是中途突然消失。
        if (this.earth && !returningFromEarth) this.earth.group.visible = false;
        if (this.tunnel && this.journey.progress > 0.3) this.tunnel.group.visible = false;
        if (!returningFromShelf) this.albumRegionGroup.visible = false;
      },
      onArrive: () => {
        this.place = "universe";
        this.albumRegionGroup.visible = returningFromShelf;
        if (returningFromShelf) {
          for (const node of this.albumNodes) {
            node.root.scale.setScalar(0.015);
            if (node.labelEl) node.labelEl.style.opacity = "0";
          }
        }
        this.rig.controls.enabled = true;
        this.rig.controls.minDistance = 6;
        this.rig.controls.maxDistance = 620;
        // 精确恢复出发时的浏览状态
        this.rig.camera.position.copy(pose.pos);
        JourneyController.handBack(this.rig.controls, pose.target);
        const m = new THREE.Matrix4().lookAt(pose.pos, pose.target, this.rig.camera.up);
        this.rig.camera.quaternion.setFromRotationMatrix(m);
        this.setState("overview");
        if (this.earth) this.earth.group.visible = false;
        if (this.tunnel) this.tunnel.group.visible = false;
        this.poseStack = [];
        this.emitJourney({ type: "arrived", destination: "overview" });
      },
    });
  }

  /** 地球接管确认:maplibre 已淡入,宇宙场景退位 */
  confirmEarthHandoff() {
    if (this.earth) this.earth.group.visible = false;
    this.setState("ambient");
  }

  /** 从地图(地球)离开:按地图当前视角重建飞行地球姿态;后续航程由 App 下发 */
  resumeFromEarth(mapPose: { lat: number; lng: number; screenRadius: number; viewportH: number }) {
    const earth = this.earth;
    if (!earth) { this.travelBack(); return; }
    this.handoffLatLng = { lat: mapPose.lat, lng: mapPose.lng };
    earth.group.visible = true;
    earth.setOpacity(1);
    earth.setOrientation(mapPose.lat, mapPose.lng, this.earthViewAxis, this.earthViewUp);
    // 由屏幕半径反解相机距离(与 EarthGlobe.screenRadiusFor 同一几何)
    const halfFov = THREE.MathUtils.degToRad(this.rig.camera.fov) / 2;
    const t = mapPose.screenRadius / Math.max(1, mapPose.viewportH / 2 / Math.tan(halfFov));
    const sinA = t / Math.sqrt(1 + t * t);
    const distance = earth.radius / Math.max(0.02, sinA);
    const frameFraction = Math.min(150, this.canvas.clientWidth * 0.08) / Math.max(1, this.canvas.clientWidth);
    const lateralRatio = 2 * Math.tan(halfFov) * this.rig.camera.aspect * frameFraction;
    const axialDistance = distance / Math.sqrt(1 + lateralRatio * lateralRatio);
    this.rig.camera.position.copy(this.earthAnchor).addScaledVector(this.earthViewAxis, axialDistance);
    this.rig.camera.up.copy(this.earthViewUp);
    const m = new THREE.Matrix4().lookAt(this.rig.camera.position, this.earthAnchor, this.earthViewUp);
    this.rig.camera.quaternion.setFromRotationMatrix(m);
    this.placeEarthInMapFrame(1);
    this.rig.controls.target.copy(this.earthAnchor);
    this.rig.camera.updateMatrixWorld(true);
    this.place = "earth";
    this.emitJourney({ type: "earth-left" });
  }

  /** 地球接近位姿:沿地球→当前相机方向减速停靠 */
  private earthApproachPose(distanceFactor: number): { pos: THREE.Vector3 } {
    const d = EARTH_RADIUS * distanceFactor;
    return { pos: this.earthAnchor.clone().addScaledVector(this.earthViewAxis, d) };
  }

  /**
   * 只移动地球的显示锚点，不移动整个宇宙镜头。这样地球一显现便已在地图的最终右侧构图，
   * 而 Astra 与背景不会在点击地图时整体横跳。
   */
  private placeEarthInMapFrame(amount: number) {
    if (!this.earth) return;
    const camera = this.rig.camera;
    const frameFraction = Math.min(150, this.canvas.clientWidth * 0.08) / Math.max(1, this.canvas.clientWidth);
    const distance = camera.position.distanceTo(this.earthAnchor);
    const lateral = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect * frameFraction * amount;
    this.earthFrameRight.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    this.earth.group.position.copy(this.earthAnchor).addScaledVector(this.earthFrameRight, lateral);
    const facing = new THREE.Vector3().subVectors(camera.position, this.earth.group.position).normalize();
    this.earth.setOrientation(this.handoffLatLng.lat, this.handoffLatLng.lng, facing, camera.up);
  }

  /** 宇宙浏览态的地球轨道：与 Astra 共用世界变换，缓慢运行且始终留在主星辰内部。 */
  private updateEarthOrbit(dt: number) {
    if (!this.earth) return;
    this.earthOrbitAngle = (this.earthOrbitAngle + dt * 0.045) % (Math.PI * 2);
    const a = this.earthOrbitAngle;
    const local = GALAXY_CORE.clone().add(new THREE.Vector3(
      Math.cos(a) * EARTH_ORBIT_X,
      Math.sin(a) * EARTH_ORBIT_Y,
      Math.sin(a * 1.37) * EARTH_ORBIT_Z,
    ));
    this.earthAnchor.copy(this.universeWorldPoint(local));
    this.earth.group.position.copy(this.earthAnchor);
  }

  private cruiseMidpoint(from: THREE.Vector3, to: THREE.Vector3, arc: number): THREE.Vector3 {
    const mid = from.clone().lerp(to, 0.5);
    const dir = new THREE.Vector3().subVectors(to, from);
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
    if (side.lengthSq() < 1) side.set(1, 0, 0);
    return mid.addScaledVector(side.normalize(), arc * 0.4).add(new THREE.Vector3(0, arc * 0.25, 0));
  }

  private beginJourney(request: Parameters<JourneyController["begin"]>[1] & { destination: JourneyDestination }) {
    this.rig.cancel();
    if (request.preserveView) {
      // 清除拖动的剩余阻尼，防止交还控制器的第一帧追加旧旋转。
      const camera = this.rig.camera, controls = this.rig.controls;
      const position = camera.position.clone(), quaternion = camera.quaternion.clone(), target = controls.target.clone();
      const damping = controls.enableDamping;
      controls.enableDamping = false;
      controls.update();
      controls.enableDamping = damping;
      camera.position.copy(position);
      camera.quaternion.copy(quaternion);
      controls.target.copy(target);
    }
    this.journey.begin({ camera: this.rig.camera, controls: this.rig.controls }, request);
    this.emitJourney({ type: "started", destination: request.destination });
  }

  private clearTunnelRide(hideTunnel: boolean) {
    this.tunnelRide = null;
    if (hideTunnel && this.tunnel) this.tunnel.group.visible = false;
  }

  /** 隧道照片切片:按拍摄时间排序的真实缩略图(异步纹理,入口处预取) */
  ensureTunnelPhotos() {
    const tunnel = this.tunnel;
    if (!tunnel) return;
    const withDate = [...this.photos]
      .filter((p) => p.captureDate || p.id)
      .sort((a, b) => (b.captureDate ?? "").localeCompare(a.captureDate ?? "") || b.id - a.id);
    this.tunnelPhotoIds = withDate.slice(0, 44).map((p) => ({
      id: p.id,
      aspect: p.width > 0 && p.height > 0 ? p.width / p.height : 1,
    }));
    this.refreshTunnelTextures();
  }

  private refreshTunnelTextures() {
    const tunnel = this.tunnel;
    if (!tunnel) return;
    tunnel.setPhotos(this.tunnelPhotoIds.map((p) => ({ id: p.id, aspect: p.aspect, texture: this.texPool.get(p.id) })));
  }

  /** 隧道内航行:相机沿中心线前进,近物掠过;末端减速对齐时间轴落点 */
  private stepTunnelRide(dt: number) {
    const ride = this.tunnelRide!;
    const tunnel = this.tunnel!;
    ride.elapsed += dt;
    const u = Math.min(1, ride.elapsed / ride.duration);
    // 五次 smootherstep 让位移完整走到出口，并在首尾保持速度连续。
    const progress = u * u * u * (u * (u * 6 - 15) + 10);
    ride.t = progress * ride.endT;
    const frame = tunnel.frameAt(ride.t);
    this.rig.camera.position.copy(frame.pos);
    // 视线看向前瞻点;克制的滚转乘在本地 Z 上,随路程起止归零
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(frame.quat);
    const lookTarget = frame.pos.clone().addScaledVector(forward, 30);
    const m = new THREE.Matrix4().lookAt(frame.pos, lookTarget, this.rig.camera.up);
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    const roll = Math.sin(progress * Math.PI) * 0.16;
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
    this.rig.camera.quaternion.copy(q);
    this.rig.camera.fov = 45 + 6 * Math.sin(Math.PI * progress);
    this.rig.camera.updateProjectionMatrix();
    if (u > 0.55) this.emitJourneyOnce("timeline-decelerate", { type: "phase", destination: "timeline", phase: "decelerate" });
    if (u >= 1) {
      // OrbitControls still updates while input is disabled; keep its target in
      // agreement with the last flight frame so it cannot turn the camera back.
      this.rig.controls.target.copy(lookTarget);
      // Keep the purple nebula at rest behind the timeline; only moving streams
      // and photographs finish fading with the completed ride.
      tunnel.group.visible = true;
      this.tunnelRide = null;
      this.tunnelDecelEmitted = false;
      this.setState("ambient");
      this.emitJourney({ type: "arrived", destination: "timeline" });
    }
  }
  private tunnelDecelEmitted = false;
  private emitJourneyOnce(key: string, event: JourneyEvent) {
    if (key === "timeline-decelerate") {
      if (this.tunnelDecelEmitted) return;
      this.tunnelDecelEmitted = true;
    }
    this.emitJourney(event);
  }

  /** 相册区域标签:世界锚点投影到屏幕 */
  private updateAlbumLabels() {
    if (!this.labelContainer) return;
    const cam = this.rig.camera;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    for (const n of this.albumNodes) {
      if (!n.labelEl) continue;
      const dist = cam.position.distanceTo(n.position);
      const v = n.position.clone().project(cam);
      const behind = v.z > 1;
      const scale = THREE.MathUtils.clamp(1 - (dist - 60) / 220, 0.15, 1);
      if (behind || scale <= 0.16 || this.place === "album") {
        n.labelEl.style.opacity = "0";
        continue;
      }
      n.labelEl.style.left = `${((v.x + 1) / 2) * w}px`;
      n.labelEl.style.top = `${((-v.y + 1) / 2) * h}px`;
      n.labelEl.style.opacity = `${scale * 0.92}`;
    }
  }

  /**
   * Universe 照片粒子球场(F):照片星球是宇宙实体。
   * 首次接近时逐步载入，每帧最多 1 颗、预算 26；已载入的实体本次浏览常驻。
   * 锚点跟随力导向布局的稳定节点位置,seed=photoId,不随机重排。
   */
  private updatePhotoSphereField(dt: number) {
    this.photoSphereLoadsThisFrame = 0;
    const cam = this.rig.camera;
    const focusId = this.photoStarId;
    // 用镜头缩放距离控制显示，不用随星系旋转变化的单球距离。
    const zoomVisibility = 1 - THREE.MathUtils.smoothstep(this.rig.getRadius(), 65, 115);
    const candidates: { id: number; pos: THREE.Vector3; dist: number }[] = [];
    for (let i = 0; i < this.photos.length; i++) {
      const pos = this.universeWorldPoint(this.nodePosition(i));
      const dist = cam.position.distanceTo(pos);
      if (this.photoSpheres.has(this.photos[i].id) || dist < 75) candidates.push({ id: this.photos[i].id, pos, dist });
    }
    candidates.sort((a, b) => a.dist - b.dist);
    // 先保留已载入和正在载入的 ID，不能被旋转后的距离排序挤出。
    const selected = candidates.filter(candidate => this.photoSpheres.has(candidate.id));
    for (const candidate of candidates) {
      if (selected.length >= 26) break;
      if (this.photoSpheres.has(candidate.id)) continue;
      if (selected.some(other => other.pos.distanceTo(candidate.pos) < 5.5)) continue;
      selected.push(candidate);
    }
    for (const c of selected) {
      let entry = this.photoSpheres.get(c.id);
      if (!entry && !this.photoFocusActive && this.photoBackdrop > .1 && zoomVisibility > .01 && c.dist < 75 && this.photoSphereLoadsThisFrame < 1) {
        this.photoSphereLoadsThisFrame++;
        const token = ++this.sphereLoadToken;
        const settings = this.photoSphereSettings;
        const proxy: THREE.Mesh = new THREE.Mesh(
          new THREE.SphereGeometry(2.55, 14, 10),
          new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, colorWrite: false, depthWrite: false }),
        );
        proxy.scale.setScalar(settings.radius / PHOTO_SPHERE_DEFAULTS.radius);
        proxy.userData = { photoId: c.id, kind: "universe-photo" };
        this.scene.add(proxy);
        entry = { sphere: null as unknown as PhotoParticleSphere, proxy, loadToken: token, offset: new THREE.Vector3(), velocity: new THREE.Vector3(), hoverTarget: new THREE.Vector3() };
        this.photoSpheres.set(c.id, entry);
        void PhotoParticleSphere.load(`http://tm.localhost/thumb/${c.id}`, this.photoSphereTier, settings)
          .then((sphere) => {
            const current = this.photoSpheres.get(c.id);
            if (!current || current.loadToken !== token) { sphere.dispose(); return; }
            sphere.setCurvature(1);
            sphere.setPointerGain(4);
            sphere.points.quaternion.copy(this.rig.camera.quaternion);
            sphere.points.position.copy(current.proxy.position);
            sphere.points.scale.setScalar(0.36);
            this.scene.add(sphere.points);
            current.sphere = sphere;
            this.setNodeReveal(c.id, 0);
          })
          .catch(() => {
            // 粒子不可用:仅移除代理,退回普通节点/卡片
            const current = this.photoSpheres.get(c.id);
            if (current && current.loadToken === token) this.disposePhotoSphere(c.id);
          });
      }
      if (this.sphereFocus && entry?.sphere === this.sphereFocus.sphere) continue;
      if (entry) {
        const displayed = c.pos.clone().add(entry.offset.clone().applyQuaternion(this.universeSpin));
        entry.proxy.position.copy(displayed);
        entry.proxy.quaternion.copy(this.universeSpin);
        if (entry.sphere) {
          this.setNodeReveal(c.id, 1 - zoomVisibility);
          entry.sphere.points.position.copy(displayed);
          entry.sphere.points.quaternion.copy(this.rig.camera.quaternion);
          const detail = 1 - THREE.MathUtils.smoothstep(c.dist, 13, 64);
          entry.sphere.points.scale.setScalar((0.36 + detail * 0.94) * THREE.MathUtils.lerp(.12, 1, zoomVisibility));
          entry.proxy.scale.setScalar(this.photoSphereSettings.radius * entry.sphere.points.scale.x / 2.55);
          entry.proxy.updateMatrixWorld(true);
          entry.sphere.setOpacity((0.44 + detail * 0.38) * zoomVisibility * this.photoBackdrop);
          entry.sphere.update(dt, this.time);
          entry.sphere.points.visible = zoomVisibility * this.photoBackdrop > .001 && focusId !== c.id;
        }
        entry.proxy.visible = !!entry.sphere && zoomVisibility > .15 && this.photoBackdrop > .15 && !this.photoFocusActive && focusId !== c.id;
      }
    }
    // 数据刷新/场景释放负责清理；旋转、缩放和悬停不销毁照片球。
  }

  private sphereLoadToken = 0;

  private disposePhotoSphere(id: number) {
    const entry = this.photoSpheres.get(id);
    if (!entry) return;
    this.scene.remove(entry.proxy);
    entry.proxy.geometry.dispose();
    (entry.proxy.material as THREE.Material).dispose();
    if (entry.sphere) {
      this.scene.remove(entry.sphere.points);
      entry.sphere.dispose();
    }
    this.photoSpheres.delete(id);
    this.setNodeReveal(id, 1);
  }

  private setNodeReveal(id: number, value: number) {
    const index = this.indexById.get(id);
    const reveal = this.nodeGeo?.getAttribute("aReveal") as THREE.BufferAttribute | undefined;
    if (index === undefined || !reveal) return;
    reveal.setX(index, value);
    reveal.needsUpdate = true;
  }

  init(canvas: HTMLCanvasElement, labelContainer: HTMLDivElement) {
    this.canvas = canvas;
    this.labelContainer = labelContainer;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setClearColor(0x000000, 0);

    this.rig = new CameraRig(canvas.clientWidth / Math.max(1, canvas.clientHeight), canvas);
    this.rig.controls.enabled = false; // 锁定态:散星不可拖动
    this.starfield = new Starfield();

    this.applyShapeLook();
    this.backdrop = new AstraWatercolorBackdrop();
    // 172/8 保持正式场景既有世界尺度，同时保留官网 camera=8 时的屏幕构图。
    this.galaxy = new AstraReferenceGalaxy(Math.min(window.devicePixelRatio,2),21.5);
    this.galaxyBaseQuaternion.copy(this.galaxy.points.quaternion);
    // 锁屏门控:场景初态钉在散开,未解锁绝不汇聚(认证相位由 setAuthPhase 显式推进)
    this.galaxy.setIntroProgress(0);
    this.galaxy.setConvergeTarget(0);
    this.scene.add(this.backdrop.mesh);
    this.scene.add(this.galaxy.points);
    this.scene.add(this.starfield.points, this.cardGroup);
    this.composer=new EffectComposer(this.renderer);this.composer.addPass(new RenderPass(this.scene,this.rig.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(1,1),.22,.18,1.15));this.composer.addPass(new OutputPass());

    // 记忆之心:宇宙原点缓慢呼吸的焦点辉光
    this.heart = makeGlowSprite(new THREE.Color(0xaebfdd), 14);
    (this.heart.material as THREE.SpriteMaterial).opacity = 0.12;
    this.scene.add(this.heart);

    // 星云:两片巨大的低透明度冷色氛围(给空间以纵深)
    const nebulaDefs: [number, number, number][] = [
      [0x1c2a4a, 150, -0.25],
      [0x2a1f3d, 120, 0.55],
    ];
    for (const [hex, scale, angF] of nebulaDefs) {
      const s = makeGlowSprite(new THREE.Color(hex), scale);
      s.position.set(Math.cos(angF * 6.28) * 70, -12, Math.sin(angF * 6.28) * 70);
      (s.material as THREE.SpriteMaterial).opacity = 0.07;
      this.nebulae.push(s);
      this.scene.add(s);
    }

    this.bindEvents();
    window.addEventListener("keydown", this.onKey);
    this.resize();

    // —— 同一宇宙的其他地点(常驻宿主,按需预热) ——
    this.scene.add(this.albumRegionGroup);
    this.earth = new EarthGlobe(EARTH_RADIUS);
    this.earthStar = makeGlowSprite(new THREE.Color("#a4d9ff"), 0.7);
    this.earthStar.visible = false;
    this.scene.add(this.earthStar);
    this.updateEarthOrbit(0);
    this.earth.setOpacity(0.78);
    this.earth.group.visible = false;
    this.scene.add(this.earth.group);
    void this.earth.loadBorders();
    this.handoffLatLng = { lat: 32, lng: 105 };
    this.tunnel = new TimeTunnel();
    this.tunnel.group.visible = false;
    this.scene.add(this.tunnel.group);

    // 照片球设置:与平面 V14 参数分开保存,独立调节
    void loadPhotoSphereSettings().then((s) => { this.photoSphereSettings = s; }).catch(() => {});
    void ipc.getSetting("particle_tier").then((v) => {
      if (v === "low" || v === "medium" || v === "high" || v === "ultra") this.photoSphereTier = v;
    }).catch(() => {});
    const onSphereSettings = () => { void loadPhotoSphereSettings().then((s) => {
      this.photoSphereSettings = s;
      for (const entry of this.photoSpheres.values()) entry.sphere?.applySettings(s);
      for (const n of this.albumPhotoNodes) { n.particles?.applySettings(s); n.proxy.scale.setScalar(s.radius / PHOTO_SPHERE_DEFAULTS.radius); }
    }); };
    window.addEventListener("photo-sphere-settings", onSphereSettings);
    this.sphereSettingsListener = onSphereSettings;
  }
  private sphereSettingsListener: ((e: Event) => void) | null = null;

  /** 认证相位(可重放状态):场景初始化后随时对齐,解决"消息先到、监听后建"的竞态 */
  setAuthPhase(phase: AuthPhase, convergeRate = 1.45) {
    if (phase === "converging") this.startConverge(convergeRate);
    else this.lockNow(); // locked / locking:保持或恢复散开,隐藏私密内容
  }

  /** 登录成功:同一批散星开始汇聚成银河(约 2.9s),镜头从当前位置轻推向全景,不瞬移 */
  startConverge(rate = 1.45) {
    if (this.universe !== "locked") return;
    this.universe = "converging";
    this.setState("enter");
    this.starfield.startGather();
    // 汇聚本身是主动作；锁屏散星不随解锁做整批相机位移。
    this.rig.controls.target.copy(GALAXY_VIEW_TARGET);
    this.galaxy.setConvergeTarget(1, rate);
    this.albumRegionGroup.visible = false;
    this.rig.controls.enabled = true;
  }

  /** 锁定:银河松散回散开态,照片云立即收回;旅程与照片球一并清理 */
  lockNow() {
    if (this.photoFocusActive) this.disposePhotoCloud();
    this.journey.cancel();
    this.clearTunnelRide(true);
    this.albumFocus = null;
    this.place = "universe";
    this.poseStack = [];
    for (const id of [...this.photoSpheres.keys()]) this.disposePhotoSphere(id);
    if (this.earth) this.earth.group.visible = false;
    this.albumRegionGroup.visible = false;
    this.universe = "locked";
    this.setState("lock");
    this.galaxy.setConvergeTarget(0, 0.85);
    this.rig.controls.enabled = false;
    this.hovered = -1;
    this.events.onHoverPhoto?.(null);
    for (const c of this.clusters) if (c.labelEl) c.labelEl.style.opacity = "0";
  }

  /** 状态切换:目标 profile 由 RAF 内阻尼逼近,天然可中断 */
  setState(name: SceneStateName) {
    this.stateTarget = PROFILES[name];
  }

  /** 页面激活状态:非当前页面时不响应 Escape/重置等语义 */
  setActive(active: boolean) {
    this.active = active;
    if (!active) this.onPointerLeave();
    if (!this.photoFocusActive && !this.journey.activeDestination) this.rig.controls.enabled = active && !this.albumRibbon;
  }

  /** 回到全景浏览(导航重入) */
  resetOverview() {
    this.albumRegionGroup.visible = false;
    this.rig.flyTo(GALAXY_VIEW_TARGET.clone(), 172);
    this.setState("overview");
  }

  private sceneDataSignature = "";

  /** 载入数据并布置星团 */
  setData(photos: GalaxyPhoto[], albums: Album[], connections: Connection[]) {
    // 名称和展示配置保存后复用正在显示的球，不重新生成场景。
    const signature = JSON.stringify([photos, [...albums].sort((a,b)=>a.id-b.id).map(a=>[a.id,a.photoIds]), connections]);
    this.lastData = [photos, albums, connections];
    const preserveAlbumDraft=this.albumCommitPending;
    this.albumCommitPending=false;
    if (signature === this.sceneDataSignature) {
      for (const node of this.albumNodes) {
        const album=albums.find(a=>a.id===node.albumId);
        if(!album)continue;
        if(node.labelEl)node.labelEl.innerHTML=`<div class="n">${escapeHtml(album.name)}</div><div class="c">${album.photoCount} 张记忆</div>`;
        const config=albumGalaxyConfig(album);
        for(const photo of this.albumPhotoNodes.filter(n=>n.albumId===album.id)) {
          photo.root.userData.displayTarget=config.photoIds===null||config.photoIds.includes(photo.photoId)?1:0;
          const saved=config.positions?.[String(photo.photoId)];
          photo.root.userData.fixed=!!saved;
          if(saved){photo.home.fromArray(saved);photo.root.position.copy(photo.home);photo.offset.set(0,0,0);photo.velocity.set(0,0,0);}
        }
      }
      return;
    }
    this.sceneDataSignature = signature;
    const remainingIds = new Set(photos.map(photo => photo.id));
    for (const id of this.photoSpheres.keys()) {
      if (!remainingIds.has(id)) this.disposePhotoSphere(id);
    }
    this.universeSpin.identity();
    if (this.galaxy) this.galaxy.points.quaternion.copy(this.galaxyBaseQuaternion);
    this.photos = photos;
    this.indexById.clear();
    photos.forEach((p, i) => this.indexById.set(p.id, i));

    // --- 相册聚类布局:双旋臂(对数螺旋),像星系的旋臂而非散点 ---
    const realAlbums = albums.filter((a) =>
      photos.some((p) => p.albumId === a.id),
    );
    const clusterCount = realAlbums.length + (photos.some((p) => p.albumId === null) ? 1 : 0);

    for (const c of this.clusters) { this.scene.remove(c.glow); c.glow.material.dispose(); c.labelEl?.remove(); }
    this.clusters = [];
    this.clusterByAlbum.clear();
    const mkCluster = (albumId: number, name: string): Cluster => {
      const i = this.clusters.length;
      // 星簇锚点挂在可视旋臂上(与 Astra 银河同一世界变换),沿臂展开并跨臂分配
      const arm = i % 5;
      const progress = 0.18 + (i / Math.max(1, clusterCount)) * 0.62 + (i % 3) * 0.05;
      const color = new THREE.Color(0x93a7c9);
      const glow = makeGlowSprite(color, 20);
      const anchor = this.galaxy.armWorldPoint(arm, progress);
      glow.position.copy(anchor);
      glow.visible = false;
      this.scene.add(glow);
      const c: Cluster = {
        albumId,
        name,
        center: glow.position.clone(),
        color,
        nodeIndexes: [],
        glow,
        labelEl: null,
        arm,
        armProgress: progress,
      };
      this.clusters.push(c);
      this.clusterByAlbum.set(albumId, c);
      return c;
    };
    for (const a of realAlbums) mkCluster(a.id, a.name);
    const orphan = photos.some((p) => p.albumId === null)
      ? mkCluster(-1, "散落的记忆")
      : null;

    // 相册色 = 成员平均色
    for (const c of this.clusters) {
      let r = 0, g = 0, b = 0, n = 0;
      for (const p of photos) {
        if ((p.albumId ?? -1) === c.albumId && p.avgColor) {
          const col = hexToRgb(p.avgColor);
          r += col[0]; g += col[1]; b += col[2]; n++;
        }
      }
      if (n > 0) {
        c.color.setRGB(r / n / 255, g / n / 255, b / n / 255);
        c.color.multiplyScalar(1.25);
        (c.glow.material as THREE.SpriteMaterial).color.copy(c.color);
      }
    }

    // --- 节点初始位置(环形 + 抖动) ---
    const pos = new Float32Array(photos.length * 3);
    const col = new Float32Array(photos.length * 3);
    const data = new Float32Array(photos.length * 2);
    const reveal = new Float32Array(photos.length).fill(1);
    const initNodes: { id: number; album: number; x: number; y: number; z: number }[] = [];

    photos.forEach((p, i) => {
      const cluster = p.albumId !== null ? this.clusterByAlbum.get(p.albumId) : orphan;
      const c = cluster ?? orphan;
      if (c) c.nodeIndexes.push(i);
      const k = c ? c.nodeIndexes.length : i;
      const ring = Math.floor(Math.sqrt(k));
      const ringPos = k - ring * ring;
      const ringN = 6 * (ring + 1);
      const a = (ringPos / ringN) * Math.PI * 2 + ring * 0.7;
      const rr = 6 + ring * 5.5;
      const x = (c?.center.x ?? 0) + Math.cos(a) * rr + (rand(i * 3.1) - 0.5) * 3;
      const y = (c?.center.y ?? 0) + (rand(i * 5.7) - 0.5) * 9;
      const z = (c?.center.z ?? 0) + Math.sin(a) * rr + (rand(i * 9.3) - 0.5) * 3;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;

      const colv = p.avgColor ? hexToRgb(p.avgColor) : [150, 165, 200];
      col[i * 3] = colv[0] / 255;
      col[i * 3 + 1] = colv[1] / 255;
      col[i * 3 + 2] = colv[2] / 255;
      data[i * 2] = (p.starred ? 9 : 6) + (p.title ? 1 : 0);
      data[i * 2 + 1] = rand(i * 11.7);

      initNodes.push({ id: p.id, album: c ? this.clusters.indexOf(c) : -1, x, y, z });
    });

    // 节点点云
    if (this.nodePoints) {
      this.scene.remove(this.nodePoints);
      this.nodeGeo.dispose();
      this.nodeMat.dispose();
    }
    this.nodeGeo = new THREE.BufferGeometry();
    this.nodeGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.nodeGeo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    this.nodeGeo.setAttribute("aData", new THREE.BufferAttribute(data, 2));
    this.nodeGeo.setAttribute("aReveal", new THREE.BufferAttribute(reveal, 1));
    this.nodeMat = new THREE.ShaderMaterial({
      vertexShader: NODE_VERT,
      fragmentShader: NODE_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        uSizeScale: { value: 1 },
        uOpacity: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.nodePoints = new THREE.Points(this.nodeGeo, this.nodeMat);
    this.nodePoints.frustumCulled = false;
    this.scene.add(this.nodePoints);

    // --- 星簇辉光按成员数量定标;颜色提亮 ---
    for (const c of this.clusters) {
      const n = Math.max(1, c.nodeIndexes.length);
      c.glow.scale.setScalar(14 + Math.sqrt(n) * 4.5);
      (c.glow.material as THREE.SpriteMaterial).opacity = 0.2;
      c.color.multiplyScalar(1.5);
      (c.glow.material as THREE.SpriteMaterial).color.copy(c.color);
    }

    // --- 星尘环:每簇一圈缓慢公转的微尘(单个 draw call) ---
    if (this.dustPoints) {
      this.scene.remove(this.dustPoints);
      this.dustGeo!.dispose();
      this.dustMat!.dispose();
      this.dustPoints = null;
    }
    {
      const perCluster = 64;
      const total = this.clusters.length * perCluster;
      const dpos = new Float32Array(total * 3); // 占位(位置在 shader 内算)
      const dcenter = new Float32Array(total * 3);
      const ddata = new Float32Array(total * 2); // radius, speed
      const dseed = new Float32Array(total * 4);
      let k = 0;
      for (const c of this.clusters) {
        const R = 8 + Math.sqrt(Math.max(1, c.nodeIndexes.length)) * 4.2;
        for (let j = 0; j < perCluster; j++, k++) {
          dcenter[k * 3] = c.center.x;
          dcenter[k * 3 + 1] = c.center.y;
          dcenter[k * 3 + 2] = c.center.z;
          ddata[k * 2] = R * (0.55 + rand(k * 3.7) * 0.75);
          ddata[k * 2 + 1] = (0.05 + rand(k * 5.9) * 0.16) * (rand(k * 7.1) > 0.5 ? 1 : -1);
          dseed[k * 4] = rand(k * 9.7) * Math.PI * 2;
          dseed[k * 4 + 1] = 0.7 + rand(k * 11.3) * 1.1;
          dseed[k * 4 + 2] = rand(k * 13.1);
          dseed[k * 4 + 3] = 0;
        }
      }
      this.dustGeo = new THREE.BufferGeometry();
      this.dustGeo.setAttribute("position", new THREE.BufferAttribute(dpos, 3));
      this.dustGeo.setAttribute("aCenter", new THREE.BufferAttribute(dcenter, 3));
      this.dustGeo.setAttribute("aData", new THREE.BufferAttribute(ddata, 2));
      this.dustGeo.setAttribute("aSeed", new THREE.BufferAttribute(dseed, 4));
      this.dustMat = new THREE.ShaderMaterial({
        vertexShader: DUST_VERT,
        fragmentShader: DUST_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
          uOpacity: { value: 1 },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this.dustPoints = new THREE.Points(this.dustGeo, this.dustMat);
      this.dustPoints.frustumCulled = false;
      this.dustPoints.visible = false;
      this.scene.add(this.dustPoints);
    }

    // --- 连线 ---
    const degrees = new Map<number,number>();
    this.edgeList = [...connections].sort((a,b)=>b.strength-a.strength).filter(c=> {
      if((degrees.get(c.a)??0)>=3 || (degrees.get(c.b)??0)>=3) return false;
      degrees.set(c.a,(degrees.get(c.a)??0)+1); degrees.set(c.b,(degrees.get(c.b)??0)+1); return true;
    }).map((c) => ({
      a: this.indexById.get(c.a) ?? -1,
      b: this.indexById.get(c.b) ?? -1,
      strength: c.strength,
    })).filter((e) => e.a >= 0 && e.b >= 0);

    if (this.lines) {
      this.scene.remove(this.lines);
      this.lineGeo.dispose();
      this.lineMat.dispose();
    }
    const lpos = new Float32Array(this.edgeList.length * 6);
    const lalpha = new Float32Array(this.edgeList.length * 2);
    const lseed = new Float32Array(this.edgeList.length * 2);
    for (let i = 0; i < this.edgeList.length; i++) {
      lalpha[i * 2] = THREE.MathUtils.clamp(this.edgeList[i].strength * 0.16, 0.03, 0.26);
      lalpha[i * 2 + 1] = lalpha[i * 2];
      lseed[i] = rand(i * 13.7);
      lseed[i + this.edgeList.length] = lseed[i];
    }
    this.lineGeo = new THREE.BufferGeometry();
    this.lineGeo.setAttribute("position", new THREE.BufferAttribute(lpos, 3));
    this.lineGeo.setAttribute("aAlpha", new THREE.BufferAttribute(lalpha, 1));
    this.lineGeo.setAttribute("aSeed", new THREE.BufferAttribute(lseed, 1));
    this.lineMat = new THREE.ShaderMaterial({
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      uniforms: { uTime: { value: 0 }, uGlobal: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.lines = new THREE.LineSegments(this.lineGeo, this.lineMat);
    this.lines.frustumCulled = false;
    this.lines.visible = false; // 旧关系图只保留数据，不在宇宙或相册中绘制悬停连线。
    this.scene.add(this.lines);

    // --- 照片星辰锚定在可视旋臂上(稳定 seed,不随进入重排) ---
    // 力导向布局会把节点再次拉离 Astra 骨架；这里固定在同一条可视旋臂上。
    this.anchorNodesOnArms(initNodes, photos);
    this.worker?.terminate();
    this.worker = null;
    const anchorArr = new Float32Array(photos.length * 3);
    for (const n of initNodes) {
      const i = this.indexById.get(n.id);
      if (i === undefined) continue;
      anchorArr[i * 3] = n.x; anchorArr[i * 3 + 1] = n.y; anchorArr[i * 3 + 2] = n.z;
    }
    this.positions = anchorArr;
    // 非默认形态:用页面注册表给的三维布局覆盖旋臂坐标
    if (this.shapeId !== DEFAULT_SHAPE) this.relayoutPositions();
    this.applyPositions();

    // --- 相册标签 DOM(名称 + 记忆数量) ---
    if (this.labelContainer) {
      this.labelContainer.innerHTML = "";
      for (const c of this.clusters) {
        const el = document.createElement("div");
        el.className = "cluster-label";
        el.style.pointerEvents = 'auto'; el.tabIndex = 0; el.setAttribute('role','button');
        el.onclick = () => this.focusCluster(c.albumId);
        el.onkeydown = (e) => { if(e.key === 'Enter') this.focusCluster(c.albumId); };
        el.innerHTML =
          `<div class="n">${escapeHtml(c.name)}</div>` +
          `<div class="c">${c.nodeIndexes.length} 张记忆</div>`;
        this.labelContainer.appendChild(el);
        c.labelEl = el;
      }
    }
    // --- 相册区域:同一宇宙中的另一片空间,每个相册一座星系(稳定锚点) ---
    if(preserveAlbumDraft&&this.albumNodes.length){
      for(const albumNode of this.albumNodes){
        const album=albums.find(a=>a.id===albumNode.albumId);if(!album)continue;
        const members=new Set(album.photoIds??[]),config=albumGalaxyConfig(album);
        if(albumNode.labelEl)albumNode.labelEl.innerHTML=`<div class="n">${escapeHtml(album.name)}</div><div class="c">${album.photoCount} 张记忆</div>`;
        for(const node of this.albumPhotoNodes.filter(n=>n.albumId===album.id)){
          const retained=members.has(node.photoId);node.root.userData.retireWhenHidden=!retained;
          node.root.userData.displayTarget=retained&&(config.photoIds===null||config.photoIds.includes(node.photoId))?1:0;
        }
      }
    } else this.rebuildAlbumRegion(albums, photos);

    this.cards.forEach((m) => { this.cardGroup.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); });
    this.cards.clear();
    this.applyUniverseSpin();
  }

  /** 相册星系目录:照片粒子球本身沿旋臂排布，没有第二套装饰星系。 */
  private rebuildAlbumRegion(albums: Album[], photos: GalaxyPhoto[]) {
    this.clearAlbumRibbon();
    this.clearAlbumInterior();
    for (const n of this.albumNodes) {
      this.albumRegionGroup.remove(n.root);
      n.proxy.geometry.dispose();
      (n.proxy.material as THREE.Material).dispose();
      n.labelEl?.remove();
    }
    this.albumNodes = [];
    const rngSeed = (id: number) => { let v = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b); v ^= v >>> 13; return v >>> 0; };
    const mulberry = (seed: number) => () => { let t = seed >>> 0; t += 0x6d2b79f5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
    const withPhotos = albums.filter((a) => photos.some((p) => a.photoIds ? a.photoIds.includes(p.id) : p.albumId === a.id));
    const golden = Math.PI * (3 - Math.sqrt(5));
    withPhotos.forEach((album, index) => {
      const rng = mulberry(rngSeed(album.id));
      const configuration = albumGalaxyConfig(album);
      const membership = new Set(album.photoIds);
      const albumPhotos = photos.filter((p) => album.photoIds ? membership.has(p.id) : p.albumId === album.id);
      const root = new THREE.Group();
      const layer = Math.floor(index / 7);
      const radius = withPhotos.length === 1 ? 0 : Math.min(36, 15 + layer * 10 + (index % 3) * 2.2);
      const position = new THREE.Vector3(
        ALBUM_REGION.x + Math.cos(index * golden) * radius,
        ALBUM_REGION.y + Math.sin(index * golden) * radius * .8,
        ALBUM_REGION.z + Math.sin(index * 1.7) * 2,
      );
      root.position.copy(position);
      root.rotation.z = (rng() - 0.5) * 0.7;
      root.scale.setScalar(1);
      const proxy = new THREE.Mesh(
        new THREE.SphereGeometry(7.2, 16, 12),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, colorWrite: false, depthWrite: false }),
      );
      proxy.userData = { albumId: album.id, kind: "album" };
      root.add(proxy);
      const armCount = 3;
      const perArm = Math.max(1, Math.ceil(albumPhotos.length / armCount));
      albumPhotos.forEach((photo, photoIndex) => {
        const photoSeed = Math.abs(Math.imul(photo.id ^ 0x85ebca6b, 0xc2b2ae35));
        const arm = photoIndex % armCount;
        const progress = (Math.floor(photoIndex / armCount) + 0.72) / (perArm + 0.72);
        const angle = arm * Math.PI * 2 / armCount + progress * Math.PI * 1.75;
        const radius2 = 1.1 + progress * 7.3;
        const home = new THREE.Vector3(
          Math.cos(angle) * radius2,
          Math.sin(angle) * radius2 * 0.72,
          (((photoSeed >>> 5) % 1000) / 1000 - 0.5) * (0.55 + progress * 1.25),
        );
        const saved = configuration.positions?.[String(photo.id)];
        const node=this.createAlbumPhotoNode(root,album.id,photo,home,configuration.photoIds===null||configuration.photoIds.includes(photo.id));
        if(saved){node.home.fromArray(saved);node.root.position.copy(node.home);node.root.userData.fixed=true;}
      });
      this.albumRegionGroup.add(root);
      this.albumNodes.push({ albumId: album.id, root, proxy, position, labelEl: null });
    });
    // 相册标签 DOM
    if (this.labelContainer) {
      for (const n of this.albumNodes) {
        const album = albums.find((a) => a.id === n.albumId);
        const el = document.createElement("div");
        el.className = "cluster-label album-region-label";
        el.style.opacity = "0";
        el.style.pointerEvents = "none";
        const count = album?.photoCount ?? 0;
        el.innerHTML = `<div class="n">${escapeHtml(album?.name ?? "相册")}</div><div class="c">${count} 张记忆</div>`;
        this.labelContainer.appendChild(el);
        n.labelEl = el;
      }
    }
  }

  /** Append one photo to the existing galaxy; never rearrange its neighbours. */
  private createAlbumPhotoNode(parent:THREE.Group,albumId:number,photo:{id:number;avgColor:string|null},home:THREE.Vector3,visible:boolean,draft=false) {
    const root=new THREE.Group();root.position.copy(home);
    root.userData.randomHome=home.clone();root.userData.fixed=false;
    root.userData.displayTarget=visible?1:0;root.userData.displayAmount=draft?0:root.userData.displayTarget;
    root.userData.draftLoading=draft;root.visible=visible;
    const color=(()=>{try{return new THREE.Color(photo.avgColor??"#8fc7ef");}catch{return new THREE.Color("#8fc7ef");}})();
    const lod=makeGlowSprite(color,1.25);lod.material.opacity=draft?0:.72;
    const proxy=new THREE.Mesh(new THREE.SphereGeometry(PHOTO_SPHERE_DEFAULTS.radius*.48,20,16),new THREE.MeshBasicMaterial({transparent:true,opacity:0,colorWrite:false,depthWrite:false}));
    proxy.scale.setScalar(this.photoSphereSettings.radius/PHOTO_SPHERE_DEFAULTS.radius);
    proxy.userData={photoId:photo.id,albumId,kind:"album-photo"};
    root.add(lod,proxy);parent.add(root);
    const node:GalaxyScene["albumPhotoNodes"][number]={photoId:photo.id,albumId,particles:null,root,proxy,lod,home:home.clone(),offset:new THREE.Vector3(),velocity:new THREE.Vector3(),hoverTarget:new THREE.Vector3(),phase:(Math.abs(Math.imul(photo.id^0x85ebca6b,0xc2b2ae35))%628)/100};
    this.albumPhotoNodes.push(node);
    void PhotoParticleSphere.load(`http://tm.localhost/thumb/${photo.id}`,"low",this.photoSphereSettings).then(particles=>{
      if(!this.albumPhotoNodes.includes(node)){particles.dispose();return;}
      particles.setCurvature(1);particles.setPointerGain(4);particles.points.scale.setScalar(.48);particles.setOpacity(draft?0:.66);
      this.pendingAlbumParticles.set(root,particles);
    }).catch(()=>{root.userData.draftLoading=false;});
    return node;
  }

  private disposeAlbumPhotoNode(node:GalaxyScene["albumPhotoNodes"][number]) {
    this.pendingAlbumParticles.get(node.root)?.dispose();this.pendingAlbumParticles.delete(node.root);
    node.root.removeFromParent();node.particles?.dispose();node.lod.material.dispose();node.proxy.geometry.dispose();(node.proxy.material as THREE.Material).dispose();
    this.albumPhotoNodes=this.albumPhotoNodes.filter(n=>n!==node);
  }

  private clearAlbumInterior() {
    for (const particles of this.pendingAlbumParticles.values()) particles.dispose();
    this.pendingAlbumParticles.clear();
    for (const n of this.albumPhotoNodes) {
      n.root.parent?.remove(n.root);
      n.particles?.dispose();
      n.lod.material.dispose();
      n.proxy.geometry.dispose();
      (n.proxy.material as THREE.Material).dispose();
    }
    this.albumPhotoNodes = [];
  }

  /**
   * 照片星辰沿可视旋臂分布:与 Astra 银河同一世界变换,远景看就是旋臂上的小星星,
   * 靠近后才知道是照片粒子球。seed 由 photoId 决定,不随进入次数重排。
   */
  private anchorNodesOnArms(initNodes: { id: number; x: number; y: number; z: number }[], photos: GalaxyPhoto[]) {
    const p = new THREE.Vector3();
    for (const c of this.clusters) {
      const arm = c.arm;
      const base = c.armProgress;
      for (const photoIndex of c.nodeIndexes) {
        const photo = photos[photoIndex];
        if (!photo || !initNodes[photoIndex]) continue;
        const seed = Math.abs(Math.imul(photo.id ^ 0x9e3779b9, 0x85ebca6b));
        const progress = THREE.MathUtils.clamp(base + ((seed % 1000) / 1000 - 0.35) * 0.12, 0.06, 0.94);
        this.galaxy.armWorldPoint(arm, progress, p);
        // 紧贴臂的小抖动:保持星簇质感又不脱离旋臂
        const j1 = ((seed >>> 3) % 1000) / 1000 - 0.5;
        const j2 = ((seed >>> 7) % 1000) / 1000 - 0.5;
        const j3 = ((seed >>> 11) % 1000) / 1000 - 0.5;
        initNodes[photoIndex].x = p.x + j1 * 8;
        initNodes[photoIndex].y = p.y + j2 * 6;
        initNodes[photoIndex].z = p.z + j3 * 8;
      }
    }
  }

  /** 记忆坐标上球:有 GPS 的照片成为地球上的光点;地球交接默认朝向记忆质心 */
  setMemoryDots(points: { lat: number; lng: number }[]) {
    if (!this.earth) return;
    this.earth.setMemoryDots(points);
    if (points.length) {
      let lat = 0, lng = 0;
      for (const p of points) { lat += p.lat; lng += p.lng; }
      this.handoffLatLng = { lat: lat / points.length, lng: lng / points.length };
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const loop = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      // 跳帧而不是缩小 dt:clock 仍按真实时间推进,动画速度不变。
      if (this.minFrameMs > 0 && now - this.lastFrameTs < this.minFrameMs) return;
      this.lastFrameTs = now;
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** 限制渲染帧率(0 或负数表示不限)。桌面壁纸模式下用 30fps 换取常驻时的 GPU 占用。 */
  setMaxFps(fps: number) {
    this.minFrameMs = fps > 0 ? 1000 / fps : 0;
  }

  /** 切换页面形态。默认旋臂沿用原有 Astra 布局,其他形态按注册表的 layout 重排。 */
  setShape(id: string) {
    if (this.shapeId === id) {
      // 首次挂载时 shapeId 已经是默认值，这里补建一次形态星尘
      this.syncShapeDust();
      this.applyShapeLook();
      return;
    }
    this.shapeId = id;
    this.syncBody();
    this.syncShapeDust();
    this.applyShapeLook();
    if (this.lastData) {
      // 照片集合可能没变,必须强制重建一次才能把布局换掉
      this.sceneDataSignature = "";
      const [photos, albums, connections] = this.lastData;
      this.setData(photos, albums, connections);
    }
  }

  /**
   * 图形决定整个画面的「光点」怎么排,而不只是换了个背景:
   *  - 旋臂星系:沿用 Astra 参考银河(它本身就是旋臂),星野保持原样;
   *  - 其它形态:收掉参考银河,把星野重排成该形态。
   * 之前只重排了照片节点,而满屏主导视觉是固定的旋臂星点,所以看起来什么都没变。
   */
  private applyShapeLook() {
    const shape = shapeOf(this.shapeId);
    if (shape.id === "spiral") {
      this.starfield?.applyShape(null);
      this.starfield?.setLook(null, 1);
      this.galaxyFadeTarget = 1;
      return;
    }
    this.starfield?.applyShape(shape.layout);
    // 球状星云做成贾维斯那种蓝色全息球:整片星点统一冷蓝并提亮,
    // 外面再裹一层真正的 3D 体积星云(会旋转、随时间翻卷)。
    if (shape.id === "sphere") {
      this.starfield?.setLook(new THREE.Color("#3fa6ff"), 1.35, 0.92);
    } else {
      this.starfield?.setLook(null, 1);
    }
    this.galaxyFadeTarget = 0;
  }

  /** 有主视觉天体的形态挂对应天体,其余撤掉 */
  private syncBody() {
    const kind = isBodyKind(this.shapeId) ? this.shapeId : null;
    // 只在「目标天体确实就是当前这个」时才跳过重建。
    // 原判断 `(kind === null) === (this.body === null)` 只比了"有没有"而没比"是哪一个",
    // 于是 环带行星 → 金色光环 → 粒子星云 互相切换时会直接 return,画面纹丝不动。
    if (this.bodyKind === kind) return;
    if (this.body) {
      // dispose 只释放资源、清空子节点,不会自动从场景里摘掉,得手动 remove。
      this.scene.remove(this.body.group);
      disposeBody(this.body);
    }
    this.body = null;
    this.bodyKind = null;
    if (kind) {
      this.body = buildBody(kind);
      this.bodyKind = kind;
      this.scene.add(this.body.group);
    }
  }

  /**
   * 形态星尘：同一个 layout 采样出一层暗淡点云。
   * 有独立天体的形态（环带行星/金色光环/粒子星云）不需要它；
   * 其余形态在没有照片时会完全空白，有了这层才能看出"选了哪个图形"。
   */
  private syncShapeDust() {
    if (isBodyKind(this.shapeId)) {
      this.disposeShapeDust();
      return;
    }
    if (this.dustShapeId === this.shapeId && this.shapeDust) return;

    this.disposeShapeDust();

    const COUNT = 2600;
    const positions = new Float32Array(COUNT * 3);
    const layout = shapeOf(this.shapeId).layout;
    const rnd = (n: number) => {
      const x = Math.sin(n * 12.9898 + 4.1414) * 43758.5453;
      return x - Math.floor(x);
    };
    for (let i = 0; i < COUNT; i++) {
      const p = layout(i, COUNT);
      positions[i * 3] = p.x + (rnd(i * 3) - 0.5) * 2.6;
      positions[i * 3 + 1] = p.y + (rnd(i * 3 + 1) - 0.5) * 2.6;
      positions[i * 3 + 2] = p.z + (rnd(i * 3 + 2) - 0.5) * 2.6;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const isGlobe = this.shapeId === "sphere";
    const mat = new THREE.PointsMaterial({
      size: isGlobe ? 0.85 : 0.62,
      color: new THREE.Color(isGlobe ? 0x4fb0ff : 0x8fb4ff),
      transparent: true,
      opacity: isGlobe ? 0.5 : 0.3,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geom, mat);
    points.frustumCulled = false;
    points.renderOrder = -1;
    this.scene.add(points);

    this.shapeDust = { points, geom, mat };
    this.dustShapeId = this.shapeId;
  }

  private disposeShapeDust() {
    if (!this.shapeDust) return;
    this.scene.remove(this.shapeDust.points);
    this.shapeDust.geom.dispose();
    this.shapeDust.mat.dispose();
    this.shapeDust = null;
    this.dustShapeId = null;
  }

  /** 只重写坐标数组,不重建粒子 */
  private relayoutPositions() {
    if (!this.positions?.length) return;
    const total = this.positions.length / 3;
    const layout = shapeOf(this.shapeId).layout;
    for (let i = 0; i < total; i++) {
      const p = layout(i, total);
      this.positions[i * 3] = p.x;
      this.positions[i * 3 + 1] = p.y;
      this.positions[i * 3 + 2] = p.z;
    }
  }

  /**
   * 把用户选的某张照片铺成页面背景。
   * 原图半透明垫在星系后方。strength 是 0-100 的存在感,只改强度时不会重新下载纹理。
   */
  setBackdrop(url: string | null, strength = 42) {
    const nextStrength = Math.max(0, Math.min(100, strength));
    const key = `${url ?? ""}|${nextStrength}`;
    if (key === this.backdropKey) return;

    const urlChanged = this.backdropUrl !== url;
    this.backdropKey = key;
    this.backdropStrength = nextStrength;

    // 拖强度滑块时只改材质透明度,不重新采样图像
    const hasVisual = !!this.backdropMesh;
    if (url && !urlChanged && this.backdropTexture && (hasVisual || nextStrength === 0)) {
      this.applyBackdropOpacity();
      return;
    }

    this.clearBackdropVisual();

    if (!url) {
      this.backdropUrl = null;
      this.disposeBackdropTexture();
      return;
    }
    if (!urlChanged && this.backdropTexture) {
      this.buildBackdrop();
      return;
    }
    this.backdropUrl = url;
    this.disposeBackdropTexture();
    new THREE.TextureLoader().load(url, (tex) => {
      // 加载期间用户可能已经换页
      if (this.backdropUrl !== url) {
        tex.dispose();
        return;
      }
      tex.colorSpace = THREE.SRGBColorSpace;
      this.backdropTexture = tex;
      this.buildBackdrop();
    });
  }

  private applyBackdropOpacity() {
    const alpha = this.backdropStrength / 100;
    if (this.backdropMesh) {
      (this.backdropMesh.material as THREE.MeshBasicMaterial).opacity = alpha;
    }
  }

  private disposeBackdropTexture() {
    if (this.backdropTexture) {
      this.backdropTexture.dispose();
      this.backdropTexture = null;
    }
  }

  private clearBackdropVisual() {
    if (this.backdropMesh) {
      this.scene.remove(this.backdropMesh);
      this.backdropMesh.geometry.dispose();
      (this.backdropMesh.material as THREE.Material).dispose();
      this.backdropMesh = null;
    }
  }

  private buildBackdrop() {
    const tex = this.backdropTexture;
    if (!tex) return;
    const alpha = this.backdropStrength / 100;
    if (alpha <= 0) return;

    const image = tex.image as { width?: number; height?: number } | null;
    const w = image?.width ?? 1600;
    const h = image?.height ?? 1000;
    const aspect = h > 0 ? w / h : 1.6;
    const height = 420;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(height * aspect, height),
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: alpha,
        depthWrite: false,
        fog: false,
      }),
    );
    mesh.position.set(0, 0, -330);
    mesh.renderOrder = -10;
    this.backdropMesh = mesh;
    this.scene.add(mesh);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose() {
    this.stop();
    disposeBody(this.body);
    this.body = null;
    this.clearBackdropVisual();
    this.disposeBackdropTexture();
    this.clearPhotoSettle();
    this.disposePhotoCloud();
    this.journey.cancel();
    this.sphereSettingsListener && window.removeEventListener("photo-sphere-settings", this.sphereSettingsListener);
    for (const id of [...this.photoSpheres.keys()]) this.disposePhotoSphere(id);
    for (const particles of this.pendingAlbumParticles.values()) particles.dispose();
    this.pendingAlbumParticles.clear();
    for (const n of this.albumPhotoNodes) { n.particles?.dispose(); n.lod.material.dispose(); n.proxy.geometry.dispose(); (n.proxy.material as THREE.Material).dispose(); }
    this.albumPhotoNodes = [];
    for (const n of this.albumNodes) { n.proxy.geometry.dispose(); (n.proxy.material as THREE.Material).dispose(); n.labelEl?.remove(); }
    this.albumNodes = [];
    this.earth?.dispose();
    this.tunnel?.dispose();
    this.worker?.terminate();
    this.worker = null;
    this.unbindEvents();
    this.rig.dispose();
    this.texPool.clear();
    this.cards.forEach((m) => {
      (m.material as THREE.Material).dispose();
      m.geometry.dispose();
    });
    this.cards.clear();
    this.starfield?.dispose();
    this.backdrop?.dispose();
    this.galaxy?.dispose();
    if (this.nodePoints) { this.nodeGeo.dispose(); this.nodeMat.dispose(); }
    if (this.lines) { this.lineGeo.dispose(); this.lineMat.dispose(); }
    this.clusters.forEach((c) => {

      (c.glow.material as THREE.SpriteMaterial).dispose();
    });
    if (this.heart) {

      (this.heart.material as THREE.SpriteMaterial).dispose();
      this.heart = null;
    }
    if (this.earthStar) {
      this.earthStar.material.dispose();
      this.earthStar = null;
    }
    for (const s of this.nebulae) {

      (s.material as THREE.SpriteMaterial).dispose();
    }
    this.nebulae = [];
    if (this.dustPoints) {
      this.dustGeo?.dispose();
      this.dustMat?.dispose();
      this.dustPoints = null;
    }
    this.cardMat.dispose();
    this.composer?.dispose();
    this.renderer?.dispose();
    this.scene.clear();
  }

  resize() {
    if (!this.renderer || !this.canvas) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w,h);
    this.backdrop?.resize(w,h);
    this.rig.resize(w / Math.max(1, h));
  }

  // ---------- 交互 ----------

  private albumRibbon: {
    amount: number; closing: boolean; index: number; scroll: number;
    items: { node: GalaxyScene["albumPhotoNodes"][number]; position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3; card: THREE.Mesh<THREE.PlaneGeometry,THREE.MeshBasicMaterial>; x: number; targetScale: number }[];
  } | null = null;

  setAlbumRibbon(action: "toggle" | "previous" | "next") {
    if (this.photoFocusActive || this.albumEditor || this.place !== "album" || this.journey.activeDestination) return;
    if (this.albumRibbon) {
      if(action === "toggle") this.albumRibbon.closing = !this.albumRibbon.closing;
      else this.albumRibbon.index = THREE.MathUtils.clamp(this.albumRibbon.index + (action === "next" ? 1 : -1), 0, this.albumRibbon.items.length - 1);
      this.emitRibbon(); return;
    }
    if(action !== "toggle")return;
    const nodes=this.albumPhotoNodes.filter(n=>n.albumId===this.albumFocus && Number(n.root.userData.displayTarget??1)>0 && n.particles);
    if(!nodes.length)return;
    const items: NonNullable<GalaxyScene["albumRibbon"]>["items"]=[];
    let x=0;
    for(const node of nodes){
      const sphere=node.particles!;
      const height=3.5, width=height*sphere.aspect;
      const card=new THREE.Mesh(new THREE.PlaneGeometry(4.42,4.42/sphere.aspect),new THREE.MeshBasicMaterial({map:sphere.photoTexture,transparent:true,opacity:0,depthTest:false,depthWrite:false,toneMapped:false}));
      card.scale.setScalar(.48);card.renderOrder=71;card.userData={kind:"album-photo",photoId:node.photoId,albumId:node.albumId};
      node.root.add(card);
      items.push({node,position:node.root.position.clone(),quaternion:node.root.quaternion.clone(),scale:node.root.scale.clone(),card,x:x+width/2,targetScale:height/(4.42/sphere.aspect*.48)});
      x+=width+.65;
    }
    this.rig.cancel();this.rig.controls.enabled=false;
    this.albumRibbon={amount:0,closing:false,index:0,scroll:items[0].x,items};
    this.emitRibbon();
  }

  private emitRibbon(){
    window.dispatchEvent(new CustomEvent("album-ribbon-state",{detail:{expanded:!!this.albumRibbon,index:this.albumRibbon?.index??0,count:this.albumRibbon?.items.length??0}}));
  }

  private clearAlbumRibbon(){
    const ribbon=this.albumRibbon;if(!ribbon)return;
    for(const item of ribbon.items){
      item.node.root.position.copy(item.position);item.node.root.quaternion.copy(item.quaternion);item.node.root.scale.copy(item.scale);
      item.node.particles?.setCurvature(1);item.node.particles?.setOpacity(.66);
      item.node.root.remove(item.card);item.card.geometry.dispose();item.card.material.dispose();
    }
    this.albumRibbon=null;this.rig.cancel();this.rig.controls.enabled=this.active;this.emitRibbon();
  }

  private updateAlbumRibbon(dt:number){
    const ribbon=this.albumRibbon;if(!ribbon)return;
    const step=Math.min(dt,.04);
    if(!this.photoFocusActive)ribbon.amount=THREE.MathUtils.clamp(ribbon.amount+step*(ribbon.closing?-1:1)/1.9,0,1);
    const leading=ribbon.items[ribbon.index];
    const halfWidth=12*Math.tan(THREE.MathUtils.degToRad(this.rig.camera.fov/2))*this.rig.camera.aspect;
    const photoHalfWidth=4.42*.48*leading.targetScale/2;
    const leftAligned=leading.x+halfWidth-photoHalfWidth-.65;
    if(ribbon.amount<.001)ribbon.scroll=leftAligned;
    ribbon.scroll=THREE.MathUtils.damp(ribbon.scroll,leftAligned,5,step);
    const camera=this.rig.camera;
    const right=new THREE.Vector3(1,0,0).applyQuaternion(camera.quaternion);
    const center=camera.position.clone().addScaledVector(camera.getWorldDirection(new THREE.Vector3()),12);
    for(let i=0;i<ribbon.items.length;i++){
      const item=ribbon.items[i],node=item.node;
      const delay=i/Math.max(1,ribbon.items.length-1)*.3;
      const t=THREE.MathUtils.smootherstep(ribbon.amount,delay,delay+.7);
      const focusBridge=getSpherePhotoBridge(this.photoStarId);
      const focusIndex=ribbon.items.findIndex(entry=>entry.node.photoId===this.photoStarId);
      const clearance=focusBridge?THREE.MathUtils.smootherstep(focusBridge.progress,0,1)*9:0;
      const aside=focusIndex>=0&&i!==focusIndex?(i<focusIndex?-clearance:clearance):0;
      const target=center.clone().addScaledVector(right,item.x-ribbon.scroll+aside);
      const parent=node.root.parent!;parent.updateWorldMatrix(true,false);
      parent.worldToLocal(target);
      const rotation=parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(camera.quaternion);
      node.root.position.lerpVectors(item.position,target,t);
      node.root.quaternion.copy(item.quaternion).slerp(rotation,t);
      node.root.scale.copy(item.scale).lerp(new THREE.Vector3().setScalar(item.targetScale),t);
      const photo=THREE.MathUtils.smoothstep(t,.28,1);
      node.particles?.setCurvature(1-t);node.particles?.setOpacity(.66*(1-photo));
      const bridge=node.photoId===this.photoStarId?getSpherePhotoBridge(node.photoId):undefined;
      item.card.material.opacity=photo*(bridge?1-THREE.MathUtils.smoothstep(bridge.progress,0,.28):focusBridge?1-.86*THREE.MathUtils.smoothstep(focusBridge.progress,0,1):1);
      item.card.visible=item.card.material.opacity>.001;
      node.root.updateWorldMatrix(true,true);
    }
    if(ribbon.amount===0&&ribbon.closing)this.clearAlbumRibbon();
  }

  private albumCommitPending=false;
  private albumEditor: { id: number; snapshots: { node: GalaxyScene["albumPhotoNodes"][number]; position: THREE.Vector3; home: THREE.Vector3; offset: THREE.Vector3; fixed: boolean; visible: boolean; temporary?:boolean }[] } | null = null;
  private albumEditDrag: { node: GalaxyScene["albumPhotoNodes"][number]; plane: THREE.Plane; offset: THREE.Vector3 } | null = null;

  editAlbum(command: { action: string; id: number; photoIds?: number[]; memberIds?:number[]; photos?:{id:number;avgColor:string|null}[]; manual?: boolean }) {
    if (command.action === "begin") {
      if (this.place !== "album" || this.albumFocus !== command.id || this.photoFocusActive) return;
      this.albumEditor = {id: command.id, snapshots: this.albumPhotoNodes.filter(n => n.albumId === command.id&&!n.root.userData.retireWhenHidden).map(node => ({node,position:node.root.position.clone(),home:node.home.clone(),offset:node.offset.clone(),fixed:!!node.root.userData.fixed,visible:Number(node.root.userData.displayTarget??1)>0}))};
    } else if (this.albumEditor?.id === command.id) {
      if (command.action === "add") {
        const parent=this.albumNodes.find(n=>n.albumId===command.id)?.root;
        if(!parent)return;
        for(const photo of command.photos??[]) {
          const existing=this.albumPhotoNodes.find(n=>n.albumId===command.id&&n.photoId===photo.id);
          if(existing){
            if(!this.albumEditor.snapshots.some(s=>s.node===existing))this.albumEditor.snapshots.push({node:existing,position:existing.root.position.clone(),home:existing.home.clone(),offset:existing.offset.clone(),fixed:!!existing.root.userData.fixed,visible:false,temporary:true});
            existing.root.userData.retireWhenHidden=false;existing.root.userData.displayTarget=1;continue;
          }
          const neighbours=this.albumPhotoNodes.filter(n=>n.albumId===command.id&&Number(n.root.userData.displayTarget)>0);
          const center=new THREE.Vector3();for(const n of neighbours)center.add(n.root.position);if(neighbours.length)center.divideScalar(neighbours.length);
          let home=center.clone(),best=-1;
          for(let k=0;k<240;k++){
            const angle=photo.id*2.39996+k*2.39996,radius=.8+Math.sqrt(k)*.46;
            const candidate=center.clone().add(new THREE.Vector3(Math.cos(angle)*radius,Math.sin(angle)*radius*.78,Math.sin(photo.id+k)*.3));
            const clearance=neighbours.reduce((d,n)=>Math.min(d,candidate.distanceTo(n.root.position)),Infinity);
            if(clearance>best){best=clearance;home=candidate;}
            if(clearance>1.6)break;
          }
          home.clampScalar(-28,28);
          const node=this.createAlbumPhotoNode(parent,command.id,photo,home,true,true);
          this.albumEditor.snapshots.push({node,position:home.clone(),home:home.clone(),offset:new THREE.Vector3(),fixed:false,visible:false,temporary:true});
        }
      } else if (command.action === "show") {
        const ids = new Set(command.photoIds);
        for (const {node} of this.albumEditor.snapshots) node.root.userData.displayTarget = ids.has(node.photoId) ? 1 : 0;
      } else if (command.action === "random") {
        for (const {node} of this.albumEditor.snapshots) {
          node.root.position.copy(node.root.userData.randomHome); node.home.copy(node.root.position);
          node.offset.set(0,0,0); node.velocity.set(0,0,0); node.root.userData.fixed = false;
        }
      } else if (command.action === "cancel" || command.action === "finish") {
        for (const snapshot of this.albumEditor.snapshots) {
          const node = snapshot.node;
          if (command.action === "cancel") {
            if(snapshot.temporary){node.root.userData.displayTarget=0;node.root.userData.retireWhenHidden=true;continue;}
            node.root.position.copy(snapshot.position); node.home.copy(snapshot.home); node.offset.copy(snapshot.offset);
            node.root.userData.displayTarget = snapshot.visible ? 1 : 0; node.root.userData.fixed = snapshot.fixed;
          } else {
            if(command.memberIds&&!command.memberIds.includes(node.photoId)){node.root.userData.displayTarget=0;node.root.userData.retireWhenHidden=true;}
            node.home.copy(node.root.position); node.offset.set(0,0,0); node.root.userData.fixed = !!command.manual;
          }
          node.velocity.set(0,0,0);
        }
        if(command.action==="finish")this.albumCommitPending=true;
        this.albumEditor = null; this.albumEditDrag = null;
        this.rig.controls.enabled = this.active;
        return;
      }
    }
    this.emitAlbumLayout();
  }

  private emitAlbumLayout() {
    if (!this.albumEditor) return;
    const positions: Record<string, number[]> = {};
    for (const {node} of this.albumEditor.snapshots) positions[node.photoId] = node.root.position.toArray();
    window.dispatchEvent(new CustomEvent("album-editor-layout", {detail:{id:this.albumEditor.id,positions}}));
  }

  private albumMotionTime = 0;

  private updateAlbumPhotoMotion(dt: number) {
    if (this.sphereFocus || this.albumRibbon) return;
    const nodes = this.albumPhotoNodes.filter(n => !n.root.userData.fixed && n.albumId !== this.albumEditor?.id);
    const step = Math.min(dt, .04);
    this.albumMotionTime += step;
    const t = this.albumMotionTime;
    const limit = 1.25;
    const clearance = (this.photoSphereSettings.radius + .18) * .96;
    const desired = new THREE.Vector3();
    const delta = new THREE.Vector3();
    // 每颗球具有独立的非周期组合轨迹；锚点、照片和往返状态保持不变。
    for (const n of nodes) {
      const seed = n.photoId * 2.39996 + n.albumId * .731;
      desired.set(
        Math.sin(t * .19 + seed) * .65 + Math.sin(t * .113 + seed * 3.1) * .22,
        Math.sin(t * .157 + seed * 1.7) * .6,
        Math.sin(t * .137 + seed * 2.3) * .5,
      ).add(n.hoverTarget).clampLength(0, limit);
      n.velocity.addScaledVector(desired.sub(n.offset), step * 1.4);
      n.velocity.multiplyScalar(Math.exp(-2.1 * step));
    }
    // 提前减速避让，接近时只移除相向速度，不产生碰撞弹跳。
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        if (a.albumId !== b.albumId) continue;
        delta.copy(a.root.position).sub(b.root.position);
        const distance = delta.length();
        if (distance >= clearance + .7) continue;
        if (distance < .0001) delta.set(1, 0, 0); else delta.divideScalar(distance);
        const approach = a.velocity.dot(delta) - b.velocity.dot(delta);
        const permitted = Math.max(0, distance - clearance) * .6;
        if (approach < -permitted) {
          const correction = (-permitted - approach) * .5;
          a.velocity.addScaledVector(delta, correction);
          b.velocity.addScaledVector(delta, -correction);
        }
        if (distance < clearance) {
          const push = (clearance - distance) * step * 1.5;
          a.velocity.addScaledVector(delta, push);
          b.velocity.addScaledVector(delta, -push);
        }
      }
    }
    for (const n of nodes) {
      n.velocity.clampLength(0, .32);
      n.offset.addScaledVector(n.velocity, step).clampLength(0, limit);
      n.root.position.copy(n.home).add(n.offset);
      n.root.updateWorldMatrix(true, true);
    }
  }

  private updatePhotoSpherePointer() {
    for (const entry of this.photoSpheres.values()) { entry.sphere?.setPointer(null); entry.hoverTarget.set(0, 0, 0); }
    for (const node of this.albumPhotoNodes) {
      node.particles?.setPointer(null);
      node.hoverTarget.set(0, 0, 0);
    }
    if (!this.photoPointerOnCanvas || this.orbiting || this.galaxyDragging || this.journey.activeDestination || this.photoFocusActive || this.universe === "locked") return;
    this.rig.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.pointerNdc, this.rig.camera);

    const candidates: { proxy: THREE.Mesh; sphere: PhotoParticleSphere }[] = [];
    if (this.place === "universe") {
      for (const entry of this.photoSpheres.values()) {
        if (entry.sphere && entry.proxy.visible && entry.sphere.points.visible) candidates.push({ proxy: entry.proxy, sphere: entry.sphere });
      }
    } else if (this.place === "shelf" || this.place === "album") {
      for (const node of this.albumPhotoNodes) {
        if (!node.particles || !node.root.visible || !node.root.parent?.visible) continue;
        node.root.updateWorldMatrix(true, true);
        if (this.place === "album" && node.albumId !== this.albumFocus) continue;
        candidates.push({ proxy: node.proxy, sphere: node.particles });
      }
    }
    if (!candidates.length) return;

    const hit = this.raycaster.intersectObjects(candidates.map((candidate) => candidate.proxy), false)[0];
    if (!hit) return;
    const candidate = candidates.find((item) => item.proxy === hit.object);
    if (!candidate) return;
    candidate.sphere.points.updateMatrixWorld(true);
    const localDirection = candidate.sphere.points.worldToLocal(hit.point.clone()).normalize();
    candidate.sphere.setPointer(localDirection);
    const universeEntry = this.photoSpheres.get(hit.object.userData.photoId as number);
    if (universeEntry?.proxy === hit.object) {
      universeEntry.hoverTarget.copy(hit.point).sub(universeEntry.proxy.position).normalize()
        .applyQuaternion(this.universeSpin.clone().invert()).multiplyScalar(-.36);
    }
    const node = this.albumPhotoNodes.find((item) => item.proxy === hit.object);
    if (node) {
      // 偏移始终相对于 home；代理球与照片共享 root，命中随显示位置移动。
      const contact = node.root.worldToLocal(hit.point.clone()).normalize();
      node.hoverTarget.copy(contact).multiplyScalar(-.36);
    }
  }

  private ribbonWheelAmount=0;
  private onRibbonWheel=(e:WheelEvent)=>{
    if(!this.albumRibbon||this.photoFocusActive)return;
    e.preventDefault();
    this.ribbonWheelAmount+=e.deltaX+e.deltaY;
    if(Math.abs(this.ribbonWheelAmount)>90){this.setAlbumRibbon(this.ribbonWheelAmount>0?"next":"previous");this.ribbonWheelAmount=0;}
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.albumEditDrag) {
      const drag = this.albumEditDrag, rect = this.canvas.getBoundingClientRect();
      this.raycaster.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,1-(e.clientY-rect.top)/rect.height*2),this.rig.camera);
      const hit = this.raycaster.ray.intersectPlane(drag.plane,new THREE.Vector3());
      if (hit) {
        const local = drag.node.root.parent!.worldToLocal(hit.add(drag.offset));
        local.clampLength(0, 18);
        drag.node.root.position.copy(local); drag.node.root.updateWorldMatrix(true,true);
        this.emitAlbumLayout();
      }
      return;
    }
    this.photoPointerOnCanvas = e.target === this.canvas && (e.buttons & 3) === 0;
    if (this.sphereFocus && !this.photoCloud) {
      const f = this.sphereFocus;
      f.sphere.setPointer(null);
      if (!f.closing && f.progress === 1 && e.target === this.canvas && e.buttons === 0) {
        const bounds = this.canvas.getBoundingClientRect();
        this.raycaster.setFromCamera(new THREE.Vector2((e.clientX - bounds.left) / bounds.width * 2 - 1, 1 - (e.clientY - bounds.top) / bounds.height * 2), this.rig.camera);
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.rig.camera.getWorldDirection(new THREE.Vector3()), f.sphere.points.position);
        const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
        if (hit) {
          const local = f.sphere.points.worldToLocal(hit);
          const x = local.x / 2.21, y = local.y / (Number(f.sphere.points.material.uniforms.uPlaneHeight.value) * .5);
          if (x*x + y*y < 1) f.sphere.setPointer(new THREE.Vector3(x, y, Math.sqrt(1 - x*x - y*y)));
        }
      }
      return;
    }
    const r = this.canvas.getBoundingClientRect();
    const prevNdcX = this.pointerNdc.x, prevNdcY = this.pointerNdc.y;
    this.pointerNdc.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
    // 指针射线喂给星野与环境星:锁屏散星同样可以被扰动
    {
      const ray = new THREE.Ray();
      this.raycaster.setFromCamera(this.pointerNdc, this.rig.camera);
      ray.copy(this.raycaster.ray);
      const speed = Math.hypot(this.pointerNdc.x - prevNdcX, this.pointerNdc.y - prevNdcY);
      const locked = this.universe === "locked";
      if(locked||e.target===this.canvas)this.starfield.setPointerRay(ray.origin, ray.direction, Math.min(.12,speed*(locked?1.6:2.4)));
    }
    const pointerAllowed=this.universe==='locked'||(e.target===this.canvas&&this.place==='universe'&&!this.journey.activeDestination&&!this.photoCloud&&(e.buttons&3)===0);
    this.galaxy.setPointer(pointerAllowed&&Math.abs(this.pointerNdc.x)<=1&&Math.abs(this.pointerNdc.y)<=1 ? this.pointerNdc : null);
    if (this.galaxyDragging && (e.buttons & 1) !== 0) {
      const dx = e.clientX - this.galaxyDragLast.x;
      const dy = e.clientY - this.galaxyDragLast.y;
      this.galaxyDragLast = { x: e.clientX, y: e.clientY };
      // Screen-relative quaternion increments allow complete flips in every
      // direction without Euler angle limits or a pole that locks vertical drag.
      const dragAxis=new THREE.Vector3(dy,dx,0);
      const dragLength=dragAxis.length();
      if(dragLength>0){
        dragAxis.normalize().applyQuaternion(this.rig.camera.quaternion);
        this.universeSpin.premultiply(new THREE.Quaternion().setFromAxisAngle(dragAxis,dragLength*.0032)).normalize();
      }
      this.applyUniverseSpin();
      return;
    }
    // 锁屏/DOM 浮层上只做星辰扰动；照片拾取仍只属于画布本身。
    if (this.universe === "locked" || e.target !== this.canvas) return;
    if ((e.buttons & 2) !== 0) return;
    this.updatePhotoSpherePointer();
    if (this.dragIndex >= 0) {
      this.updateDrag();
      return;
    }
    if (this.orbiting) return;
    // 照片粒子聚焦中:射线打到照片平面,喂给尾迹风流
    if (this.photoCloud) {
      this.raycaster.setFromCamera(this.pointerNdc, this.rig.camera);
      const hit = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.photoPlane, hit)) {
        const cloud = this.photoCloud;
        cloud.points.updateMatrixWorld();
        const local = cloud.points.worldToLocal(hit.clone());
        const now = performance.now();
        const dt = Math.min(0.12, Math.max(0.008, (now - this.photoLastMoveAt) / 1000));
        const dx = local.x - this.photoLastLocal.x;
        const dy = local.y - this.photoLastLocal.y;
        const speed = Math.hypot(dx, dy) / dt;
        if (this.photoLastLocal.x < 8) {
          cloud.setTrail(local.x, local.y, dx, dy, THREE.MathUtils.clamp(speed * 1.6, 0.12, 1));
        }
        this.photoLastLocal.set(local.x, local.y);
        this.photoLastMoveAt = now;
      }
      return;
    }
    this.pick();
  };
  private photoLastMoveAt = 0;

  private syncPickPointer(e: MouseEvent) {
    const rect=this.canvas.getBoundingClientRect();
    this.pointerNdc.set((e.clientX-rect.left)/rect.width*2-1,1-(e.clientY-rect.top)/rect.height*2);
    this.rig.camera.updateMatrixWorld();
    this.scene.updateMatrixWorld(true);
  }

  private onPointerDown = (e: PointerEvent) => {
    if(!this.active || this.journey.activeDestination)return;
    this.syncPickPointer(e);
    if(this.albumRibbon && (this.albumRibbon.amount<1 || this.albumRibbon.closing))return;
    if (this.albumEditor && e.button === 0) {
      const rect=this.canvas.getBoundingClientRect();
      this.raycaster.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,1-(e.clientY-rect.top)/rect.height*2),this.rig.camera);
      const nodes=this.albumEditor.snapshots.map(s=>s.node).filter(n=>n.root.visible);
      for(const n of nodes)n.root.updateWorldMatrix(true,true);
      const hit=this.raycaster.intersectObjects(nodes.map(n=>n.proxy),false)[0];
      const node=nodes.find(n=>n.proxy===hit?.object);
      if(node&&hit){
        const center=node.root.getWorldPosition(new THREE.Vector3());
        this.albumEditDrag={node,plane:new THREE.Plane().setFromNormalAndCoplanarPoint(this.rig.camera.getWorldDirection(new THREE.Vector3()),hit.point),offset:center.sub(hit.point)};
        this.rig.controls.enabled=false;
        window.dispatchEvent(new Event("album-editor-moved"));
      }
      return;
    }
    this.photoPointerOnCanvas = false;
    this.updatePhotoSpherePointer();
    if (e.button === 2) {
      this.downPos = { x: e.clientX, y: e.clientY };
      this.orbiting = true;
      return;
    }
    if (e.button !== 0) return;
    this.downPos = { x: e.clientX, y: e.clientY };
    this.galaxyDragLast = { x: e.clientX, y: e.clientY };
    this.galaxyDragging = this.place === "universe" && this.universe !== "locked" && !this.photoFocusActive && !this.journey.activeDestination;
    this.orbiting = true;
    if (!this.photoCloud && this.universe !== "locked") this.pick();
  };

  private onPointerUp = (e: PointerEvent) => {
    if(this.albumRibbon && (this.albumRibbon.amount<1 || this.albumRibbon.closing)){this.orbiting=false;return;}
    if (this.albumEditor && e.button === 0) {
      this.albumEditDrag=null; this.rig.controls.enabled=true; this.orbiting=false; return;
    }
    this.photoPointerOnCanvas = e.target === this.canvas;
    if (e.button !== 0) {
      this.orbiting = false;
      return;
    }
    const moved = Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y);
    this.galaxyDragging = false;
    if (this.photoFocusActive) {
      this.orbiting = false;
      return; // 照片聚焦中:拖动观察,点击不改变层级
    }
    if (this.dragIndex >= 0) {
      this.worker?.postMessage({ type: "release", index: this.dragIndex });
      this.dragIndex = -1;
      this.canvas.style.cursor = "";
    } else if (this.orbiting && moved < 5 && e.target === this.canvas && !this.journey.activeDestination) {
      this.syncPickPointer(e);
      this.pick();
      if (this.hoveredAlbum >= 0) {
        this.events.onAlbumClick?.(this.hoveredAlbum); // 目录页:单击预选
      } else if (this.hoverCardId >= 0) {
        this.events.onSelectPhoto?.(this.hoverCardId);
      } else if (this.hoveredProxyPhoto >= 0) {
        // 照片星球:点击命中真实球体 → 连续镜头聚焦 → 展开照片 → 详情
        this.events.onSelectPhoto?.(this.hoveredProxyPhoto);
      } else if (this.hovered >= 0) {
        this.focusPhoto(this.hovered);
        this.setState("cluster");
      } else if (this.place === "universe") {
        this.rig.flyTo(GALAXY_VIEW_TARGET.clone(), 172);
        this.setState("overview");
      }
    }
    this.orbiting = false;
  };

  private onPointerLeave = () => {
    this.photoPointerOnCanvas = false;
    this.pointerNdc.set(-10, -10);
    this.galaxy.setPointer(null);
    for (const entry of this.photoSpheres.values()) { entry.sphere?.setPointer(null); entry.hoverTarget.set(0, 0, 0); }
    for (const node of this.albumPhotoNodes) node.particles?.setPointer(null);
    this.orbiting = false;
    this.galaxyDragging = false;
    this.photoLastLocal.set(9, 9);
    this.hovered = this.hoverCardId = this.hoveredAlbum = this.hoveredProxyPhoto = -1;
    this.lastHoverKey="-1:-1";this.canvas.style.cursor="";
    this.events.onHoverPhoto?.(null);
  };


  private onKey = (e: KeyboardEvent) => {
    if (!this.active || this.photoFocusActive || this.albumEditor) return;
    const t = e.target as HTMLElement | null;
    if (t && t.matches && t.matches("input,textarea,select")) return;
    if(this.albumRibbon && (e.key==="ArrowLeft"||e.key==="ArrowRight")) {this.setAlbumRibbon(e.key==="ArrowLeft"?"previous":"next");return;}
    if (e.key !== "Escape") return;
    if (this.place === "album") this.exitAlbum();
    else if (this.place === "shelf") this.travelBack();
    else if (this.place === "timeline") this.travelBack();
    else if (this.universe !== "locked") this.focusCluster(null);
  };

  private onDblClick = (e: MouseEvent) => {
    if(!this.active || this.journey.activeDestination)return;
    this.syncPickPointer(e);
    this.pick();
    if (this.albumEditor || this.albumRibbon) return;
    if (this.photoFocusActive || this.universe === "locked") return;
    if (this.hoveredAlbum >= 0) {
      this.events.onAlbumEnter?.(this.hoveredAlbum); // 目录页:双击确认进入
    } else if (this.hoverCardId >= 0) {
      this.events.onSelectPhoto?.(this.hoverCardId);
    } else if (this.hovered >= 0) {
      this.focusPhoto(this.hovered);
    } else if (this.place === "universe") {
      this.rig.flyTo(GALAXY_VIEW_TARGET.clone(), 172);
    }
  };

  private onContextMenu = (e: MouseEvent) => e.preventDefault();

  private bindEvents() {
    window.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("wheel",this.onRibbonWheel,{passive:false});
    window.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("dblclick", this.onDblClick);
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
  }

  private unbindEvents() {
    if (!this.canvas) return;
    window.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("wheel",this.onRibbonWheel);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("dblclick", this.onDblClick);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("keydown",this.onKey);
  }

  private pick() {
    this.hovered = this.hoverCardId = this.hoveredAlbum = this.hoveredProxyPhoto = -1;
    if (!this.positions || !this.active || this.journey.activeDestination || this.photoFocusActive || this.universe === "locked") return;
    this.raycaster.setFromCamera(this.pointerNdc, this.rig.camera);
    // 近处卡片优先
    const cardArr = [...this.cards.values()].filter((c) => c.visible);
    const cardHit = this.raycaster.intersectObjects(cardArr, false)[0];
    let id = -1;
    this.hoverCardId = -1;
    this.hoveredAlbum = -1;
    this.hoveredProxyPhoto = -1;
    if (cardHit) {
      id = (cardHit.object.userData.photoId as number) ?? -1;
      this.hoverCardId = id;
    } else {
      // 照片粒子球 / 相册星系 / 相册内照片球:代理球命中
      const proxies: THREE.Object3D[] = [];
      if(this.albumRibbon)for(const item of this.albumRibbon.items)if(item.card.visible)proxies.push(item.card);
      if(this.place === "universe")for (const entry of this.photoSpheres.values()) if (entry.proxy.visible && entry.sphere?.points.visible) proxies.push(entry.proxy);
      for (const n of this.albumNodes) if (this.place === "shelf" && n.root.visible) proxies.push(n.proxy);
      for (const n of this.albumPhotoNodes) if (this.place === "album" && n.albumId === this.albumFocus && n.root.visible && n.root.parent?.visible && Number(n.root.userData.displayAmount ?? 1) > .15) proxies.push(n.proxy);
      const proxyHit = proxies.length ? this.raycaster.intersectObjects(proxies, false)[0] : null;
      if (proxyHit) {
        const kind = proxyHit.object.userData.kind as string;
        const pid = proxyHit.object.userData.photoId as number | undefined;
        const aid = proxyHit.object.userData.albumId as number | undefined;
        if (kind === "album") this.hoveredAlbum = aid ?? -1;
        else { this.hoveredProxyPhoto = pid ?? -1; id = pid ?? -1; }
      } else if(this.place === "universe" && this.nodeMat.uniforms.uOpacity.value > .08) {
        this.raycaster.params.Points = { threshold: Math.max(0.9, this.rig.getRadius() * 0.012) };
        const reveal=this.nodeGeo.getAttribute("aReveal");
        const pointHit = this.raycaster.intersectObject(this.nodePoints, false).find(hit=>hit.index!==undefined && reveal.getX(hit.index)>.15);
        if (pointHit && typeof pointHit.index === "number") {
          id = this.photos[pointHit.index]?.id ?? -1;
        }
      }
    }
    this.hovered=id;
    const hoverKey = `${id}:${this.hoveredAlbum}`;
    if (hoverKey !== this.lastHoverKey) {
      this.lastHoverKey = hoverKey;
      this.hovered = id;
      this.canvas.style.cursor = (id >= 0 || this.hoveredAlbum >= 0) ? "pointer" : "";
      this.events.onHoverPhoto?.(id >= 0 ? id : null);
      if (id >= 0) {
        if (this.place === "album") prewarmDetailPhoto(id);
        else if (this.place === "universe") void this.acquireCloud(id).catch(() => {});
      }

    }
  }
  private lastHoverKey = "-1:-1";

  private nodePosition(i: number): THREE.Vector3 {
    if (this.positions) {
      return new THREE.Vector3(
        this.positions[i * 3],
        this.positions[i * 3 + 1],
        this.positions[i * 3 + 2],
      );
    }
    const p = this.nodeGeo.getAttribute("position") as THREE.BufferAttribute;
    return new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
  }

  private updateDrag() {
    this.raycaster.setFromCamera(this.pointerNdc, this.rig.camera);
    const hit = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.dragPlane, hit)) {
      const i = this.dragIndex;
      const posAttr = this.nodeGeo.getAttribute("position") as THREE.BufferAttribute;
      posAttr.setXYZ(i, hit.x, this.dragPlane.constant * -1, hit.z);
      posAttr.needsUpdate = true;
      this.worker?.postMessage({
        type: "drag",
        index: i,
        x: hit.x,
        y: this.dragPlane.constant * -1,
        z: hit.z,
      });
      // 拖动的卡片跟随
      const card = this.cards.get(this.photos[i]?.id ?? -1);
      if (card) {
        card.position.set(hit.x, this.dragPlane.constant * -1, hit.z);
      }
    }
  }

  private applyPositions() {
    if (!this.positions) return;
    (this.nodeGeo.getAttribute("position") as THREE.BufferAttribute).array.set(this.positions);
    (this.nodeGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    const lpos = this.lineGeo.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < this.edgeList.length; i++) {
      const a = this.edgeList[i].a * 3;
      const b = this.edgeList[i].b * 3;
      lpos.setXYZ(i * 2, this.positions[a], this.positions[a + 1], this.positions[a + 2]);
      lpos.setXYZ(i * 2 + 1, this.positions[b], this.positions[b + 1], this.positions[b + 2]);
    }
    lpos.needsUpdate = true;
    this.nodeGeo.computeBoundingSphere();
  }

  // ---------- 渲染帧 ----------

  private frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    this.time += dt;
    // 主视觉天体：环面纹理流动 + 缓慢自转
    this.body?.tick(dt, this.rig.camera);

    // FPS 统计
    this.fpsAcc += dt;
    this.fpsN++;
    if (this.fpsAcc >= 1) {
      this.events.onFps?.(Math.round(this.fpsN / this.fpsAcc));
      this.fpsAcc = 0;
      this.fpsN = 0;
    }

    const backdropTarget = this.sphereFocus?.closing ? 1 : (this.photoFocusActive || this.photoStarId >= 0) ? 0 : 1;
    this.photoBackdrop = THREE.MathUtils.damp(this.photoBackdrop, backdropTarget, 5, dt);

    // 状态机:阻尼逼近目标 profile(可中断,不排队)
    const k = Math.min(1, dt * 2.4);
    const c = this.stateCur;
    const t = this.stateTarget;
    c.stars += (t.stars - c.stars) * k;
    c.nebula += (t.nebula - c.nebula) * k;
    c.dust += (t.dust - c.dust) * k;
    c.nodes += (t.nodes - c.nodes) * k;
    c.lines += (t.lines - c.lines) * k;
    c.heart += (t.heart - c.heart) * k;

    // 地球旅程只收起 Astra 主星辰及其内容；外围星野持续存在，避免地球被亮核粒子穿透。
    const journeyDestination = this.journey.activeDestination;
    let mainGalaxyVisibility = 1;
    if (journeyDestination === "earth") {
      mainGalaxyVisibility = 1 - THREE.MathUtils.smoothstep(this.journey.progress, 0.28, 0.72);
    } else if (this.place === "earth" && journeyDestination) {
      mainGalaxyVisibility = THREE.MathUtils.smoothstep(this.journey.progress, 0.14, 0.82);
    } else if (this.place === "earth") {
      mainGalaxyVisibility = 0;
    }

    // 星野视差(极轻)
    this.starfield.setPointerEnabled(true);
    this.starfield.setGentleInteraction(this.universe!=='locked');
    // 所有图形(星系 / 点云形态 / 照片星)跟随宇宙自旋;空闲时也缓慢自转,保持"活着"的动态。
    this.tickUniverseSpin(dt);
    this.starfield.setSpin(this.universeSpin);
    this.starfield.update(dt, this.time, this.rig.camera);
    this.starfield.setOpacity((journeyDestination === "earth" || this.place === "earth") ? Math.max(c.stars, 0.78) : c.stars);
    this.backdrop.update(this.time);

    // 记忆之心呼吸
    if (this.heart) {
      this.heart.visible = false;
      const hm = this.heart.material as THREE.SpriteMaterial;
      hm.opacity = (0.1 + 0.045 * Math.sin(this.time * 0.7)) * c.heart;
      this.heart.scale.setScalar((13.5 + 1.6 * Math.sin(this.time * 0.5)) * (0.4 + 0.6 * c.heart));
    }
    for (const s of this.nebulae) {
      s.visible = false;
      (s.material as THREE.SpriteMaterial).opacity = 0.07 * c.nebula;
    }
    if (this.dustMat) this.dustMat.uniforms.uOpacity.value = c.dust * mainGalaxyVisibility;
    if (this.nodeMat) this.nodeMat.uniforms.uOpacity.value = c.nodes * mainGalaxyVisibility * this.photoBackdrop;
    if (this.lineMat) this.lineMat.uniforms.uGlobal.value = 0;

    // 非旋臂形态:渐隐 Astra 参考银河,把画面主视觉让给按图形重排后的星野
    this.galaxyFade += (this.galaxyFadeTarget - this.galaxyFade) * Math.min(1, dt * 2.2);
    if (Math.abs(this.galaxyFadeTarget - this.galaxyFade) < 0.002) this.galaxyFade = this.galaxyFadeTarget;
    this.galaxy.points.visible = this.galaxyFade > 0.02;

    // 星尘本身以 stars 通道取亮度:锁定散开态可见,聚焦时压暗
    this.galaxy.tick(dt,this.renderer,this.rig.camera,this.rig.camera.aspect,c.stars * mainGalaxyVisibility * this.galaxyFade,this.galaxyBaseQuaternion);
    if (this.universe === "converging" && this.galaxy.converge > 0.985) {
      this.universe = "ready"; // 就绪由真实动画进度宣布,而不是 UI 定时器
      this.events.onEnterComplete?.();
    }
    if (this.photoCloud) {
      this.photoCloud.update(dt, this.time);
      if (!this.sphereFocus) this.photoCloud.setViewportHeight(this.canvas.clientHeight, 2.7, 4.8, this.rig.camera.fov);
    }

    // —— 旅程推进:旅程期间 JourneyController 独占相机 ——
    if (this.journey.activeDestination) {
      const destination = this.journey.activeDestination;
      const stillGoing = this.journey.update(dt, this.rig.camera);
      if (destination === "earth" && stillGoing && this.journey.progress > 0.72) this.emitEarthPose("earth-pose");
      const phase = this.journey.phase;
      if (phase !== this.lastJourneyPhase) {
        this.lastJourneyPhase = phase;
        this.emitJourney({ type: "phase", destination: this.journey.activeDestination ?? "overview", phase });
      }
      if (!stillGoing) this.lastJourneyPhase = "arrived";
    } else if (this.tunnelRide && this.tunnel) {
      this.stepTunnelRide(dt);
    } else {
      if (!this.sphereFocus && !this.albumRibbon) this.rig.update(dt);
    }
    this.lastJourneyPhase = this.journey.activeDestination ? this.journey.phase : this.lastJourneyPhase;

    // —— 星球/隧道/相册区域的常驻更新 ——
    if (this.journey.activeDestination === "earth" && this.earth) {
      this.placeEarthInMapFrame(1);
      this.earth.group.visible = true;
      this.earth.setOpacity(THREE.MathUtils.smoothstep(this.journey.progress, 0.46, 0.84));
    } else if (this.place === "earth" && this.journey.activeDestination === "overview" && this.earth) {
      // 拉远前半段固定在右侧；地球已经足够小时再缓慢归回它在银河中的真实轨道位置。
      const frameAmount = 1 - THREE.MathUtils.smoothstep(this.journey.progress, 0.56, 0.96);
      this.placeEarthInMapFrame(frameAmount);
      this.earth.group.visible = true;
      const detailFade = THREE.MathUtils.smoothstep(this.journey.progress, 0.28, 0.72);
      this.earth.setOpacity(1 - detailFade);
      if (this.earthStar) {
        this.earthStar.position.copy(this.earth.group.position);
        this.earthStar.visible = true;
        this.earthStar.material.opacity = detailFade * 0.65;
      }
    } else if (this.place === "earth" && this.journey.activeDestination === "shelf" && this.earth) {
      this.earth.setOpacity(1-THREE.MathUtils.smoothstep(this.journey.progress,0.05,0.55));
    } else if (this.place === "universe" && this.universe === "ready" && !this.photoCloud && this.earth) {
      this.updateEarthOrbit(dt);
      this.earth.group.visible = false;
      if (this.earthStar) {
        this.earthStar.position.copy(this.earthAnchor);
        this.earthStar.visible = true;
        this.earthStar.material.opacity = 0.65;
      }
    }
    if (this.earthStar && (this.universe === "locked" || this.photoCloud || (this.journey.activeDestination && this.journey.activeDestination !== "overview") || (this.place !== "universe" && this.place !== "earth"))) this.earthStar.visible = false;
    if (this.earth?.group.visible) this.earth.tick(this.time);
    if (this.tunnel?.group.visible) {
      const ride = this.tunnelRide;
      this.tunnel.update(dt, ride?.t ?? 0, ride ? ride.t / Math.max(0.0001, ride.endT) : 1);
      if (++this.tunnelTexRefresh % 2 === 0) this.refreshTunnelTextures();
    }
    const shelfVisible = this.place === "shelf" || this.place === "album" || this.journey.activeDestination === "shelf" || this.journey.activeDestination === "album";
    if(!shelfVisible)for(const n of this.albumNodes)if(n.labelEl)n.labelEl.style.opacity="0";
    if (shelfVisible) {
      const returning = this.journey.activeDestination === "overview";
      const collapse = returning ? THREE.MathUtils.smoothstep(this.journey.progress, 0.18, 0.96) : 0;
      for (const n of this.albumNodes) {
        n.root.scale.setScalar(THREE.MathUtils.lerp(1, 0.015, collapse));
        const focus = this.albumFocus;
        const entering = this.journey.activeDestination === "album";
        const exiting = this.place === "album" && this.journey.activeDestination === "shelf";
        const isolation = entering ? THREE.MathUtils.smoothstep(this.journey.progress, 0, .85)
          : exiting ? 1 - THREE.MathUtils.smoothstep(this.journey.progress, .05, 1)
          : this.place === "album" ? 1 : 0;
        const opacity = focus !== null && n.albumId !== focus ? 1 - isolation : 1;
        n.root.visible = opacity > 0;
        n.root.userData.albumOpacity = opacity;
      }
      this.updatePhotoSpherePointer();
      this.updateAlbumPhotoMotion(dt);
      for (const n of this.albumPhotoNodes) {
        // 一次目录浏览及其往返共用实体、尺寸、锚点和朝向。
        const pending = this.pendingAlbumParticles.get(n.root);
        if (pending && !this.journey.activeDestination) {
          n.root.add(pending.points);
          n.root.userData.particleBlend=n.root.userData.draftLoading?0:1;
          n.root.userData.draftLoading=false;
          n.particles = pending;
          n.lod.visible = Number(n.root.userData.particleBlend)<1;
          this.pendingAlbumParticles.delete(n.root);
        }
        if (n.particles === this.sphereFocus?.sphere) continue;
        n.particles?.update(dt, this.time);
        const target = Number(n.root.userData.displayTarget ?? 1);
        const amount = THREE.MathUtils.damp(Number(n.root.userData.displayAmount ?? target), target, 5, Math.min(dt,.05));
        n.root.userData.displayAmount = amount;
        if(n.root.userData.retireWhenHidden&&amount<.002&&target===0){this.disposeAlbumPhotoNode(n);continue;}
        n.root.visible = amount > .002 || target > 0;
        n.root.scale.setScalar(THREE.MathUtils.lerp(.82,1,amount));
        const opacity = Number(n.root.parent?.userData.albumOpacity ?? 1) * amount * this.photoBackdrop;
        const blend=n.particles?THREE.MathUtils.damp(Number(n.root.userData.particleBlend??1),1,9,Math.min(dt,.05)):0;
        n.root.userData.particleBlend=blend;
        n.particles?.setOpacity(.66 * opacity * blend);
        n.lod.visible=blend<.998;
        n.lod.material.opacity = .72 * opacity * (1-blend);
      }
      this.updateAlbumLabels();
      if (returning) for (const n of this.albumNodes) if (n.labelEl) n.labelEl.style.opacity = "0";
    }
    if (this.place === "universe" && this.universe !== "locked" && !this.journey.activeDestination) {
      this.updatePhotoSpherePointer();
      const step = Math.min(dt, .05), omega = 4.5, decay = Math.exp(-omega * step);
      for (const entry of this.photoSpheres.values()) {
        for (const axis of ["x", "y", "z"] as const) {
          const displacement = entry.offset[axis] - entry.hoverTarget[axis];
          const impulse = entry.velocity[axis] + omega * displacement;
          entry.offset[axis] = entry.hoverTarget[axis] + (displacement + impulse * step) * decay;
          entry.velocity[axis] = (entry.velocity[axis] - omega * impulse * step) * decay;
        }
      }
      this.updatePhotoSphereField(dt);
    }

    // 屏幕上方向由相机四元数连续给出，无欧拉角极点或翻面分支。
    // 包括镜头旅程，照片朝向始终更新；位置仍由星系空间变换决定。
    for (const entry of this.photoSpheres.values()) {
      if (entry.sphere && entry.sphere !== this.sphereFocus?.sphere) entry.sphere.points.quaternion.copy(this.rig.camera.quaternion);
    }
    this.rig.camera.updateMatrixWorld();
    if (this.nodeMat) this.nodeMat.uniforms.uTime.value = this.time;
    if (this.lineMat) this.lineMat.uniforms.uTime.value = this.time;
    if (this.dustMat) this.dustMat.uniforms.uTime.value = this.time;
    if (this.universe !== "locked") {
      this.updateCards();
      this.updateLabels();
    }

    this.updateAlbumRibbon(dt);
    this.updateSphereFocus(dt);
    this.composer.render(dt);
    if(import.meta.env.DEV) { this.canvas.dataset.camera=this.rig.camera.position.toArray().map(v=>v.toFixed(4)).join(','); this.canvas.dataset.drawCalls=String(this.renderer.info.render.calls); }
  }

  /** 宇宙仅保留照片粒子星辰；旧卡片对象只负责被清场。 */
  private updateCards() {
    for (const card of this.cards.values()) {
      card.visible = false;
      (card.material as THREE.MeshBasicMaterial).opacity = 0;
    }
  }

  /** 相册标签投影到屏幕 */
  private updateLabels() {
    if (!this.labelContainer) return;
    const cam = this.rig.camera;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    for (const c of this.clusters) {
      if (!c.labelEl) continue;
      c.labelEl.style.pointerEvents="none";c.labelEl.tabIndex=-1;
      if (this.place !== "universe" || this.journey.activeDestination || this.photoFocusActive) { c.labelEl.style.opacity = "0"; continue; }
      const worldCenter = this.universeWorldPoint(c.center);
      const dist = cam.position.distanceTo(worldCenter);
      const v = worldCenter.project(cam);
      const behind = v.z > 1;
      const scale = THREE.MathUtils.clamp(1 - (dist - 60) / 420, 0.15, 1);
      if (behind || v.z < -1 || Math.abs(v.x)>1.1 || Math.abs(v.y)>1.1 || scale <= 0.16) {
        c.labelEl.style.opacity = "0";
        continue;
      }
      c.labelEl.style.left = `${((v.x + 1) / 2) * w}px`;
      c.labelEl.style.top = `${((-v.y + 1) / 2) * h}px`;
      c.labelEl.style.opacity = `${scale * 0.9 * this.photoBackdrop}`;
      c.labelEl.style.pointerEvents=this.photoBackdrop>.9?"auto":"none";c.labelEl.tabIndex=this.photoBackdrop>.9?0:-1;
    }
  }

  /** 飞向相册星团 */
  focusCluster(albumId: number | null) {
    if (albumId === null) {
      this.rig.flyTo(GALAXY_VIEW_TARGET.clone(), 172);
      this.setState("overview");
      return;
    }
    if(this.place!=="universe"||!this.active||this.journey.activeDestination||this.photoFocusActive)return;
    const c = this.clusterByAlbum.get(albumId);
    if (c) {
      // 标签投影与镜头使用同一个经过旋转的星系锚点；重复点击继续靠近。
      const target = this.universeWorldPoint(c.center);
      const distance = this.rig.camera.position.distanceTo(target);
      this.rig.flyTo(target, Math.min(distance, THREE.MathUtils.clamp(distance * .42, 8, 34)), 1050);
      this.setState("cluster");
    }
  }

  /** 飞向某张照片 */
  focusPhoto(id: number) {
    const i = this.indexById.get(id);
    if (i === undefined) return;
    const p = this.universeWorldPoint(this.nodePosition(i));
    this.rig.flyTo(p, 10);
  }

  // ---------- 星辰 → 照片(同一场景内的 morph) ----------

  get photoFocusActive() {
    return this.photoCloud !== null || this.sphereFocus !== null;
  }

  private sphereFocus: {
    sphere: PhotoParticleSphere; parent: THREE.Object3D; localPosition: THREE.Vector3;
    localQuaternion: THREE.Quaternion; localScale: THREE.Vector3;
    position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3;
    target: THREE.Vector3; targetScale: number; opacity: number;
    progress: number; closing: boolean; formed: boolean; resolve?: () => void;
  } | null = null;

  private beginSphereFocus(id: number, sphere: PhotoParticleSphere) {
    const points = sphere.points;
    points.updateWorldMatrix(true, false);
    const parent = points.parent!;
    const localPosition = points.position.clone(), localQuaternion = points.quaternion.clone(), localScale = points.scale.clone();
    const position = points.getWorldPosition(new THREE.Vector3());
    const quaternion = points.getWorldQuaternion(new THREE.Quaternion());
    const scale = points.getWorldScale(new THREE.Vector3());
    const camera = this.rig.camera;
    const distance = 10;
    const visibleHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const planeHeight = Number(points.material.uniforms.uPlaneHeight.value);
    const targetScale = Math.min(visibleHeight * .78 / planeHeight, visibleHeight * camera.aspect * .82 / 4.42);
    this.scene.attach(points);
    this.rig.cancel();
    this.rig.controls.enabled = false;
    this.photoStarId = id;
    this.sphereFocus = {
      sphere, parent, localPosition, localQuaternion, localScale, position, quaternion, scale,
      target: camera.position.clone().addScaledVector(camera.getWorldDirection(new THREE.Vector3()), distance),
      targetScale, opacity: Number(points.material.uniforms.uOpacity.value), progress: 0, closing: false, formed: false,
    };
    sphere.setPointer(null);
    const bridge = new SpherePhotoBridge(id, sphere, camera,
      () => this.events.onPhotoStarFormed?.(id),
      () => {
        const f = this.sphereFocus;
        if (!f) return;
        f.parent.add(points); points.position.copy(f.localPosition); points.quaternion.copy(f.localQuaternion); points.scale.copy(f.localScale);
        points.visible = true;
        if (this.photoCloud) { this.disposeCloud(this.photoCloud); this.photoCloud = null; }
        this.sphereFocus = null; this.photoStarId = -1;
        clearSpherePhotoBridge(id); this.rig.cancel(); this.rig.controls.enabled = this.active && !this.albumRibbon;
        f.resolve?.();
      }, this.place === "album" ? this.canvas.getBoundingClientRect() : undefined);
    setSpherePhotoBridge(id, bridge);
    if (this.place === "universe") {
      void this.acquireCloud(id).then(data => {
        if (getSpherePhotoBridge(id) !== bridge) return;
        const cloud = new ParticlePhoto(data, 1, 2);
        cloud.setMorphImmediate(0);
        cloud.points.position.copy(this.sphereFocus!.target);
        cloud.points.quaternion.copy(camera.quaternion);
        cloud.points.scale.setScalar(2.7 * 10 / 4.8);
        cloud.setViewportHeight(this.canvas.clientHeight, 2.7 * 10 / 4.8, 10, camera.fov);
        bridge.install(cloud.points as THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>);
        this.photoCloud = cloud;
        this.photoPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), cloud.points.position);
        this.scene.add(cloud.points);
        bridge.ready = true;
      }).catch(() => { bridge.finish(); this.events.onPhotoStarFail?.(id); });
    }
  }

  private updateSphereFocus(dt: number) {
    const f = this.sphereFocus;
    if (!f) return;
    const bridge = getSpherePhotoBridge(this.photoStarId);
    if (bridge) {
      if (this.place === "universe") bridge.tick(Math.min(dt, .033));
      return;
    }
    f.progress = THREE.MathUtils.clamp(f.progress + dt / 1.15 * (f.closing ? -1 : 1), 0, 1);
    const u = f.progress, t = u * u * u * (u * (u * 6 - 15) + 10);
    const points = f.sphere.points;
    points.position.lerpVectors(f.position, f.target, t);
    points.quaternion.copy(f.quaternion).slerp(this.rig.camera.quaternion, t);
    points.scale.copy(f.scale).lerp(new THREE.Vector3().setScalar(f.targetScale), t);
    f.sphere.setCurvature(1 - t);
    f.sphere.setOpacity(THREE.MathUtils.lerp(f.opacity, .88, t));
    f.sphere.update(dt, this.time);
    if (u === 1 && !f.formed && !f.closing) {
      f.formed = true;
      this.events.onPhotoStarFormed?.(this.photoStarId);
    }
    if (u === 0 && f.closing) {
      f.parent.add(points);
      points.position.copy(f.localPosition); points.quaternion.copy(f.localQuaternion); points.scale.copy(f.localScale);
      f.sphere.setCurvature(1); f.sphere.setOpacity(f.opacity);
      this.sphereFocus = null; this.photoStarId = -1;
      this.rig.controls.enabled = this.active;
      f.resolve?.();
    }
  }

  /** 点击记忆星辰:相机飞近,星辰分裂成粒子并组成照片 */
  async focusPhotoStar(id: number) {
    if (this.universe === "locked" || this.sphereFocus) return;
    const source = this.place === "album"
      ? this.albumPhotoNodes.find(n => n.albumId === this.albumFocus && n.photoId === id)?.particles
      : this.photoSpheres.get(id)?.sphere;
    if (source) { this.beginSphereFocus(id, source); return; }
    const i = this.indexById.get(id);
    if (i === undefined) return;
    if (this.photoStarId === id && this.photoCloud) return; // 已在聚焦这张
    const node = this.universeWorldPoint(this.nodePosition(i));
    try {
      if (this.photoCloud && this.photoStarId !== id) await this.collapsePhotoStar(true);
      if (this.photoCloud) return;
    } catch { /* 继续聚焦新照片 */ }
    this.photoStarId = id;
    this.photoCamPose = {
      pos: this.rig.camera.position.clone(),
      target: this.rig.controls.target.clone(),
    };
    this.setState("detail");
    let data: ParticleCloudData;
    try {
      data = await this.acquireCloud(id);
    } catch {
      this.photoStarId = -1;
      this.events.onPhotoStarFail?.(id);
      return;
    }
    if (this.photoStarId !== id) return; // 期间被取消
    const cloud = new ParticlePhoto(data, 1, 2.0); // 汇成照片约 1.1s
    const dist = 4.8;
    const camPos = this.rig.camera.position;
    const dir = camPos.clone().sub(node).normalize();
    // 保存聚焦平面(面向最终相机),供鼠标射线使用
    this.photoPlane.setFromNormalAndCoplanarPoint(dir.clone().negate(), node);
    this.rig.controls.minDistance = 2.0;
    this.rig.flyTo(node, dist, 1150);
    cloud.points.position.copy(node);
    cloud.points.quaternion.copy(this.rig.camera.quaternion);
    cloud.setViewportHeight(this.canvas.clientHeight, 2.7, dist, this.rig.camera.fov);
    cloud.points.scale.setScalar(2.7);
    cloud.setMorph(0);
    this.photoCloud = cloud;
    this.scene.add(cloud.points);
    const settle = setTimeout(() => {
      if (this.photoCloud === cloud && this.photoStarId === id) this.events.onPhotoStarFormed?.(id);
    }, 1250);
    this.photoSettleTimer = settle;
  }
  private photoSettleTimer: ReturnType<typeof setTimeout> | null = null;

  /** ESC/关闭:照片粒子收回成星辰,相机回到原位 */
  collapsePhotoStar(fast = false) {
    return new Promise<void>((resolve) => {
      if (this.sphereFocus) {
        this.sphereFocus.closing = true;
        const previous = this.sphereFocus.resolve;
        this.sphereFocus.resolve = () => { previous?.(); resolve(); };
        const bridge = getSpherePhotoBridge(this.photoStarId);
        if (bridge) { if (fast) bridge.finish(); else bridge.close(); }
        else if (fast) { this.sphereFocus.progress = 0; this.updateSphereFocus(0); }
        return;
      }
      const cloud = this.photoCloud;
      this.clearPhotoSettle();
      if (!cloud) {
        resolve();
        return;
      }
      const pose = this.photoCamPose;
      this.photoCloud = null;
      const finish = () => {
        this.disposeCloud(cloud);
        if (pose) {
          this.rig.flyToPose(pose.pos, pose.target, 950);
        } else {
          this.rig.flyTo(GALAXY_VIEW_TARGET.clone(), 172, 950);
        }
        this.rig.controls.minDistance = 6;
        this.setState("overview");
        this.photoStarId = -1;
        this.photoCamPose = null;
        resolve();
      };
      if (fast) {
        finish();
      } else {
        cloud.collapse(0.72);
        const t = setTimeout(finish, 780);
        this.photoCollapseTimer = t;
      }
    });
  }
  private photoCollapseTimer: ReturnType<typeof setTimeout> | null = null;

  /** 聚焦中把照片转回正对相机 */
  resetPhotoView() {
    if (this.sphereFocus) return;
    const i = this.photoStarId >= 0 ? this.indexById.get(this.photoStarId) : undefined;
    if (i === undefined) return;
    this.rig.flyTo(this.universeWorldPoint(this.nodePosition(i)), 4.8, 700);
  }

  private clearPhotoSettle() {
    if (this.photoSettleTimer) { clearTimeout(this.photoSettleTimer); this.photoSettleTimer = null; }
    if (this.photoCollapseTimer) { clearTimeout(this.photoCollapseTimer); this.photoCollapseTimer = null; }
  }

  private disposeCloud(cloud: ParticlePhoto) {
    this.scene.remove(cloud.points);
    cloud.dispose();
  }

  private disposePhotoCloud() {
    if (this.sphereFocus) void this.collapsePhotoStar(true);
    this.clearPhotoSettle();
    if (this.photoCloud) this.disposeCloud(this.photoCloud);
    this.photoCloud = null;
    this.photoStarId = -1;
    this.photoCamPose = null;
    this.rig.controls.minDistance = 6;
  }

  private async acquireCloud(id: number): Promise<ParticleCloudData> {
    const hit = this.photoCloudCache.get(id);
    if (hit) return hit;
    const tierValue = await ipc.getSetting("particle_tier");
    const tier = (["low", "medium", "high", "ultra"].includes(tierValue ?? "") ? tierValue : "medium") as QualityTier;
    const data = await samplePhoto(`http://tm.localhost/photo/${id}`, tier);
    this.photoCloudCache.set(id, data);
    if (this.photoCloudCache.size > 6) {
      const first = this.photoCloudCache.keys().next().value;
      if (first !== undefined) this.photoCloudCache.delete(first);
    }
    return data;
  }

  onResize() {
    this.resize();
  }
}

// ---------- 工具 ----------

function rand(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "");
  const v = parseInt(m.length === 3 ? m.split("").map((c) => c + c).join("") : m, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c] ?? c);
}

let glowTex: THREE.Texture | null = null;
function getGlowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,0.85)");
  g.addColorStop(0.25, "rgba(255,255,255,0.28)");
  g.addColorStop(0.6, "rgba(255,255,255,0.07)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

function makeGlowSprite(color: THREE.Color, scale: number): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: getGlowTexture(),
    color,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const s = new THREE.Sprite(mat);
  s.scale.setScalar(scale);
  return s;
}
