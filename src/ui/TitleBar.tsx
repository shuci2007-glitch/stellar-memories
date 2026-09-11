import { ipc } from "../core/db";

/** 自绘无边框标题栏(保留 Windows 基本行为) */
export default function TitleBar() {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 1c.6 6.5 4.5 10.4 11 11-6.5.6-10.4 4.5-11 11-.6-6.5-4.5-10.4-11-11C7.5 11.4 11.4 7.5 12 1Z"
            fill="currentColor"
          />
        </svg>
        <span>星辰相册</span>
      </div>
      <div className="win-controls">
        <button title="最小化" onClick={() => ipc.winMinimize()}>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button title="最大化/还原" onClick={() => ipc.winToggleMaximize()}>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="0.5" y="0.5" width="9" height="9" rx="1" stroke="currentColor" fill="none" />
          </svg>
        </button>
        <button title="关闭" className="close" onClick={() => ipc.winClose()}>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </div>
  );
}
