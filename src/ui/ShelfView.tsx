import { useRef, useState } from "react";
import { ipc } from "../core/db";
import { tmThumb, type Album } from "../core/types";
import { useToast } from "../core/toast";

/** 相册架:深色玻璃悬浮卡片 */
export default function ShelfView({
  albums,
  onOpenAlbum,
  onChanged,
}: {
  albums: Album[];
  onOpenAlbum: (albumId: number) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [renaming, setRenaming] = useState<number | null>(null);
  const [name, setName] = useState("");
  const cardRefs = useRef(new Map<number, HTMLDivElement>());

  const onCardMove = (id: number, e: React.MouseEvent) => {
    const el = cardRefs.current.get(id);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    el.style.transform = `translateY(-4px) rotateX(${(-y * 5).toFixed(2)}deg) rotateY(${(x * 7).toFixed(2)}deg)`;
  };
  const onCardLeave = (id: number) => {
    const el = cardRefs.current.get(id);
    if (el) el.style.transform = "";
  };

  const rename = async (id: number) => {
    if (name.trim()) {
      await ipc.renameAlbum(id, name.trim());
      onChanged();
      toast("已重命名");
    }
    setRenaming(null);
  };

  return (
    <div className="shelf">
      <h2>相册架</h2>
      <div className="shelf-grid">
        {albums.map((a) => (
          <div
            key={a.id}
            ref={(el) => {
              if (el) cardRefs.current.set(a.id, el);
            }}
            className="album-card"
            style={{ transformStyle: "preserve-3d" }}
            onMouseMove={(e) => onCardMove(a.id, e)}
            onMouseLeave={() => onCardLeave(a.id)}
            onClick={() => (renaming === a.id ? undefined : onOpenAlbum(a.id))}
          >
            {a.coverPhotoId ? (
              <img className="cover" src={tmThumb(a.coverPhotoId)} alt="" loading="lazy" />
            ) : (
              <div className="cover none">尚无照片</div>
            )}
            <div className="album-actions">
              <button
                title="重命名"
                onClick={(e) => {
                  e.stopPropagation();
                  setRenaming(a.id);
                  setName(a.name);
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path
                    d="m4 20 .8-3.2L16.4 5.2a2 2 0 0 1 2.8 0l-.4-.4a2 2 0 0 1 0 2.8L7.2 19.2 4 20Z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                </svg>
              </button>
            </div>
            <div className="body">
              {renaming === a.id ? (
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => rename(a.id)}
                  onKeyDown={(e) => e.key === "Enter" && rename(a.id)}
                  onClick={(e) => e.stopPropagation()}
                  style={{ width: "100%", fontSize: "var(--f-l)" }}
                />
              ) : (
                <>
                  <div className="name">{a.name}</div>
                  <div className="sub">
                    {a.photoCount} Photos{a.auto ? " · 自动" : ""}
                  </div>
                </>
              )}
            </div>
          </div>
        ))}
        {albums.length === 0 && (
          <div className="search-empty">导入照片后,相册会像星星一样聚拢在这里</div>
        )}
      </div>
      <h2>文件位置说明</h2>
      <div style={{ color: "var(--tx-3)", fontSize: "var(--f-xs)", lineHeight: 2 }}>
        软件只保存索引与缩略图,原始照片始终保留在原位置且不会被修改。
      </div>
    </div>
  );
}
