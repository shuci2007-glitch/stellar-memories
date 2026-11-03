import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Photo } from "../src/core/types";
import { routeProgressGeometry } from "../src/core/memoryRoutes";
import Slideshow from "../src/ui/Slideshow";

const photo = (id: number, extra: Partial<Photo> = {}): Photo => ({
  id,
  path: `C:/photos/${id}.jpg`,
  filename: `IMG_${id}.JPG`,
  width: 4000,
  height: 3000,
  thumbPath: null,
  particlePath: null,
  avgColor: "#888888",
  score: 0,
  captureDate: "2024-05-01 10:00:00",
  dateSource: "exif",
  gpsLat: 30 + id / 100,
  gpsLon: 120 + id / 100,
  camera: null,
  lens: null,
  iso: null,
  shutter: null,
  aperture: null,
  focal: null,
  starred: false,
  missing: false,
  imported: true,
  kind: "photo",
  processed: true,
  duration: null,
  liveVideoId: null,
  createdAt: "",
  updatedAt: "",
  ...extra,
});

describe("幻灯片放映", () => {
  it("显示首张、计数与控制条", () => {
    const html = renderToStaticMarkup(
      <Slideshow photos={[photo(1), photo(2)]} onClose={() => {}} />,
    );
    expect(html).toContain("1 / 2");
    expect(html).toContain("退出 · ESC");
    expect(html).toContain("2024-05-01");
    expect(html).toContain("slide-img");
  });

  it("可以从指定位置开始", () => {
    const html = renderToStaticMarkup(
      <Slideshow photos={[photo(1), photo(2), photo(3)]} startIndex={2} onClose={() => {}} />,
    );
    expect(html).toContain("3 / 3");
  });

  it("视频直接渲染播放器而不是静态图", () => {
    const html = renderToStaticMarkup(
      <Slideshow photos={[photo(7, { kind: "video" })]} onClose={() => {}} />,
    );
    expect(html).toContain("<video");
    expect(html).toContain("http://tm.localhost/video/7");
    expect(html).toContain("slide-video");
  });

  it("实况先亮静帧并标注实况", () => {
    const html = renderToStaticMarkup(
      <Slideshow photos={[photo(8, { liveVideoId: 88 })]} onClose={() => {}} />,
    );
    // 首帧是静帧（img），动态片段要等静帧阶段结束才挂载
    expect(html).toContain("http://tm.localhost/photo/8");
    expect(html).not.toContain("<video");
    expect(html).toContain("实况");
  });
});

describe("行程已走过轨迹", () => {
  const route = {
    day: "2024-05-01",
    color: "#fff",
    photos: [photo(1), photo(2), photo(3)],
  };

  it("按站点数返回对应段数", () => {
    expect(routeProgressGeometry(route, 0).features).toHaveLength(0);
    expect(routeProgressGeometry(route, 1).features).toHaveLength(1);
    expect(routeProgressGeometry(route, 2).features).toHaveLength(2);
    // 超出站点数不会多画
    expect(routeProgressGeometry(route, 9).features).toHaveLength(2);
  });

  it("每段都带日期与颜色属性", () => {
    const f = routeProgressGeometry(route, 2).features[0];
    expect(f.properties?.day).toBe("2024-05-01");
    expect(f.geometry.type).toBe("LineString");
  });
});
