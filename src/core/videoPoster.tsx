import { useEffect, useRef } from "react";
import { ipc } from "./db";
import { tmVideo, type Photo } from "./types";

/**
 * 视频封面补全。
 *
 * 后端不解码视频(不引 ffmpeg,不给安装包加几十 MB),所以在渲染进程里用
 * <video> + canvas 截一帧,再把 JPEG 字节回写给后端。每轮最多处理几张,
 * 避免同时解码多个视频把内存顶上去。
 */
const PER_PASS = 2;

function grabFrame(src: string): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    let settled = false;
    const done = (value: Uint8Array | null) => {
      if (settled) return;
      settled = true;
      video.removeAttribute("src");
      video.load();
      resolve(value);
    };
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    video.onerror = () => done(null);
    video.onloadeddata = () => {
      const target = Math.min(
        Number.isFinite(video.duration) ? Math.max(0.1, video.duration * 0.1) : 0.5,
        3,
      );
      video.currentTime = target;
    };
    video.onseeked = () => {
      try {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) return done(null);
        const w = Math.min(640, vw);
        const h = Math.round((w * vh) / vw);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return done(null);
        ctx.drawImage(video, 0, 0, w, h);
        canvas.toBlob(
          async (blob) => {
            if (!blob) return done(null);
            done(new Uint8Array(await blob.arrayBuffer()));
          },
          "image/jpeg",
          0.82,
        );
      } catch {
        done(null);
      }
    };
    // 卡住的视频不要一直占着
    setTimeout(() => done(null), 12_000);
    video.src = src;
  });
}

export default function VideoPosterAgent({
  photos,
  onChanged,
}: {
  photos: Photo[];
  onChanged: () => void;
}) {
  const busy = useRef(false);

  useEffect(() => {
    if (busy.current) return;
    const pending = photos.filter((p) => p.kind === "video" && !p.thumbPath).slice(0, PER_PASS);
    if (pending.length === 0) return;
    busy.current = true;
    void (async () => {
      let saved = 0;
      for (const p of pending) {
        const bytes = await grabFrame(tmVideo(p.id));
        if (bytes && bytes.length > 0) {
          try {
            await ipc.saveVideoPoster(p.id, Array.from(bytes));
            saved += 1;
          } catch {
            /* 单张失败不影响其它 */
          }
        }
      }
      busy.current = false;
      if (saved > 0) onChanged();
    })();
  }, [photos, onChanged]);

  return null;
}
