import { useEffect, useMemo, useState } from "react";
import { tmThumb, type Photo } from "../core/types";
import TimelinePlayer from "./TimelinePlayer";

/**
 * 当前星系的全部照片。
 * 从宇宙页打开，网格铺开这个页面里的所有照片；点「播放全部」按顺序播，
 * 照片推镜到底、视频与实况播完再切下一张。
 */
export default function GalaxyGallery({
  spaceName,
  photos,
  onClose,
  onOpenPhoto,
}: {
  spaceName: string;
  photos: Photo[];
  onClose: () => void;
  onOpenPhoto: (id: number) => void;
}) {
  const [playing, setPlaying] = useState(false);

  // 播放时 ESC 交给播放器处理，避免一次按键把播放器和网格一起关掉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || playing) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, playing]);

  const stats = useMemo(() => {
    let video = 0;
    let live = 0;
    for (const p of photos) {
      if (p.kind === "video") video += 1;
      else if (p.liveVideoId != null) live += 1;
    }
    return { total: photos.length, video, live };
  }, [photos]);

  return (
    <div className="galaxy-gallery" role="dialog" aria-label={`${spaceName} 全部照片`}>
      <header className="gg-head">
        <div>
          <small>这个星系的全部照片</small>
          <h2>{spaceName}</h2>
          <p className="gg-meta">
            {stats.total} 张
            {stats.video > 0 && ` · 视频 ${stats.video}`}
            {stats.live > 0 && ` · 实况 ${stats.live}`}
          </p>
        </div>
        <div className="gg-actions">
          <button className="pill-btn primary" disabled={!photos.length} onClick={() => setPlaying(true)}>
            播放全部
          </button>
          <button className="pill-btn" onClick={onClose}>关闭 · ESC</button>
        </div>
      </header>

      {photos.length === 0 ? (
        <div className="gg-empty">这个星系还没有照片</div>
      ) : (
        <div className="gg-grid">
          {photos.map((p) => (
            <button
              key={p.id}
              className="gg-item"
              onClick={() => onOpenPhoto(p.id)}
              title={p.filename}
            >
              <img src={tmThumb(p.id)} alt={p.filename} loading="lazy" />
              {p.liveVideoId != null && <span className="thumb-live-badge">实况</span>}
              {p.kind === "video" && <span className="thumb-kind-badge">视频</span>}
              <span className="gg-date">{p.captureDate?.slice(0, 10) ?? ""}</span>
            </button>
          ))}
        </div>
      )}

      {playing && photos.length > 0 && (
        <TimelinePlayer
          photos={photos}
          onClose={() => setPlaying(false)}
          onOpenPhoto={(id) => {
            setPlaying(false);
            onOpenPhoto(id);
          }}
        />
      )}
    </div>
  );
}
