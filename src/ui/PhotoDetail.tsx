import { getSpherePhotoBridge } from "../three/SpherePhotoBridge";
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ipc } from '../core/db';
import { tmPhoto, tmThumb, tmVideo, type Photo, type Memory } from '../core/types';
import { useToast } from '../core/toast';
import ParticleDetailCanvas from './ParticleDetailCanvas';
import OpeningPhotoPreview from './OpeningPhotoPreview';

/**
 * 只保留末两级目录。
 * 完整绝对路径含 Windows 用户名与私有目录命名，截图/录屏/投屏时会连带泄露。
 */
function maskPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? p : `…\\${parts.slice(-2).join("\\")}`;
}

/** 照片详情:默认保留为可交互粒子画面,由侧栏显式切换原图。 */
export default function PhotoDetail({photo,memory,onMemoryChanged,onClose,onNav,exiting,onAlbum,onEditLocation,source,onClosed,sphereTransition=false,originalFirst=false,onDeleted}:{onDeleted:(id:number)=>Promise<void>; originalFirst?:boolean;sphereTransition?:boolean;photo:Photo;memory:Memory;onMemoryChanged:()=>void;onClose:()=>void;onNav:(dir:1|-1)=>void;exiting:boolean;onAlbum:()=>void;onEditLocation:()=>void;source:HTMLElement|null;onClosed:()=>void; }) {
 const bridgeRef=useRef(sphereTransition ? getSpherePhotoBridge(photo.id) : undefined);
 const bridge=bridgeRef.current;
 const wrapRef=useRef<HTMLDivElement>(null);
 const animationRef=useRef<Animation|null>(null);
 const [ready,setReady]=useState(false);
 const [canvasMounted,setCanvasMounted]=useState(false);
 const [arrived,setArrived]=useState(false);
 useEffect(()=>{
   if(!bridge)return;
   let frame=0;
   const sync=()=>{if(bridge.progress===1&&!bridge.closing){setArrived(true);return;}frame=requestAnimationFrame(sync);};
   frame=requestAnimationFrame(sync);
   return()=>cancelAnimationFrame(frame);
 },[bridge]);
 const openingDone=useRef(false);
 const openingProgress=()=>bridge?1:openingDone.current?1:Math.min(1,Number(animationRef.current?.currentTime??0)/1100);
 const closedRef=useRef(onClosed);closedRef.current=onClosed;
 const sourceTransform=()=>{
   const el=wrapRef.current;if(!el||!source||!source.isConnected)return 'scale(0.92)';
   const target={left:el.offsetLeft,top:el.offsetTop,width:el.offsetWidth,height:el.offsetHeight};
   const parent=el.offsetParent?.getBoundingClientRect();
   const rect=source.getBoundingClientRect();
   return `translate(${rect.left-target.left-(parent?.left??0)}px,${rect.top-target.top-(parent?.top??0)}px) scale(${rect.width/target.width},${rect.height/target.height})`;
 };
 useLayoutEffect(()=>{
   const el=wrapRef.current;if(!el)return;
   const panel=el.parentElement!;
   const availableWidth=Math.max(1,panel.clientWidth-398);
   const availableHeight=Math.max(1,panel.clientHeight-66);
   const ratio=(photo.width||1)/(photo.height||1);
   const width=Math.min(availableWidth,availableHeight*ratio);
   const height=width/ratio;
   el.style.inset='auto';el.style.width=`${width}px`;el.style.height=`${height}px`;
   el.style.left=`${38+(availableWidth-width)/2}px`;el.style.top=`${24+(availableHeight-height)/2}px`;
   el.style.transform=bridge?'none':sourceTransform();
   if(source)source.style.visibility='hidden';
   return()=>{animationRef.current?.cancel();if(source)source.style.visibility='';};
 },[]);
 useEffect(()=>{
   let second=0;
   const first=requestAnimationFrame(()=>{second=requestAnimationFrame(()=>setCanvasMounted(true));});
   return()=>{cancelAnimationFrame(first);cancelAnimationFrame(second);};
 },[]);
 useEffect(()=>{
   // The already-decoded thumbnail starts immediately. Its spatial dot mask and
   // the eventual WebGL particles both follow this same opening clock.
   if(exiting||bridge)return;
   const el=wrapRef.current;if(!el)return;
   const animation=el.animate([{transform:el.style.transform},{transform:'none'}],{duration:originalFirst?700:1100,easing:'cubic-bezier(.4,0,.6,1)',fill:'forwards'});
   animationRef.current=animation;
   let maskFrame=0;
   const updatePreview=()=>{
     const progress=Math.min(1,Number(animation.currentTime??0)/1100);
     el.style.setProperty('--opening-radius',`${progress*145}%`);
     if(progress<1)maskFrame=requestAnimationFrame(updatePreview);
   };
   if(!originalFirst)maskFrame=requestAnimationFrame(updatePreview);
   animation.onfinish=()=>{
     openingDone.current=true;el.style.transform='none';
     // The shader now supplies the ellipse. Release the temporary clipping so
     // switching back to original can restore the full rectangular photograph.
     animation.cancel();el.style.borderRadius='0';setArrived(true);
   };
   return()=>cancelAnimationFrame(maskFrame);
 },[]);
 useEffect(()=>{
   if(ready&&arrived&&wrapRef.current)wrapRef.current.style.borderRadius='0';
 },[ready,arrived]);
 useEffect(()=>{
   if(!exiting)return;
   if(bridge){bridge.close();return;}
   const el=wrapRef.current;if(!el){closedRef.current();return;}
   const current=getComputedStyle(el).transform;
   animationRef.current?.cancel();
   animationRef.current=el.animate([{transform:current,borderRadius:'0px'},{transform:sourceTransform(),borderRadius:'8px'}],{duration:700,easing:'cubic-bezier(.4,0,.25,1)',fill:'forwards'});
   animationRef.current.onfinish=()=>closedRef.current();
 },[exiting]);
 const [removing,setRemoving]=useState(false);
 const [deleting,setDeleting]=useState(false);
 const removalGuard=useRef(false);
 const [error,setError]=useState('');
 const [fit100,setFit100]=useState<'fit'|'100'>('fit');
 const [showExif,setShowExif]=useState(false);
 const [displayMode,setDisplayMode]=useState<'particle'|'original'>(originalFirst?'original':'particle');
 const [livePlaying,setLivePlaying]=useState(false);
 const liveVideoRef=useRef<HTMLVideoElement>(null);
 const [form,setForm]=useState({title:memory.title??'',text:memory.text??'',location:memory.location??'',mood:memory.mood??'',date:photo.captureDate?.slice(0,10)??''});
 const [starred,setStarred]=useState(photo.starred);
 const toast=useToast();
 useEffect(()=>setDisplayMode(originalFirst?'original':'particle'),[photo.id,originalFirst]);
 // 实况照片打开即播，不再要求手动点；播完停在最后一帧，不回静帧。
 useEffect(()=>{setLivePlaying(photo.liveVideoId!=null);},[photo.id,photo.liveVideoId]);
 // 自动播放可能被 WebView 的播放策略拦，拦了就静音再试一次。
 useEffect(()=>{
   const el=liveVideoRef.current;
   if(!el||!livePlaying)return;
   const p=el.play();
   if(p&&typeof p.catch==='function')p.catch(()=>{el.muted=true;void el.play().catch(()=>{});});
 },[livePlaying,photo.id]);
 const [originalLoaded,setOriginalLoaded]=useState(false);
 useEffect(()=>setError(''),[photo.id]);
 useEffect(()=>{
   const handler=(e:KeyboardEvent)=>{if(removalGuard.current){e.preventDefault();return;}if((e.target as HTMLElement).matches('input,textarea'))return;if(e.key==='Escape')onClose();else if(e.key==='ArrowRight')onNav(1);else if(e.key==='ArrowLeft')onNav(-1);};
   window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);
 },[onClose,onNav]);
  const saveField = async (patch: Partial<typeof form>) => {
    const next = { ...form, ...patch };
    setForm(next);
    try {
      await ipc.saveMemory(
        photo.id,
        next.title || null,
        next.text || null,
        next.location || null,
        next.mood || null,
      );
      if (patch.date !== undefined && patch.date) {
        await ipc.setPhotoDate(photo.id, patch.date);
      }
      onMemoryChanged();
    } catch (e) {
      toast(`保存失败: ${e}`);
    }
  };

  const removePhoto=async()=>{
    if(removalGuard.current||!ready)return;
    removalGuard.current=true;setRemoving(true);
    try {
      await ipc.deletePhoto(photo.id);
      setDeleting(true);
    }catch(e){removalGuard.current=false;setRemoving(false);toast(`删除失败：${e}`);}
  };
  const closeUnlessRemoving=()=>{if(!removalGuard.current)onClose();};
  const toggleStar = async () => {
    const v = !starred;
    setStarred(v);
    await ipc.toggleStar(photo.id, v);
    onMemoryChanged();
  };

 return (<>
   <div className={'detail-veil'+(bridge&&(!arrived||exiting)?' sphere-detail-veil':'')+(exiting?' is-exiting':'')} onClick={closeUnlessRemoving}/>
   <div className={'detail-panel continuous-detail'+(bridge?' sphere-detail-panel':'')+(bridge&&(!arrived||exiting)?' sphere-detail-travel':'')+(exiting?' is-exiting':'')+(arrived?' is-arrived':'')+(removing?' is-consuming':'')} role="dialog" aria-label="照片详情">
     <button className="detail-close" onClick={closeUnlessRemoving} aria-label="关闭照片">×</button>
     <div className={'photo-wrap'+(arrived&&!exiting&&displayMode==='particle'?' particle-ellipse-frame':'')} ref={wrapRef}>
        {photo.kind === 'video' && !deleting && (
          <video
            className="detail-video"
            src={tmVideo(photo.id)}
            poster={tmThumb(photo.id)}
            controls
            playsInline
            preload="metadata"
          />
        )}
        {photo.liveVideoId != null && !deleting && !livePlaying && (
          <button className="live-play-overlay" onClick={() => setLivePlaying(true)} aria-label="播放实况照片" title="播放实况">
            <span className="live-play-icon">▶</span>
            <span className="live-badge">实况 · 点击播放</span>
          </button>
        )}
        {photo.liveVideoId != null && !deleting && livePlaying && (
          <video
            ref={liveVideoRef}
            className="detail-video live-video"
            src={tmVideo(photo.liveVideoId)}
            poster={tmThumb(photo.id)}
            autoPlay
            controls
            playsInline
            onError={() => {
              setLivePlaying(false);
              toast("这段实况无法播放：系统可能缺少 HEVC 视频解码器");
            }}
          />
        )}
        {photo.kind !== 'video' && canvasMounted&&<ParticleDetailCanvas hidden={originalFirst&&displayMode==='original'} deleting={deleting} onConsumed={()=>void onDeleted(photo.id)} photoId={photo.id} bridge={bridge} active={displayMode==='particle'} onReady={()=>setReady(true)} fit100={fit100==='100'} frozen={exiting} onError={setError} openingProgress={originalFirst?undefined:openingProgress}/>}
        {photo.kind !== 'video' && !deleting&&originalFirst&&displayMode==='original'&&<div className="map-original-photo"><img src={tmThumb(photo.id)} alt="" draggable={false}/><img src={tmPhoto(photo.id)} alt={photo.filename} draggable={false} onLoad={()=>setOriginalLoaded(true)} style={{opacity:originalLoaded?1:0}}/></div>}
        {photo.kind !== 'video' && !deleting&&!originalFirst&&!bridge&&(source?.querySelector('img')?<OpeningPhotoPreview image={source.querySelector('img')} progress={openingProgress} ready={ready}/>:!ready&&<img className="detail-loading-photo" src={tmPhoto(photo.id)} alt={photo.filename} draggable={false}/>)}
       {error&&<div className="preview-error">{error}</div>}
     </div>
     <div className="detail-info">
          <div className="detail-info-heading">
            <div>
              <span className="detail-info-eyebrow">{photo.liveVideoId != null ? "LIVE PHOTO" : "PHOTO MEMORY"}</span>
              <h2>{photo.liveVideoId != null ? "实况照片" : "照片记忆"}</h2>
              {photo.liveVideoId != null && <span className="detail-info-live">点击照片可播放动态</span>}
            </div>
            <button className="detail-info-close" onClick={closeUnlessRemoving} aria-label="关闭照片详情">×</button>
          </div>
          <div className="detail-info-filename" title={photo.filename}>{photo.filename}</div>
          <div className="detail-mode-bar" role="tablist" aria-label="照片显示模式" style={photo.kind === 'video' ? { display: 'none' } : undefined}>
            <button role="tab" aria-selected={displayMode==='particle'} className={displayMode==='particle'?'active':''} onClick={()=>setDisplayMode('particle')}>粒子</button>
            <button role="tab" aria-selected={displayMode==='original'} className={displayMode==='original'?'active':''} onClick={()=>setDisplayMode('original')}>原图</button>
          </div>
          <div className="field">
            <label>标题</label>
            <input
              className="title-input"
              placeholder="为这张照片起个名字…"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              onBlur={(e) => saveField({ title: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          </div>

          <div className="date-row">
            <input
              type="date"
              value={form.date}
              onChange={(e) => saveField({ date: e.target.value })}
            />
            <span className="src">
              {photo.dateSource === "exif"
                ? "拍摄日期"
                : photo.dateSource === "user"
                  ? "手动设置"
                  : photo.dateSource === "file"
                    ? "推断日期"
                    : ""}
            </span>
          </div>

          <div className="field">
            <label>地点</label>
            <input
              placeholder="在哪里?"
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              onBlur={(e) => saveField({ location: e.target.value })}
            />
          </div>

          <div className="location-tools">
            <button className="pill-btn primary" onClick={onEditLocation}>{photo.gpsLat!=null&&photo.gpsLon!=null?'去地球调整位置':'去地球设置位置'}</button>
            {photo.gpsLat!=null&&photo.gpsLon!=null&&<button onClick={onAlbum}>在地图中查看 ↗</button>}
          </div>
          <div className="field">
            <label>心情</label>
            <input
              placeholder="那天的心情…"
              value={form.mood}
              onChange={(e) => setForm({ ...form, mood: e.target.value })}
              onBlur={(e) => saveField({ mood: e.target.value })}
            />
          </div>

          <div className="field">
            <label>文字记忆</label>
            <textarea
              placeholder="写下这段记忆…"
              value={form.text}
              onChange={(e) => setForm({ ...form, text: e.target.value })}
              onBlur={(e) => saveField({ text: e.target.value })}
            />
          </div>

          <div>
            <button
              className="pill-btn"
              style={{ marginBottom: 10 }}
              onClick={() => setShowExif((s) => !s)}
            >
              照片信息
            </button>
            {showExif && (
              <div style={{ fontSize: "var(--f-xs)", color: "var(--tx-3)", lineHeight: 2 }}>
                <div style={{overflowWrap:"anywhere",userSelect:"text"}}>原图位置 · {maskPath(photo.path)}</div>
                {photo.camera && <div>相机 · {photo.camera}</div>}
                {photo.lens && <div>镜头 · {photo.lens}</div>}
                {(photo.focal || photo.aperture || photo.shutter || photo.iso) && (
                  <div>
                    {photo.focal} {photo.aperture} {photo.shutter} {photo.iso ? `ISO ${photo.iso}` : ""}
                  </div>
                )}
                {(photo.gpsLat != null) && (
                  <div>
                    GPS · {photo.gpsLat.toFixed(4)}, {photo.gpsLon?.toFixed(4)}
                  </div>
                )}
                <div>
                  原始尺寸 · {photo.width} × {photo.height}
                </div>
              </div>
            )}
          </div>

          <div className="photo-remove-action">
            <button className="pill-btn ghost-danger" disabled={removing||!ready||!arrived} onClick={()=>void removePhoto()}>{removing?'正在移入黑洞…':'从相册中删除'}</button>
            <small>仅从软件中移除，原文件保留</small>
          </div>
          <div className="footer">
            <button
              className="pill-btn"
              onClick={toggleStar}
              style={starred ? { color: "#d8c9a0" } : {}}
            >
              {starred ? "★ 已收藏" : "☆ 收藏"}
            </button>
            <button className="pill-btn" onClick={() => setFit100((f) => (f === "fit" ? "100" : "fit"))}>
              {fit100 === "fit" ? "100%" : "适应窗口"}
            </button>
            <button className="pill-btn ghost-danger" onClick={closeUnlessRemoving}>
              关闭 ESC
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
