# 省级照片墙地图素材

- 省界轮廓复用项目现有 china-provinces.geojson（DataV.GeoAtlas）。
- province-landmarks.json 的景点名称、经纬度来自 Wikidata，CC0；每条记录保留对应实体的 source URL。获取日期：2026-09-09。
- 照片墙叠加现有 Earth 日间地表纹理（Solar System Scope，CC BY 4.0，见 earth/ATTRIBUTION.md）及离线市区边界；呈现为柔和纸面地图。
- 照片坐标取自已有照片 GPS，照片卡片为避免遮挡就近展开，虚线指回精确坐标。实线是照片墙装饰绳，不代表旅行路线。

## 地形

province-relief/*.png 根据 Mapzen Terrain Tiles 的 Terrarium 高程数据绘制，包含 SRTM 等公开高程源；地表影像配色、晕渲及等高线由 scripts/build-province-relief.py 计算。为风格化地图显示，非测绘成果。下载日期：2026-09-09。

- 数据目录：https://registry.opendata.aws/terrain-tiles/
- 格式：https://github.com/tilezen/joerd/blob/master/docs/formats.md
- 完整来源与署名：https://github.com/tilezen/joerd/blob/master/docs/attribution.md
- 景点插画为项目内 SVG 概括绘制，位置沿用 Wikidata 坐标。

## 景点扩充与布局

2026-09-09 使用 `scripts/extend-wall-landmarks.py` 从 Wikidata 查询并增量合并公开地理坐标，保留每条记录的实体来源。目录现有 231 处景点，覆盖 34 个省级地区，每个地区至少 5 处；未能核实坐标的条目不会加入。照片和景点共同使用省级地理投影；为避免遮挡，插画可就近移开，以细引线指向原始坐标。照片完整卡片在省界内避让，拍摄点定位线仅在指向或聚焦照片时显示。麻绳仅连接少量近邻，每张照片最多一条，不代表旅行路线。

2026-09-09：`scripts/extend-wall-landmarks-zh.py` 补充中文站点景点坐标。底图改为 Solar System Scope 8K Earth Day Map 的经纬度采样，结合 Mapzen 高程阴影，保留原影像沙漠、植被、水体及积雪颜色；仅轻微提亮以适应纸面风格，不再按海拔把沿海陆地着成水色。地表纹理属于静态地理概貌，不是实时或季节雪况。原纹理缓存于 scripts/terrain-cache/earth_day_8k.jpg，派生图片在 province-relief。

- 地表素材：https://www.solarsystemscope.com/textures/ ，Solar System Scope / INOVE，CC BY 4.0：https://creativecommons.org/licenses/by/4.0/
