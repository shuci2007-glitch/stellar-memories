//! 后台补处理:导入时只处理前 N 张,剩下的在这里按批次慢慢补缩略图与粒子缓存。
//!
//! 目标是削掉「一次导入几千张」时的内存峰值:那时会有几千张全尺寸位图同时驻留。
//! 这里每次只取 4 张,处理完再取下一批,用户随时可以暂停。

use crate::db::Db;
use crate::exif::read_exif;
use crate::particle_cache;
use crate::thumbs;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const BATCH: usize = 4;

pub struct Backfill {
    pub paused: AtomicBool,
    pub running: AtomicBool,
    pub done: AtomicU32,
    pub total: AtomicU32,
}

impl Backfill {
    pub fn new() -> Self {
        Self {
            paused: AtomicBool::new(false),
            running: AtomicBool::new(false),
            done: AtomicU32::new(0),
            total: AtomicU32::new(0),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackfillProgress {
    running: bool,
    paused: bool,
    done: u32,
    total: u32,
}

pub fn pending_count(db: &Db) -> u32 {
    let conn = db.0.lock();
    conn.query_row(
        "SELECT COUNT(*) FROM photos WHERE processed=0 AND imported=1 AND missing=0 AND kind='photo'",
        [],
        |r| r.get::<_, i64>(0),
    )
    .unwrap_or(0) as u32
}

fn emit(app: &AppHandle, bf: &Backfill) {
    let _ = app.emit(
        "backfill-progress",
        BackfillProgress {
            running: bf.running.load(Ordering::SeqCst),
            paused: bf.paused.load(Ordering::SeqCst),
            done: bf.done.load(Ordering::SeqCst),
            total: bf.total.load(Ordering::SeqCst),
        },
    );
}

fn fetch_batch(db: &Db, limit: usize) -> Vec<(i64, String)> {
    let conn = db.0.lock();
    let Ok(mut q) = conn.prepare(
        "SELECT id, path FROM photos
         WHERE processed=0 AND imported=1 AND missing=0 AND kind='photo'
         ORDER BY id LIMIT ?1",
    ) else {
        return Vec::new();
    };
    q.query_map([limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

fn process_one(db: &Db, data_dir: &Path, quality: &str, id: i64, path: &str) {
    let p = PathBuf::from(path);
    let info = read_exif(&p);
    let img = match thumbs::decode_image(&p, info.orientation) {
        Ok(img) => img,
        Err(_) => {
            let conn = db.0.lock();
            conn.execute("UPDATE photos SET missing=1, processed=1 WHERE id=?1", [id]).ok();
            return;
        }
    };
    let thumb_path = data_dir.join("thumbs").join(format!("{id}.jpg"));
    let preview_path = data_dir.join("thumbs").join(format!("{id}_p.jpg"));
    let particle_path = data_dir.join("particles").join(format!("{id}.spc"));
    let tr = match thumbs::generate(&img, &thumb_path, &preview_path) {
        Ok(t) => t,
        Err(_) => {
            let conn = db.0.lock();
            conn.execute("UPDATE photos SET missing=1, processed=1 WHERE id=?1", [id]).ok();
            return;
        }
    };
    let (pcount, _) = particle_cache::generate(&img, id, quality, &particle_path).unwrap_or_default();
    let conn = db.0.lock();
    conn.execute(
        r#"UPDATE photos SET
            width=?1, height=?2, thumb_path=?3, particle_path=?4,
            avg_color=?5, score=?6, capture_date=COALESCE(capture_date, ?7),
            date_source=COALESCE(date_source, ?8), gps_lat=?9, gps_lon=?10,
            camera=?11, lens=?12, iso=?13, shutter=?14, aperture=?15, focal=?16,
            processed=1, updated_at=datetime('now','localtime')
           WHERE id=?17"#,
        rusqlite::params![
            tr.width as i64,
            tr.height as i64,
            thumb_path.to_string_lossy(),
            if pcount > 0 { Some(particle_path.to_string_lossy().to_string()) } else { None },
            tr.avg_color,
            tr.score,
            info.capture_date,
            info.date_source,
            info.gps_lat,
            info.gps_lon,
            info.camera,
            info.lens,
            info.iso,
            info.shutter,
            info.aperture,
            info.focal,
            id
        ],
    )
    .ok();
}

/// 启动后台补处理。已经在跑就什么都不做。
pub fn schedule(app: AppHandle, db: Db, data_dir: PathBuf, quality: String) {
    let bf: Arc<Backfill> = {
        let state = app.state::<crate::AppState>();
        if state.backfill.running.swap(true, Ordering::SeqCst) {
            return;
        }
        state.backfill.clone()
    };
    std::fs::create_dir_all(data_dir.join("thumbs")).ok();
    std::fs::create_dir_all(data_dir.join("particles")).ok();

    bf.done.store(0, Ordering::SeqCst);
    bf.total.store(pending_count(&db), Ordering::SeqCst);
    emit(&app, &bf);

    std::thread::spawn(move || {
        let mut done = 0u32;
        loop {
            if bf.paused.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(600));
                // 暂停期间新增了待处理项也要能继续
                if !bf.running.load(Ordering::SeqCst) {
                    return;
                }
                continue;
            }
            let batch = fetch_batch(&db, BATCH);
            if batch.is_empty() {
                break;
            }
            for (id, path) in batch {
                if bf.paused.load(Ordering::SeqCst) {
                    break;
                }
                process_one(&db, &data_dir, &quality, id, &path);
                done += 1;
                bf.done.store(done, Ordering::SeqCst);
            }
            emit(&app, &bf);
            std::thread::sleep(Duration::from_millis(150));
        }
        bf.running.store(false, Ordering::SeqCst);
        bf.total.store(done, Ordering::SeqCst);
        emit(&app, &bf);
        // 让界面重新取一次缩略图
        let _ = app.emit("library-changed", ());
    });
}
