# 地球边界来源与表达

2026-09-10：修复 Natural Earth 世界边界与 DataV 中国省界叠加时，在藏南等区域出现两套边线的问题。

- `countries.geojson`：原 Natural Earth 世界面数据，保留原文件。
- `china-provinces.geojson`：原 DataV.GeoAtlas 中国省级面数据（含离岸要素），保留原文件。
- `earth-boundaries.geojson`：由 `scripts/build-consistent-earth-boundaries.py` 离线生成。中国范围使用现有中国省级面数据的几何并集；邻国面扣除该范围，替代旧 CHN/TWN 面。地图页与 Three.js 飞行地球使用同一文件。没有手工猜测或移动边界坐标。
- 中国各省、城市标注仍采用原 DataV 层；真实地表、地形、昼夜及照片经纬度不变。

参照资料：
- 自然资源部标准地图服务：https://bzdt.ch.mnr.gov.cn/
- 公开地图内容表示规范（自然资规〔2023〕2号）：https://www.fmprc.gov.cn/web/wjb_673085/zzjg_673183/bjhysws_674671/bhflfg/dtdmxgfl/202303/P020230313585504979937.pdf
- DataV.GeoAtlas：https://datav.aliyun.com/portal/school/atlas/area_generator

## 限制

这是应用已有数据的边界一致性修正，并非自然资源部发布的标准地图成品，不含审图号，也未完成官方全图逐要素审查。世界其他争议地区仍继承 Natural Earth 数据，重要岛屿与海域表达仍受现有 DataV 精度限制。不能据此声称已达到官方标准地图要求或保证视频平台审核通过。用于公开发布的标准地图成品应从标准地图服务取得并保留其审图信息。
