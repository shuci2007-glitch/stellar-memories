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
        if thumbs::is_supported(root) {
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
        } else if thumbs::is_supported(&p) {
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
    _album_name: Option<String>,
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
    {
        let conn = db.0.lock();
        for f in &files {
            if f.unsupported {
                *skipped_unsupported.lock() += 1;
                continue;
            }
            let exists: bool = conn
                .query_row("SELECT 1 FROM photos WHERE path = ?1", [&f.path], |_| Ok(true))
                .unwrap_or(false);
            if exists {
                // 若上次中断(imported=0)则复用该行
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
            if conn
                .execute(
                    "INSERT INTO photos(path, filename) VALUES(?1, ?2)",
                    rusqlite::params![f.path, filename],
                )
                .is_ok()
            {
                pending.push(Pending { id: conn.last_insert_rowid(), path: f.path.clone() });
            }
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
                let img = match thumbs::load_oriented(&path, info.orientation) {
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
                ORDER BY p.score DESC LIMIT 1
            ) WHERE cover_photo_id IS NULL"#,
            [],
        )
        .ok();
    }

    build_auto_connections(&db, &new_ids);

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
