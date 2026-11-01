import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc } from "../core/db";
import { useToast } from "../core/toast";

type Session = { url: string; qrSvg: string; port: number; target: string };

/**
 * 手机上传:先选一个落盘目录,再起临时局域网服务给手机扫码。
 * 照片直接写进用户选的文件夹,关掉这个面板就停止接收。
 */
export default function PhoneUpload({
  onClose,
  onFinished,
}: {
  onClose: () => void;
  onFinished: () => void;
}) {
  const toast = useToast();
  const [target, setTarget] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [count, setCount] = useState(0);
  const [lastName, setLastName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  useEffect(() => {
    void ipc.getSetting("upload_target").then((v) => setTarget(v ?? ""));
  }, []);

  // 收到几张了:壁纸/主界面都不需要实时刷新,轮询足够。
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(async () => {
      try {
        const s = await ipc.phoneUploadStatus();
        if (!s) return;
        setCount(s.count);
        setLastName(s.lastName);
      } catch {
        /* 会话可能已被后端关闭 */
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [session]);

  const pickDir = useCallback(async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "选择手机照片存放的文件夹",
    });
    if (!picked || typeof picked !== "string") return;
    setTarget(picked);
    await ipc.setSetting("upload_target", picked).catch(() => {});
    return picked;
  }, []);

  const begin = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      let dir = target;
      if (!dir) {
        const picked = await open({
          directory: true,
          multiple: false,
          title: "选择手机照片存放的文件夹",
        });
        if (!picked || typeof picked !== "string") return;
        dir = picked;
        setTarget(picked);
        await ipc.setSetting("upload_target", picked).catch(() => {});
      }
      const info = await ipc.startPhoneUpload(dir);
      setSession(info);
      setCount(0);
      setClosed(false);
    } catch (e) {
      toast(`手机上传启动失败：${e}`);
    } finally {
      setBusy(false);
    }
  }, [busy, target, toast]);

  const finish = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const n = await ipc.stopPhoneUpload();
      setSession(null);
      setClosed(true);
      onFinished();
      if (n > 0) toast(`${n} 张照片已开始入库`);
      onClose();
    } catch (e) {
      toast(`结束上传失败：${e}`);
    } finally {
      setBusy(false);
    }
  }, [busy, onClose, onFinished, toast]);

  // 直接关面板也要把服务停掉,不留后台监听。
  useEffect(() => {
    return () => {
      if (sessionRef.current) void ipc.stopPhoneUpload().catch(() => {});
    };
  }, []);

  return (
    <div className="phone-upload" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel">
        <h3>手机上传</h3>

        {!session && (
          <>
            <div className="tip">
              手机和这台电脑连同一个 WiFi，扫码后用手机浏览器选照片，照片直接保存到下面这个文件夹。
            </div>
            <div className="tip" style={{ color: "var(--tx-2)", wordBreak: "break-all" }}>
              {target || "还没选择存放位置"}
            </div>
            <div className="actions">
              <button className="pill-btn" onClick={() => void pickDir()} disabled={busy}>
                换文件夹
              </button>
              <button className="pill-btn primary" onClick={() => void begin()} disabled={busy}>
                {busy ? "启动中…" : "开始接收"}
              </button>
            </div>
            <div className="warn">
              首次使用 Windows 可能弹出防火墙提示，请允许「专用网络」，否则手机连不上。
            </div>
          </>
        )}

        {session && (
          <>
            <div
              className="qr"
              dangerouslySetInnerHTML={{ __html: session.qrSvg }}
              aria-label="手机上传二维码"
            />
            <div className="url">{session.url}</div>
            <div className="stat">
              <span>{count > 0 ? `已收到 ${count} 张` : "等待手机上传…"}</span>
              <span>{lastName ?? ""}</span>
            </div>
            <div className="tip">照片会先存进上面选好的文件夹，点「结束」后统一入库并建成相册。</div>
            <div className="actions">
              <button className="pill-btn" onClick={() => void finish()} disabled={busy}>
                取消
              </button>
              <button className="pill-btn primary" onClick={() => void finish()} disabled={busy}>
                {busy ? "整理中…" : "结束"}
              </button>
            </div>
          </>
        )}

        {closed && !session && <div className="tip">本次上传已结束。</div>}
      </div>
    </div>
  );
}
