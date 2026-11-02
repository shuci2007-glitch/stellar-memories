import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// 预加载函数会创建 Worker，SSR 下不需要，直接桩掉。
vi.mock("../src/three/DetailPhotoResources", () => ({ prewarmDetailPhoto: () => {} }));

import TimelineView from "../src/ui/TimelineView";

const photos = [
  { id: 1, captureDate: "2024-10-03 10:00:00", kind: "photo", starred: true, gpsLat: 31.2, gpsLon: 121.4 },
  { id: 2, captureDate: "2024-10-04 10:00:00", kind: "video", starred: false, gpsLat: null, gpsLon: null },
  { id: 3, captureDate: "2023-05-01 10:00:00", kind: "photo", starred: false, liveVideoId: 9, gpsLat: 30.1, gpsLon: 120.2 },
  { id: 4, captureDate: null, kind: "photo", starred: false, gpsLat: 1, gpsLon: 2 },
];

const render = (onThisDay: typeof photos = []) =>
  renderToStaticMarkup(
    <TimelineView photos={photos} onThisDay={onThisDay} onOpenPhoto={() => {}} />,
  );

describe("时间轴视图", () => {
  it("渲染筛选条与年份分组", () => {
    const html = render();
    for (const label of ["全部", "照片", "视频", "实况", "已加星", "无地点"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("2024");
    expect(html).toContain("2023");
    expect(html).toContain("未知时间");
    expect(html).toContain("tl-select");
  });

  it("视频与实况在缩略图上打标", () => {
    const html = render();
    expect(html).toContain("thumb-kind-badge");
    expect(html).toContain("thumb-live-badge");
  });

  it("往年今天只在有数据时渲染", () => {
    expect(render()).not.toContain("往年今天");
    expect(render([photos[0]])).toContain("往年今天");
  });

  it("空库给出引导文案", () => {
    const html = renderToStaticMarkup(
      <TimelineView photos={[]} onOpenPhoto={() => {}} />,
    );
    expect(html).toContain("还没有照片");
  });
});
