import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import GalaxyView from "./GalaxyView";
import TimelineView from "./TimelineView";
import { ipc } from "../core/db";
import { tmPreview } from "../core/types";
import { shapeOf, type Space } from "../core/spaces";
import type { Album, Connection, GalaxyPhoto } from "../core/types";

/** 壁纸不做地球漫游,恒定为空且引用稳定,避免每次渲染都触发场景副作用。 */
const NO_GPS: { lat: number; lng: number }[] = [];

/**
 * 桌面壁纸分支:同一个 Three.js 星系,但不带任何界面。
 * 页面不接收交互(桌面图标在上面),锁定后立刻散成星野,避免把私人照片摊在桌面上。
 */
export default function WallpaperApp() {
  const [photos, setPhotos] = useState<GalaxyPhoto[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [ready, setReady] = useState(false);
  const [authPhase, setAuthPhase] = useState<"locked" | "converging">("converging");
  const [space, setSpace] = useState<Space | null>(null);

  // 桌面热键 Ctrl+Alt+T 切换:在壁纸画面内叠加/关闭时间轴。
  const [timelineMode, setTimelineMode] = useState(false);
  const timelinePhotos = useMemo(
    () =>
      photos.map((p) => ({
        id: p.id,
        captureDate: p.captureDate,
        filename: p.title ?? "",
        liveVideoId: null,
      })),
    [photos],
  );
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<boolean>("wallpaper:timeline", (e) => setTimelineMode(!!e.payload)).then(
      (u) => (unlisten = u),
    );
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const state = await ipc.authState();
        if (!live) return;
        setAuthPhase(state.unlocked ? "converging" : "locked");
        if (!state.unlocked) return;
        const [a, g, c, spaces] = await Promise.all([
          ipc.listAlbums(),
          ipc.getGalaxyData(),
          ipc.getConnections(),
          ipc.listSpaces(),
        ]);
        if (!live) return;
        setAlbums(a);
        setPhotos(g);
        setConnections(c);
        // 壁纸跟着主界面当前选中的页面走(图形、背景照片、照片范围)
        const saved = Number(await ipc.getSetting("active_space"));
        const pick = spaces.find((s) => s.id === saved) ?? spaces[0] ?? null;
        if (pick) {
          const scoped = await ipc.getGalaxyData(pick.id);
          if (!live) return;
          setPhotos(scoped);
          setSpace(pick);
        }
        setReady(true);
      } catch {
        // 锁屏期间 IPC 会被拒绝,保持现状即可
      }
    };
    void load();
    // 图库变动后重新取一次;壁纸没有交互入口,只能靠轮询跟上主界面。
    const dataTimer = setInterval(load, 60_000);
    const lockTimer = setInterval(async () => {
      try {
        const state = await ipc.authState();
        if (!live) return;
        setAuthPhase(state.unlocked ? "converging" : "locked");
      } catch {
        /* ignore */
      }
    }, 15_000);
    return () => {
      live = false;
      clearInterval(dataTimer);
      clearInterval(lockTimer);
    };
  }, []);

  // 壁纸只做星系漫游,不会飞地球,不需要记忆光点。
  const noop = () => {};

  return (
    <div className="wallpaper-root">
      <GalaxyView
        photos={photos}
        albums={albums}
        connections={connections}
        hasContent
        onSelectPhoto={noop}
        onImport={noop}
        ready={ready}
        focusAlbumId={null}
        suspended={false}
        active={false}
        hidden={false}
        authPhase={authPhase}
        convergeRate={2.8}
        onEnterComplete={noop}
        onPhotoStarFormed={noop}
        onPhotoStarFail={noop}
        onJourneyEvent={noop}
        onAlbumClick={noop}
        onAlbumEnter={noop}
        viewIsGalaxy={false}
        gpsPoints={NO_GPS}
        maxFps={30}
        shape={space ? shapeOf(space.shape).id : undefined}
        backdropUrl={space?.backgroundPhotoId ? tmPreview(space.backgroundPhotoId) : null}
        backdropStrength={space?.backgroundStrength ?? 42}
      />
      {timelineMode && (
        <div className="wallpaper-timeline-overlay">
          <TimelineView photos={timelinePhotos} onOpenPhoto={noop} />
        </div>
      )}
    </div>
  );
}
