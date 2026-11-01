import { useEffect, useMemo, useState } from "react";
import { ipc } from "../core/db";
import { SHAPES, shapeOf, type Space } from "../core/spaces";
import { tmThumb, type Photo } from "../core/types";
import { useToast } from "../core/toast";
import { isTauri } from "../core/env";

/** 顶部的页面切换条:每个页面一个胶囊,带图形小标 */
export function SpaceBar({
  spaces,
  activeId,
  onSelect,
  onReload,
  allPhotos,
}: {
  spaces: Space[];
  activeId: number | null;
  onSelect: (id: number) => void;
  onReload: () => void;
  allPhotos: Photo[];
}) {
  const [editing, setEditing] = useState<Space | null>(null);
  const toast = useToast();

  const create = async () => {
    try {
      // 新页面默认「全部照片」:否则新建出来是空的(只有本页 + 0 张),
      // 选任何图形都看不出变化,会让人以为图形坏了。要想独立选图,再改成「只有本页」。
      const id = await ipc.createSpace(
        `页面 ${spaces.length + 1}`,
        SHAPES[1].id,
        "shared",
      );
      await ipc.saveSpace(id, `页面 ${spaces.length + 1}`, SHAPES[1].id, "shared", null);
      onReload();
      const created = (await ipc.listSpaces()).find((s) => s.id === id) ?? null;
      if (created) setEditing(created);
      onSelect(id);
    } catch (e) {
      toast(`新建页面失败：${e}`);
    }
  };

  const active = spaces.find((s) => s.id === activeId) ?? null;

  /** 删除页面。照片本身不会被删,只是从这个页面里拿掉。 */
  const remove = async (space: Space) => {
    if (spaces.length <= 1) {
      toast("至少要保留一个页面");
      return;
    }
    try {
      await ipc.deleteSpace(space.id);
      const rest = await ipc.listSpaces();
      setEditing(null);
      onReload();
      const next = rest[0]?.id ?? null;
      if (next !== null) onSelect(next);
      toast(`已删除页面「${space.name}」`);
    } catch (e) {
      toast(`删除失败：${e}`);
    }
  };

  return (
    <>
      <div className="spacebar">
        {spaces.map((s) => (
          <button
            key={s.id}
            className={"space-chip" + (s.id === activeId ? " active" : "")}
            onClick={() => onSelect(s.id)}
            title={`${shapeOf(s.shape).name} · ${s.photoCount} 张 · ${s.scope === "own" ? "独立照片" : "全部照片"}`}
          >
            <i className="dot" data-shape={s.shape} />
            {s.name}
          </button>
        ))}
        {isTauri() && (
          <button className="space-chip add" onClick={() => void create()} title="新建页面">
            +
          </button>
        )}
        {isTauri() && active && (
          <button className="space-chip gear" onClick={() => setEditing(active)} title="页面设置">
            ⚙
          </button>
        )}
      </div>
      {editing && (
        <SpaceEditor
          space={editing}
          allPhotos={allPhotos}
          canDelete={spaces.length > 1}
          onDelete={() => void remove(editing)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onReload();
          }}
        />
      )}
    </>
  );
}

function SpaceEditor({
  space,
  allPhotos,
  canDelete,
  onDelete,
  onClose,
  onSaved,
}: {
  space: Space;
  allPhotos: Photo[];
  canDelete: boolean;
  onDelete: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(space.name);
  // Tauri 的 webview 里 window.confirm 不可靠,所以用两段式就地确认代替弹窗。
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [shape, setShape] = useState(space.shape);
  const [scope, setScope] = useState(space.scope === "own" ? "own" : "shared");
  const [bgId, setBgId] = useState<number | null>(space.backgroundPhotoId);
  const [bgStrength, setBgStrength] = useState<number>(space.backgroundStrength ?? 42);
  const [members, setMembers] = useState<number[]>([]);
  const [picking, setPicking] = useState<null | "bg" | "members">(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void ipc
      .listPhotos(undefined, space.id)
      .then((list) => setMembers(list.map((p) => p.id)))
      .catch(() => {});
  }, [space.id]);

  const bgPhoto = useMemo(() => allPhotos.find((p) => p.id === bgId) ?? null, [allPhotos, bgId]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await ipc.saveSpace(space.id, name, shape, scope, bgId, "plate", bgStrength);
      if (scope === "own") {
        // 先保存 scope 再取现有成员,才能正确算出增删
        const current = new Set(
          await ipc.listPhotos(undefined, space.id).then((l) => l.map((p) => p.id)),
        );
        const next = new Set(members);
        const toAdd = [...next].filter((id) => !current.has(id));
        const toRemove = [...current].filter((id) => !next.has(id));
        if (toAdd.length) await ipc.addSpacePhotos(space.id, toAdd);
        if (toRemove.length) await ipc.removeSpacePhotos(space.id, toRemove);
      }
      toast("页面已保存");
      onSaved();
    } catch (e) {
      toast(`保存失败：${e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-editor" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel">
        <h3>页面设置</h3>

        <div className="panel-body">
        <label className="field">
          <span>名称</span>
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>

        <div className="field">
          <span>图形</span>
          <div className="shape-grid">
            {SHAPES.map((s) => (
              <button
                key={s.id}
                className={"shape-option" + (shape === s.id ? " active" : "")}
                onClick={() => setShape(s.id)}
                title={s.hint}
              >
                <i className="dot" data-shape={s.id} />
                {s.name}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>照片范围</span>
          <div className="seg">
            <button className={scope === "shared" ? "active" : ""} onClick={() => setScope("shared")}>
              全部照片
            </button>
            <button className={scope === "own" ? "active" : ""} onClick={() => setScope("own")}>
              只有本页
            </button>
          </div>
        </div>

        {scope === "own" && (
          <div className="field">
            <span>本页照片（{members.length}）</span>
            <button className="pill-btn" onClick={() => setPicking("members")}>
              选择照片
            </button>
            {members.length === 0 && (
              <span className="field-warn">
                这个页面还没有照片，宇宙里会是空的 —— 这时换任何「图形」都看不出变化。
                先选几张照片，或把上面的照片范围改回「全部照片」。
              </span>
            )}
          </div>
        )}

        <div className="field">
          <span>背景照片</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {bgPhoto ? (
              <img className="bg-thumb" src={tmThumb(bgPhoto.id)} alt="" />
            ) : (
              <span style={{ color: "var(--tx-3)", fontSize: 12 }}>未设置</span>
            )}
            <button className="pill-btn" onClick={() => setPicking("bg")}>选择</button>
            {bgId !== null && (
              <button
                className="pill-btn"
                onClick={() => { setBgId(null); }}
              >
                清除
              </button>
            )}
          </div>
          <span style={{ color: "var(--tx-3)", fontSize: 11, lineHeight: 1.6 }}>
            原图半透明垫在星系后方，星空还是主角。
          </span>
        </div>

        {bgId !== null && (
          <label className="field">
            <span>
              存在感 <b style={{ color: "var(--tx-2)", fontWeight: 400 }}>{bgStrength}%</b>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={bgStrength}
              onChange={(e) => setBgStrength(Number(e.target.value))}
            />
          </label>
        )}
        </div>

        <div className="actions">
          {canDelete &&
            (confirmDelete ? (
              <>
                <span className="del-warn">删除页面「{name}」？照片不会丢</span>
                <button className="pill-btn danger" onClick={onDelete}>
                  确认删除
                </button>
                <button className="pill-btn" onClick={() => setConfirmDelete(false)}>
                  我再想想
                </button>
              </>
            ) : (
              <button
                className="pill-btn ghost-danger"
                onClick={() => setConfirmDelete(true)}
                title="删除这个页面"
              >
                删除页面
              </button>
            ))}
          <button className="pill-btn" onClick={onClose} disabled={saving}>取消</button>
          <button className="pill-btn primary" onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>

      {picking && (
        <PhotoPicker
          photos={allPhotos}
          selected={picking === "bg" ? (bgId === null ? [] : [bgId]) : members}
          single={picking === "bg"}
          onClose={() => setPicking(null)}
          onConfirm={(ids) => {
            if (picking === "bg") setBgId(ids[0] ?? null);
            else setMembers(ids);
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}

function PhotoPicker({
  photos,
  selected,
  single,
  onClose,
  onConfirm,
}: {
  photos: Photo[];
  selected: number[];
  single?: boolean;
  onClose: () => void;
  onConfirm: (ids: number[]) => void;
}) {
  const [picked, setPicked] = useState<number[]>(selected);
  const toggle = (id: number) => {
    if (single) {
      setPicked([id]);
      return;
    }
    setPicked((cur) => (cur.includes(id) ? cur.filter((v) => v !== id) : [...cur, id]));
  };
  return (
    <div className="photo-picker" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel">
        <h3>{single ? "选择背景照片" : `选择本页照片（已选 ${picked.length}）`}</h3>
        <div className="grid">
          {photos.map((p) => (
            <button
              key={p.id}
              className={"cell" + (picked.includes(p.id) ? " picked" : "")}
              onClick={() => toggle(p.id)}
              title={p.filename}
            >
              <img src={tmThumb(p.id)} alt="" loading="lazy" />
            </button>
          ))}
          {photos.length === 0 && <div className="empty-tip">图库里还没有照片</div>}
        </div>
        <div className="actions">
          <button className="pill-btn" onClick={onClose}>取消</button>
          <button className="pill-btn primary" onClick={() => onConfirm(picked)}>确定</button>
        </div>
      </div>
    </div>
  );
}
