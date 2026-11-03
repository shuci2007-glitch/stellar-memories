import { addProtocol, type Map as LibreMap, type RasterTileSource } from "maplibre-gl";

/**
 * 自定义协议 `earthsurface://` 由 worker 生成地球贴图瓦片。
 *
 * 这个协议是 **全局注册** 的（maplibre 不允许重复注册同名协议，重复会抛错），
 * 而地图组件可能因为切页/重挂载被创建多次。所以：
 *  - 协议只在进程内注册一次，之后一直复用；
 *  - 协议内部把请求转发给「当前活跃的 worker」，重挂载时替换指针；
 *  - 卸载时只终止自己的 worker 并拒绝在途请求，**不 removeProtocol**，
 *    否则会把仍在使用的下一个实例一起废掉（表现为地球空白/花屏）。
 */

type PendingTask = {
  resolve: (data: { data: ArrayBuffer }) => void;
  reject: (error: Error) => void;
};

const pending = new Map<number, PendingTask>();
let serial = 0;
let activeWorker: Worker | null = null;
let protocolInstalled = false;

function ensureProtocol() {
  if (protocolInstalled) return;
  protocolInstalled = true;
  addProtocol("earthsurface", async (params, controller) => {
    const values = params.url.replace("earthsurface://", "").split("/").map(Number);
    return new Promise<{ data: ArrayBuffer }>((resolve, reject) => {
      const worker = activeWorker;
      if (!worker) {
        reject(new Error("地球瓦片服务未就绪"));
        return;
      }
      const id = ++serial;
      const abort = () => {
        pending.delete(id);
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (controller.signal.aborted) {
        abort();
        return;
      }
      controller.signal.addEventListener("abort", abort, { once: true });
      pending.set(id, {
        resolve: (data) => {
          controller.signal.removeEventListener("abort", abort);
          resolve(data);
        },
        reject: (error) => {
          controller.signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      worker.postMessage({ id, time: values[0], z: values[1], x: values[2], y: values[3] });
    });
  });
}

/** Local worker tiles: all decoding and sunlight compositing stays off the UI thread. */
export function installEarthMapSurface(map: LibreMap) {
  const worker = new Worker(new URL("./earthTiles.worker.ts", import.meta.url), { type: "module" });
  activeWorker = worker;
  worker.onmessage = (e) => {
    const task = pending.get(e.data.id);
    if (!task) return;
    pending.delete(e.data.id);
    if (e.data.error) task.reject(new Error(e.data.error));
    else task.resolve({ data: e.data.data });
  };
  ensureProtocol();
  const url = () => `earthsurface://${Date.now()}/{z}/{x}/{y}`;
  map.addSource("earth-surface", {
    type: "raster",
    tiles: [url()],
    tileSize: 256,
    maxzoom: 4,
    attribution: "Solar System Scope · CC BY 4.0",
  });
  map.addLayer(
    { id: "earth-surface", type: "raster", source: "earth-surface", paint: { "raster-fade-duration": 1000 } },
    "countries-line",
  );
  let disposed = false;
  const timer = window.setInterval(() => {
    if (!disposed && !document.hidden) (map.getSource("earth-surface") as RasterTileSource)?.setTiles([url()]);
  }, 30000);
  return () => {
    disposed = true;
    clearInterval(timer);
    if (activeWorker === worker) activeWorker = null;
    worker.terminate();
    for (const task of pending.values()) task.reject(new Error("地球视图已关闭"));
    pending.clear();
    // 注意：这里故意不 removeProtocol，协议是全局单例，留给后续实例复用。
  };
}
