# 第三方来源

PolyForm Noncommercial 1.0.0 仅覆盖项目自有代码，不能替代下列上游许可。

- React、Three.js、Vite、TypeScript、Vitest：MIT；MapLibre GL JS：BSD-3-Clause。其他 npm 依赖见各包 LICENSE 与 package-lock.json。
- Tauri 与 Rust 依赖保留各 crate 许可，见 Cargo.lock 及上游发行包；不把所有 Rust 依赖统一标为 MIT。
- Solar System Scope 地球纹理：CC BY 4.0，作者 INOVE / Solar System Scope，https://www.solarsystemscope.com/textures/ 。本地版本来自 Three.js 示例资源；省级地形背景由地表颜色和高程阴影生成。详见 `public/maps/earth/ATTRIBUTION.md`。
- Natural Earth：Public Domain，https://www.naturalearthdata.com/about/terms-of-use/ 。安装包内置其 110m 行政边界（`ne_110m_admin_0_countries`，仅保留 ADMIN/NAME/ADM0_A3 字段，见 `public/maps/world-countries.geojson`）。
- Wikidata 景点坐标：CC0，目录逐项记录来源链接。
- 高程底图：Mapzen / SRTM，https://github.com/tilezen/joerd/blob/master/docs/attribution.md 。
- DataV.GeoAtlas 中国省市边界：随安装包分发，来源 https://datav.aliyun.com/portal/school/atlas/area_generator 。该数据的开放再分发条款未完全明确，已按仓库所有者的决定内置以实现完全离线；如上游提出异议，可改用 `scripts/setup-map-data.py` 在本机下载后自行构建。

星系动画与自用版完全一致：动画代码为本项目原创实现，其架构原理参考公开网页（OpenAI Astra 演示页）的学习性复现；旋臂路径数据由该页面动画的 SVG 轨迹烘焙为数值采样（`src/three/armPaths.ts`）。由仓库所有者确认以此形式发布。

项目不是 OpenAI 或上述数据提供者的官方产品，也不主张获得其背书。
