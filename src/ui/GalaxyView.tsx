import { useEffect, useRef } from "react";
import { GalaxyScene, type SceneStateName, type JourneyEvent } from "../three/GalaxyScene";
import type { Album, Connection, GalaxyPhoto } from "../core/types";

/** 记忆宇宙 3D 视图(从锁屏散星到银河到照片到地球/相册/隧道,同一场景常驻) */
export default function GalaxyView({
  photos,
  albums,
  connections,
  hasContent,
  onSelectPhoto,
  onImport,
  ready,
  focusAlbumId,
  suspended,
  active,
  hidden,
  authPhase,
  convergeRate = 1.45,
  onEnterComplete,
  onPhotoStarFormed,
  onPhotoStarFail,
  onJourneyEvent,
  onAlbumClick,
  onAlbumEnter,
  viewIsGalaxy,
  gpsPoints,
  maxFps,
  shape,
  backdropUrl,
  backdropStrength,
}: {
  photos: GalaxyPhoto[];
  albums: Album[];
  connections: Connection[];
  hasContent: boolean;
  onSelectPhoto: (id: number) => void;
  onImport: () => void;
  ready: boolean;
  focusAlbumId: number|null;
  suspended: boolean;
  active: boolean;
  hidden: boolean;
  /** 认证相位:可重放状态,由场景在实际渲染中对齐;不用一次性事件猜时序 */
  authPhase: "locked" | "converging" | "locking";
  convergeRate?: number;
  onEnterComplete: () => void;
  onPhotoStarFormed: (id: number) => void;
  onPhotoStarFail: (id: number) => void;
  onJourneyEvent: (event: JourneyEvent) => void;
  onAlbumClick: (albumId: number) => void;
  onAlbumEnter: (albumId: number) => void;
  /** 只在宇宙页且无照片时显示导入引导 */
  viewIsGalaxy: boolean;
  /** 有 GPS 的照片:地球上的记忆光点 */
  gpsPoints: { lat: number; lng: number }[];
  /** 帧率上限(桌面壁纸常驻时降频,0 或不传为不限) */
  maxFps?: number;
  /** 当前页面的图形 id(见 core/spaces.ts) */
  shape?: string;
  /** 页面背景照片的图片地址,空则无背景板 */
  backdropUrl?: string | null;
  /** 背景照片的存在感(0-100) */
  backdropStrength?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<GalaxyScene | null>(null);
  const cbRef = useRef({ onPhotoStarFormed, onPhotoStarFail, onEnterComplete, onJourneyEvent, onAlbumClick, onAlbumEnter });
  cbRef.current = { onPhotoStarFormed, onPhotoStarFail, onEnterComplete, onJourneyEvent, onAlbumClick, onAlbumEnter };

  // 初始化引擎(只一次;初始为锁定散星态,由 authPhase 驱动汇聚/散开)
  useEffect(() => {
    if (!canvasRef.current || !labelRef.current || sceneRef.current) return;
    const scene = new GalaxyScene({
      onSelectPhoto,
      onEnterComplete: () => cbRef.current.onEnterComplete(),
      onPhotoStarFormed: (id) => cbRef.current.onPhotoStarFormed(id),
      onPhotoStarFail: (id) => cbRef.current.onPhotoStarFail(id),
      onJourneyEvent: (event) => cbRef.current.onJourneyEvent(event),
      onAlbumClick: (albumId) => cbRef.current.onAlbumClick(albumId),
      onAlbumEnter: (albumId) => cbRef.current.onAlbumEnter(albumId),
    });
    scene.init(canvasRef.current, labelRef.current);
    scene.start();
    sceneRef.current = scene;
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__galaxyScene = scene;
    const ro = new ResizeObserver(() => scene.onResize());
    ro.observe(canvasRef.current);
    return () => {
      ro.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 认证相位 → 场景(可重放:重复执行幂等,挂载即对齐当前相位)
  useEffect(() => {
    sceneRef.current?.setAuthPhase(authPhase, convergeRate);
  }, [authPhase, convergeRate]);

  // 帧率上限(壁纸模式 30fps,主界面不限)
  useEffect(() => {
    sceneRef.current?.setMaxFps(maxFps ?? 0);
  }, [maxFps]);

  // 页面形态与背景照片
  useEffect(() => {
    if (shape) sceneRef.current?.setShape(shape);
  }, [shape]);
  useEffect(() => {
    sceneRef.current?.setBackdrop(backdropUrl ?? null, backdropStrength ?? 42);
  }, [backdropUrl, backdropStrength]);

  // 星辰照片聚焦/收回 + 旅程导航指令(App → 场景)
  useEffect(() => {
    const focusStar = (e: Event) => {
      void sceneRef.current?.focusPhotoStar((e as CustomEvent<number>).detail);
    };
    const collapse = () => { void sceneRef.current?.collapsePhotoStar().then(() => window.dispatchEvent(new Event("galaxy-photo-closed"))); };
    const discard = () => { void sceneRef.current?.collapsePhotoStar(true); };
    const reset = () => sceneRef.current?.resetPhotoView();
    const travelTo = (e: Event) => {
      const d = (e as CustomEvent<{ destination: "earth" | "shelf" | "timeline"; lat?: number; lng?: number }>).detail;
      sceneRef.current?.travelTo(d.destination, d);
    };
    const travelBack = () => sceneRef.current?.travelBack();
    const albumEnter = (e: Event) => sceneRef.current?.enterAlbum((e as CustomEvent<number>).detail);
    const albumRibbon = (e: Event) => sceneRef.current?.setAlbumRibbon((e as CustomEvent).detail);
    const albumEdit = (e: Event) => sceneRef.current?.editAlbum((e as CustomEvent).detail);
    const albumExit = () => sceneRef.current?.exitAlbum();
    const earthConfirm = () => sceneRef.current?.confirmEarthHandoff();
    const earthResume = (e: Event) => sceneRef.current?.resumeFromEarth((e as CustomEvent).detail);
    window.addEventListener("galaxy-focus-photo-star", focusStar);
    window.addEventListener("galaxy-collapse-photo-star", collapse);
    window.addEventListener("galaxy-photo-reset", reset);
    window.addEventListener("galaxy-discard-photo-star", discard);
    window.addEventListener("journey-to", travelTo);
    window.addEventListener("journey-back", travelBack);
    window.addEventListener("album-enter", albumEnter);
    window.addEventListener("album-exit", albumExit);
    window.addEventListener("album-editor", albumEdit);
    window.addEventListener("album-ribbon", albumRibbon);
    window.addEventListener("earth-handoff-confirm", earthConfirm);
    window.addEventListener("earth-resume", earthResume);
    return () => {
      window.removeEventListener("galaxy-focus-photo-star", focusStar);
      window.removeEventListener("galaxy-collapse-photo-star", collapse);
      window.removeEventListener("galaxy-photo-reset", reset);
      window.removeEventListener("galaxy-discard-photo-star", discard);
      window.removeEventListener("journey-to", travelTo);
      window.removeEventListener("journey-back", travelBack);
      window.removeEventListener("album-enter", albumEnter);
      window.removeEventListener("album-exit", albumExit);
      window.removeEventListener("album-editor", albumEdit);
      window.removeEventListener("album-ribbon", albumRibbon);
      window.removeEventListener("earth-handoff-confirm", earthConfirm);
      window.removeEventListener("earth-resume", earthResume);
    };
  }, []);

  // 数据就绪后载入
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !ready) return;
    scene.setData(photos, albums, connections);
  }, [photos, albums, connections, ready]);

  // 地球记忆光点随照片 GPS 更新
  useEffect(() => {
    sceneRef.current?.setMemoryDots(gpsPoints);
  }, [gpsPoints]);

  useEffect(()=> { if(ready && focusAlbumId!==null) sceneRef.current?.focusCluster(focusAlbumId); },[ready,focusAlbumId,photos]);
  // 地图页完全遮挡时停止渲染;详情打开时保持弱化运行(状态机淡出)
  useEffect(()=> { if(suspended) sceneRef.current?.stop(); else sceneRef.current?.start(); },[suspended]);
  useEffect(()=> { sceneRef.current?.setActive(active); },[active]);
  // 窗口最小化/后台时暂停渲染,回前台平稳恢复
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) sceneRef.current?.stop();
      else if (!suspended) sceneRef.current?.start();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [suspended]);

  // 状态机:detail / ambient / overview 由 App 广播,场景阻尼过渡(不硬停)
  useEffect(() => {
    const handler = (e: Event) => {
      sceneRef.current?.setState((e as CustomEvent<string>).detail as SceneStateName);
    };
    window.addEventListener("galaxy-state", handler);
    return () => window.removeEventListener("galaxy-state", handler);
  }, []);

  // 外部请求聚焦相册 / 返回全景
  useEffect(() => {
    const handler = (e: Event) => {
      const albumId = (e as CustomEvent<number | null>).detail;
      sceneRef.current?.focusCluster(albumId);
    };
    window.addEventListener("galaxy-focus-cluster", handler);
    return () => window.removeEventListener("galaxy-focus-cluster", handler);
  }, []);
  useEffect(() => {
    const handler = () => sceneRef.current?.resetOverview();
    window.addEventListener("galaxy-reset", handler);
    return () => window.removeEventListener("galaxy-reset", handler);
  }, []);

  return (
    <div style={{ position: "absolute", inset: 0, visibility: hidden ? "hidden" : "visible" }}>
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: 1 }} />
      <div ref={labelRef} style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 2 }} />
      {!hidden && active && !hasContent && <GalaxyEmpty onImport={onImport} visible={viewIsGalaxy} />}
    </div>
  );
}

function GalaxyEmpty({ onImport, visible }: { onImport: () => void; visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="empty">
      <div className="t">把你的回忆放进这里</div>
      <div className="s">每一张照片 · 都会成为一颗星辰</div>
      <button className="pill-btn primary btn" onClick={onImport}>
        导入照片
      </button>
      <div className="drag-hint">或将照片 / 文件夹拖入窗口</div>
    </div>
  );
}
