import { useEffect, useState } from "react";
import { ipc } from "../core/db";
import { listenImportProgress } from "../core/events";
import type { ImportProgress } from "../core/types";

const PHASE_TEXT: Record<ImportProgress["phase"], string> = {
  scanning: "正在扫描照片",
  processing: "正在读取信息 · 生成缩略图与粒子",
  relations: "正在建立记忆关系",
  done: "导入完成",
  canceled: "已取消",
};

/** 右下角导入进度卡(可取消,可完成) */
export default function ImportOverlay({
  onFinished,
}: {
  onFinished: () => void;
}) {
  const [p, setP] = useState<ImportProgress | null>(null);

  useEffect(() => {
    let un: (() => void) | null = null;
    listenImportProgress((prog) => {
      setP(prog);
      if (prog.phase === "done" || prog.phase === "canceled") {
        if (prog.phase === "done") onFinished();
        setTimeout(() => setP(null), 2600);
      }
    }).then((u) => (un = u));
    return () => un?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!p) return null;
  const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  const done = p.phase === "done" || p.phase === "canceled";

  return (
    <div className="import-card">
      <div className="phase">{PHASE_TEXT[p.phase]}</div>
      <div className="count">
        {p.done} <small>/ {p.total || "…"}</small>
      </div>
      <div className="bar">
        <div style={{ width: `${pct}%` }} />
      </div>
      {!done && p.current && <div className="current">{p.current}</div>}
      {p.skipped > 0 && (
        <div className="current" style={{ color: "var(--tx-3)" }}>
          {p.skipped} 个文件已跳过(不支持的格式或读取失败)
        </div>
      )}
      <div className="row">
        <span style={{ fontSize: "var(--f-xs)", color: "var(--tx-3)", letterSpacing: "0.1em" }}>
          {pct}%
        </span>
        {!done && (
          <button onClick={() => ipc.cancelImport()}>取消导入</button>
        )}
      </div>
    </div>
  );
}
