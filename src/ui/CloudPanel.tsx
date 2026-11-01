import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "../core/toast";
import {
  fetchCloudAlbums,
  fetchCloudMedia,
  getCloud,
  sessionLabel,
  signedUrlFor,
  type CloudAlbum,
  type CloudMedia,
} from "../core/cloud";

type Stage = "checking" | "login" | "albums" | "media";

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 900,
  background: "linear-gradient(160deg, #0a0c14 0%, #10131f 55%, #0a0c14 100%)",
  display: "flex",
  flexDirection: "column",
  color: "#e8eaf0",
  fontFamily: "inherit",
};

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "14px 20px",
  borderBottom: "1px solid rgba(255,255,255,.08)",
  flexWrap: "wrap",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "11px 13px",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,.16)",
  background: "rgba(255,255,255,.05)",
  color: "inherit",
  fontSize: 14,
  outline: "none",
};

const primaryBtn: React.CSSProperties = {
  padding: "12px 18px",
  borderRadius: 10,
  border: "none",
  cursor: "pointer",
  background: "linear-gradient(135deg, #6c8cff, #8a6cff)",
  color: "#fff",
  fontSize: 15,
  fontWeight: 600,
  width: "100%",
};

const ghostBtn: React.CSSProperties = {
  padding: "7px 12px",
  borderRadius: 9,
  border: "1px solid rgba(255,255,255,.16)",
  background: "rgba(255,255,255,.05)",
  color: "inherit",
  cursor: "pointer",
  fontSize: 13,
};

export default function CloudPanel({ onClose }: { onClose: () => void }) {
  const [stage, setStage] = useState<Stage>("checking");
  const [session, setSession] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [otp, setOtp] = useState<{ phone: string; verificationId: string; isExistingUser: boolean } | null>(null);
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef<number | null>(null);

  const [albums, setAlbums] = useState<CloudAlbum[]>([]);
  const [album, setAlbum] = useState<CloudAlbum | null>(null);
  const [media, setMedia] = useState<CloudMedia[]>([]);
  const [urls, setUrls] = useState<Record<number, string>>({});
  const [preview, setPreview] = useState<{ src: string; type: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [uploadDone, setUploadDone] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importDone, setImportDone] = useState(0);
  const [importMsg, setImportMsg] = useState("");
  const [canUpload, setCanUpload] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const loadAlbums = useCallback(async () => {
    setBusy(true);
    setErr("");
    try {
      const list = await fetchCloudAlbums();
      setAlbums(list);
      setStage("albums");
    } catch (e: any) {
      setErr(e?.message || "读取失败");
      setStage("albums");
    } finally {
      setBusy(false);
    }
  }, []);

  // 启动：尝试恢复已有登录态
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cloud = getCloud();
        const { data } = await cloud.auth.getSession();
        if (!alive) return;
        if (data) {
          setSession(data);
          await loadAlbums();
        } else {
          setStage("login");
        }
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message || "云端连接失败");
        setStage("login");
      }
    })();
    return () => {
      alive = false;
      clearTimer();
    };
  }, [loadAlbums]);

  async function sendCode() {
    setErr("");
    if (!/^1\d{10}$/.test(phone)) {
      setErr("请输入正确的 11 位手机号");
      return;
    }
    setBusy(true);
    try {
      const cloud = getCloud();
      const { data, error } = await cloud.auth.sendOtp({ phone });
      if (error) {
        setErr(error.message || "验证码发送失败");
        return;
      }
      setOtp({ phone, verificationId: data.verificationId, isExistingUser: data.isExistingUser });
      setCountdown(60);
      clearTimer();
      timerRef.current = window.setInterval(() => {
        setCountdown((c) => {
          if (c <= 1) {
            clearTimer();
            return 0;
          }
          return c - 1;
        });
      }, 1000);
    } catch (e: any) {
      setErr(e?.message || "验证码发送失败");
    } finally {
      setBusy(false);
    }
  }

  async function doLogin() {
    setErr("");
    if (!otp || otp.phone !== phone) {
      setErr("请先获取验证码");
      return;
    }
    if (!/^\d{4,6}$/.test(code)) {
      setErr("请输入验证码");
      return;
    }
    setBusy(true);
    try {
      const cloud = getCloud();
      const { error } = await cloud.auth.verifyOtp({
        phone: otp.phone,
        verificationId: otp.verificationId,
        isExistingUser: otp.isExistingUser,
        token: code,
      });
      if (error) {
        setErr(error.message || "验证失败");
        return;
      }
      const { data } = await cloud.auth.getSession();
      setSession(data);
      setOtp(null);
      setCode("");
      await loadAlbums();
    } catch (e: any) {
      setErr(e?.message || "登录失败");
    } finally {
      setBusy(false);
    }
  }

  async function openAlbum(a: CloudAlbum) {
    setAlbum(a);
    setStage("media");
    setMedia([]);
    setUrls({});
    setErr("");
    setBusy(true);
    try {
      const list = await fetchCloudMedia(a.id);
      setMedia(list);

      // 家庭相册：先确认自己有没有上传权限（只读成员直接隐藏上传入口）
      let canUp = true;
      const uid = session?.user?.id;
      if (a.family_id && uid) {
        try {
          const { data: me } = await getCloud()
            .database.from("family_members")
            .select("can_upload")
            .eq("family_id", a.family_id)
            .eq("user_id", uid)
            .maybeSingle();
          canUp = !me || me.can_upload !== false;
        } catch {
          canUp = true;
        }
      }
      setCanUpload(canUp);
      // 分批取签名地址，避免一次打太多请求
      const batch: Record<number, string> = {};
      for (let i = 0; i < list.length; i += 6) {
        const chunk = list.slice(i, i + 6);
        const pairs = await Promise.all(
          chunk.map(async (m) => {
            try {
              return [m.id, await signedUrlFor(m.storage_path)] as [number, string];
            } catch {
              return [m.id, ""] as [number, string];
            }
          }),
        );
        for (const [id, u] of pairs) if (u) batch[id] = u;
        setUrls({ ...batch });
      }
    } catch (e: any) {
      setErr(e?.message || "读取相册内容失败");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try {
      await getCloud().auth.signOut();
    } catch {
      /* 忽略 */
    }
    setSession(null);
    setAlbums([]);
    setMedia([]);
    setUrls({});
    setAlbum(null);
    setStage("login");
  }

  async function onPickFiles(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const files = Array.from(input.files || []);
    input.value = "";
    if (!files.length || !album || !session) return;

    setUploading(true);
    setUploadTotal(files.length);
    setUploadDone(0);
    setErr("");

    const cloud = getCloud();
    const uid = session?.user?.id;
    let ok = 0;

    for (const f of files) {
      try {
        const ext = (f.name.includes(".") ? f.name.split(".").pop() : "bin") || "bin";
        const key = `albums/${album.id}/${crypto.randomUUID()}.${ext.toLowerCase()}`;
        const path = cloud.storage.userPath(uid, key);
        const { error } = await cloud.storage.upload(path, f, {
          contentType: f.type || "application/octet-stream",
        });
        if (error) {
          setErr(error.message || "上传失败");
        } else {
          const isVideo =
            (f.type || "").startsWith("video") ||
            /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(f.name);
          const { error: recErr } = await cloud.database.from("media").insert({
            album_id: album.id,
            family_id: album.family_id || null,
            storage_path: path,
            media_type: isVideo ? "video" : "photo",
            meta: { name: f.name, size: f.size },
          });
          if (recErr) {
            setErr(recErr.message || "写入记录失败（可能没有该相册的上传权限）");
            // 记录写不进去就删掉已上传的文件，避免孤儿文件
            try {
              await cloud.storage.remove([path]);
            } catch {
              /* 忽略清理失败 */
            }
          } else ok++;
        }
      } catch (err: any) {
        setErr(err?.message || "上传失败");
      }
      setUploadDone((n) => n + 1);
    }

    setUploading(false);
    if (ok > 0) await openAlbum(album);
  }

  // 把云端相册的照片下载到本地并接入本地库（星系 / 时间线 / 地图都自动支持）
  async function importToLocal() {
    if (!album || media.length === 0) return;
    if (
      !confirm(
        `把「${album.name}」的 ${media.length} 个文件导入本地相册？\n` +
          `导入后会生成缩略图、出现在 3D 星系里；已导入过的文件会自动跳过。`,
      )
    )
      return;

    setImporting(true);
    setImportDone(0);
    setImportMsg("");
    setErr("");

    const paths: string[] = [];
    for (const m of media) {
      try {
        const url = urls[m.id] || (await signedUrlFor(m.storage_path));
        if (!url) throw new Error("无法获取下载地址");
        const local = await invoke<string>("cloud_download", {
          url,
          storagePath: m.storage_path,
        });
        if (local) paths.push(local);
      } catch (e: any) {
        setErr(e?.message || "下载失败");
      }
      setImportDone((n) => n + 1);
    }

    setImporting(false);
    if (paths.length === 0) return;

    try {
      await invoke("import_photos", { paths, albumName: album.name });
      setImportMsg(`已提交 ${paths.length} 个文件，正在后台生成缩略图与粒子图，稍后即可在星系中看到。`);
      toast(`已提交导入 ${paths.length} 个文件`);
    } catch (e: any) {
      setErr(e?.message || "导入失败");
    }
  }

  return (
    <div style={overlay} onClick={(e) => e.stopPropagation()}>
      <div style={bar}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <strong style={{ fontSize: 16, letterSpacing: 1 }}>云端相册</strong>
          {session && <span style={{ fontSize: 12, opacity: 0.6 }}>{sessionLabel(session)}</span>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {stage === "media" && (
            <button style={ghostBtn} onClick={() => { setStage("albums"); setAlbum(null); }}>
              ← 返回相册
            </button>
          )}
          {session && (
            <button style={ghostBtn} onClick={logout}>
              退出
            </button>
          )}
          <button style={ghostBtn} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "18px 20px 32px" }}>
        {stage === "checking" && <p style={{ opacity: 0.6 }}>正在连接云端…</p>}

        {stage === "login" && (
          <div style={{ maxWidth: 380, margin: "6vh auto 0" }}>
            <h2 style={{ margin: "0 0 6px", fontSize: 20 }}>登录云端</h2>
            <p style={{ margin: "0 0 18px", fontSize: 13, opacity: 0.6 }}>
              与网页端同一个账号；用手机号验证码登录。
            </p>
            <input
              style={inputStyle}
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 11))}
              placeholder="11 位手机号"
              inputMode="numeric"
            />
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <input
                style={{ ...inputStyle, flex: 1 }}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="6 位验证码"
                inputMode="numeric"
              />
              <button
                style={{ ...ghostBtn, whiteSpace: "nowrap", minWidth: 104 }}
                onClick={sendCode}
                disabled={busy || countdown > 0}
              >
                {countdown > 0 ? `${countdown}s 后重发` : "获取验证码"}
              </button>
            </div>
            {err && <p style={{ color: "#ff6b6b", fontSize: 13, marginTop: 10 }}>{err}</p>}
            <button style={{ ...primaryBtn, marginTop: 16 }} onClick={doLogin} disabled={busy}>
              {busy ? "处理中…" : "登录"}
            </button>
          </div>
        )}

        {stage === "albums" && (
          <>
            {err && <p style={{ color: "#ff6b6b", fontSize: 13 }}>{err}</p>}
            {!busy && albums.length === 0 && !err && (
              <p style={{ opacity: 0.6 }}>云端还没有相册。可以到网页端新建并上传照片。</p>
            )}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                gap: 12,
                marginTop: 8,
              }}
            >
              {albums.map((a) => (
                <button
                  key={a.id}
                  onClick={() => openAlbum(a)}
                  style={{
                    textAlign: "left",
                    padding: "16px 14px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,.12)",
                    background: "rgba(255,255,255,.04)",
                    color: "inherit",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{a.name}</div>
                  <div style={{ fontSize: 12, opacity: 0.55, marginTop: 4 }}>
                    {a.kind === "family" ? "家庭共享" : "个人"}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {stage === "media" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
              <h3 style={{ margin: 0, fontSize: 17 }}>{album?.name}</h3>
              <span style={{ fontSize: 12, opacity: 0.55 }}>{media.length} 个文件</span>
              <span style={{ flex: 1 }} />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,video/*"
                style={{ display: "none" }}
                onChange={onPickFiles}
              />
              <button
                style={{ ...ghostBtn, opacity: importing ? 0.6 : 1 }}
                onClick={importToLocal}
                disabled={importing || media.length === 0}
              >
                {importing ? `下载 ${importDone}/${media.length}` : "导入到本地"}
              </button>
              <button
                style={{ ...ghostBtn, opacity: uploading || !canUpload ? 0.6 : 1 }}
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || !canUpload}
                title={canUpload ? "选择本地照片上传到云端" : "你对这个相册只有查看权限"}
              >
                {!canUpload
                  ? "只读（无上传权限）"
                  : uploading
                    ? `上传中 ${uploadDone}/${uploadTotal}`
                    : "上传照片"}
              </button>
            </div>
            {importMsg && (
              <p style={{ fontSize: 12, opacity: 0.72, margin: "0 0 10px" }}>{importMsg}</p>
            )}
            {err && <p style={{ color: "#ff6b6b", fontSize: 13 }}>{err}</p>}
            {busy && media.length === 0 && <p style={{ opacity: 0.6 }}>加载中…</p>}
            {!busy && media.length === 0 && !err && <p style={{ opacity: 0.6 }}>这个相册还没有照片。</p>}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))",
                gap: 10,
              }}
            >
              {media.map((m) => {
                const src = urls[m.id];
                return (
                  <div
                    key={m.id}
                    style={{
                      position: "relative",
                      aspectRatio: "1",
                      borderRadius: 10,
                      overflow: "hidden",
                      background: "rgba(255,255,255,.05)",
                      border: "1px solid rgba(255,255,255,.1)",
                      cursor: src ? "zoom-in" : "default",
                    }}
                    onClick={() => src && setPreview({ src, type: m.media_type })}
                  >
                    {src ? (
                      m.media_type === "video" ? (
                        <video src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} muted />
                      ) : (
                        <img
                          src={src}
                          alt=""
                          loading="lazy"
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                      )
                    ) : (
                      <div
                        style={{
                          width: "100%",
                          height: "100%",
                          display: "grid",
                          placeItems: "center",
                          fontSize: 11,
                          opacity: 0.45,
                        }}
                      >
                        加载中
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {preview && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,.88)",
            display: "grid",
            placeItems: "center",
            padding: 24,
          }}
          onClick={() => setPreview(null)}
        >
          {preview.type === "video" ? (
            <video src={preview.src} controls autoPlay style={{ maxWidth: "94%", maxHeight: "90%" }} />
          ) : (
            <img src={preview.src} alt="" style={{ maxWidth: "94%", maxHeight: "90%", objectFit: "contain" }} />
          )}
        </div>
      )}
    </div>
  );
}
