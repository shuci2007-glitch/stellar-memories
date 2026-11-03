import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import GalaxyGallery from "../src/ui/GalaxyGallery";
import type { Photo } from "../src/core/types";

const photo = (id: number, extra: Partial<Photo> = {}): Photo =>
  ({
    id,
    path: `C:/photos/${id}.jpg`,
    filename: `IMG_${id}.JPG`,
    width: 4000,
    height: 3000,
    thumbPath: null,
    particlePath: null,
    avgColor: "#888888",
    score: 0,
    captureDate: "2026-10-03 10:00:00",
    dateSource: "exif",
    gpsLat: null,
    gpsLon: null,
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
  }) as Photo;

describe("星系全部照片", () => {
  it("列出照片并统计视频与实况", () => {
    const html = renderToStaticMarkup(
      <GalaxyGallery
        spaceName="主星系"
        photos={[photo(1), photo(2, { kind: "video" }), photo(3, { liveVideoId: 33 })]}
        onClose={() => {}}
        onOpenPhoto={() => {}}
      />,
    );
    expect(html).toContain("主星系");
    expect(html).toContain("3 张");
    expect(html).toContain("视频 1");
    expect(html).toContain("实况 1");
    expect(html).toContain("播放全部");
    expect(html).toContain("gg-grid");
  });

  it("空星系给出提示且禁用播放", () => {
    const html = renderToStaticMarkup(
      <GalaxyGallery spaceName="空页面" photos={[]} onClose={() => {}} onOpenPhoto={() => {}} />,
    );
    expect(html).toContain("这个星系还没有照片");
    expect(html).toContain("disabled");
  });
});
