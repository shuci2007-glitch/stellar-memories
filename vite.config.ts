import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const host = process.env.TAURI_DEV_HOST;

// maplibre 在运行时用 new URL('./maplibre-gl-worker.mjs', 模块自身URL) 加载
// worker,vite 感知不到这个动态引用,需要把文件复制到产物旁边。
// worker 自身还静态导入 maplibre-gl-shared.mjs,必须一并复制,
// 否则打包后 worker 模块解析失败,地图 style 永远加载不完(地图黑屏)。
const copyMaplibreWorker = () => ({
  name: "copy-maplibre-worker",
  closeBundle: async () => {
    await mkdir("dist/assets", { recursive: true });
    for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
      await copyFile(`node_modules/maplibre-gl/dist/${file}`, `dist/assets/${file}`);
    }
  },
});

export default defineConfig({
  plugins: [react(), copyMaplibreWorker()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      // 桌面壁纸是独立窗口、独立入口:不加载任何界面组件与地图依赖。
      input: {
        main: resolve(process.cwd(), "index.html"),
        wallpaper: resolve(process.cwd(), "wallpaper.html"),
      },
    },
  },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["maplibre-gl"] },
});
