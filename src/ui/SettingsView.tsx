import { useEffect, useRef, useState } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { ipc } from "../core/db";
import {publishAuthSettings} from "../core/AuthSettings";
import {loadMapRoutesEnabled,saveMapRoutesEnabled} from "../core/MapRouteSettings";
import { useToast } from "../core/toast";
import type { PerfMode, QualityTier } from "../core/types";
import {
  PHOTO_PARTICLE_DEFAULTS,
  PHOTO_PARTICLE_SETTING_SPECS,
  loadPhotoParticleSettings,
  restorePhotoParticleDefaults,
  savePhotoParticleSetting,
  type PhotoParticleSettings,
} from "../core/PhotoParticleSettings";
import {
  PHOTO_SPHERE_DEFAULTS,
  PHOTO_SPHERE_SETTING_SPECS,
  loadPhotoSphereSettings,
  restorePhotoSphereDefaults,
  savePhotoSphereSetting,
  type PhotoSphereSettings,
} from "../core/PhotoSphereSettings";

type LockMin = "5" | "15" | "30" | "60" | "never";

/** 设置:粒子质量 / 性能模式 / 自动锁定 / 密码 / 备份 / 关于 */
export default function SettingsView({onClose}:{onClose:()=>void}) {
  const [tier, setTier] = useState<QualityTier>("medium");
  const [perf, setPerf] = useState<PerfMode>("balanced");
  const [lock, setLock] = useState<LockMin>("15");
  const [stats, setStats] = useState({ photoCount: 0, albumCount: 0, memoryCount: 0 });
  const [pwdOld, setPwdOld] = useState("");
  const [pwdNew, setPwdNew] = useState("");
  const [changingPwd, setChangingPwd] = useState(false);
  const [passwordEnabled,setPasswordEnabled]=useState(true),[passwordReady,setPasswordReady]=useState(false),[savingPassword,setSavingPassword]=useState(false);
  const passwordGuard=useRef(false);
  useEffect(()=>{let live=true;void ipc.authState().then(s=>{if(live){setPasswordEnabled(s.hasPassword);setPasswordReady(true);}}).catch(()=>{if(live)toast("密码设置读取失败，请重新打开设置");});return()=>{live=false;};},[]);
  const disablePassword=async()=>{
    if(passwordGuard.current||!passwordReady)return;
    passwordGuard.current=true;setSavingPassword(true);
    try{await ipc.setPasswordless();await publishAuthSettings();setPasswordEnabled(false);setChangingPwd(false);setPwdOld("");setPwdNew("");toast("已设为无密码，启动后点击解锁即可进入");}
    catch(e){toast(`无密码设置保存失败：${e}`);}finally{passwordGuard.current=false;setSavingPassword(false);}
  };
  const [particle, setParticle] = useState<PhotoParticleSettings>({ ...PHOTO_PARTICLE_DEFAULTS });
  const [sphere, setSphere] = useState<PhotoSphereSettings>({ ...PHOTO_SPHERE_DEFAULTS });
  const toast = useToast();
  const [mapRoutes,setMapRoutes]=useState(true),[routesReady,setRoutesReady]=useState(false),[savingRoutes,setSavingRoutes]=useState(false);
  const routeSaveGuard=useRef(false);
  useEffect(()=>{
    let live=true;
    void loadMapRoutesEnabled().then(value=>{if(live){setMapRoutes(value);setRoutesReady(true);}}).catch(()=>{if(live){setRoutesReady(true);toast("连线设置读取失败，可重新选择开关");}});
    return()=>{live=false;};
  },[]);
  const updateMapRoutes=async(enabled:boolean)=>{
    if(routeSaveGuard.current)return;
    routeSaveGuard.current=true;setSavingRoutes(true);
    try{await saveMapRoutesEnabled(enabled);setMapRoutes(enabled);}catch(e){toast(`连线设置保存失败：${e}`);}finally{routeSaveGuard.current=false;setSavingRoutes(false);}
  };
  useEffect(()=>{const close=(e:KeyboardEvent)=>{if(e.key==="Escape")onClose();};window.addEventListener("keydown",close);return()=>window.removeEventListener("keydown",close);},[onClose]);

  useEffect(() => {
    (async () => {
      setTier(((await ipc.getSetting("particle_tier")) as QualityTier) ?? "medium");
      setPerf(((await ipc.getSetting("perf_mode")) as PerfMode) ?? "balanced");
      setLock(((await ipc.getSetting("auto_lock")) as LockMin) ?? "15");
      setParticle(await loadPhotoParticleSettings());
      setSphere(await loadPhotoSphereSettings());
      setStats(await ipc.getStats());
    })();
  }, []);

  const saveTier = async (t: QualityTier) => {
    setTier(t);
    await ipc.setSetting("particle_tier", t);
    toast("粒子质量已更新,重新导入的照片将使用新档位");
  };
  const savePerf = async (m: PerfMode) => {
    setPerf(m);
    await ipc.setSetting("perf_mode", m);
  };
  const saveLock = async (m: LockMin) => {
    setLock(m);
    await ipc.setSetting("auto_lock", m);
  };

  const updateParticle = (key: keyof PhotoParticleSettings, value: number) => {
    setParticle((current) => ({ ...current, [key]: value }));
    void savePhotoParticleSetting(key, value);
  };

  const resetParticle = async () => {
    setParticle(await restorePhotoParticleDefaults());
    toast("已恢复 V14 照片粒子默认值");
  };

  const updateSphere = (key: keyof PhotoSphereSettings, value: number) => {
    setSphere((current) => ({ ...current, [key]: value }));
    void savePhotoSphereSetting(key, value);
  };

  const resetSphere = async () => {
    setSphere(await restorePhotoSphereDefaults());
    toast("已恢复照片粒子球默认值");
  };

  const changePwd = async () => {
    if(passwordGuard.current||!passwordReady)return;
    if (!changingPwd) {
      setChangingPwd(true);
      return;
    }
    if(pwdNew.length<4){toast("密码至少 4 位");return;}
    passwordGuard.current=true;setSavingPassword(true);
    try {
      if(passwordEnabled)await ipc.changePassword(pwdOld, pwdNew);else await ipc.setPassword(pwdNew);
      await publishAuthSettings();setPasswordEnabled(true);
      toast("密码已保存");
      setPwdOld("");
      setPwdNew("");
      setChangingPwd(false);
    } catch (e) {
      toast(`${e}`);
    } finally {passwordGuard.current=false;setSavingPassword(false);}
  };

  const doExport = async () => {
    const path = await save({
      title: "导出星辰相册备份",
      defaultPath: "stellar-memories-backup.json",
      filters: [{ name: "Stellar Memories Backup", extensions: ["json"] }],
    });
    if (!path) return;
    try {
      await ipc.exportBackup(path, false);
      toast("备份已导出(元数据,不含原图)");
    } catch (e) {
      toast(`导出失败: ${e}`);
    }
  };

  const doImport = async () => {
    const path = await open({
      title: "导入备份",
      multiple: false,
      filters: [{ name: "Stellar Memories Backup", extensions: ["json"] }],
    });
    if (!path || typeof path !== "string") return;
    try {
      const n = await ipc.importBackup(path);
      toast(`已恢复 ${n} 条文字记忆`);
    } catch (e) {
      toast(`导入失败: ${e}`);
    }
  };

  return (
    <div className="settings" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="inner">
        <h2>设置</h2>

        <div className="group">
          <div className="row">
            <div className="lab">地球照片连线<small>只连接同一天的照片，日期颜色固定；开关立即生效并保存</small></div>
            <div className="seg">
              <button disabled={!routesReady||savingRoutes} className={mapRoutes?"active":""} aria-pressed={mapRoutes} onClick={()=>void updateMapRoutes(true)}>开启</button>
              <button disabled={!routesReady||savingRoutes} className={!mapRoutes?"active":""} aria-pressed={!mapRoutes} onClick={()=>void updateMapRoutes(false)}>关闭</button>
            </div>
          </div>
          <div className="row">
            <div className="lab">
              粒子质量<small>影响照片粒子化的密度,越高越华丽</small>
            </div>
            <div className="seg">
              {(["low", "medium", "high", "ultra"] as QualityTier[]).map((t) => (
                <button key={t} className={tier === t ? "active" : ""} onClick={() => saveTier(t)}>
                  {{ low: "低", medium: "中", high: "高", ultra: "极高" }[t]}
                </button>
              ))}
            </div>
          </div>
          <div className="row">
            <div className="lab">
              性能模式<small>自动为平衡;低端设备建议性能模式</small>
            </div>
            <div className="seg">
              {(["performance", "balanced", "quality"] as PerfMode[]).map((m) => (
                <button key={m} className={perf === m ? "active" : ""} onClick={() => savePerf(m)}>
                  {{ performance: "性能", balanced: "平衡", quality: "高质量" }[m]}
                </button>
              ))}
            </div>
          </div>
          <div className="row">
            <div className="lab">自动锁定<small>无操作后自动回到锁屏</small></div>
            <div className="seg">
              {(["5", "15", "30", "60", "never"] as LockMin[]).map((m) => (
                <button key={m} className={lock === m ? "active" : ""} onClick={() => saveLock(m)}>
                  {{ "5": "5分", "15": "15分", "30": "30分", "60": "1时", never: "从不" }[m]}
                </button>
              ))}
            </div>
          </div>
          <div className="row">
            <div className="lab">
              快速隐藏<small>任何时候按 Ctrl + Shift + L 立即锁定</small>
            </div>
            <div className="seg">
              <button className="active">Ctrl+Shift+L</button>
            </div>
          </div>
        </div>

        <div className="settings-section-title">
          <h2>照片粒子 · V14</h2>
          <button className="pill-btn" onClick={resetParticle}>恢复 V14 默认值</button>
        </div>
        <div className="group particle-settings-group">
          {PHOTO_PARTICLE_SETTING_SPECS.map((spec) => (
            <label className="row particle-setting" key={spec.key}>
              <span className="lab">{spec.label}<small>{particle[spec.key].toFixed(spec.digits)}</small></span>
              <input
                aria-label={spec.label}
                type="range"
                min={spec.min}
                max={spec.max}
                step={spec.step}
                value={particle[spec.key]}
                onChange={(event) => updateParticle(spec.key, Number(event.target.value))}
              />
            </label>
          ))}
        </div>

        <div className="settings-section-title">
          <h2>照片粒子球</h2>
          <button className="pill-btn" onClick={resetSphere}>恢复球体默认值</button>
        </div>
        <div className="group particle-settings-group">
          {PHOTO_SPHERE_SETTING_SPECS.map((spec) => (
            <label className="row particle-setting" key={spec.key}>
              <span className="lab">{spec.label}<small>{sphere[spec.key].toFixed(spec.digits)}</small></span>
              <input aria-label={spec.label} type="range" min={spec.min} max={spec.max} step={spec.step} value={sphere[spec.key]} onChange={(event) => updateSphere(spec.key, Number(event.target.value))} />
            </label>
          ))}
        </div>

        <h2>密码</h2>
        <div className="group">
          <div className="row">
            <div className="lab">解锁方式<small>{passwordEnabled?"启动时输入密码解锁":"无密码，启动时直接点击解锁"}</small></div>
            <div className="seg">
              <button disabled={!passwordReady||savingPassword} className={passwordEnabled?"active":""} aria-pressed={passwordEnabled} onClick={()=>{if(!passwordEnabled)setChangingPwd(true);}}>密码解锁</button>
              <button disabled={!passwordReady||savingPassword} className={!passwordEnabled?"active":""} aria-pressed={!passwordEnabled} onClick={()=>void disablePassword()}>无密码</button>
            </div>
          </div>
          <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
            <div className="lab" style={{ minWidth: 90 }}>
              {passwordEnabled?"修改密码":"设置密码"}
            </div>
            {changingPwd && (
              <>
                {passwordEnabled&&<input
                  type="password"
                  disabled={savingPassword}
                  placeholder="原密码"
                  value={pwdOld}
                  onChange={(e) => setPwdOld(e.target.value)}
                  style={{
                    borderBottom: "1px solid var(--line-2)",
                    padding: "6px 2px",
                    width: 130,
                  }}
                />}
                <input
                  type="password"
                  disabled={savingPassword}
                  maxLength={64}
                  placeholder="新密码(≥4位)"
                  value={pwdNew}
                  onChange={(e) => setPwdNew(e.target.value)}
                  style={{
                    borderBottom: "1px solid var(--line-2)",
                    padding: "6px 2px",
                    width: 130,
                  }}
                />
              </>
            )}
            <button className="pill-btn" disabled={!passwordReady||savingPassword} onClick={changePwd}>
              {savingPassword?"保存中…":changingPwd?"保存密码":passwordEnabled?"修改":"设置"}
            </button>
            {changingPwd&&<button className="pill-btn" disabled={savingPassword} onClick={()=>{setChangingPwd(false);setPwdOld("");setPwdNew("");}}>取消</button>}
          </div>
        </div>

        <h2>备份</h2>
        <div className="group">
          <div className="row">
            <div className="lab">
              导出备份<small>记忆文字、相册、关系、设置(不含原图)</small>
            </div>
            <button className="pill-btn" onClick={doExport}>
              导出
            </button>
          </div>
          <div className="row">
            <div className="lab">从备份恢复</div>
            <button className="pill-btn" onClick={doImport}>
              选择文件
            </button>
          </div>
        </div>

        <h2>关于</h2>
        <div className="about">
          星辰相册 Stellar Memories v1.0.0
          <br />
          {stats.photoCount} 张照片 · {stats.albumCount} 个相册 · {stats.memoryCount} 段文字记忆
          <br />
          所有数据 100% 本地保存 · 原始照片只读不修改
          <br />
          把回忆,变成可以探索的星系。
        </div>
      </div>
    </div>
  );
}
