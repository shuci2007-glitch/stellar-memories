import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import "./styles/global.css";

// 隐藏启动占位
requestAnimationFrame(() => {
  document.getElementById("boot")?.classList.add("hide");
  setTimeout(() => document.getElementById("boot")?.remove(), 800);
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
