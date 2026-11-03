import { useCallback, useEffect, useRef, useState } from "react";
import { tmPhoto, tmThumb, tmVideo } from "../core/types";
import type { SlidePhoto } from "./Slideshow";

/** 照片停留时长 = 镜头推到底的时长，动画走完才切下一张。 */
const PUSH_MS = 6500;
/** 实况先亮静帧一小会儿，再放动态片段。 */
const LIVE_STILL_MS = 1600;

function PlayerVideo({
  src,
  poster,
  paused,
  onEnded,
  onProgress,
  onFailed,
}: {
  src: string;
  poster?: string;
  paused: boolean;
  onEnded: () => void;
  onProgress: (r: number) => void;
  onFailed: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (paused) {
      el.pause();
      return;
    }
    const p = el.play();
    if (p && typeof p.catch === "function") {
      p.catch(() => {
        el.muted = true;
        void el.play().catch(() => {});
      });
    }
  }, [paused, src]);
  return (
    <video
      ref={ref}
      className="tl-player-media"
      src={src}
      poster={poster}
      playsInline
      preload="auto"
      onEnded={onEnded}
      onError={onFailed}
      onTimeUpdate={(e) => {
        const v = e.currentTarget;
        if (v.duration > 0) onProgress(Math.min(1, v.currentTime / v.duration));
      }}
    />
  );
}

/**
 * 时间轴页内的播放器。
 * 镜头从原尺寸缓慢推到 1.32 倍，走完整段推镜才切下一位；
 * 视频和实况直接播，实况先静帧再放动态片段。
 */
export default function TimelinePlayer({
  photos,
  startIndex = 0,
  onClose,
  onOpenPhoto,
}: {
  photos: SlidePhoto[];
  startIndex?: number;
  onClose: () => void;
  onOpenPhoto?: (id: number) => void;
}) {
  const [index, setIndex] = useState(() => Math.max(0, Math.min(startIndex, photos.length - 1)));
  const [playing, setPlaying] = useState(true);
  const [livePhase, setLivePhase] = useState<"still" | "motion">("still");
  const [progress, setProgress] = useState(0);
  const [imgReady, setImgReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const photo = photos[index];

  const isVideo = photo?.kind === "video";
  const isLive = photo?.liveVideoId != null;
  const videoSrc = isVideo
    ? tmVideo(photo.id)
    : isLive && livePhase === "motion" && photo.liveVideoId != null
      ? tmVideo(photo.liveVideoId)
      : "";
  const mediaDriven = !failed && !!videoSrc;

  const step = useCallback(
    (dir: 1 | -1) => setIndex((i) => (i + dir + photos.length) % photos.length),
    [photos.length],
  );

  useEffect(() => {
    setLivePhase("still");
    setProgress(0);
    setImgReady(false);
    setFailed(false);
  }, [index]);

  // 静帧阶段推进：照片推镜走完、实况静帧到点进动态
  useEffect(() => {
    if (!playing || !photos.length) return;
    if (isVideo && !failed) return; // 视频播完自己切
    if (isLive && livePhase === "motion" && !failed) return;
    if (!isLive && !isVideo && !imgReady) return; // 图没出来先不计时
    const ms = isLive ? LIVE_STILL_MS : PUSH_MS;
    const t = window.setTimeout(() => {
      if (isLive && !failed) setLivePhase("motion");
      else step(1);
    }, ms);
    return () => window.clearTimeout(t);
  }, [playing, index, isVideo, isLive, livePhase, failed, imgReady, step, photos.length]);

  // 图还没加载完时给个上限，避免一张坏图把播放卡死
  useEffect(() => {
    if (isVideo || isLive) return;
    const t = window.setTimeout(() => setImgReady(true), 3000);
    return () => window.clearTimeout(t);
  }, [index, isVideo, isLive]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        step(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        step(-1);
      } else if (e.key === "p" || e.key === "P") {
        e.stopPropagation();
        setPlaying((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, step]);

  if (!photo) return null;

  return (
    <div className="tl-player" role="dialog" aria-label="播放时间轴">
      <div className="tl-player-stage">
        {mediaDriven ? (
          <PlayerVideo
            key={`v-${photo.id}-${livePhase}`}
            src={videoSrc}
            poster={tmThumb(photo.id)}
            paused={!playing}
            onEnded={() => step(1)}
            onProgress={setProgress}
            onFailed={() => setFailed(true)}
          />
        ) : (
          <img
            key={photo.id}
            className={`tl-player-media tl-player-dolly${playing ? "" : " is-paused"}`}
            src={tmPhoto(photo.id)}
            alt={photo.filename ?? ""}
            onLoad={() => setImgReady(true)}
            onError={(e) => {
              const el = e.currentTarget;
              setImgReady(true);
              if (!el.dataset.fb) {
                el.dataset.fb = "1";
                el.src = tmThumb(photo.id);
              }
            }}
          />
        )}

        <div className="tl-player-top">
          <span className="tl-player-date">{photo.captureDate?.slice(0, 10) ?? "时间未知"}</span>
          <span className="tl-player-count">
            {index + 1} / {photos.length}
          </span>
        </div>
      </div>

      <div className="tl-player-bar">
        <div className="tl-player-track">
          {mediaDriven ? (
            <i style={{ width: `${Math.round(progress * 100)}%`, animation: "none" }} />
          ) : isLive ? (
            <i
              key={`${index}-${livePhase}-${playing}`}
              style={{
                animationDuration: `${LIVE_STILL_MS}ms`,
                animationPlayState: playing ? "running" : "paused",
              }}
            />
          ) : (
            <i
              key={`${index}-${playing}-${imgReady}`}
              style={{
                animationDuration: `${PUSH_MS}ms`,
                animationPlayState: playing && imgReady ? "running" : "paused",
              }}
            />
          )}
        </div>
        <div className="tl-player-controls">
          <button onClick={() => step(-1)} aria-label="上一张">‹</button>
          <button onClick={() => setPlaying((p) => !p)} aria-label={playing ? "暂停" : "继续"}>
            {playing ? "暂停" : "继续"}
          </button>
          <button onClick={() => step(1)} aria-label="下一张">›</button>
          {onOpenPhoto && (
            <button
              onClick={() => {
                onClose();
                onOpenPhoto(photo.id);
              }}
              className="tl-player-open"
            >
              看这张
            </button>
          )}
          <span className="tl-player-name">{photo.filename ?? ""}</span>
          <button className="tl-player-exit" onClick={onClose}>退出 · ESC</button>
        </div>
      </div>
    </div>
  );
}
