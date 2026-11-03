import { useCallback, useEffect, useRef, useState } from "react";
import { tmPhoto, tmThumb, tmVideo, type Photo } from "../core/types";

/** 放映只需要这几个字段，时间轴的精简对象也能直接传进来。 */
export type SlidePhoto = Pick<Photo, "id"> & {
  kind?: string;
  liveVideoId?: number | null;
  captureDate?: string | null;
  filename?: string;
};

/** 静帧展示时长与 Ken Burns 动画时长保持一致，画面要走到尽头再切。 */
const IMAGE_MS = 7200;
/** 实况照片：先亮静帧一小会儿（像手机上的实况），再自动播放动态片段。 */
const LIVE_STILL_MS = 1600;

/**
 * 播放一个媒体文件。
 * 浏览器/WebView 对「无用户手势的带声音自动播放」会拒绝，这里先试有声，
 * 失败就静音重播——总比黑着不动强。
 */
function SlideVideo({
  src,
  poster,
  paused,
  className,
  onEnded,
  onProgress,
  onFailed,
}: {
  src: string;
  poster?: string;
  paused: boolean;
  className: string;
  onEnded: () => void;
  onProgress: (ratio: number) => void;
  onFailed?: () => void;
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
      className={className}
      src={src}
      poster={poster}
      playsInline
      preload="auto"
      onEnded={onEnded}
      onError={() => onFailed?.()}
      onTimeUpdate={(e) => {
        const v = e.currentTarget;
        if (v.duration > 0) onProgress(Math.min(1, v.currentTime / v.duration));
      }}
    />
  );
}

/** 全屏幻灯片：给家人看的模式。空格/→ 下一张、← 上一张、ESC 退出。 */
export default function Slideshow({
  photos,
  startIndex = 0,
  onClose,
}: {
  photos: SlidePhoto[];
  startIndex?: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(() => Math.max(0, Math.min(startIndex, photos.length - 1)));
  const [playing, setPlaying] = useState(true);
  const [chrome, setChrome] = useState(true);
  /** 实况照片的两个阶段：先静帧，后动态 */
  const [livePhase, setLivePhase] = useState<"still" | "motion">("still");
  const [progress, setProgress] = useState(0);
  /** 视频解不出来（比如系统缺 HEVC 解码器）时回退成静帧，别把片子卡住 */
  const [videoFailed, setVideoFailed] = useState(false);
  const hideRef = useRef<number | null>(null);
  const photo = photos[index];

  const isVideo = photo?.kind === "video";
  const isLive = photo?.liveVideoId != null;
  /** 由媒体自己驱动进度和切页的类型（视频、实况的动态阶段） */
  const mediaDriven = !videoFailed && (isVideo || (isLive && livePhase === "motion"));

  const step = useCallback(
    (dir: 1 | -1) => setIndex((i) => (i + dir + photos.length) % photos.length),
    [photos.length],
  );

  // 换页：重置实况阶段与进度
  useEffect(() => {
    setLivePhase("still");
    setProgress(0);
    setVideoFailed(false);
  }, [index]);

  // 静帧阶段自动推进：普通照片到点切下一张，实况到点进入动态阶段
  useEffect(() => {
    if (!playing || photos.length === 0) return;
    if (isVideo && !videoFailed) return; // 视频播完由 onEnded 切
    if (isLive && livePhase === "motion" && !videoFailed) return; // 动态片段播完由 onEnded 切
    const ms = isLive && !videoFailed ? LIVE_STILL_MS : IMAGE_MS;
    const t = window.setTimeout(() => {
      if (isLive && !videoFailed) setLivePhase("motion");
      else step(1);
    }, ms);
    return () => window.clearTimeout(t);
  }, [playing, index, isVideo, isLive, livePhase, step, photos.length, videoFailed]);

  // 预取下一张，切页不闪
  useEffect(() => {
    const next = photos[(index + 1) % Math.max(1, photos.length)];
    if (!next) return;
    const img = new Image();
    img.src = tmPhoto(next.id);
    return () => {
      img.src = "";
    };
  }, [index, photos]);

  // 键盘：捕获阶段拦截，避免同时触发全局 ESC
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

  // 鼠标静止 2.6 秒后隐藏控制条
  useEffect(() => {
    const wake = () => {
      setChrome(true);
      if (hideRef.current) window.clearTimeout(hideRef.current);
      hideRef.current = window.setTimeout(() => setChrome(false), 2600);
    };
    wake();
    window.addEventListener("pointermove", wake);
    return () => {
      window.removeEventListener("pointermove", wake);
      if (hideRef.current) window.clearTimeout(hideRef.current);
    };
  }, []);

  if (!photo) return null;

  const showVideo = !videoFailed && (isVideo || (isLive && livePhase === "motion"));
  const videoSrc = isVideo
    ? tmVideo(photo.id)
    : isLive && photo.liveVideoId != null
      ? tmVideo(photo.liveVideoId)
      : "";

  return (
    <div className={`slideshow${chrome ? "" : " is-idle"}`} role="dialog" aria-label="幻灯片放映">
      {showVideo ? (
        <SlideVideo
          key={`v-${photo.id}-${livePhase}`}
          className="slide-img slide-video"
          src={videoSrc}
          poster={tmThumb(photo.id)}
          paused={!playing}
          onEnded={() => step(1)}
          onProgress={setProgress}
          onFailed={() => setVideoFailed(true)}
        />
      ) : (
        <img
          key={photo.id}
          className={`slide-img kb-${index % 2}`}
          src={tmPhoto(photo.id)}
          alt={photo.filename}
          onError={(e) => {
            const el = e.currentTarget;
            if (el.dataset.fb) return;
            el.dataset.fb = "1";
            el.src = tmThumb(photo.id);
          }}
          onClick={() => step(1)}
        />
      )}

      <div className="slide-top">
        <span className="slide-date">
          {photo.captureDate?.slice(0, 10) ?? "时间未知"}
          {isLive && <span className="slide-live-tag">实况</span>}
          {isVideo && <span className="slide-live-tag">视频</span>}
        </span>
        <span className="slide-count">
          {index + 1} / {photos.length}
        </span>
      </div>

      <div className="slide-bottom">
        <div className="slide-bar">
          {mediaDriven ? (
            <i style={{ width: `${Math.round(progress * 100)}%`, animation: "none" }} />
          ) : (
            <i
              key={`${index}-${playing}-${livePhase}`}
              style={{
                animationDuration: `${isLive && !videoFailed ? LIVE_STILL_MS : IMAGE_MS}ms`,
                animationPlayState: playing ? "running" : "paused",
              }}
            />
          )}
        </div>
        <div className="slide-controls">
          <button onClick={(e) => { e.stopPropagation(); step(-1); }} aria-label="上一张">‹</button>
          <button onClick={(e) => { e.stopPropagation(); setPlaying((p) => !p); }} aria-label={playing ? "暂停" : "播放"}>
            {playing ? "❚❚" : "▶"}
          </button>
          <button onClick={(e) => { e.stopPropagation(); step(1); }} aria-label="下一张">›</button>
          <button className="slide-exit" onClick={(e) => { e.stopPropagation(); onClose(); }}>退出 · ESC</button>
        </div>
        <div className="slide-name">{photo.filename ?? ""}</div>
      </div>
    </div>
  );
}
