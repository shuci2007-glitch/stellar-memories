import { useMemo, useState } from "react";
import { tmThumb } from "../core/types";
import { prewarmDetailPhoto } from '../three/DetailPhotoResources';
import TimelinePlayer from "./TimelinePlayer";

interface TimelinePhoto {
  id: number;
  captureDate: string | null;
  filename?: string;
  liveVideoId?: number | null;
  kind?: string;
  starred?: boolean;
  gpsLat?: number | null;
  gpsLon?: number | null;
}

interface YearBlock {
  year: string;
  months: { month: string; label: string; photos: TimelinePhoto[] }[];
}

type FilterKey = "all" | "photo" | "video" | "live" | "star" | "nogps";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "photo", label: "照片" },
  { key: "video", label: "视频" },
  { key: "live", label: "实况" },
  { key: "star", label: "已加星" },
  { key: "nogps", label: "无地点" },
];

function matchFilter(p: TimelinePhoto, f: FilterKey): boolean {
  switch (f) {
    case "photo": return p.kind !== "video";
    case "video": return p.kind === "video";
    case "live": return p.liveVideoId != null;
    case "star": return !!p.starred;
    case "nogps": return p.gpsLat == null || p.gpsLon == null;
    default: return true;
  }
}

function buildBlocks(photos: TimelinePhoto[]): YearBlock[] {
  const byYear = new Map<string, Map<string, TimelinePhoto[]>>();
  for (const p of photos) {
    const key = p.captureDate?.slice(0, 10) ?? "unknown";
    const year = key === "unknown" ? "未知时间" : key.slice(0, 4);
    const month = key === "unknown" ? "未知" : key.slice(0, 7);
    if (!byYear.has(year)) byYear.set(year, new Map());
    const months = byYear.get(year)!;
    if (!months.has(month)) months.set(month, []);
    months.get(month)!.push(p);
  }
  const years = [...byYear.keys()].sort((a, b) =>
    a === "未知时间" ? 1 : b === "未知时间" ? -1 : b.localeCompare(a),
  );
  return years.map((y) => ({
    year: y,
    months: [...byYear.get(y)!.keys()]
      .sort((a, b) => (a === "未知" ? 1 : b === "未知" ? -1 : b.localeCompare(a)))
      .map((m) => ({
        month: m,
        label: m === "未知" ? "未知" : `${parseInt(m.slice(5, 7))} 月`,
        photos: [...byYear.get(y)!.get(m)!].sort((a, b) =>
          (b.captureDate ?? "").localeCompare(a.captureDate ?? "") || b.id - a.id,
        ),
      })),
  }));
}

/** 时间轴视图:年 → 月 → 照片，带筛选与批量整理。 */
export default function TimelineView({
  photos,
  onThisDay = [],
  onOpenPhoto,
  onDeletePhotos,
  onStarPhotos,
}: {
  photos: TimelinePhoto[];
  onThisDay?: TimelinePhoto[];
  onOpenPhoto: (id: number, source?: HTMLElement) => void;
  onDeletePhotos?: (ids: number[]) => Promise<void> | void;
  onStarPhotos?: (ids: number[], starred: boolean) => Promise<void> | void;
}) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  /** 页内播放：null 表示没在播 */
  const [player, setPlayer] = useState<{ list: TimelinePhoto[]; start: number } | null>(null);

  const shown = useMemo(() => photos.filter((p) => matchFilter(p, filter)), [photos, filter]);
  const blocks = useMemo(() => buildBlocks(shown), [shown]);

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const selectAll = () => setSelected(new Set(shown.map((p) => p.id)));
  const clearSelection = () => setSelected(new Set());
  const exitSelecting = () => { setSelecting(false); clearSelection(); };

  const applyStar = async (starred: boolean) => {
    const ids = [...selected];
    if (!ids.length || !onStarPhotos) return;
    await onStarPhotos(ids, starred);
    clearSelection();
  };

  const removeSelected = async () => {
    const ids = [...selected];
    if (!ids.length || !onDeletePhotos) return;
    if (!window.confirm(`从相册中删除选中的 ${ids.length} 张记录？原文件不会被删除。`)) return;
    await onDeletePhotos(ids);
    exitSelecting();
  };

  return (
    <div className="timeline">
      <div className="tl-toolbar">
        <div className="tl-chips">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`tl-chip${filter === f.key ? " on" : ""}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        {selecting ? (
          <div className="tl-actions">
            <span className="tl-count">{selected.size} 已选</span>
            <button onClick={selectAll}>全选</button>
            <button onClick={clearSelection}>清空</button>
            <button disabled={!selected.size} onClick={() => void applyStar(true)}>加星</button>
            <button disabled={!selected.size} onClick={() => void applyStar(false)}>取消星标</button>
            <button className="danger" disabled={!selected.size} onClick={() => void removeSelected()}>删除</button>
            <button className="primary" onClick={exitSelecting}>完成</button>
          </div>
        ) : (
          <div className="tl-actions">
            <span className="tl-count">{shown.length} 张</span>
            <button
              disabled={!shown.length}
              onClick={() => setPlayer({ list: shown, start: 0 })}
              title="在当前页里逐张播放（照片缓慢推近到底，视频与实况直接播）"
            >
              播放
            </button>
            <button className="tl-select" onClick={() => setSelecting(true)}>选择</button>
          </div>
        )}
      </div>

      {onThisDay.length > 0 && filter === "all" && !selecting && (
        <section className="tl-otd">
          <h3>往年今天 <span>{onThisDay.length} 张</span></h3>
          <div className="photo-strip">
            {onThisDay.map((p) => (
              <div
                key={p.id}
                className="ph"
                onPointerEnter={() => prewarmDetailPhoto(p.id)}
                onClick={(e) => onOpenPhoto(p.id, e.currentTarget)}
              >
                <img src={tmThumb(p.id)} alt={p.filename} loading="lazy" />
                {p.liveVideoId != null && <span className="thumb-live-badge">实况</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      {shown.length === 0 && (
        <div className="search-empty">
          {photos.length === 0 ? "还没有照片,先导入一些回忆吧" : "该筛选下没有照片"}
        </div>
      )}

      {blocks.map((b) => (
        <div key={b.year} className="year-block">
          <h2>{b.year === "未知时间" ? "未知时间" : `${b.year}`}</h2>
          <div className="months">
            {b.months.map((m) => (
              <div key={m.month} className="month-block">
                <h3>
                  {m.label}
                  <span style={{ marginLeft: 10, letterSpacing: "0.1em" }}>
                    {m.photos.length} 张
                  </span>
                </h3>
                <div className="photo-strip">
                  {m.photos.map((p) => {
                    const isSelected = selected.has(p.id);
                    return (
                      <div
                        key={p.id}
                        className={`ph${isSelected ? " selected" : ""}`}
                        onPointerEnter={() => prewarmDetailPhoto(p.id)}
                        onFocus={() => prewarmDetailPhoto(p.id)}
                        onPointerDown={() => prewarmDetailPhoto(p.id)}
                        onClick={(e) => {
                          if (selecting) toggle(p.id);
                          else onOpenPhoto(p.id, e.currentTarget);
                        }}
                      >
                        <img src={tmThumb(p.id)} alt={p.filename} loading="lazy" />
                        {p.liveVideoId != null && <span className="thumb-live-badge">实况</span>}
                        {p.kind === "video" && <span className="thumb-kind-badge">视频</span>}
                        {selecting && <span className={`ph-check${isSelected ? " on" : ""}`} />}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {player && (
        <TimelinePlayer
          photos={player.list}
          startIndex={player.start}
          onClose={() => setPlayer(null)}
          onOpenPhoto={(id) => onOpenPhoto(id)}
        />
      )}
    </div>
  );
}
