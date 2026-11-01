import { useEffect, useRef, useState } from "react";
import { ipc } from "../core/db";

/**
 * 后台补处理进度条。导入只处理前 N 张,剩下的在这里排队;
 * 用户看得见进度、能暂停,也就不会以为照片"丢了一部分"。
 */
export default function BackfillBar({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<{ running: boolean; paused: boolean; done: number; pending: number } | null>(null);
  const lastPending = useRef<number>(0);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const s = await ipc.backfillStatus();
        if (!live) return;
        setStatus(s);
        // 处理完一批就刷新一次列表,缩略图会陆续出现
        if (lastPending.current > 0 && s.pending < lastPending.current) onChanged();
        lastPending.current = s.pending;
      } catch {
        /* 锁定态读不到,忽略 */
      }
    };
    void tick();
    const timer = setInterval(tick, 2500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [onChanged]);

  if (!status || status.pending === 0) return null;
  const total = status.done + status.pending;

  return (
    <div className="backfill-bar">
      <span>
        {status.paused ? "已暂停" : status.running ? "后台整理中" : "待整理"} {status.done}/{total}
      </span>
      {status.paused || !status.running ? (
        <button
          onClick={() => {
            void ipc.setBackfillPaused(false).then(() => ipc.runBackfill()).catch(() => {});
          }}
        >
          继续
        </button>
      ) : (
        <button onClick={() => void ipc.setBackfillPaused(true).catch(() => {})}>暂停</button>
      )}
    </div>
  );
}
