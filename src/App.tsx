import {AUTH_SETTINGS_EVENT} from "./core/AuthSettings";
import StarStoryPhoto from "./ui/StarStoryPhoto";
import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { TransitionCoordinator } from './core/TransitionCoordinator';
import { initialViewState, navigateView } from './core/AppViewState';
import TitleBar from "./ui/TitleBar";
import LockScreen from "./ui/LockScreen";
import TopBar from "./ui/TopBar";
import GalaxyView from "./ui/GalaxyView";
import TimelineView from "./ui/TimelineView";
import ShelfPanel from "./ui/ShelfPanel";
const MapView = lazy(() => import("./ui/MapView"));
import PhotoDetail from "./ui/PhotoDetail";
import ImportOverlay from "./ui/ImportOverlay";
import SettingsView from "./ui/SettingsView";
import BackfillBar from "./ui/BackfillBar";
import Slideshow from "./ui/Slideshow";import VideoPosterAgent from "./core/videoPoster";
import { SpaceBar } from "./ui/SpaceBar";
import { shapeOf, type Space } from "./core/spaces";
import { ToastProvider, useToast } from "./core/toast";
import { listenImportProgress } from "./core/events";
import { ipc } from "./core/db";
import { isTauri } from "./core/env";

// 浏览器回退模式(无后端)下,塞一组演示页面,让页面切换条出现并能切到不同图形。
// 仅用于预览,桌面端永远走 Tauri,不会用到这份数据。
const DEMO_SPACES: import("./core/spaces").Space[] = [
  { id: 1, name: "旋臂星系",   shape: "spiral", scope: "shared", backgroundPhotoId: null, backgroundStrength: 42, sortOrder: 0, photoCount: 0 },
  { id: 4, name: "球状星云",   shape: "sphere", scope: "shared", backgroundPhotoId: null, backgroundStrength: 42, sortOrder: 3, photoCount: 0 },
  { id: 5, name: "环状",       shape: "ring",   scope: "shared", backgroundPhotoId: null, backgroundStrength: 42, sortOrder: 4, photoCount: 0 },
  { id: 6, name: "环带行星",   shape: "saturn", scope: "shared", backgroundPhotoId: null, backgroundStrength: 42, sortOrder: 5, photoCount: 0 },
  { id: 7, name: "金色光环",   shape: "golden", scope: "shared", backgroundPhotoId: null, backgroundStrength: 42, sortOrder: 6, photoCount: 0 },
  { id: 8, name: "粒子星云",   shape: "nebula", scope: "shared", backgroundPhotoId: null, backgroundStrength: 42, sortOrder: 7, photoCount: 0 },
  // 来自三段参考视频的纯网格形态
  { id: 9, name: "光带结",     shape: "knot",   scope: "shared", backgroundPhotoId: null, backgroundStrength: 42, sortOrder: 8, photoCount: 0 },
  { id: 10, name: "同心光环",  shape: "halo",   scope: "shared", backgroundPhotoId: null, backgroundStrength: 42, sortOrder: 9, photoCount: 0 },
  { id: 11, name: "螺旋星盘",  shape: "galaxy", scope: "shared", backgroundPhotoId: null, backgroundStrength: 42, sortOrder: 10, photoCount: 0 },
  // 由正面 2D 图反推的 3D 盘体
  { id: 12, name: "星盘·图反推", shape: "imgalaxy", scope: "shared", backgroundPhotoId: null, backgroundStrength: 42, sortOrder: 11, photoCount: 0 },
  { id: 13, name: "光环·图反推", shape: "imgring", scope: "shared", backgroundPhotoId: null, backgroundStrength: 42, sortOrder: 12, photoCount: 0 },
  { id: 14, name: "星盘·视频帧反推", shape: "imgalaxyv", scope: "shared", backgroundPhotoId: null, backgroundStrength: 42, sortOrder: 13, photoCount: 0 },
];

import { tmPreview } from "./core/types";
import type { JourneyEvent } from "./three/GalaxyScene";
import type {
  Album,
  Connection,
  GalaxyPhoto,
  Photo,
  Memory,
  ViewMode,
} from "./core/types";

type AuthStage = "locked" | "converging" | "ready";

function Shell() {
  const toast = useToast();
  // 认证三态:locked=散星 + 密码 · converging=汇聚 · ready=银河
  const [stage, setStage] = useState<AuthStage>("locked");
  const [lockLeaving, setLockLeaving] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [passwordless,setPasswordless]=useState(false);
  const [authReady,setAuthReady]=useState(false);
  const authed = stage !== "locked";
  const [appView, setAppView] = useState(initialViewState);
  const view = appView.mainView;
  const viewRef = useRef(view);
  viewRef.current = view;
  const transition = useRef(new TransitionCoordinator());
  const detailData = appView.detail;
  const detailId = detailData?.photo.id ?? null;
  const [photoFormed, setPhotoFormed] = useState(false);
  const [albumRibbonExpanded,setAlbumRibbonExpanded]=useState(false);
  useEffect(()=>{const state=(e:Event)=>setAlbumRibbonExpanded(!!(e as CustomEvent).detail.expanded);window.addEventListener("album-ribbon-state",state);return()=>window.removeEventListener("album-ribbon-state",state);},[]);
  const [locationEdit,setLocationEdit]=useState<{photoId:number;returnView:ViewMode;detail:{photo:Photo;memory:Memory}}|null>(null);

  const [mapReturn,setMapReturn]=useState<{view:ViewMode;albumId:number|null;photoId:number}|null>(null);
  const returningPhoto=useRef<{view:ViewMode;albumId:number|null;detail:{photo:Photo;memory:Memory};entering?:boolean}|null>(null);
  const mapTarget=useRef<{lat:number;lng:number}|null>(null);

  // ---------- 连续旅程导航:点击只提交意图,到达事件才落地页面 ----------
  const navIntent = useRef<{ seq: number; view: ViewMode; albumId: number | null }>({ seq: 0, view: "galaxy", albumId: null });
  const [navPending, setNavPending] = useState<ViewMode | null>(null);
  const [shelfFocus, setShelfFocus] = useState<number | null>(null);
  const [shelfPhase, setShelfPhase] = useState<"traveling" | "index" | "interior">("traveling");
  const [mapReleasing, setMapReleasing] = useState(false); // 地图淡出、飞行地球接管期间
  const mapReleasingRef = useRef(false);
  mapReleasingRef.current = mapReleasing;
  const earthHandoff = useRef({ id: -1, arrived: false, mapReady: false });
  // 浏览状态恢复:首次访问后保持挂载(隐藏不渲染),保住地球相机与时间轴滚动
  const [visited, setVisited] = useState({ timeline: false, map: false });
  const detailSource = useRef<HTMLElement | null>(null);
  const finishDetailClose = useCallback(() => {
    if (detailSource.current) detailSource.current.style.visibility = "";
    detailSource.current = null;
    if (viewRef.current === "galaxy" || viewRef.current === "shelf") window.dispatchEvent(new Event("galaxy-collapse-photo-star"));
    setAppView(s=>({...s,detail:null,content:'overview',exiting:false}));
  }, []);

  const destToView = (d: string): ViewMode =>
    d === "overview" ? "galaxy" : d === "earth" ? "map" : (d as ViewMode);

  const closeDetail = useCallback(() => {
    transition.current.cancel();
    // 宇宙内的星辰照片:粒子收回成星辰,相机回位
    if ((viewRef.current === "galaxy" || viewRef.current === "shelf") && (appView.content === "photo_focus" || (viewRef.current === "shelf" && !detailSource.current))) {
      window.dispatchEvent(new Event("galaxy-collapse-photo-star"));
      setAppView(s=>({...s,exiting:true}));
      return;
    }
    setAppView(s=>({...s,exiting:true}));
  },[appView.content]);
  useEffect(() => {
    const closed = () => { setAppView(s=>({...s,detail:null,content:'overview',exiting:false})); setPhotoFormed(false); };
    window.addEventListener("galaxy-photo-closed", closed);
    return () => window.removeEventListener("galaxy-photo-closed", closed);
  },[]);

  const dispatchJourney = useCallback((v: ViewMode) => {
    // 视图名 → 世界目的地:地图=地球,相册架=相册区域,时间轴=隧道
    const destination = v === "map" ? "earth" : v;
    if (v === "galaxy") window.dispatchEvent(new CustomEvent("journey-back"));
    else window.dispatchEvent(new CustomEvent("journey-to", { detail: { destination, ...(v === "map" ? mapTarget.current : {}) } }));
  }, []);

  const finishEarthHandoff = useCallback((handoffId: number) => {
    const gate = earthHandoff.current;
    const nav = navIntent.current;
    if (gate.id !== handoffId || !gate.arrived || !gate.mapReady || nav.seq !== handoffId || nav.view !== "map") return;
    window.dispatchEvent(new Event("earth-handoff-confirm"));
    setAppView(s => navigateView(s, "map"));
    setNavPending(null);
    setMapReleasing(false);
  }, []);

  /** 从地图离开:先按地图当前视角恢复飞行地球,再从那里起航到下一个目的地 */
  const releaseMapThen = useCallback((v: ViewMode) => {
    setMapReleasing(true);
    const onPose = (e: Event) => {
      window.removeEventListener("map-pose", onPose);
      window.dispatchEvent(new CustomEvent("earth-resume", { detail: (e as CustomEvent).detail }));
      window.dispatchEvent(new CustomEvent("map-fade", { detail: { visible: false } }));
      requestAnimationFrame(() => dispatchJourney(v));
    };
    window.addEventListener("map-pose", onPose);
    window.dispatchEvent(new Event("map-pose-query"));
  }, [dispatchJourney]);

  const changeView = useCallback((v: ViewMode, albumId: number | null = null) => {
    transition.current.cancel();
    setSettingsOpen(false);
    setSearchOpen(false);
    setImportMenu(false);
    // 再次点击当前一级页面 = 回到该页浏览状态(宇宙:返回全景)
    if (v === viewRef.current && albumId === null && navPending === null && !mapReleasingRef.current) {
      if (v === "galaxy") window.dispatchEvent(new Event("galaxy-reset"));
      return;
    }
    const nextIntent = { seq: navIntent.current.seq + 1, view: v, albumId };
    navIntent.current = nextIntent;
    earthHandoff.current = v === "map"
      ? { id: nextIntent.seq, arrived: false, mapReady: false }
      : { id: -1, arrived: false, mapReady: false };
    setNavPending(v);
    if (navPending === "map" && v !== "map") window.dispatchEvent(new CustomEvent("map-fade", { detail: { visible: false } }));
    if (v === "map") setMapReleasing(false);
    setShelfPhase("traveling");
    if (v === "shelf" || v === "timeline") setShelfFocus(null);
    if (v === "map") setVisited(s => s.map ? s : { ...s, map: true }); // 提前预热 maplibre,地球抵达时已就绪
    if (viewRef.current === "map") releaseMapThen(v);
    else dispatchJourney(v);
  }, [navPending, releaseMapThen, dispatchJourney]);

  // 场景旅程事件:唯一的到达事实来源
  const onJourneyEvent = useCallback((ev: JourneyEvent) => {
    const nav = navIntent.current;
    if (ev.type === "started") {
      // 场景自主起航(如 ESC 返回)也纳入意图,保证最后一次意图胜出
      const v = destToView(ev.destination);
      if (nav.view !== v || navPending !== null) {
        navIntent.current = { seq: nav.seq + 1, view: v, albumId: null };
        setNavPending(v);
        if (v === "shelf") setShelfPhase("traveling");
      }
      return;
    }
    if (ev.type === "near" && ev.destination === "earth") {
      setVisited(s => s.map ? s : { ...s, map: true });
      return;
    }
    if (ev.type === "earth-ready") {
      if (nav.view !== "map") return;
      window.dispatchEvent(new CustomEvent("map-adopt-pose", {
        detail: { lat: ev.lat, lng: ev.lng, screenRadius: ev.screenRadius, viewportH: ev.viewportH, handoffId: nav.seq },
      }));
      return;
    }
    if (ev.type === "earth-pose") {
      if (nav.view !== "map") return;
      window.dispatchEvent(new CustomEvent("map-sync-pose", {
        detail: { lat: ev.lat, lng: ev.lng, screenRadius: ev.screenRadius, viewportH: ev.viewportH, handoffId: nav.seq },
      }));
      return;
    }
    if (ev.type === "earth-arrived") {
      const gate = earthHandoff.current;
      if (gate.id !== nav.seq || nav.view !== "map") return;
      gate.arrived = true;
      finishEarthHandoff(nav.seq);
      return;
    }
    if (ev.type === "arrived") {
      const seq = nav.seq;
      const commit = (v: ViewMode, albumId: number | null = null) => {
        if (navIntent.current.seq !== seq) return; // 只有最新意图落地
        setAppView(s => navigateView(s, v, albumId));
        setNavPending(null);
        if (v !== "map") setMapReleasing(false);
      };
      if (ev.destination === "overview" && nav.view === "galaxy") commit("galaxy");
      else if (ev.destination === "shelf" && nav.view === "shelf") { setShelfPhase("index"); setShelfFocus(null); commit("shelf"); }
      else if (ev.destination === "timeline" && nav.view === "timeline") commit("timeline");
      else if (ev.destination === "album") { setShelfPhase("interior"); setShelfFocus(ev.albumId ?? null); setNavPending(null); }
    }
  }, [navPending, finishEarthHandoff]);

  // 只有 MapLibre 已按 Three 地球姿态画出首帧且交叉淡入完成，才允许地图接管并隐藏 Three 地球。
  useEffect(() => {
    const complete = (e: Event) => {
      const handoffId = (e as CustomEvent<{ handoffId?: number }>).detail?.handoffId;
      const nav = navIntent.current;
      if (handoffId !== nav.seq || nav.view !== "map") return;
      const gate = earthHandoff.current;
      if (gate.id !== handoffId) return;
      gate.mapReady = true;
      finishEarthHandoff(handoffId);
    };
    window.addEventListener("map-handoff-complete", complete);
    return () => window.removeEventListener("map-handoff-complete", complete);
  }, [finishEarthHandoff]);

  const enterAlbum = useCallback((albumId: number) => {
    setShelfFocus(albumId);
    setShelfPhase("traveling");
    navIntent.current = { seq: navIntent.current.seq + 1, view: "shelf", albumId };
    window.dispatchEvent(new CustomEvent("album-enter", { detail: albumId }));
  }, []);
  const exitAlbum = useCallback(() => {
    setShelfPhase("traveling");
    window.dispatchEvent(new Event("album-exit"));
  }, []);
  useEffect(()=>()=>{transition.current.cancel();},[]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [slideshowOpen, setSlideshowOpen] = useState(false);
  const [searchOpen,setSearchOpen]=useState(false);
  const changeSearch=useCallback((open:boolean)=>{setSearchOpen(open);if(open){setSettingsOpen(false);setImportMenu(false);}},[]);

  const [albums, setAlbums] = useState<Album[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [onThisDay, setOnThisDay] = useState<Photo[]>([]);
  const [allPhotos, setAllPhotos] = useState<Photo[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [spaceId, setSpaceId] = useState<number | null>(null);
  const spaceRef = useRef<number | null>(null);
  spaceRef.current = spaceId;
  const [galaxyPhotos, setGalaxyPhotos] = useState<GalaxyPhoto[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [dataReady, setDataReady] = useState(false);

  const [dropping, setDropping] = useState(false);
  const [importMenu, setImportMenu] = useState(false);
  useEffect(() => {
    if (stage !== "ready") return;
    if (view === "timeline") setVisited((v) => v.timeline ? v : { ...v, timeline: true });
  }, [view, stage]);
  const lastActivity = useRef(Date.now());
  const unDrag = useRef<(() => void) | null>(null);

  // ---------- 认证 ----------
  const [convergeRate, setConvergeRate] = useState(1.45);
  const onEnterComplete = useCallback(() => setStage("ready"), []);
  useEffect(() => {
    // 纯网页预览(非 Tauri 环境,比如浏览器里直接打开 dev server):没有后端,
    // 直接放行进主界面,方便先看界面/星空效果。桌面应用永远走 Tauri,不会进这里。
    if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) {
      setAuthReady(true);
      setStage("ready");
      return;
    }
    let live=true;
    const changed=(e:Event)=>{const s=(e as CustomEvent<{hasPassword:boolean;passwordless:boolean}>).detail;setHasPassword(s.hasPassword);setPasswordless(s.passwordless);setAuthReady(true);};
    window.addEventListener(AUTH_SETTINGS_EVENT,changed);
    ipc.authState().then((s) => {
      if(!live)return;
      setHasPassword(s.hasPassword);setPasswordless(s.passwordless);setAuthReady(true);
      // 会话恢复:仅后端确认已解锁才进入快速汇聚;完成仍由场景动画事件宣布
      if (s.unlocked) {
        setConvergeRate(2.8);
        setStage("converging");
      }
    }).catch(()=>{if(live)toast("解锁设置读取失败，请重新启动相册");});
    return()=>{live=false;window.removeEventListener(AUTH_SETTINGS_EVENT,changed);};
  }, []);

  const unlock = useCallback((withPassword:boolean,withoutPassword:boolean) => {
    // 密码 UI 淡出;同一批散星此刻开始汇聚,主界面就绪由场景的完成事件宣布
    setHasPassword(withPassword);setPasswordless(withoutPassword);
    setConvergeRate(1.45);
    setLockLeaving(true);
    setStage("converging");
    setTimeout(() => setLockLeaving(false), 600);
  }, []);

  const lock = useCallback(() => {
    transition.current.cancel();
    ipc.lockApp();
    setAppView(initialViewState);
    setSettingsOpen(false);
    setPhotoFormed(false);
    setLocationEdit(null);
    setMapReturn(null);returningPhoto.current=null;mapTarget.current=null;
    setSearchOpen(false);setImportMenu(false);
    setNavPending(null);
    setShelfPhase("traveling");
    setShelfFocus(null);
    // 场景经 authPhase=locked 立即散开并隐藏私密内容;密码浮层即刻出现
    setStage("locked");
  }, []);

  // ---------- 数据加载 ----------
  const reload = useCallback(async () => {
    // 浏览器回退模式(非 Tauri)下没有后端,直接以空数据标记就绪,不发起 ipc
    if (!isTauri()) { setDataReady(true); return; }
    const sid = spaceRef.current;
    try {
      const [a, p, g, c, all, otd] = await Promise.all([
        ipc.listAlbums(),
        ipc.listPhotos(undefined, sid ?? undefined),
        ipc.getGalaxyData(sid ?? undefined),
        ipc.getConnections(),
        ipc.listPhotos(),
        // 回顾数据失败不应拖垮整次刷新
        ipc.getOnThisDay().catch(() => [] as Photo[]),
      ]);
      setAlbums(a);
      setPhotos(p);
      setGalaxyPhotos(g);
      setConnections(c);
      setAllPhotos(all);
      setOnThisDay(otd);
      setDataReady(true);
    } catch (e) {
      toast(`数据加载失败: ${e}`);
    }
  }, [toast]);

  // 任何来源的导入结束后都刷新本地数据。
  // 从其他窗口/入口触发的导入不会挂 ImportOverlay，所以这里常驻监听一次。
  useEffect(() => {
    if (!authed) return;
    if (!isTauri()) return; // 浏览器回退模式:无导入事件监听
    let un: (() => void) | null = null;
    let alive = true;
    void (async () => {
      const fn = await listenImportProgress((p) => {
        if (p.phase === "done") void reload();
      });
      if (alive) un = fn;
      else fn();
    })();
    return () => {
      alive = false;
      if (un) un();
    };
  }, [authed, reload]);

  // 进入后先取页面列表并恢复上次停留的页面,再按页面取照片
  useEffect(() => {
    if (!authed) return;
    if (!isTauri()) {
      // 浏览器回退模式:没有后端可加载页面,塞一组演示页面,让页面切换条出现并能切到不同图形
      setSpaces(DEMO_SPACES);
      const first = DEMO_SPACES[0];
      spaceRef.current = first.id;
      setSpaceId(first.id);
      void reload();
      return;
    }
    let live = true;
    void (async () => {
      try {
        const list = await ipc.listSpaces();
        if (!live) return;
        setSpaces(list);
        const saved = Number(await ipc.getSetting("active_space"));
        const pick = list.find((s) => s.id === saved) ?? list[0] ?? null;
        if (pick) {
          setSpaceId(pick.id);
          spaceRef.current = pick.id;
        }
      } catch (e) {
        if (live) toast(`页面加载失败: ${e}`);
      }
      if (live) void reload();
    })();
    return () => { live = false; };
  }, [authed]);

  // 切换页面 → 重新取该页面的照片
  const switchSpace = useCallback(
    (id: number) => {
      spaceRef.current = id;
      setSpaceId(id);
      setSpaces((list) => [...list]);
      // 浏览器回退模式下没有后端,不要发起 ipc;桌面端才持久化当前页面
      if (isTauri()) void ipc.setSetting("active_space", String(id)).catch(() => {});
      void reload();
    },
    [reload],
  );

  // ---------- 详情 ----------
  const openDetail = useCallback(
    async (id: number, source?: HTMLElement) => {
      try {
        const token=transition.current.cancel();
        const d = await ipc.getPhotoFull(id);
        if(!transition.current.current(token)) return;
        if (detailSource.current) detailSource.current.style.visibility = "";
        detailSource.current = source ?? null;
        setPhotoFormed(false);
        setAppView(s=>({...s,detail:{photo:d.photo,memory:d.memory},content:s.mainView==='galaxy'?'photo_focus':'photo_detail',exiting:false}));
        if (viewRef.current==='galaxy'||viewRef.current==='shelf') window.dispatchEvent(new CustomEvent("galaxy-focus-photo-star", { detail: id }));
      } catch (e) {
        toast(`打开失败: ${e}`);
      }
    },
    [toast],
  );

  const onPhotoDeleted=useCallback(async(id:number)=>{
    // The consumed image stays gone while every view receives the updated index.
    window.dispatchEvent(new Event("galaxy-discard-photo-star"));
    await reload();
    if(detailSource.current)detailSource.current.style.visibility="";
    detailSource.current=null;setPhotoFormed(false);
    setMapReturn(s=>s?.photoId===id?null:s);
    setLocationEdit(s=>s?.photoId===id?null:s);
    setAppView(s=>({...s,detail:s.detail?.photo.id===id?null:s.detail,content:'overview',exiting:false,mapPhotoId:s.mapPhotoId===id?null:s.mapPhotoId}));
    toast("已从相册中删除，原文件保留");
  },[reload,toast]);

  /** 时间轴批量删除：逐条走后端（每条都会清理关联表），最后统一刷新一次。 */
  const onDeletePhotos = useCallback(async (ids: number[]) => {
    for (const id of ids) {
      try { await ipc.deletePhoto(id); } catch (e) { toast(`删除失败：${e}`); break; }
    }
    await reload();
    toast(`已从相册删除 ${ids.length} 张记录，原文件保留`);
  }, [reload, toast]);

  /** 时间轴批量加星 / 取消星标。 */
  const onStarPhotos = useCallback(async (ids: number[], starred: boolean) => {
    for (const id of ids) {
      try { await ipc.toggleStar(id, starred); } catch (e) { toast(`操作失败：${e}`); break; }
    }
    await reload();
    toast(starred ? `已加星 ${ids.length} 张` : `已取消星标 ${ids.length} 张`);
  }, [reload, toast]);

  const onPhotoStarFormed = useCallback((_id: number) => {
    setPhotoFormed(true);
  }, []);
  const onPhotoStarFail = useCallback((id: number) => {
    // 粒子不可用:直接落到原图详情,不打断用户
    setPhotoFormed(false);
    setAppView(s => s.detail?.photo.id===id ? {...s,content:'photo_detail'} : s);
  }, []);

  const navDetail = useCallback(
    (dir: 1 | -1) => {
      if (photos.length === 0) return;
      const idx = photos.findIndex((p) => p.id === detailId);
      const next = photos[(idx + dir + photos.length) % photos.length];
      openDetail(next.id);
    },
    [photos, detailId, openDetail],
  );

  const visitPhotoMap = useCallback(async (edit:boolean) => {
    if (!detailData) return;
    try {
      const token=transition.current.cancel();
      // Read again after the detail fields have saved, so GPS and story never revert to an old snapshot.
      const fresh=await ipc.getPhotoFull(detailData.photo.id);
      if(!transition.current.current(token))return;
      setMapReturn({view:viewRef.current,albumId:viewRef.current==='shelf'?shelfFocus:null,photoId:fresh.photo.id});
      returningPhoto.current=null;
      mapTarget.current=fresh.photo.gpsLat!=null&&fresh.photo.gpsLon!=null?{lat:fresh.photo.gpsLat,lng:fresh.photo.gpsLon}:null;
      setLocationEdit(edit?{photoId:fresh.photo.id,returnView:viewRef.current,detail:fresh}:null);
      if(detailSource.current)detailSource.current.style.visibility="";
      detailSource.current=null;
      setPhotoFormed(false);
      setAppView(s=>({...s,detail:null,content:"overview",exiting:false,mapPhotoId:edit?null:fresh.photo.id}));
      changeView("map");
    } catch(e){toast(`打开地图失败：${e}`);}
  }, [detailData, shelfFocus, changeView, toast]);

  const returnToPhoto = useCallback(async () => {
    if(!mapReturn)return;
    try {
      const token=transition.current.cancel();
      const fresh=await ipc.getPhotoFull(mapReturn.photoId);
      if(!transition.current.current(token))return;
      returningPhoto.current={...mapReturn,detail:fresh};
      setLocationEdit(null);setMapReturn(null);mapTarget.current=null;
      setAppView(s=>({...s,mapPhotoId:null}));
      changeView(mapReturn.view);
    }catch(e){toast(`返回照片失败：${e}`);}
  },[mapReturn,changeView,toast]);

  useEffect(()=>{
    const pending=returningPhoto.current;
    if(!pending||view!==pending.view||navPending!==null||mapReleasing)return;
    if(view==='shelf'&&pending.albumId!==null&&shelfPhase!=='interior'){
      if(!pending.entering){pending.entering=true;enterAlbum(pending.albumId);}
      return;
    }
    returningPhoto.current=null;
    detailSource.current=null;
    setAppView(s=>({...s,detail:pending.detail,content:'photo_detail',exiting:false}));
    if(view==='galaxy'||view==='shelf')window.dispatchEvent(new CustomEvent("galaxy-focus-photo-star",{detail:pending.detail.photo.id}));
  },[view,navPending,mapReleasing,shelfPhase,enterAlbum,mapReturn]);

  const finishLocationEdit = useCallback(async (saved: boolean, place?: string) => {
    const context = locationEdit;
    if (!context) return;
    const token = transition.current.cancel();
    if (saved && place) {
      const fresh=await ipc.getPhotoFull(context.photoId);
      if(!transition.current.current(token))return;
      const m=fresh.memory;
      try { await ipc.saveMemory(context.photoId,m.title,m.text,place,m.mood); }
      catch(e) { toast(`坐标已保存，地点文字保存失败：${e}`); }
    }
    if (saved) await reload();
    if (!transition.current.current(token)) return;
    setLocationEdit(null);
    setAppView(s=>({...s,mainView:"map",detail:null,content:"overview",exiting:false,mapPhotoId:saved?context.photoId:null}));
  }, [locationEdit, reload, toast]);

  // 测试夹具专用入口(仅开发构建)
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__openDetail = (id: number) => void openDetail(id);
  }, [openDetail]);

  // ---------- 导入 ----------
  const doImport = useCallback(
    async (mode: "files" | "folder") => {
      setImportMenu(false);
      const sel = await open(
        mode === "folder"
          ? { directory: true, multiple: true, title: "选择照片与视频文件夹" }
          : {
              multiple: true,
              title: "选择照片或视频（含实况照片的静帧与动态）",
              filters: [
                {
                  name: "照片与视频",
                  extensions: [
                    "jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "tif",
                    "heic", "heif",
                    "mp4", "mov", "webm", "m4v", "mkv", "avi",
                  ],
                },
              ],
            },
      );
      if (!sel) return;
      const paths = (Array.isArray(sel) ? sel : [sel]).map(String);
      if (paths.length === 0) return;
      try {
        await ipc.importPhotos(paths);
        toast("导入已开始");
      } catch (e) {
        toast(`导入失败: ${e}`);
      }
    },
    [toast],
  );

  // 拖放导入(Tauri 专属:浏览器预览无 webview,直接跳过)
  useEffect(() => {
    if (!authed) return;
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    const p = getCurrentWebview().onDragDropEvent((ev) => {
      const t = ev.payload.type;
      if (t === "enter" || t === "over") {
        setDropping(true);
      } else if (t === "drop") {
        setDropping(false);
        const paths = ev.payload.paths ?? [];
        if (paths.length > 0) {
          ipc
            .importPhotos(paths)
            .then(() => toast("导入已开始"))
            .catch((e) => toast(`导入失败: ${e}`));
        }
      } else if (t === "leave") {
        setDropping(false);
      }
    });
    unDrag.current = () => p.then((f) => f());
    return () => {
      unDrag.current?.();
      unDrag.current = null;
    };
  }, [authed, toast]);

  // ---------- 自动锁定 + 快速隐藏 ----------
  useEffect(() => {
    if (!authed) return;
    const bump = () => (lastActivity.current = Date.now());
    window.addEventListener("mousemove", bump);
    window.addEventListener("keydown", bump);
    window.addEventListener("mousedown", bump);

    const onQuickLock = () => lock();
    window.addEventListener("quick-lock", onQuickLock);
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        onQuickLock();
      }
    };
    window.addEventListener("keydown", key);

    const tick = async () => {
      const v = (await ipc.getSetting("auto_lock")) ?? "15";
      if (v === "never") return;
      const mins = parseInt(v);
      if (Date.now() - lastActivity.current > mins * 60_000) {
        onQuickLock();
      }
    };
    const iv = setInterval(tick, 20_000);
    return () => {
      window.removeEventListener("mousemove", bump);
      window.removeEventListener("keydown", bump);
      window.removeEventListener("mousedown", bump);
      window.removeEventListener("keydown", key);
      window.removeEventListener("quick-lock", onQuickLock);
      clearInterval(iv);
    };
  }, [authed, lock]);

  // 相册双击聚焦(相册架 → 宇宙)
  useEffect(() => {
    const h = () => changeView("galaxy");
    window.addEventListener("open-album-in-galaxy", h);
    return () => window.removeEventListener("open-album-in-galaxy", h);
  }, []);

  // 视图切换 → 主场景氛围状态(详情弱化 / 其他页面保留轻微星野)
  const detailOpen = detailId !== null && !!detailData;
  useEffect(() => {
    const state = view === "galaxy" ? (detailOpen ? "detail" : "overview") : "ambient";
    window.dispatchEvent(new CustomEvent("galaxy-state", { detail: state }));
  }, [view, detailOpen]);

  const showLock = stage === "locked" || lockLeaving;

  const activeSpace = spaces.find((s) => s.id === spaceId) ?? null;
  const activeShape = activeSpace ? shapeOf(activeSpace.shape).id : undefined;
  const backdropUrl = activeSpace?.backgroundPhotoId
    ? tmPreview(activeSpace.backgroundPhotoId)
    : null;

  return (
    <div className="app">
      <TitleBar />

      <div className="stage">
        {/* 宇宙场景:散星 → 银河 → 照片 → 地球/相册区域/时间隧道,同一场景常驻 */}
        <GalaxyView
          photos={galaxyPhotos}
          albums={albums}
          connections={connections}
          hasContent={galaxyPhotos.length > 0}
          onSelectPhoto={openDetail}
          onImport={() => setImportMenu(true)}
          ready={dataReady}
          focusAlbumId={appView.albumId}
          suspended={view === "map" && navPending === null && !mapReleasing}
          active={stage === "ready" && !detailOpen && (view === "galaxy" || view === "shelf" || !!navPending)}
          hidden={view === "map" && navPending === null && !mapReleasing}
          authPhase={stage === "locked" ? "locked" : "converging"}
          convergeRate={convergeRate}
          onEnterComplete={onEnterComplete}
          onPhotoStarFormed={onPhotoStarFormed}
          onPhotoStarFail={onPhotoStarFail}
          onJourneyEvent={onJourneyEvent}
          onAlbumClick={setShelfFocus}
          onAlbumEnter={enterAlbum}
          viewIsGalaxy={view === "galaxy"}
          gpsPoints={useMemo(() => photos.filter((p) => p.gpsLat !== null && p.gpsLon !== null).map((p) => ({ lat: p.gpsLat as number, lng: p.gpsLon as number })), [photos])}
          shape={activeShape}
          backdropUrl={backdropUrl}
          backdropStrength={activeSpace?.backgroundStrength ?? 42}
        />
        {stage === "ready" && visited.timeline && (
          <div style={{ position: "absolute", inset: 0, opacity: view === "timeline" && navPending === null ? 1 : 0, pointerEvents: view === "timeline" && navPending === null ? "auto" : "none", transition: "opacity 430ms ease" }}>
            <TimelineView
              photos={photos}
              onThisDay={onThisDay}
              onOpenPhoto={openDetail}
              onDeletePhotos={onDeletePhotos}
              onStarPhotos={onStarPhotos}
            />
          </div>
        )}
        {stage === "ready" && visited.map && (
          <div style={{ position: "absolute", inset: 0, visibility: view === "map" || navPending === "map" || mapReleasing ? "visible" : "hidden" }}>
            <Suspense fallback={null}>
              <MapView photos={photos} onOpenPhoto={openDetail} focusPhotoId={appView.mapPhotoId} active={view === "map" && navPending === null && !mapReleasing}
                locationEdit={locationEdit ? {photoId:locationEdit.photoId,lat:locationEdit.detail.photo.gpsLat,lon:locationEdit.detail.photo.gpsLon} : null}
                onLocationDone={finishLocationEdit} onPhotosChanged={reload} />
            </Suspense>
          </div>
        )}
        {/* 相册区域面板:三维由场景渲染,面板在减速/到达后出现 */}
        {stage === "ready" && view === "shelf" && (
          <ShelfPanel
            albums={albums}
            photoCount={(albumId) => albums.find(a => a.id === albumId)?.photoCount ?? 0}
            focusAlbumId={shelfFocus}
            phase={navPending === "shelf" ? "traveling" : shelfPhase}
            visible={view === "shelf" && navPending === null && !detailOpen}
            onEnter={enterAlbum}
            onExit={exitAlbum}
            onChanged={reload}
          />
        )}
        {view === "map" && navPending === null && mapReturn && !detailOpen && <button className="map-detail-return pill-btn" onClick={()=>void returnToPhoto()} aria-label="返回照片详情">〈 返回照片</button>}
        {settingsOpen && <SettingsView onClose={()=>setSettingsOpen(false)} />}

        {stage === "ready" && !mapReturn && !returningPhoto.current && !(view === "shelf" && albumRibbonExpanded) && !(detailOpen && appView.content === "photo_detail") && (
          <TopBar
            view={navPending ?? view}
            searchOpen={searchOpen} onSearchChange={changeSearch}
            onView={v=>{setMapReturn(null);returningPhoto.current=null;mapTarget.current=null;setLocationEdit(null);setAppView(s=>({...s,mapPhotoId:null}));changeView(v);}}
            onImport={() => {setSearchOpen(false);setSettingsOpen(false);setImportMenu(s=>!s);}}
            onSettings={() => {setSearchOpen(false);setImportMenu(false);setSettingsOpen(s=>!s);}}
            onSlideshow={() => {
              const list = allPhotos.length ? allPhotos : photos;
              if (!list.length) { toast("还没有照片可以放映"); return; }
              setSearchOpen(false); setSettingsOpen(false); setImportMenu(false);
              setSlideshowOpen(true);
            }}
            onOpenPhoto={openDetail}
          />
        )}

        {stage === "ready" && view === "galaxy" && !detailOpen && spaces.length > 0 && (
          <SpaceBar
            spaces={spaces}
            activeId={spaceId}
            onSelect={switchSpace}
            onReload={() => {
              void ipc.listSpaces().then(setSpaces).catch(() => {});
              void reload();
            }}
            allPhotos={allPhotos}
          />
        )}

        {/* 星辰照片的轻量信息面板(粒子照片由场景呈现) */}
        {detailOpen && (view === "galaxy" || view === "shelf") && appView.content === "photo_focus" && (
          <div className={"preview-caption photo-star-caption" + (photoFormed ? " is-formed" : "")}>
            <span>记忆 · 粒子</span>
            <h2>{detailData!.memory.title || detailData!.photo.filename}</h2>
            <p>{detailData!.photo.captureDate?.slice(0, 10) ?? "日期未知"}{detailData!.memory.location ? ` · ${detailData!.memory.location}` : ""}</p>
            <div className="preview-actions">
              <button onClick={() => setAppView(s => ({...s, content: 'photo_detail'}))}>进入照片详情 ↗</button>
              <button onClick={() => window.dispatchEvent(new Event("galaxy-photo-reset"))}>回到正面</button>
              <button onClick={closeDetail}>返回 · ESC</button>
            </div>
          </div>
        )}
        {detailOpen && (view === "galaxy" || view === "shelf") && appView.content === "photo_focus" && (
          <EscHandler onEsc={closeDetail} />
        )}

        {importMenu && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 85,
            }}
            onClick={() => setImportMenu(false)}
          >
            <div
              className="search-panel"
              style={{ width: 260, left: "50%", right: "auto", transform: "translateX(-50%)" }}
              onClick={(e) => e.stopPropagation()}
            >
              <button className="search-result" onClick={() => doImport("files")}>
                <div className="meta">
                  <div className="t">导入照片…</div>
                  <div>加入时间轴，不自动创建星系</div>
                </div>
              </button>
              <button className="search-result" onClick={() => doImport("folder")}>
                <div className="meta">
                  <div className="t">导入文件夹…</div>
                  <div>以文件夹名创建星系，包含子目录照片</div>
                </div>
              </button>
              <div className="search-empty">原图保留在源文件夹；也可拖入照片或文件夹</div>
            </div>
          </div>
        )}

        {detailOpen && appView.content === "photo_detail" && view === "shelf" && albumRibbonExpanded && <StarStoryPhoto key={detailData!.photo.id} photo={detailData!.photo} memory={detailData!.memory} exiting={appView.exiting} onClose={closeDetail}/>}
        {detailOpen && appView.content === "photo_detail" && !(view === "shelf" && albumRibbonExpanded) && (
          <PhotoDetail
            onDeleted={onPhotoDeleted}
            key={detailData!.photo.id}
            originalFirst={view === "map"}
            sphereTransition={view === "shelf" && !detailSource.current}
            exiting={appView.exiting}
            source={detailSource.current}
            onClosed={finishDetailClose}
            onAlbum={()=>void visitPhotoMap(false)}
            onEditLocation={()=>void visitPhotoMap(true)}
            photo={detailData!.photo}
            memory={detailData!.memory}
            onMemoryChanged={reload}
            onClose={closeDetail}
            onNav={navDetail}
          />
        )}

        <ImportOverlay onFinished={reload} />
        <VideoPosterAgent photos={allPhotos} onChanged={reload} />
        {stage === "ready" && <BackfillBar onChanged={reload} />}

        {dropping && (
          <div className="drop-veil">
            <svg width="46" height="46" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.8 }}>
              <path
                d="M12 3c.5 5.4 3.7 8.6 9 9-5.4.5-8.6 3.7-9 9-.5-5.4-3.7-8.6-9-9 5.4-.5 8.6-3.7 9-9Z"
                fill="rgba(235,238,248,0.9)"
              />
            </svg>
            <div className="t1">松手,让回忆落入星辰</div>
            <div className="s" style={{ color: "var(--tx-3)", letterSpacing: "0.2em", fontSize: "var(--f-s)" }}>
              支持照片与文件夹
            </div>
          </div>
        )}

        {showLock && (
          <LockScreen hasPassword={hasPassword} passwordless={passwordless} ready={authReady} leaving={lockLeaving} onSuccess={unlock} />
        )}
      </div>

      {slideshowOpen && (
        <Slideshow
          photos={allPhotos.length ? allPhotos : photos}
          onClose={() => setSlideshowOpen(false)}
        />
      )}
    </div>
  );
}

/** Esc 只关最内层:聚焦面板 Esc = 收回星辰 */
function EscHandler({ onEsc }: { onEsc: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.matches && t.matches("input,textarea,select")) return;
      if (e.key === "Escape") onEsc();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onEsc]);
  return null;
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
