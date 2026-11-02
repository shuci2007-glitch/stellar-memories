import { useCallback, useEffect, useRef, useState } from "react";
import { tmPhoto, tmThumb, type Photo } from "../core/types";

const DURATION = 5200;

/** 全屏幻灯片：给家人看的模式。空格暂停、←/→ 切换、ESC 退出。 */
export default function Slideshow({
  photos,
  startIndex = 0,
  onClose,
}: {
  photos: Photo[];
  startIndex?: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(() => Math.max(0, Math.min(startIndex, photos.length - 1)));
  const [playing, setPlaying] = useState(true);
  const [chrome, setChrome] = useState(true);
  const hideRef = useRef<number | null>(null);
  const photo = photos[index];

  const step = useCallback(
    (dir: 1 | -1) => setIndex((i) => (i + dir + photos.length) % photos.length),
    [photos.length],
  );

  // 自动播放
  useEffect(() => {
    if (!playing || photos.length < 2) return;
    const t = window.setTimeout(() => step(1), DURATION);
    return () => window.clearTimeout(t);
  }, [playing, index, step, photos.length]);

  // 预取下一张，切页不闪
  useEffect(() => {
    const next = photos[(index + 1) % Math.max(1, photos.length)];
    if (!next) return;
    const img = new Image();
    img.src = tmPhoto(next.id);
    return () => { img.src = ""; };
  }, [index, photos]);

  // 键盘：捕获阶段拦截，避免同时触发全局 ESC
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
      else if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); e.stopPropagation(); step(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); step(-1); }
      else if (e.key === "p" || e.key === "P") { e.stopPropagation(); setPlaying((v) => !v); }
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

  return (
    <div className={`slideshow${chrome ? "" : " is-idle"}`} role="dialog" aria-label="幻灯片放映">
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

      <div className="slide-top">
        <span className="slide-date">{photo.captureDate?.slice(0, 10) ?? "时间未知"}</span>
        <span className="slide-count">{index + 1} / {photos.length}</span>
      </div>

      <div className="slide-bottom">
        <div className="slide-bar">
          <i
            key={`${index}-${playing}`}
            style={{
              animationDuration: `${DURATION}ms`,
              animationPlayState: playing ? "running" : "paused",
            }}
          />
        </div>
        <div className="slide-controls">
          <button onClick={(e) => { e.stopPropagation(); step(-1); }} aria-label="上一张">‹</button>
          <button onClick={(e) => { e.stopPropagation(); setPlaying((p) => !p); }} aria-label={playing ? "暂停" : "播放"}>
            {playing ? "❚❚" : "▶"}
          </button>
          <button onClick={(e) => { e.stopPropagation(); step(1); }} aria-label="下一张">›</button>
          <button className="slide-exit" onClick={(e) => { e.stopPropagation(); onClose(); }}>退出 · ESC</button>
        </div>
        <div className="slide-name">{photo.filename}</div>
      </div>
    </div>
  );
}
