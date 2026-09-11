import { useEffect, useRef, useState } from "react";
import { ipc } from "../core/db";

/** 锁屏:背景就是尚未成形的宇宙散星(同一场景),控件极简悬浮 */
export default function LockScreen({
  hasPassword,
  passwordless,
  ready,
  leaving,
  onSuccess,
}: {
  hasPassword: boolean;
  passwordless:boolean;
  ready:boolean;
  leaving: boolean;
  onSuccess: (hasPassword:boolean,passwordless:boolean) => void;
}) {
  const [pwd, setPwd] = useState("");
  const [err, setErr] = useState(false);
  const firstSetup = !hasPassword&&!passwordless;
  const [pwd2, setPwd2] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting=useRef(false);
  const [failure,setFailure]=useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [firstSetup,ready,passwordless]);

  const submit = async () => {
    if (submitting.current || busy || !ready || leaving || (!passwordless&&!pwd)) return;
    submitting.current=true;setBusy(true);setFailure("");
    try {
      if (firstSetup) {
        if (pwd.length < 4 || pwd !== pwd2) {
          setErr(true);
          setTimeout(() => setErr(false), 900);
          return;
        }
        await ipc.setPassword(pwd);
        onSuccess(true,false);
      } else {
        const ok = await ipc.verifyPassword(passwordless?"":pwd);
        if (ok) {
          onSuccess(hasPassword,passwordless);
        } else {
          setErr(true);
          setPwd("");
          setTimeout(() => setErr(false), 900);
        }
      }
    } catch(e) {
      setFailure(`解锁失败：${e}`);
    } finally {
      submitting.current=false;setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") submit();
  };

  return (
    <div className={"lock" + (leaving ? " is-leaving" : "")}>
      <div className="box">
        <div className="logo">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.9 }}>
            <path
              d="M12 1c.6 6.5 4.5 10.4 11 11-6.5.6-10.4 4.5-11 11-.6-6.5-4.5-10.4-11-11C7.5 11.4 11.4 7.5 12 1Z"
              fill="rgba(235,238,248,0.92)"
            />
          </svg>
          <div className="name">星辰相册</div>
          <div className="en">STELLAR MEMORIES</div>
        </div>
        {ready&&firstSetup && (
          <>
            <input
              ref={inputRef}
              type="password"
              placeholder="设置密码"
              maxLength={64}
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
              onKeyDown={onKey}
              autoFocus
            />
            <input
              type="password"
              placeholder="再次输入"
              maxLength={64}
              value={pwd2}
              onChange={(e) => setPwd2(e.target.value)}
              onKeyDown={onKey}
            />
            <div className="hint">密码用于保护你的记忆 · 本地保存,不联网</div>
          </>
        )}
        {ready&&hasPassword && (
          <input
            ref={inputRef}
            type="password"
            placeholder="输入密码"
            maxLength={64}
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            onKeyDown={onKey}
            autoFocus
          />
        )}
        <div className={"hint" + (err ? " err shake-once" : "")}>
          {failure|| (err ? (firstSetup ? "两次输入不一致或太短" : "密码不正确") : ready?"\u00A0":"正在读取解锁设置…")}
        </div>
        <button className="lock-btn" onClick={submit} disabled={busy||!ready||leaving}>
          {ready&&firstSetup ? "进入" : "解锁"}
        </button>
      </div>
    </div>
  );
}
