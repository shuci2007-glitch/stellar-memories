import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/**
 * 顶层错误边界:任何渲染 / effect 抛错都不再让整棵 React 树静默卸载成黑屏,
 * 而是把错误显示出来,便于定位(浏览器预览尤其需要)。
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("应用崩溃:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "#0a0d18",
          color: "#e6e9f2",
          font: "13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace",
          padding: 28,
          overflow: "auto",
          zIndex: 99999,
        }}
      >
        <h2 style={{ color: "#ff8a8a", margin: "0 0 12px" }}>应用运行时出错</h2>
        <div style={{ color: "#ffb4b4", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {error.message}
        </div>
        {error.stack && (
          <pre style={{ color: "#8b93a7", whiteSpace: "pre-wrap", marginTop: 16 }}>
            {error.stack}
          </pre>
        )}
      </div>
    );
  }
}
