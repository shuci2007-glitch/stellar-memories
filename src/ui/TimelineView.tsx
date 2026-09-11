import { useMemo } from "react";
import { tmThumb, type Photo } from "../core/types";
import { prewarmDetailPhoto } from '../three/DetailPhotoResources';

interface YearBlock {
  year: string;
  months: { month: string; photos: Photo[] }[];
}

/** 时间轴视图:年 → 月 → 照片 */
export default function TimelineView({
  photos,
  onOpenPhoto,
}: {
  photos: Photo[];
  onOpenPhoto: (id: number, source?: HTMLElement) => void;
}) {
  const blocks = useMemo<YearBlock[]>(() => {
    const byYear = new Map<string, Map<string, Photo[]>>();
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
          month: m === "未知" ? "未知" : `${parseInt(m.slice(5, 7))} 月`,
          photos: [...byYear.get(y)!.get(m)!].sort((a, b) =>
            (b.captureDate ?? "").localeCompare(a.captureDate ?? "") || b.id - a.id,
          ),
        })),
    }));
  }, [photos]);

  return (
    <div className="timeline">
      {blocks.length === 0 && (
        <div className="search-empty">还没有照片,先导入一些回忆吧</div>
      )}
      {blocks.map((b) => (
        <div key={b.year} className="year-block">
          <h2>{b.year === "未知时间" ? "未知时间" : `${b.year}`}</h2>
          <div className="months">
            {b.months.map((m) => (
              <div key={m.month} className="month-block">
                <h3>
                  {m.month}
                  <span style={{ marginLeft: 10, letterSpacing: "0.1em" }}>
                    {m.photos.length} 张
                  </span>
                </h3>
                <div className="photo-strip">
                  {m.photos.map((p) => (
                    <div key={p.id} className="ph" onPointerEnter={()=>prewarmDetailPhoto(p.id)} onFocus={()=>prewarmDetailPhoto(p.id)} onPointerDown={()=>prewarmDetailPhoto(p.id)} onClick={(e) => onOpenPhoto(p.id, e.currentTarget)}>
                      <img src={tmThumb(p.id)} alt={p.filename} loading="lazy" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
