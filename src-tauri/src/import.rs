use crate::db::Db;
use chrono::Datelike;
use crate::exif::read_exif;
use crate::particle_cache;
use crate::thumbs;
use parking_lot::Mutex;
use rayon::prelude::*;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub job_id: i64,
    pub phase: String,      // scanning | metadata | thumbnails | particles | relations | done
    pub done: u32,
    pub total: u32,
    pub skipped: u32,
    pub current: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanFile {
    pub path: String,
    pub unsupported: bool,
}

pub struct ImportControl {
    pub cancel: AtomicBool,
}

fn collect_files(root: &Path, out: &mut Vec<ScanFile>) {
    // 单文件直接入队(支持拖入单张照片)
    if root.is_file() {
        if thumbs::is_supported(root) || thumbs::is_video(root) || thumbs::heic_accepted(root) {
            out.push(ScanFile { path: root.to_string_lossy().into_owned(), unsupported: false });
        } else if thumbs::is_known_unsupported(root) {
            out.push(ScanFile { path: root.to_string_lossy().into_owned(), unsupported: true });
        }
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            collect_files(&p, out);
        } else if thumbs::is_supported(&p) || thumbs::is_video(&p) || thumbs::heic_accepted(&p) {
            out.push(ScanFile { path: p.to_string_lossy().into_owned(), unsupported: false });
        } else if thumbs::is_known_unsupported(&p) {
            out.push(ScanFile { path: p.to_string_lossy().into_owned(), unsupported: true });
        }
    }
}

/// 启动导入(后台线程)。重复导入相同 root 时自动跳过已导入文件(断点续传)。
pub fn start_import(
    app: AppHandle,
    db: Db,
    data_dir: PathBuf,
    paths: Vec<String>,
    control: Arc<ImportControl>,
    album_name: Option<String>,
    quality: String,
) -> Result<i64, String> {
    // 创建 job
    let job_id = {
        let conn = db.0.lock();
        conn.execute(
            "INSERT INTO import_jobs(root_path, state) VALUES(?1, 'running')",
            [paths.join("|")],
        )
        .map_err(|e| e.to_string())?;
        conn.last_insert_rowid()
    };

    std::thread::spawn(move || {
        let _ = run_import(app, db, data_dir, paths, control, job_id, album_name, quality);
    });
    Ok(job_id)
}

fn emit_progress(app: &AppHandle, p: &ImportProgress) {
    let _ = app.emit("import-progress", p);
}

fn run_import(
    app: AppHandle,
    db: Db,
    data_dir: PathBuf,
    roots: Vec<String>,
    control: Arc<ImportControl>,
    job_id: i64,
    album_name: Option<String>,
    quality: String,
) -> Result<(), String> {
    // 1. 扫描
    let mut files: Vec<ScanFile> = Vec::new();
    let skipped_unsupported = Arc::new(Mutex::new(0u32));
    for root in &roots {
        collect_files(Path::new(root), &mut files);
    }
    let total = files.len() as u32;

    {
        let conn = db.0.lock();
        conn.execute(
            "UPDATE import_jobs SET total = ?1 WHERE id = ?2",
            rusqlite::params![total, job_id],
        )
        .ok();
    }
    emit_progress(&app, &ImportProgress {
        job_id, phase: "scanning".into(), done: 0, total, skipped: 0, current: String::new(),
    });

    // 2. 预插入占位行(重复路径跳过 → 断点续传)
    struct Pending {
        id: i64,
        path: String,
    }
    let mut pending: Vec<Pending> = Vec::new();
    // 本次导入里落库的视频(含实况照片的动态片段),用于后面的实况配对。
    let mut video_ids: Vec<i64> = Vec::new();
    {
        let conn = db.0.lock();
        for f in &files {
            if f.unsupported {
                *skipped_unsupported.lock() += 1;
                continue;
            }
            let path = Path::new(&f.path);
            let is_video = thumbs::is_video(path);
            let exists: bool = conn
                .query_row("SELECT 1 FROM photos WHERE path = ?1", [&f.path], |_| Ok(true))
                .unwrap_or(false);
            if exists {
                // 若上次中断(imported=0)则复用该行
                if is_video {
                    continue;
                }
                let incomplete: Option<i64> = conn
                    .query_row(
                        "SELECT id FROM photos WHERE path = ?1 AND imported = 0",
                        [&f.path],
                        |r| r.get(0),
                    )
                    .ok();
                if let Some(id) = incomplete {
                    pending.push(Pending { id, path: f.path.clone() });
                }
                continue;
            }
            let filename = Path::new(&f.path)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let kind = if is_video { "video" } else { "photo" };
            if conn
                .execute(
                    "INSERT INTO photos(path, filename, kind, processed) VALUES(?1, ?2, ?3, 0)",
                    rusqlite::params![f.path, filename, kind],
                )
                .is_ok()
            {
                let id = conn.last_insert_rowid();
                if is_video {
                    // 视频不解码:入库即可见,封面由前端截帧回写。
                    video_ids.push(id);
                    let date = std::fs::metadata(&f.path)
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .map(|t| {
                            let dt: chrono::DateTime<chrono::Local> = t.into();
                            dt.format("%Y-%m-%d %H:%M:%S").to_string()
                        });
                    conn.execute(
                        "UPDATE photos SET imported=1, processed=0, capture_date=?1, date_source='file' WHERE id=?2",
                        rusqlite::params![date, id],
                    )
                    .ok();
                } else {
                    pending.push(Pending { id, path: f.path.clone() });
                }
            }
        }
    }

    // 分批:只把前 N 张做完整预处理(EXIF + 缩略图 + 粒子),其余先入库占位,
    // 由后台按空闲节奏补处理,避免一次导入几千张时内存爆掉。
    let limit: usize = {
        let conn = db.0.lock();
        crate::db::get_setting(&conn, "import_batch_limit")
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(40)
    };
    let head_len = limit.min(pending.len());
    let tail: Vec<Pending> = pending.split_off(head_len);
    if !tail.is_empty() {
        let conn = db.0.lock();
        for item in &tail {
            conn.execute(
                "UPDATE photos SET imported=1, processed=0 WHERE id=?1",
                [item.id],
            )
            .ok();
        }
    }

    // 3. 并行处理(EXIF + 缩略图 + 粒子缓存)
    let thumbs_dir = data_dir.join("thumbs");
    let particles_dir = data_dir.join("particles");
    std::fs::create_dir_all(&thumbs_dir).ok();
    std::fs::create_dir_all(&particles_dir).ok();

    let total_pending = pending.len() as u32;
    let done = Arc::new(Mutex::new(0u32));
    let skipped_err = Arc::new(Mutex::new(0u32));
    let new_ids: Arc<Mutex<Vec<i64>>> = Arc::new(Mutex::new(Vec::new()));
    let db_for_workers = db.clone();
    let app2 = app.clone();
    let quality2 = quality.clone();
    let control2 = control.clone();

    let items: Vec<Pending> = pending;

    items
        .into_par_iter()
            .map(|item| {
                if control2.cancel.load(Ordering::Relaxed) {
                    return; // 未处理项保持 imported=0,下次导入自动续传
                }
                let path = PathBuf::from(&item.path);
                let info = read_exif(&path);
                let img = match thumbs::decode_image(&path, info.orientation) {
                    Ok(i) => i,
                    Err(_) => {
                        *skipped_err.lock() += 1;
                        let conn = db_for_workers.0.lock();
                        conn.execute(
                            "UPDATE photos SET missing = 1, imported = 1 WHERE id = ?1",
                            [item.id],
                        )
                        .ok();
                        return;
                    }
                };
                let thumb_path = thumbs_dir.join(format!("{}.jpg", item.id));
                let preview_path = thumbs_dir.join(format!("{}_p.jpg", item.id));
                let particle_path = particles_dir.join(format!("{}.spc", item.id));

                let tr = match thumbs::generate(&img, &thumb_path, &preview_path) {
                    Ok(t) => t,
                    Err(_) => {
                        *skipped_err.lock() += 1;
                        let conn = db_for_workers.0.lock();
                        conn.execute(
                            "UPDATE photos SET missing = 1, imported = 1 WHERE id = ?1",
                            [item.id],
                        )
                        .ok();
                        return;
                    }
                };
                let (pcount, _ptier) =
                    particle_cache::generate(&img, item.id, &quality2, &particle_path).unwrap_or_default();

                let (w, h) = (tr.width as i64, tr.height as i64);
                let conn = db_for_workers.0.lock();
                conn.execute(
                    r#"UPDATE photos SET
                        width=?1, height=?2, thumb_path=?3, particle_path=?4,
                        avg_color=?5, score=?6, capture_date=?7, date_source=?8,
                        gps_lat=?9, gps_lon=?10, camera=?11, lens=?12, iso=?13,
                        shutter=?14, aperture=?15, focal=?16, imported=1,
                        updated_at=datetime('now','localtime')
                       WHERE id=?17"#,
                    rusqlite::params![
                        w, h,
                        thumb_path.to_string_lossy(),
                        if pcount > 0 { Some(particle_path.to_string_lossy().to_string()) } else { None },
                        tr.avg_color, tr.score,
                        info.capture_date, info.date_source,
                        info.gps_lat, info.gps_lon,
                        info.camera, info.lens, info.iso,
                        info.shutter, info.aperture, info.focal,
                        item.id
                    ],
                )
                .ok();
                drop(conn);
                new_ids.lock().push(item.id);

                let mut d = done.lock();
                *d += 1;
                let dd = *d;
                drop(d);
                if dd % 5 == 0 || dd == total_pending {
                    emit_progress(&app2, &ImportProgress {
                        job_id,
                        phase: "processing".into(),
                        done: dd,
                        total: total_pending,
                        skipped: *skipped_unsupported.lock() + *skipped_err.lock(),
                        current: Path::new(&item.path)
                            .file_name()
                            .map(|s| s.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                    });
                }
            })
            .collect::<Vec<()>>();

    if control.cancel.load(Ordering::Relaxed) {
        let conn = db.0.lock();
        conn.execute(
            "UPDATE import_jobs SET state='canceled', done=?1, skipped=?2, updated_at=datetime('now','localtime') WHERE id=?3",
            rusqlite::params![*done.lock(), *skipped_unsupported.lock() + *skipped_err.lock(), job_id],
        )
        .ok();
        emit_progress(&app, &ImportProgress {
            job_id, phase: "canceled".into(), done: *done.lock(), total: total_pending,
            skipped: *skipped_unsupported.lock() + *skipped_err.lock(), current: String::new(),
        });
        return Ok(());
    }

    // 4. 文件夹星系 + 关系
    let new_ids = std::mem::take(&mut *new_ids.lock());
    emit_progress(&app, &ImportProgress {
        job_id, phase: "relations".into(), done: total_pending, total: total_pending,
        skipped: *skipped_unsupported.lock() + *skipped_err.lock(), current: String::new(),
    });

    {
        let conn = db.0.lock();
        // 仅目录导入建立星系；单张/多张照片导入只加入时间轴。
        // 按完整目录路径匹配本次扫描，已导入照片也复用原记录。
        for root in roots.iter().filter(|root| Path::new(root).is_dir()) {
            let ids: Vec<i64> = files.iter().filter(|f| !f.unsupported && Path::new(&f.path).starts_with(Path::new(root)))
                .filter_map(|f| conn.query_row("SELECT id FROM photos WHERE path=?1 AND imported=1 AND missing=0", [&f.path], |r| r.get(0)).ok()).collect();
            if ids.is_empty() { continue; }
            let name = Path::new(root).file_name().map(|v| v.to_string_lossy().into_owned()).unwrap_or_else(|| root.clone());
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO albums(name, auto) VALUES(?1, 0)", [&name]).map_err(|e| e.to_string())?;
            let album_id = tx.last_insert_rowid();
            for id in ids {
                tx.execute("INSERT OR IGNORE INTO album_photos(album_id, photo_id) VALUES(?1, ?2)", rusqlite::params![album_id, id]).map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;
        }
        // 更新相册封面(最高分照片)
        conn.execute(
            r#"UPDATE albums SET cover_photo_id = (
                SELECT ap.photo_id FROM album_photos ap
                JOIN photos p ON p.id = ap.photo_id
                WHERE ap.album_id = albums.id AND p.imported = 1
                  AND p.id NOT IN (SELECT live_video_id FROM photos WHERE live_video_id IS NOT NULL)
                ORDER BY p.score DESC LIMIT 1
            ) WHERE cover_photo_id IS NULL"#,
            [],
        )
        .ok();
        // 指定了相册名(手机上传):同名的相册直接并入,避免每次上传多出一个空星系。
        // 按批投递而不是按目录,所以不会触发上面「一个文件夹一个星系」的逻辑。
        if let Some(name) = album_name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            if !new_ids.is_empty() {
                let existing: Option<i64> = conn
                    .query_row("SELECT id FROM albums WHERE name=?1 AND auto=0 ORDER BY id LIMIT 1", [name], |r| r.get(0))
                    .ok();
                let album_id = match existing {
                    Some(id) => id,
                    None => {
                        conn.execute("INSERT INTO albums(name, auto) VALUES(?1, 0)", [name]).map_err(|e| e.to_string())?;
                        conn.last_insert_rowid()
                    }
                };
                for id in &new_ids {
                    conn.execute("INSERT OR IGNORE INTO album_photos(album_id, photo_id) VALUES(?1, ?2)", rusqlite::params![album_id, id]).ok();
                }
                conn.execute(
                    "UPDATE albums SET cover_photo_id=(SELECT p.id FROM album_photos ap JOIN photos p ON p.id=ap.photo_id WHERE ap.album_id=?1 AND p.imported=1 AND p.missing=0 AND p.id NOT IN (SELECT live_video_id FROM photos WHERE live_video_id IS NOT NULL) ORDER BY p.score DESC,p.id LIMIT 1) WHERE id=?1 AND (cover_photo_id IS NULL OR NOT EXISTS(SELECT 1 FROM photos p2 JOIN album_photos ap2 ON ap2.photo_id=p2.id WHERE ap2.album_id=?1 AND p2.id=albums.cover_photo_id))",
                    [album_id],
                ).ok();
            }
        }
    }

    build_auto_connections(&db, &new_ids);

    // 实况照片配对:静帧(photo)+ 同主名的动态(mov/video) → 在静帧上可播放。
    // 只在同一批导入涉及的「主名」范围内做,避免全库扫描,也避免误配同名普通视频。
    pair_live_photos(&db, &new_ids, &video_ids);

    // 导入结束立刻把剩下的交给后台慢慢补,用户在别的页面时它也在跑。
    crate::backfill::schedule(app.clone(), db.clone(), data_dir.clone(), quality.clone());

    let conn = db.0.lock();
    conn.execute(
        "UPDATE import_jobs SET state='done', done=?1, skipped=?2, updated_at=datetime('now','localtime') WHERE id=?3",
        rusqlite::params![total_pending, *skipped_unsupported.lock() + *skipped_err.lock(), job_id],
    )
    .ok();
    drop(conn);
    emit_progress(&app, &ImportProgress {
        job_id, phase: "done".into(), done: total_pending, total: total_pending,
        skipped: *skipped_unsupported.lock() + *skipped_err.lock(), current: String::new(),
    });
    Ok(())
}

/// 同步导入一组文件路径并归入指定相册名。
/// 复用与 UI 导入完全相同的管线(含缩略图、粒子、关系),只是同步阻塞直到完成,
/// 供「单个相册导入」在一条命令内完成导入 + 重映射。
pub fn import_album_paths(
    app: AppHandle,
    db: Db,
    data_dir: PathBuf,
    paths: Vec<String>,
    album_name: Option<String>,
    quality: String,
) -> Result<(), String> {
    let job_id = {
        let conn = db.0.lock();
        conn.execute(
            "INSERT INTO import_jobs(root_path, state) VALUES(?1, 'running')",
            [paths.join("|")],
        )
        .map_err(|e| e.to_string())?;
        conn.last_insert_rowid()
    };
    let control = Arc::new(ImportControl {
        cancel: AtomicBool::new(false),
    });
    run_import(app, db, data_dir, paths, control, job_id, album_name, quality)
}

/// 自动关系:同日 1.0 / ±2 日 0.6 / 同月 0.3;同相册 +0.2;每节点最多 6 条。
pub fn build_auto_connections(db: &Db, photo_ids: &[i64]) {
    let conn = db.0.lock();
    let date_of = |id: i64| -> Option<String> {
        conn.query_row(
            "SELECT capture_date FROM photos WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap_or(None)
    };
    for &id in photo_ids {
        let Some(ref d0) = date_of(id) else { continue };
        let Ok(dt0) = chrono::NaiveDate::parse_from_str(&d0[0..10.min(d0.len())], "%Y-%m-%d") else { continue };

        // 候选:有日期的相邻照片(时间接近)+ 同相册
        let mut cands: Vec<(i64, f64)> = Vec::new();
        let mut q = conn
            .prepare(
                "SELECT id, capture_date FROM photos
                 WHERE id != ?1 AND imported = 1 AND capture_date IS NOT NULL
                 ORDER BY ABS(julianday(capture_date) - julianday(?2)) LIMIT 24",
            )
            .unwrap();
        let rows = q
            .query_map(rusqlite::params![id, d0], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .unwrap();
        for row in rows.flatten() {
            let (other, d1) = row;
            let Ok(dt1) = chrono::NaiveDate::parse_from_str(&d1[0..10.min(d1.len())], "%Y-%m-%d")
            else { continue };
            let days = (dt1 - dt0).num_days().abs();
            let s = if days == 0 {
                1.0
            } else if days <= 2 {
                0.6
            } else if days <= 31 && dt1.year() == dt0.year() && dt1.month() == dt0.month() {
                0.3
            } else {
                continue;
            };
            cands.push((other, s));
        }
        // 同相册加分
        let albums: Vec<i64> = {
            let mut q = conn
                .prepare("SELECT album_id FROM album_photos WHERE photo_id=?1")
                .unwrap();
            q.query_map([id], |r| r.get(0))
                .unwrap()
                .flatten()
                .collect()
        };
        if !albums.is_empty() {
            for (other, s) in cands.iter_mut() {
                    let shared: bool = {
                        let o = *other;
                        let mut q = conn
                            .prepare(
                                "SELECT 1 FROM album_photos WHERE photo_id=?1 AND album_id IN (SELECT album_id FROM album_photos WHERE photo_id=?2) LIMIT 1",
                            )
                            .unwrap();
                        q.query_row(rusqlite::params![o, id], |_| Ok(true)).unwrap_or(false)
                    };
                if shared {
                    *s = (*s + 0.2).min(1.2);
                }
            }
        }
        cands.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        cands.truncate(6);

        for (other, s) in cands {
            let (a, b) = if id < other { (id, other) } else { (other, id) };
            conn.execute(
                "INSERT INTO connections(photo_a, photo_b, kind, strength) VALUES(?1, ?2, 'auto', ?3)
                 ON CONFLICT(photo_a, photo_b) DO UPDATE SET
                   strength = CASE WHEN connections.kind='manual' THEN connections.strength
                                   ELSE MAX(connections.strength, excluded.strength) END",
                rusqlite::params![a, b, s],
            )
            .ok();
        }
    }
}

/// 主名(扩展名之前的部分,忽略大小写)。实况照片 = 静帧 `IMG_1234.JPG` + 动态 `IMG_1234.MOV`,
/// 二者主名相同,靠它把两张记录绑成「一张可播放的实况」。
fn stem_of(filename: &str) -> String {
    let lower = filename.to_ascii_lowercase();
    match lower.rfind('.') {
        Some(i) if i > 0 => lower[..i].to_string(),
        _ => lower,
    }
}

/// 实况照片配对:把同主名的静帧(photo)指向其动态(mov/video)。
/// 只在本批导入涉及的主名范围内匹配,既避免全库扫描,也避免误把同名普通视频配成实况。
/// 跨批次也能生效:例如这次只传了 .mov,而静帧是上次导入的,只要主名一致就会配对上。
fn pair_live_photos(db: &Db, photo_ids: &[i64], video_ids: &[i64]) {
    if photo_ids.is_empty() && video_ids.is_empty() {
        return;
    }
    let conn = db.0.lock();
    let mut stems: Vec<String> = Vec::new();
    for id in photo_ids.iter().chain(video_ids.iter()) {
        if let Ok(name) = conn.query_row("SELECT filename FROM photos WHERE id=?1", [id], |r| r.get::<_, String>(0)) {
            let s = stem_of(&name);
            if !stems.contains(&s) {
                stems.push(s);
            }
        }
    }
    if stems.is_empty() {
        return;
    }
    let mut q = match conn.prepare(
        "SELECT id, filename, kind FROM photos
         WHERE (kind='photo' AND live_video_id IS NULL) OR kind='video'",
    ) {
        Ok(q) => q,
        Err(_) => return,
    };
    let rows = match q.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))) {
        Ok(r) => r,
        Err(_) => return,
    };
    let mut stills: Vec<(i64, String)> = Vec::new();
    let mut vids: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    for row in rows.flatten() {
        let (id, filename, kind) = row;
        let stem = stem_of(&filename);
        if !stems.contains(&stem) {
            continue;
        }
        if kind == "video" {
            vids.entry(stem).or_insert(id); // 同主名取第一个视频作为动态片段
        } else {
            stills.push((id, stem));
        }
    }
    drop(q);
    for (sid, stem) in stills {
        if let Some(&vid) = vids.get(&stem) {
            if vid != sid {
                conn.execute("UPDATE photos SET live_video_id=?1 WHERE id=?2", [vid, sid]).ok();
            }
        }
    }
}
