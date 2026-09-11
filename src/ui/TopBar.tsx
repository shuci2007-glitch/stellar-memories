import { useEffect, useRef, useState } from "react";
import { ipc } from "../core/db";
import { tmThumb, type Photo, type ViewMode } from "../core/types";

/** 顶栏:视图切换 + 搜索/导入/设置(极简) */
export default function TopBar({
  view,
  onView,
  onImport,
  onSettings,
  onOpenPhoto,
  searchOpen, onSearchChange,
}: {
  searchOpen: boolean;
  onSearchChange: (open: boolean) => void;
  view: ViewMode;
  onView: (v: ViewMode) => void;
  onImport: () => void;
  onSettings: () => void;
  onOpenPhoto: (id: number) => void;
}) {
  const setSearchOpen = onSearchChange;
  const panelRef = useRef<HTMLDivElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const [searchError, setSearchError] = useState("");
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Photo[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => inputRef.current?.focus(), 50);
      }
      if (e.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSearchChange]);

  useEffect(() => {
    if (!searchOpen) return;
    inputRef.current?.focus();
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Node && !panelRef.current?.contains(e.target) && !searchButtonRef.current?.contains(e.target)) setSearchOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [searchOpen, onSearchChange]);

  useEffect(() => {
    let cancelled = false;
    setSearchError(""); setResults([]);
    if (!searchOpen || !q.trim()) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const found = await ipc.searchPhotos(q.trim());
        if (!cancelled) setResults(found);
      } catch (error) {
        if (!cancelled) setSearchError(`搜索失败：${error}`);
      } finally { if (!cancelled) setLoading(false); }
    }, 220);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [q, searchOpen]);

  const views: { key: ViewMode; label: string }[] = [
    { key: "galaxy", label: "宇宙" },
    { key: "timeline", label: "时间轴" },
    { key: "map", label: "地图" },
    { key: "shelf", label: "相册架" },
  ];

  return (
    <div className="topbar">
      <div className="nav">
        {views.map((v) => (
          <button
            key={v.key}
            className={view === v.key ? "active" : ""}
            onClick={() => {setSearchOpen(false); onView(v.key);}}
          >
            {v.label}
          </button>
        ))}
      </div>
      <div className="actions">
        <button
          className="icon-btn"
          title="搜索 (Ctrl+F)"
          ref={searchButtonRef}
          onClick={() => {
            setSearchOpen(!searchOpen);
            setTimeout(() => inputRef.current?.focus(), 50);
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.6" />
            <path d="m15.5 15.5 5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <button className="icon-btn" title="导入照片" onClick={onImport}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <button className="icon-btn" title="设置" onClick={onSettings}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.6" />
            <path
              d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {searchOpen && (
        <div ref={panelRef} className="search-panel">
          <input
            ref={inputRef}
            placeholder="搜索文件名、日期、标题、故事、相册、地点…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setSearchOpen(false)}
          />
          {loading && <div className="search-empty">正在寻找记忆…</div>}
          {searchError && <div className="search-empty" role="alert">{searchError}</div>}
          {!loading && !searchError && results.length === 0 && q.trim() && (
            <div className="search-empty">没有找到相关的记忆</div>
          )}
          {results.map((p) => (
            <div
              key={p.id}
              className="search-result"
              onClick={() => {
                onOpenPhoto(p.id);
                setSearchOpen(false);
              }}
            >
              <img src={tmThumb(p.id)} alt="" loading="lazy" />
              <div className="meta">
                <div className="t">{p.filename}</div>
                <div>{p.captureDate?.slice(0, 10) ?? "日期未知"}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
