# 参与开发

使用合成照片与独立数据目录开发，不要使用个人图库作为提交的测试夹具。提交前运行 `npm test`、`npm run build` 和 `cargo test --manifest-path src-tauri/Cargo.toml`。

修改照片删除、导入、备份或相册成员逻辑时，说明对原图、数据库和失败恢复的影响。不要引入截图中的私人信息、绝对用户路径、API key 或提取自未授权网站的代码。

不要将下载缓存（`.local-map-data/`）、构建产物、调试记录、签名证书或个人 `.env` 文件加入 Git。`public/maps/` 内的边界数据随安装包分发，更新它们时必须同步更新 THIRD_PARTY_NOTICES.md 的来源说明。地图资源及第三方资产不能套用项目许可证（PolyForm Noncommercial 1.0.0）。
