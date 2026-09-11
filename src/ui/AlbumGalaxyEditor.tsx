import { useEffect, useRef, useState } from "react";
import { ipc } from "../core/db";
import { albumGalaxyConfig, tmThumb, type Album, type Photo } from "../core/types";

export default function AlbumGalaxyEditor({album,onClose,onSaved}:{album:Album;onClose:()=>void;onSaved:()=>void|Promise<void>}) {
  const [name,setName]=useState(album.name);
  const [photos,setPhotos]=useState<Photo[]>([]);
  const [members,setMembers]=useState<number[]>([]);
  const [additions,setAdditions]=useState<Set<number>>(new Set());
  const [removals,setRemovals]=useState<Set<number>>(new Set());
  const originalMembers=useRef(new Set<number>());
  const [ids,setIds]=useState<Set<number>>(new Set());
  const [picking,setPicking]=useState(false);
  const [pending,setPending]=useState<Set<number>>(new Set());
  const [manual,setManual]=useState(false);
  const [placing,setPlacing]=useState(false);
  const [loading,setLoading]=useState(true);
  const [loaded,setLoaded]=useState(false);
  const [attempt,setAttempt]=useState(0);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const positions=useRef<Record<string,[number,number,number]>>({});
  const completed=useRef(false);
  const saveGuard=useRef(false);
  const command=(action:string,extra:object={})=>window.dispatchEvent(new CustomEvent("album-editor",{detail:{action,id:album.id,...extra}}));
  useEffect(()=>{
    let live=true;
    const layout=(e:Event)=>{const d=(e as CustomEvent).detail;if(d.id===album.id)positions.current=d.positions;};
    const moved=()=>setManual(true);
    window.addEventListener("album-editor-layout",layout);
    window.addEventListener("album-editor-moved",moved);
    command("begin");setLoading(true);setLoaded(false);setError("");
    void Promise.all([ipc.listAlbums(),ipc.listPhotos()]).then(([albums,available])=>{
      if(!live)return;
      const current=albums.find(a=>a.id===album.id);
      if(!current)throw new Error("此星系已不存在");
      const availableIds=new Set(available.map(p=>p.id));
      const memberIds=[...new Set(current.photoIds??[])].filter(id=>availableIds.has(id));
      const config=albumGalaxyConfig({...current,photoIds:memberIds});
      const selected=new Set(config.photoIds??memberIds);
      originalMembers.current=new Set(memberIds);setRemovals(new Set());
      setPhotos(available);setMembers(memberIds);setAdditions(new Set());setPending(new Set());
      setIds(selected);setManual(config.positions!==null);setLoaded(true);
      command("show",{photoIds:[...selected]});
    }).catch(e=>{if(live)setError(`照片读取失败：${e}`);}).finally(()=>{if(live)setLoading(false);});
    return()=>{live=false;window.removeEventListener("album-editor-layout",layout);window.removeEventListener("album-editor-moved",moved);if(!completed.current)command("cancel");};
  },[album.id,attempt]);
  const blocked=loading||!loaded||saving;
  const memberSet=new Set(members);
  const choices=photos.filter(p=>!memberSet.has(p.id));
  const toggle=(id:number)=>{
    if(blocked||!memberSet.has(id))return;
    const next=new Set(ids);if(next.has(id))next.delete(id);else next.add(id);
    setIds(next);command("show",{photoIds:[...next]});
  };
  const acceptAdditions=()=>{
    const selected=choices.filter(p=>pending.has(p.id)).map(p=>p.id);
    if(!selected.length)return;
    setMembers(prev=>[...prev,...selected]);
    setAdditions(prev=>new Set([...prev,...selected.filter(id=>!originalMembers.current.has(id))]));
    setRemovals(prev=>new Set([...prev].filter(id=>!selected.includes(id))));
    command("add",{photos:choices.filter(p=>pending.has(p.id)).map(p=>({id:p.id,avgColor:p.avgColor}))});
    const next=new Set([...ids,...selected]);setIds(next);command("show",{photoIds:[...next]});
    setPending(new Set());setPicking(false);setError("");
  };
  const remove=(id:number)=>{
    if(blocked)return;
    setMembers(prev=>prev.filter(member=>member!==id));
    setAdditions(prev=>new Set([...prev].filter(member=>member!==id)));
    if(originalMembers.current.has(id))setRemovals(prev=>new Set([...prev,id]));
    const next=new Set(ids);next.delete(id);setIds(next);command("show",{photoIds:[...next]});
  };
  const save=async()=>{
    if(blocked||saveGuard.current)return;
    if(!name.trim()){setError("请输入星系名称");return;}
    saveGuard.current=true;setSaving(true);setError("");
    const visible=[...ids].filter(id=>memberSet.has(id));
    const validPositions=Object.fromEntries(Object.entries(positions.current).filter(([id])=>memberSet.has(Number(id))));
    try {
      await ipc.saveAlbumGalaxy(album.id,name.trim(),{photoIds:visible,positions:manual?validPositions:null},[...additions],[...removals]);
    } catch(e){setError(`保存失败：${e}`);setSaving(false);saveGuard.current=false;return;}
    completed.current=true;command("finish",{manual,memberIds:members});
    try { await onSaved();onClose(); }
    catch { setError("修改已保存，刷新失败，请关闭后重新进入星系。");setSaving(false);saveGuard.current=false; }
  };
  return <aside className={"album-editor"+(placing?" is-placing":"")} onKeyDown={e=>{e.stopPropagation();if(e.key==="Escape"&&!saving){if(picking){setPicking(false);setPending(new Set());}else onClose();}}}>
    <h2>{picking?"添加照片到星系":"编辑星系"}</h2>
    {picking?<>
      <p>从时间轴已有照片中选择 · 已选 {pending.size} 张</p>
      <p>加入草稿后立即显示照片球，可直接摆放；保存修改后正式加入星系。</p>
      <div className="galaxy-create-grid album-editor-grid">
        {choices.length===0?<p>时间轴中的可用照片都已在此星系中。</p>:choices.map(photo=><button key={photo.id} aria-pressed={pending.has(photo.id)} className={pending.has(photo.id)?"selected":""} onClick={()=>setPending(prev=>{const next=new Set(prev);if(next.has(photo.id))next.delete(photo.id);else next.add(photo.id);return next;})}>
          <img src={tmThumb(photo.id)} loading="lazy" alt={photo.filename}/><span>{pending.has(photo.id)?"✓ 已选":"选择照片"}</span><small>{photo.captureDate?.slice(0,10)??"日期未知"}</small>
        </button>)}
      </div>
      <div className="panel-actions"><button className="pill-btn" onClick={()=>{setPicking(false);setPending(new Set());}}>取消添加</button><button className="pill-btn primary" disabled={!pending.size} onClick={acceptAdditions}>加入编辑草稿（{pending.size} 张）</button></div>
    </>:<>
      <label>名称<input value={name} disabled={saving} onChange={e=>setName(e.target.value)}/></label>
      <p>{loading?"正在读取星系照片…":`共 ${members.length} 张 · 展示 ${ids.size} 个照片球`}{additions.size>0&&` · 待加入 ${additions.size} 张`}{removals.size>0&&` · 待移除 ${removals.size} 张`}</p>
      <div className="panel-actions"><button className="pill-btn primary" disabled={blocked} onClick={()=>{setPlacing(false);setPending(new Set());setPicking(true);}}>＋ 添加照片到星系</button><button className="pill-btn" disabled={blocked} onClick={()=>setPlacing(!placing)}>{placing?"选择粒子球":"摆放星座"}</button><button className="pill-btn" disabled={blocked} onClick={()=>{setManual(false);command("random");}}>恢复随机排布</button></div>
      {placing?<p>左键拖动照片球摆出星座，右键调整视角。{manual?"保存后保留摆放位置。":"拖动任意球开始自定义。"}{additions.size>0&&"新加入的照片球也可立即拖动摆放。"}</p>:<>
        <p>勾选控制粒子球展示；从星系移除后照片仍在时间轴中，原文件保留。</p>
        <div className="galaxy-create-grid album-editor-grid">{loaded&&members.length===0?<p>星系暂无照片，可以从时间轴添加。</p>:photos.filter(p=>memberSet.has(p.id)).map(photo=><div key={photo.id} className="album-editor-photo"><button disabled={blocked} aria-pressed={ids.has(photo.id)} className={ids.has(photo.id)?"selected":""} onClick={()=>toggle(photo.id)}><img src={tmThumb(photo.id)} loading="lazy" alt={photo.filename}/><span>{ids.has(photo.id)?"✓ 设为粒子球":"设为粒子球"}</span>{additions.has(photo.id)&&<small>新加入 · 待保存</small>}</button><button className="album-editor-remove" disabled={blocked} onClick={()=>remove(photo.id)} aria-label={`从星系移除 ${photo.filename}`}>从星系移除</button></div>)}</div>
      </>}
      {error&&<p role="alert" className="galaxy-create-error">{error}</p>}
      {!loading&&!loaded&&<button className="pill-btn" onClick={()=>setAttempt(n=>n+1)}>重新读取照片</button>}
      <div className="panel-actions"><button className="pill-btn" disabled={saving} onClick={onClose}>取消</button><button className="pill-btn primary" disabled={blocked} onClick={()=>void save()}>{saving?"保存中…":"保存修改"}</button></div>
    </>}
  </aside>;
}
