/**
 * 运行环境判断。
 * 本应用是 Tauri 桌面程序，也支持「纯网页回退模式」（如浏览器预览）。
 * 网页模式下没有 Rust 后端，所有 ipc 调用都会 reject，需要提前跳过。
 */

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
