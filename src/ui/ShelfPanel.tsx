import AlbumGalaxyEditor from "./AlbumGalaxyEditor";
import { useEffect, useState } from "react";
import { ipc } from "../core/db";
import { useToast } from "../core/toast";
import { tmThumb, type TimelineItem, type Album } from "../core/types";

/**
 * 相册区域的 DOM 面板:目录(预选/确认进入/重命名)与相册内部(返回)。
 * 三维部分(相册星系、照片粒子球)由 GalaxyScene 的相册区域渲染;
 * 面板只在旅程减速/到达后出现。
 */
export default function ShelfPanel({
  albums,
  photoCount,
  focusAlbumId,
  phase,
  visible,
  onEnter,
  onExit,
  onChanged,
}: {
  albums: Album[];
  photoCount: (albumId: number) => number;
  focusAlbumId: number | null;
  phase: "traveling" | "index" | "interior";
  visible: boolean;
  onEnter: (albumId: number) => void;
  onExit: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [ribbon,setRibbon]=useState({expanded:false,index:0,count:0});
  useEffect(()=>{const state=(e:Event)=>setRibbon((e as CustomEvent).detail);window.addEventListener("album-ribbon-state",state);return()=>window.removeEventListener("album-ribbon-state",state);},[]);
  const ribbonAction=(action:string)=>window.dispatchEvent(new CustomEvent("album-ribbon",{detail:action}));
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [choices, setChoices] = useState<TimelineItem[]>([]);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const openCreate = async () => {
    setCreating(true); setDraftName(""); setChosen(new Set()); setError(""); setLoading(true);
    try { setChoices(await ipc.getTimeline()); }
    catch (e) { setChoices([]); setError(`照片读取失败：${e}`); }
    finally { setLoading(false); }
  };
  const saveCreate = async () => {
    if (saving) return;
    if (!draftName.trim()) { setError("请输入星系名称"); return; }
    if (!chosen.size) { setError("请至少选择一张照片"); return; }
    setSaving(true); setError("");
    try { await ipc.createAlbum(draftName.trim(), [...chosen]); }
    catch (e) { setError(`保存失败：${e}`); setSaving(false); return; }
    setCreating(false); setSaving(false);
    try { await onChanged(); toast("星系已创建"); }
    catch { toast("星系已保存，刷新失败，请重新打开相册架"); }
  };
  const [editing,setEditing]=useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const selected = albums.find((a) => a.id === focusAlbumId) ?? null;

  const saveRename = async () => {
    if (!selected || !name.trim()) { setRenaming(false); return; }
    await ipc.renameAlbum(selected.id, name.trim());
    await onChanged();
    toast("相册已重命名");
    setRenaming(false);
  };

  if (!visible) return null;
  return (
    <div className="shelf-panel">
      {editing && selected && phase === "interior" && <AlbumGalaxyEditor album={selected} onClose={()=>setEditing(false)} onSaved={onChanged}/>}
      {creating && <div className="galaxy-create-backdrop" onKeyDown={e => { e.stopPropagation(); if (e.key === "Escape" && !saving) setCreating(false); }}>
        <section className="galaxy-create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-galaxy-title">
          <h2 id="create-galaxy-title">添加星系</h2>
          <label>星系名称<input autoFocus value={draftName} disabled={saving} placeholder="例如：夏日旅行" onChange={e => setDraftName(e.target.value)} /></label>
          <p>从时间轴选择照片 · 已选 {chosen.size} 张</p>
          {error && <p role="alert" className="galaxy-create-error">{error}</p>}
          <div className="galaxy-create-grid">
            {loading ? <p>正在读取时间轴…</p> : choices.length === 0 ? <p>时间轴暂无可选照片，请先导入照片。</p> : choices.map(photo => <button type="button" key={photo.id} disabled={saving} aria-pressed={chosen.has(photo.id)} aria-label={`选择照片 ${photo.id}，${photo.date ?? "日期未知"}`} className={chosen.has(photo.id) ? "selected" : ""} onClick={() => setChosen(prev => { const next = new Set(prev); if (next.has(photo.id)) next.delete(photo.id); else next.add(photo.id); return next; })}>
              <img src={tmThumb(photo.id)} loading="lazy" alt={`照片 ${photo.id}`} />
              <span>{chosen.has(photo.id) ? "✓ 已选" : "选择"}</span><small>{photo.date?.slice(0, 10) ?? "日期未知"}</small>
            </button>)}
          </div>
          <div className="panel-actions"><button className="pill-btn" disabled={saving} onClick={() => setCreating(false)}>取消</button><button className="pill-btn primary" disabled={loading || saving} onClick={() => void saveCreate()}>{saving ? "保存中…" : `创建星系（${chosen.size} 张）`}</button></div>
        </section>
      </div>}

      {phase === "index" && (
        <>
          <header className="album-galaxy-heading">
            <small>ALBUM CONSTELLATIONS</small>
            <h1>{albums.length ? "相册星系" : "等待第一座相册星系"}</h1>
            <p>
              {albums.length
                ? "单击预选 · 双击或确认进入 · 拖动观察同一宇宙中的这片区域"
                : "有照片还没有相册?点击添加星系选择照片,它们会在这里各自形成一座星系。"}
            </p>
          <button className="pill-btn primary" onClick={() => void openCreate()}>＋ 添加星系</button>
          </header>
          {albums.length > 0 && (
            <nav className="album-galaxy-index" aria-label="相册目录">
              {albums.map((a) => (
                <button
                  key={a.id}
                  className={focusAlbumId === a.id ? "active" : ""}
                  onClick={() => onEnter(a.id)}
                  onDoubleClick={() => onEnter(a.id)}
                >
                  <span>{a.name}</span>
                  <small>{photoCount(a.id)}</small>
                </button>
              ))}
            </nav>
          )}
          {selected && (
            <aside className="album-selection-panel">
              <small>已选相册星系</small>
              {renaming ? (
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={saveRename}
                  onKeyDown={(e) => e.key === "Enter" && void saveRename()}
                />
              ) : (
                <h2>{selected.name}</h2>
              )}
              <p>{photoCount(selected.id)} 张照片在内部形成照片粒子星群</p>
              <div className="panel-actions">
                <button className="pill-btn primary" onClick={() => onEnter(selected.id)}>进入相册星系 →</button>
                <button className="pill-btn" onClick={() => { setRenaming(true); setName(selected.name); }}>重命名</button>
              </div>
            </aside>
          )}
          {albums.length === 0 && (
            <div className="solar-empty">
              <span>✦</span>
              <p>还没有相册。建立第一座相册后,<br />它会作为一座独立星系出现在这片区域。</p>
            </div>
          )}
        </>
      )}
      {phase === "interior" && ribbon.expanded && <button className="ribbon-close" aria-label="收起照片" title="收起 · Esc" onClick={()=>ribbonAction("toggle")}>×</button>}
      {phase === "interior" && selected && !ribbon.expanded && (
        <header className="album-galaxy-heading album-interior-heading">
          <small>ALBUM GALAXY</small>
          <h1>{selected.name}</h1>
          <p>{photoCount(selected.id)} 张记忆悬浮为照片粒子星球 · 单击一颗展开照片 · ESC 返回目录</p>
          <div className="panel-actions">
            <button className="pill-btn" disabled={editing} onClick={onExit}>← 返回相册目录</button>
            <button className="pill-btn primary" disabled={editing||ribbon.expanded} onClick={()=>setEditing(true)}>编辑星系</button>
            <button className="pill-btn primary" disabled={editing} onClick={()=>ribbonAction("toggle")}>{ribbon.expanded?"收起":"展开"}</button>
          </div>
        </header>
      )}
    </div>
  );
}
