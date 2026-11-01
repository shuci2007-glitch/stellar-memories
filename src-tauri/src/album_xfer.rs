use crate::db::Db;
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const MANIFEST_VERSION: u32 = 1;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub folder: String,
    pub photo_count: usize,
    pub skipped: usize,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub album_id: i64,
    pub name: String,
    pub photo_count: usize,
    pub memory_count: usize,
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim()
        .to_string()
}

/// 导出单个相册为自包含文件夹:
/// `<target>/<相册名>_相册_<时间戳>/manifest.json` + `photos/`(原图副本)。
/// 缩略图与粒子缓存不打包——导入时由官方管线自动重新生成,以减小体积。
pub fn export_album(
    db: &Db,
    album_id: i64,
    target: &Path,
) -> Result<ExportResult, String> {
    let conn = db.0.lock();

    let (name, description, cover): (String, Option<String>, Option<i64>) = conn
        .query_row(
            "SELECT name, description, cover_photo_id FROM albums WHERE id=?1 AND auto=0",
            [album_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| "相册不存在或不可导出".to_string())?;

    // 相册星系布局(存在 settings 里,可为 null)
    let galaxy_config: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [format!("album_galaxy_{album_id}")],
            |r| r.get(0),
        )
        .ok();

    // 本相册的照片 id
    let mut photo_ids: Vec<i64> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT photo_id FROM album_photos WHERE album_id=?1")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query([album_id]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            if let Ok(id) = row.get::<_, i64>(0) {
                photo_ids.push(id);
            }
        }
    }

    let mut photos_json: Vec<serde_json::Value> = Vec::new();
    let mut skipped = 0usize;

    for pid in photo_ids {
        // 照片元数据
        let row = conn.query_row(
            "SELECT p.path, p.filename, p.capture_date, p.date_source, p.gps_lat, p.gps_lon,
                    p.camera, p.lens, p.iso, p.shutter, p.aperture, p.focal, p.starred, p.kind
             FROM photos p WHERE p.id=?1",
            [pid],
            |r| Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<f64>>(4)?,
                r.get::<_, Option<f64>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, Option<i64>>(8)?,
                r.get::<_, Option<String>>(9)?,
                r.get::<_, Option<String>>(10)?,
                r.get::<_, Option<String>>(11)?,
                r.get::<_, i64>(12)?,
                r.get::<_, Option<String>>(13)?.unwrap_or_else(|| "photo".into()),
            )),
        );
        let Ok((path, filename, cap, ds, lat, lon, cam, lens, iso, shut, ap, foc, starred, kind)) =
            row
        else {
            skipped += 1;
            continue;
        };
        let src = PathBuf::from(&path);
        if !src.exists() {
            skipped += 1;
            continue;
        }

        // 导出文件名: <id>.<ext>,避免原名冲突
        let ext = Path::new(&filename)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let export_file = if ext.is_empty() {
            format!("{pid}")
        } else {
            format!("{pid}.{ext}")
        };

        let memory: Option<serde_json::Value> = conn
            .query_row(
                "SELECT title, text, location, mood FROM memories WHERE photo_id=?1",
                [pid],
                |r| {
                    Ok(json!({
                        "title": r.get::<_, Option<String>>(0)?,
                        "text": r.get::<_, Option<String>>(1)?,
                        "location": r.get::<_, Option<String>>(2)?,
                        "mood": r.get::<_, Option<String>>(3)?,
                    }))
                },
            )
            .ok();

        let entry = json!({
            "id": pid,
            "file": export_file,
            "filename": filename,
            "captureDate": cap,
            "dateSource": ds,
            "gpsLat": lat,
            "gpsLon": lon,
            "camera": cam,
            "lens": lens,
            "iso": iso,
            "shutter": shut,
            "aperture": ap,
            "focal": foc,
            "starred": starred,
            "kind": kind,
            "memory": memory,
        });

        // 复制原图;失败则该照片从导出清单剔除
        let dst = target.join("photos").join(&export_file);
        if std::fs::copy(&src, &dst).is_err() {
            skipped += 1;
            continue;
        }
        photos_json.push(entry);
    }

    drop(conn);

    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let folder = target.join(format!("{}_相册_{}", sanitize(&name), ts));
    std::fs::create_dir_all(&folder).map_err(|e| format!("无法创建导出文件夹: {e}"))?;
    std::fs::create_dir_all(folder.join("photos")).map_err(|e| format!("无法创建照片目录: {e}"))?;

    let manifest = json!({
        "app": "stellar-memories",
        "kind": "album",
        "formatVersion": MANIFEST_VERSION,
        "exportedAt": chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        "album": {
            "name": name,
            "description": description,
            "coverPhotoId": cover,
            "galaxyConfig": galaxy_config,
        },
        "photoCount": photos_json.len(),
        "photos": photos_json,
    });

    std::fs::write(
        folder.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("写入清单失败: {e}"))?;

    Ok(ExportResult {
        folder: folder.to_string_lossy().to_string(),
        photo_count: photos_json.len(),
        skipped,
        name,
    })
}

/// 导入单个相册导出包(文件夹含 manifest.json,或直接选 manifest.json)。
/// 复用官方导入管线建立相册与缩略图/粒子,再按路径把旧 id 重映射为新 id,
/// 恢复文字记忆、封面与星系布局。
pub fn import_album(
    app: tauri::AppHandle,
    db: &Db,
    data_dir: &Path,
    source: &Path,
    quality: String,
) -> Result<ImportResult, String> {
    // 解析 manifest 与导出文件夹
    let (manifest_path, export_folder): (PathBuf, PathBuf) = {
        let p = source.to_path_buf();
        if p.is_dir() {
            (p.join("manifest.json"), p)
        } else if p
            .file_name()
            .map(|f| f == "manifest.json")
            .unwrap_or(false)
        {
            let parent = p.parent().unwrap_or(&p).to_path_buf();
            (p, parent)
        } else {
            return Err("请选择导出的相册文件夹或 manifest.json 文件".into());
        }
    };
    if !manifest_path.exists() {
        return Err("所选位置没有 manifest.json,不是有效的相册导出包".into());
    }

    let data = std::fs::read(&manifest_path).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
    if v["app"].as_str() != Some("stellar-memories") || v["kind"].as_str() != Some("album") {
        return Err("不是有效的星辰相册导出包".into());
    }
    let album_name = v["album"]["name"].as_str().unwrap_or("导入的相册").to_string();
    let description = v["album"]["description"].as_str().map(|s| s.to_string());
    let old_cover = v["album"]["coverPhotoId"].as_i64();
    let galaxy_config = v["album"]["galaxyConfig"].as_str().map(|s| s.to_string());

    // 收集导出照片完整路径,建立 旧id -> 导出文件路径
    let photos_dir = export_folder.join("photos");
    let mut paths: Vec<String> = Vec::new();
    let mut old_to_file: HashMap<i64, String> = HashMap::new();
    if let Some(arr) = v["photos"].as_array() {
        for ph in arr {
            if let (Some(id), Some(file)) = (ph["id"].as_i64(), ph["file"].as_str()) {
                let full = photos_dir.join(file);
                if full.exists() {
                    paths.push(full.to_string_lossy().to_string());
                    old_to_file.insert(id, full.to_string_lossy().to_string());
                }
            }
        }
    }
    if paths.is_empty() {
        return Err("导出包中没有可导入的照片文件".into());
    }

    // 同步导入(复用官方管线:建相册 + 缩略图 + 粒子 + 关系)
    crate::import::import_album_paths(
        app,
        db.clone(),
        data_dir.to_path_buf(),
        paths.clone(),
        Some(album_name.clone()),
        quality,
    )
    .map_err(|e| format!("导入照片失败: {e}"))?;

    // 找到刚建立的同名相册
    let conn = db.0.lock();
    let album_id: i64 = conn
        .query_row(
            "SELECT id FROM albums WHERE name=?1 AND auto=0 ORDER BY id DESC LIMIT 1",
            [&album_name],
            |r| r.get(0),
        )
        .map_err(|_| "导入后找不到相册".to_string())?;

    // 旧 id -> 新 id(按导出文件路径匹配)
    let mut old_to_new: HashMap<i64, i64> = HashMap::new();
    for (old, path) in &old_to_file {
        if let Ok(new_id) = conn.query_row(
            "SELECT id FROM photos WHERE path=?1 COLLATE NOCASE",
            [path],
            |r| r.get(0),
        ) {
            old_to_new.insert(*old, new_id);
        }
    }

    // 恢复元数据 + 记忆
    let mut memory_count = 0usize;
    if let Some(arr) = v["photos"].as_array() {
        for ph in arr {
            let old = match ph["id"].as_i64() {
                Some(x) => x,
                None => continue,
            };
            let new_id = match old_to_new.get(&old) {
                Some(x) => *x,
                None => continue,
            };
            conn.execute(
                "UPDATE photos SET capture_date=?1, date_source=?2, gps_lat=?3, gps_lon=?4,
                        camera=?5, lens=?6, iso=?7, shutter=?8, aperture=?9, focal=?10, starred=?11
                 WHERE id=?12",
                rusqlite::params![
                    ph["captureDate"].as_str(),
                    ph["dateSource"].as_str(),
                    ph["gpsLat"].as_f64(),
                    ph["gpsLon"].as_f64(),
                    ph["camera"].as_str(),
                    ph["lens"].as_str(),
                    ph["iso"].as_i64(),
                    ph["shutter"].as_str(),
                    ph["aperture"].as_str(),
                    ph["focal"].as_str(),
                    ph["starred"].as_i64().unwrap_or(0),
                    new_id
                ],
            )
            .ok();
            if let Some(m) = ph["memory"].as_object() {
                let has = m.get("title").and_then(|x| x.as_str()).is_some()
                    || m.get("text").and_then(|x| x.as_str()).is_some()
                    || m.get("location").and_then(|x| x.as_str()).is_some()
                    || m.get("mood").and_then(|x| x.as_str()).is_some();
                if has {
                    conn.execute(
                        "INSERT INTO memories(photo_id, title, text, location, mood)
                         VALUES(?1,?2,?3,?4,?5)
                         ON CONFLICT(photo_id) DO UPDATE SET title=?2, text=?3, location=?4, mood=?5",
                        rusqlite::params![
                            new_id,
                            m.get("title").and_then(|x| x.as_str()),
                            m.get("text").and_then(|x| x.as_str()),
                            m.get("location").and_then(|x| x.as_str()),
                            m.get("mood").and_then(|x| x.as_str())
                        ],
                    )
                    .ok();
                    memory_count += 1;
                }
            }
        }
    }

    // 描述
    if let Some(d) = &description {
        conn.execute("UPDATE albums SET description=?1 WHERE id=?2", rusqlite::params![d, album_id])
            .ok();
    }
    // 封面(remap 旧 id -> 新 id)
    if let Some(old_c) = old_cover {
        if let Some(new_c) = old_to_new.get(&old_c) {
            conn.execute(
                "UPDATE albums SET cover_photo_id=?1 WHERE id=?2
                 AND (cover_photo_id IS NULL
                      OR NOT EXISTS(SELECT 1 FROM photos p2 WHERE p2.id=albums.cover_photo_id))",
                rusqlite::params![new_c, album_id],
            )
            .ok();
        }
    }
    // 星系布局(remap photoIds 数组与 positions 键)
    if let Some(gc) = &galaxy_config {
        if let Ok(mut cfg) = serde_json::from_str::<serde_json::Value>(gc) {
            if let Some(obj) = cfg.as_object_mut() {
                if let Some(ids) = obj.get_mut("photoIds").and_then(|x| x.as_array_mut()) {
                    *ids = ids
                        .iter()
                        .filter_map(|idv| {
                            idv.as_i64()
                                .and_then(|oid| old_to_new.get(&oid))
                                .map(|n| json!(n))
                        })
                        .collect();
                }
                if let Some(pos) = obj.get_mut("positions").and_then(|x| x.as_object_mut()) {
                    let mut new_pos = serde_json::Map::new();
                    for (k, val) in pos.iter() {
                        if let Ok(oid) = k.parse::<i64>() {
                            if let Some(n) = old_to_new.get(&oid) {
                                new_pos.insert(n.to_string(), val.clone());
                            }
                        }
                    }
                    *pos = new_pos;
                }
            }
            let key = format!("album_galaxy_{album_id}");
            if let Ok(json_str) = serde_json::to_string(&cfg) {
                conn.execute(
                    "INSERT INTO settings(key,value) VALUES(?1,?2)
                     ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    rusqlite::params![key, json_str],
                )
                .ok();
            }
        }
    }

    drop(conn);
    Ok(ImportResult {
        album_id,
        name: album_name,
        photo_count: old_to_new.len(),
        memory_count,
    })
}
