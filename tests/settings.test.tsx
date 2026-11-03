import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsView from "../src/ui/SettingsView";

// 设置页的读取都在 useEffect 里，SSR 不执行；这里只验静态结构。
describe("设置页 · 媒体", () => {
  const html = renderToStaticMarkup(<SettingsView onClose={() => {}} />);

  it("有补全实况照片的入口", () => {
    expect(html).toContain("媒体");
    expect(html).toContain("补全实况照片");
    expect(html).toContain("开始扫描");
  });

  it("说明写清楚是给动态照片用的", () => {
    expect(html).toContain("动态照片");
    expect(html).toContain("实况");
  });
});
