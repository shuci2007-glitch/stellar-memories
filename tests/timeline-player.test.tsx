import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TimelinePlayer from "../src/ui/TimelinePlayer";

const p = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "photo",
  liveVideoId: null,
  captureDate: "2026-10-03 10:00:00",
  filename: `IMG_${id}.jpg`,
  ...extra,
});

describe("时间轴页内播放", () => {
  it("显示日期、计数与推镜层", () => {
    const html = renderToStaticMarkup(
      <TimelinePlayer photos={[p(1), p(2), p(3)]} onClose={() => {}} />,
    );
    expect(html).toContain("1 / 3");
    expect(html).toContain("2026-10-03");
    expect(html).toContain("tl-player-dolly");
    expect(html).toContain("退出 · ESC");
  });

  it("可以从指定位置开始", () => {
    const html = renderToStaticMarkup(
      <TimelinePlayer photos={[p(1), p(2), p(3)]} startIndex={2} onClose={() => {}} />,
    );
    expect(html).toContain("3 / 3");
  });

  it("视频直接渲染播放器", () => {
    const html = renderToStaticMarkup(
      <TimelinePlayer photos={[p(9, { kind: "video" })]} onClose={() => {}} />,
    );
    expect(html).toContain("<video");
    expect(html).toContain("http://tm.localhost/video/9");
  });

  it("实况先是静帧，不挂视频", () => {
    const html = renderToStaticMarkup(
      <TimelinePlayer photos={[p(8, { liveVideoId: 88 })]} onClose={() => {}} />,
    );
    expect(html).toContain("http://tm.localhost/photo/8");
    expect(html).not.toContain("<video");
  });
});
