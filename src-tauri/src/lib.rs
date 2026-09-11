mod auth;
mod backup;
mod db;
mod exif;
mod import;
mod models;
mod particle_cache;
mod protocol;
mod thumbs;

use db::Db;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

pub struct AppState {
    pub db: Db,
    pub data_dir: PathBuf,
    pub unlocked: Arc<AtomicBool>,
    pub import_cancel: Arc<Mutex<Option<Arc<import::ImportControl>>>>,
}

// ---------- 窗口控制 ----------

#[tauri::command]
fn win_minimize(window: tauri::Window) {
    window.minimize().ok();
}

#[tauri::command]
fn win_toggle_maximize(window: tauri::Window) {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().ok();
    } else {
        window.maximize().ok();
    }
}

#[tauri::command]
fn win_close(window: tauri::Window) {
    window.close().ok();
}

fn require_unlocked(state: &AppState) -> Result<(),String> { if auth::is_unlocked(&state.unlocked) { Ok(()) } else { Err("请先解锁相册".into()) } }

// ---------- 认证 ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthState {
    has_password: bool,
    passwordless: bool,
    unlocked: bool,
}

#[tauri::command]
fn auth_state(state: State<AppState>) -> AuthState {
    AuthState {
        has_password: auth::has_password(&state.db),
        passwordless: auth::passwordless(&state.db),
        unlocked: auth::is_unlocked(&state.unlocked),
    }
}

#[tauri::command]
fn set_password(state: State<AppState>, password: String) -> Result<(), String> {
    if (auth::has_password(&state.db)||auth::passwordless(&state.db)) && !auth::is_unlocked(&state.unlocked) { return Err("请先解锁相册".into()); }
    auth::set_password(&state.db, &password)?;
    state.unlocked.store(true,Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn set_passwordless(state: State<AppState>) -> Result<(), String> {
    if !auth::is_unlocked(&state.unlocked) { return Err("请先解锁相册".into()); }
    auth::set_passwordless(&state.db)
}

#[tauri::command]
fn change_password(state: State<AppState>, old: String, new: String) -> Result<(), String> {
    require_unlocked(&state)?;
    auth::change_password(&state.db, &old, &new)
}

#[tauri::command]
fn verify_password(state: State<AppState>, password: String) -> bool {
    auth::verify_and_unlock(&state.db, &state.unlocked, &password)
}

#[tauri::command]
fn lock_app(state: State<AppState>) {
    auth::lock(&state.unlocked);
    // 等待进行中的数据库操作完成(获取一次锁后立即释放)。
    drop(state.db.0.lock());
}

// ---------- 设置 ----------

#[tauri::command]
fn get_setting(state: State<AppState>, key: String) -> Option<String> {
    if key.starts_with("password_") { return None; }
    if !auth::is_unlocked(&state.unlocked) && !(matches!(key.as_str(),"particle_tier"|"perf_mode"|"auto_lock"|"map_photo_routes_enabled") || key.starts_with("photo_particle_") || key.starts_with("photo_sphere_")) { return None; }
    let conn = state.db.0.lock();
    db::get_setting(&conn, &key)
}

#[tauri::command]
fn set_setting(state: State<AppState>, key: String, value: String) -> Result<(), String> {
    require_unlocked(&state)?;
    if key.starts_with("password_") || key.starts_with("album_galaxy_") || key.starts_with("province_wall_") { return Err("此设置必须使用专用接口".into()); }
    if key.len()>128 || value.len()>4096 { return Err("设置值过长".into()); }
    state.db.0.lock().execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",rusqlite::params![key,value]).map_err(|e|e.to_string())?;
    Ok(())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProvinceWallNotes {
    wall_text: String,
    photo_notes: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    photo_positions: std::collections::BTreeMap<String, [f64; 2]>,
    #[serde(default)]
    photo_scales: std::collections::BTreeMap<String, f64>,
}

#[tauri::command]
fn save_province_wall(state: State<AppState>, province: String, notes: ProvinceWallNotes) -> Result<(), String> {
    if !state.unlocked.load(Ordering::SeqCst) { return Err("请先解锁相册".into()); }
    if province.trim().is_empty() || province.len() > 200 { return Err("省级行政区名称无效".into()); }
    if notes.wall_text.len() > 300_000 || notes.photo_notes.len() > 100_000 || notes.photo_notes.iter().any(|(id, text)| id.parse::<i64>().map_or(true, |id| id <= 0) || text.len() > 100_000) {
        return Err("手记过长或照片编号无效".into());
    }
    // These coordinates describe placement on the wall, never photo GPS metadata.
    if notes.photo_positions.len()>100_000 || notes.photo_positions.iter().any(|(id,p)| id.parse::<i64>().map_or(true,|id|id<=0) || p.iter().any(|v|!v.is_finite()) || p[0].abs()>180. || p[1].abs()>90.) {
        return Err("照片墙摆放位置无效".into());
    }
    if notes.photo_scales.len()>100_000 || notes.photo_scales.iter().any(|(id,scale)| id.parse::<i64>().map_or(true,|id|id<=0) || !scale.is_finite() || *scale<0.65 || *scale>2.4) {
        return Err("照片墙尺寸无效".into());
    }
    let json = serde_json::to_string(&notes).map_err(|e| e.to_string())?;
    let conn = state.db.0.lock();
    conn.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![format!("province_wall_{province}"), json]).map_err(|e| format!("手记保存失败: {e}"))?;
    Ok(())
}

// ---------- 导入 ----------

#[tauri::command]
fn import_photos(
    app: AppHandle,
    state: State<AppState>,
    paths: Vec<String>,
    album_name: Option<String>,
) -> Result<i64, String> {
    require_unlocked(&state)?;
    let quality = {
        let conn = state.db.0.lock();
        db::get_setting(&conn, "particle_tier").unwrap_or_else(|| "medium".into())
    };
    let control = Arc::new(import::ImportControl {
        cancel: AtomicBool::new(false),
    });
    *state.import_cancel.lock() = Some(control.clone());
    import::start_import(
        app,
        state.db.clone(),
        state.data_dir.clone(),
        paths,
        control,
        album_name,
        quality,
    )
}

#[tauri::command]
fn cancel_import(state: State<AppState>) {
    if !auth::is_unlocked(&state.unlocked) { return; }
    if let Some(c) = state.import_cancel.lock().as_ref() {
        c.cancel.store(true, Ordering::Relaxed);
    }
}

// ---------- 照片 ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PhotoFull {
    photo: models::Photo,
    memory: models::Memory,
}

fn row_to_photo(r: &rusqlite::Row) -> rusqlite::Result<models::Photo> {
    Ok(models::Photo {
        id: r.get(0)?,
        path: r.get(1)?,
        filename: r.get(2)?,
        width: r.get(3)?,
        height: r.get(4)?,
        thumb_path: r.get(5)?,
        particle_path: r.get(6)?,
        avg_color: r.get(7)?,
        score: r.get(8)?,
        capture_date: r.get(9)?,
        date_source: r.get(10)?,
        gps_lat: r.get(11)?,
        gps_lon: r.get(12)?,
        camera: r.get(13)?,
        lens: r.get(14)?,
        iso: r.get(15)?,
        shutter: r.get(16)?,
        aperture: r.get(17)?,
        focal: r.get(18)?,
        starred: r.get::<_, i64>(19)? != 0,
        missing: r.get::<_, i64>(20)? != 0,
        imported: r.get::<_, i64>(21)? != 0,
        created_at: r.get(22)?,
        updated_at: r.get(23)?,
    })
}

const PHOTO_COLS: &str = "id, path, filename, width, height, thumb_path, particle_path, avg_color, score, capture_date, date_source, gps_lat, gps_lon, camera, lens, iso, shutter, aperture, focal, starred, missing, imported, created_at, updated_at";

#[tauri::command]
fn list_photos(state: State<AppState>, album_id: Option<i64>) -> Result<Vec<models::Photo>, String> {
    require_unlocked(&state)?;
    let conn = state.db.0.lock();
    let mut photos = Vec::new();
    if let Some(aid) = album_id {
        let mut q = conn
            .prepare(&format!(
                "SELECT {PHOTO_COLS} FROM photos p JOIN album_photos ap ON ap.photo_id = p.id
                 WHERE ap.album_id = ?1 AND p.imported = 1 AND p.missing = 0 ORDER BY p.capture_date, p.id"
            ))
            .map_err(|e| e.to_string())?;
        let rows = q.query_map([aid], row_to_photo).map_err(|e| e.to_string())?;
        for row in rows {
            photos.push(row.map_err(|e| e.to_string())?);
        }
    } else {
        let mut q = conn
            .prepare(&format!(
                "SELECT {PHOTO_COLS} FROM photos WHERE imported = 1 AND missing = 0 ORDER BY capture_date, id"
            ))
            .map_err(|e| e.to_string())?;
        let rows = q.query_map([], row_to_photo).map_err(|e| e.to_string())?;
        for row in rows {
            photos.push(row.map_err(|e| e.to_string())?);
        }
    }
    Ok(photos)
}

#[tauri::command]
fn get_photo_full(state: State<AppState>, id: i64) -> Result<PhotoFull, String> {
    require_unlocked(&state)?;
    let conn = state.db.0.lock();
    let photo = conn
        .query_row(
            &format!("SELECT {PHOTO_COLS} FROM photos WHERE id = ?1"),
            [id],
            row_to_photo,
        )
        .map_err(|e| format!("照片不存在: {e}"))?;
    let memory = conn
        .query_row(
            "SELECT photo_id, title, text, location, mood, updated_at FROM memories WHERE photo_id = ?1",
            [id],
            |r| {
                Ok(models::Memory {
                    photo_id: r.get(0)?,
                    title: r.get(1)?,
                    text: r.get(2)?,
                    location: r.get(3)?,
                    mood: r.get(4)?,
                    updated_at: r.get(5)?,
                })
            },
        )
        .unwrap_or(models::Memory {
            photo_id: id,
            title: None,
            text: None,
            location: None,
            mood: None,
            updated_at: String::new(),
        });
    Ok(PhotoFull { photo, memory })
}

#[tauri::command]
fn save_memory(
    state: State<AppState>,
    photo_id: i64,
    title: Option<String>,
    text: Option<String>,
    location: Option<String>,
    mood: Option<String>,
) -> Result<(), String> {
    require_unlocked(&state)?;
    let conn = state.db.0.lock();
    conn.execute(
        "INSERT INTO memories(photo_id, title, text, location, mood, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, datetime('now','localtime'))
         ON CONFLICT(photo_id) DO UPDATE SET title=?2, text=?3, location=?4, mood=?5,
           updated_at=datetime('now','localtime')",
        rusqlite::params![photo_id, title, text, location, mood],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn toggle_star(state: State<AppState>, id: i64, starred: bool) -> Result<(), String> {
    require_unlocked(&state)?;
    let conn = state.db.0.lock();
    conn.execute(
        "UPDATE photos SET starred = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
        rusqlite::params![starred as i64, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}


#[tauri::command]
fn set_photo_location(state: State<AppState>, id: i64, latitude: Option<f64>, longitude: Option<f64>) -> Result<(), String> {
    require_unlocked(&state)?;
    match (latitude, longitude) {
      (Some(lat), Some(lon)) if lat.is_finite() && lon.is_finite() && lat.abs() <= 90.0 && lon.abs() <= 180.0 => {},
      (None, None) => {},
      _ => return Err("坐标超出有效范围".into()),
    }
    let conn = state.db.0.lock();
    conn.execute("UPDATE photos SET gps_lat=?1, gps_lon=?2, updated_at=datetime('now','localtime') WHERE id=?3", rusqlite::params![latitude, longitude, id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_photo_date(state: State<AppState>, id: i64, date: String) -> Result<(), String> {
    require_unlocked(&state)?;
    if chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").is_err() {
        return Err("日期格式应为 YYYY-MM-DD".into());
    }
    let conn = state.db.0.lock();
    conn.execute(
        "UPDATE photos SET capture_date = ?1 || ' 00:00:00', date_source = 'user',
         updated_at = datetime('now','localtime') WHERE id = ?2",
        rusqlite::params![date, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 仅移除软件内记录；原图、预览及粒子缓存均不做文件操作。
#[tauri::command]
fn delete_photo(state: State<AppState>, id: i64) -> Result<(), String> {
    if !state.unlocked.load(Ordering::SeqCst) { return Err("请先解锁相册".into()); }
    let mut conn = state.db.0.lock();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // Display IDs and custom positions live in settings, outside the foreign-key
    // cascade. Remove only this deleted photo from its albums' saved layouts.
    let layouts: Vec<(String, String)> = {
        let mut query = tx.prepare("SELECT key,value FROM settings WHERE key IN (SELECT 'album_galaxy_' || album_id FROM album_photos WHERE photo_id=?1)").map_err(|e| e.to_string())?;
        let rows = query.query_map([id], |r| Ok((r.get(0)?,r.get(1)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<_,_>>().map_err(|e| e.to_string())?
    };
    for (key,json) in layouts {
        if let Ok(mut config) = serde_json::from_str::<AlbumGalaxyConfig>(&json) {
            if let Some(ids) = &mut config.photo_ids { ids.retain(|photo_id| *photo_id != id); }
            if let Some(positions) = &mut config.positions { positions.remove(&id.to_string()); }
            let value = serde_json::to_string(&config).map_err(|e| e.to_string())?;
            tx.execute("UPDATE settings SET value=?1 WHERE key=?2",rusqlite::params![value,key]).map_err(|e| e.to_string())?;
        }
    }
    tx.execute("DELETE FROM photos WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    // 相册保留，只为受影响的封面选择仍存在的照片；关联记录由外键级联移除。
    tx.execute("UPDATE albums SET cover_photo_id=(SELECT p.id FROM album_photos ap JOIN photos p ON p.id=ap.photo_id WHERE ap.album_id=albums.id AND p.imported=1 AND p.missing=0 ORDER BY p.score DESC,p.id LIMIT 1) WHERE cover_photo_id=?1", [id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
fn rescan_missing(state: State<AppState>) -> Result<u32, String> {
    require_unlocked(&state)?;
    let conn = state.db.0.lock();
    let rows: Vec<(i64, String)> = conn
        .prepare("SELECT id, path FROM photos WHERE imported=1 AND missing=0")
        .map_err(|e| e.to_string())?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    let mut missing: u32 = 0;
    for (id, path) in rows {
        if !Path::new(&path).exists() {
            conn.execute("UPDATE photos SET missing=1 WHERE id=?1", [id])
                .map_err(|e| e.to_string())?;
            missing += 1;
        }
    }
    Ok(missing)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    photo_count: i64,
    album_count: i64,
    memory_count: i64,
}

#[tauri::command]
fn get_stats(state: State<AppState>) -> Result<Stats,String> {
    require_unlocked(&state)?;
    let conn = state.db.0.lock();
    Ok(Stats {
        photo_count: conn
            .query_row("SELECT COUNT(*) FROM photos WHERE imported=1 AND missing=0", [], |r| r.get(0))
            .unwrap_or(0),
        album_count: conn
            .query_row("SELECT COUNT(*) FROM albums", [], |r| r.get(0))
            .unwrap_or(0),
        memory_count: conn
            .query_row("SELECT COUNT(*) FROM memories WHERE title IS NOT NULL OR text IS NOT NULL", [], |r| r.get(0))
            .unwrap_or(0),
    })
}

// ---------- 时间轴 ----------

#[derive(Serialize, Deserialize)]
struct TimelineItem {
    id: i64,
    date: Option<String>,
    starred: bool,
    avg_color: Option<String>,
}

#[tauri::command]
fn get_timeline(state: State<AppState>) -> Result<Vec<TimelineItem>, String> {
    require_unlocked(&state)?;
    let conn = state.db.0.lock();
    let mut q = conn
        .prepare("SELECT id, capture_date, starred, avg_color FROM photos WHERE imported=1 AND missing=0 ORDER BY capture_date")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| {
            Ok(TimelineItem {
                id: r.get(0)?,
                date: r.get(1)?,
                starred: r.get::<_, i64>(2)? != 0,
                avg_color: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

// ---------- 搜索 ----------

#[tauri::command]
fn search_photos(state: State<AppState>, query: String) -> Result<Vec<models::Photo>, String> {
    require_unlocked(&state)?;
    let conn = state.db.0.lock();
    let query = query.trim();
    if query.is_empty() { return Ok(Vec::new()); }
    let escaped = query.replace('!', "!!").replace('%', "!%").replace('_', "!_");
    let like = format!("%{escaped}%");
    let date_like = format!("%{}%", escaped.replace(['/', '.'], "-"));
    let columns = PHOTO_COLS.split(',').map(|c| format!("p.{}", c.trim())).collect::<Vec<_>>().join(", ");
    let sql = format!(
        "SELECT DISTINCT {columns} FROM photos p
         LEFT JOIN memories m ON m.photo_id = p.id
         LEFT JOIN album_photos ap ON ap.photo_id = p.id
         LEFT JOIN albums al ON al.id = ap.album_id
         WHERE p.imported = 1 AND p.missing = 0 AND (
           p.filename LIKE ?1 ESCAPE '!' OR p.capture_date LIKE ?2 ESCAPE '!'
           OR m.title LIKE ?1 ESCAPE '!' OR m.text LIKE ?1 ESCAPE '!'
           OR m.location LIKE ?1 ESCAPE '!' OR m.mood LIKE ?1 ESCAPE '!'
           OR al.name LIKE ?1 ESCAPE '!'
         ) ORDER BY p.capture_date DESC, p.id DESC LIMIT 200"
    );
    let mut q = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = q.query_map(rusqlite::params![like, date_like], row_to_photo).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

// ---------- 相册 ----------

#[tauri::command]
fn list_albums(state: State<AppState>) -> Result<Vec<models::Album>, String> {
    require_unlocked(&state)?;
    let conn = state.db.0.lock();
    let mut q = conn
        .prepare(
            "SELECT a.id, a.name, a.description, a.cover_photo_id, a.auto, a.sort_order, a.created_at,
                    (SELECT COUNT(*) FROM album_photos ap JOIN photos p ON p.id=ap.photo_id WHERE ap.album_id = a.id AND p.imported=1 AND p.missing=0) AS cnt,
                    (SELECT GROUP_CONCAT(ap.photo_id) FROM album_photos ap JOIN photos p ON p.id=ap.photo_id WHERE ap.album_id = a.id AND p.imported=1 AND p.missing=0),
                    (SELECT value FROM settings WHERE key = 'album_galaxy_' || a.id)
             FROM albums a ORDER BY a.auto, a.sort_order DESC, a.name",
        )
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| {
            // SELECT 列序:id,name,description,cover_photo_id,auto,sort_order,created_at,cnt
            // 此前 photo_count/created_at 索引错位,行映射全部失败,flatten() 静默丢弃,
            // 导致相册永远读不到(相册架空、时间轴却有照片)。
            Ok(models::Album {
                galaxy_config: r.get(9)?,
                photo_ids: r.get::<_, Option<String>>(8)?.unwrap_or_default().split(',').filter_map(|v| v.parse().ok()).collect(),
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                cover_photo_id: r.get(3)?,
                auto: r.get::<_, i64>(4)? != 0,
                sort_order: r.get(5)?,
                created_at: r.get(6)?,
                photo_count: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

#[tauri::command]
fn create_album(state: State<AppState>, name: String, photo_ids: Vec<i64>) -> Result<i64, String> {
    require_unlocked(&state)?;
    let name = name.trim();
    if name.is_empty() { return Err("请输入星系名称".into()); }
    let ids: std::collections::BTreeSet<i64> = photo_ids.into_iter().collect();
    if ids.is_empty() { return Err("请至少选择一张照片".into()); }
    let mut conn = state.db.0.lock();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for id in &ids {
        let valid: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM photos WHERE id=?1 AND imported=1 AND missing=0)", [id], |r| r.get(0)).map_err(|e| e.to_string())?;
        if !valid { return Err("所选照片已不可用，请重新选择".into()); }
    }
    tx.execute("INSERT INTO albums(name, auto, cover_photo_id) VALUES(?1, 0, ?2)", rusqlite::params![name, ids.first()]).map_err(|e| e.to_string())?;
    let album_id = tx.last_insert_rowid();
    for id in ids {
        tx.execute("INSERT INTO album_photos(album_id, photo_id) VALUES(?1, ?2)", rusqlite::params![album_id, id]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(album_id)
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AlbumGalaxyConfig {
    photo_ids: Option<Vec<i64>>,
    positions: Option<std::collections::BTreeMap<String, [f64; 3]>>,
}

#[tauri::command]
fn save_album_galaxy(state: State<AppState>, id: i64, name: String, config: AlbumGalaxyConfig, add_photo_ids: Option<Vec<i64>>, remove_photo_ids: Option<Vec<i64>>) -> Result<(), String> {
    if !state.unlocked.load(Ordering::SeqCst) { return Err("请先解锁相册".into()); }
    if name.trim().is_empty() { return Err("请输入星系名称".into()); }
    let mut conn = state.db.0.lock();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM albums WHERE id=?1)",[id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !exists { return Err("相册不存在".into()); }
    // Membership additions and display/layout edits commit together. Cancelling
    // the editor or failing validation never leaves a partly changed album.
    let additions: std::collections::BTreeSet<i64> = add_photo_ids.unwrap_or_default().into_iter().collect();
    for photo_id in &additions {
        let available: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM photos WHERE id=?1 AND imported=1 AND missing=0)",[photo_id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !available { return Err("所选照片已不可用，请重新打开编辑器选择".into()); }
        tx.execute("INSERT OR IGNORE INTO album_photos(album_id,photo_id) VALUES(?1,?2)",rusqlite::params![id,photo_id]).map_err(|e|e.to_string())?;
    }
    for photo_id in remove_photo_ids.unwrap_or_default().into_iter().collect::<std::collections::BTreeSet<_>>() {
        if additions.contains(&photo_id) { return Err("同一张照片不能同时加入和移除".into()); }
        // Only this album relationship is removed; photo records and files stay intact.
        tx.execute("DELETE FROM album_photos WHERE album_id=?1 AND photo_id=?2",rusqlite::params![id,photo_id]).map_err(|e|e.to_string())?;
    }
    let valid = |photo_id: i64| -> Result<bool, String> {
        tx.query_row("SELECT EXISTS(SELECT 1 FROM album_photos ap JOIN photos p ON p.id=ap.photo_id WHERE ap.album_id=?1 AND ap.photo_id=?2 AND p.imported=1 AND p.missing=0)", rusqlite::params![id, photo_id], |r| r.get(0)).map_err(|e| e.to_string())
    };
    if let Some(ids) = &config.photo_ids {
        for photo_id in ids { if !valid(*photo_id)? { return Err("照片不属于此相册".into()); } }
    }
    if let Some(positions) = &config.positions {
        for (key, position) in positions {
            let photo_id = key.parse::<i64>().map_err(|_| "照片编号无效".to_string())?;
            if !valid(photo_id)? || position.iter().any(|v| !v.is_finite() || v.abs() > 30.) { return Err("星座位置无效".into()); }
        }
    }
    if tx.execute("UPDATE albums SET name=?1 WHERE id=?2", rusqlite::params![name.trim(), id]).map_err(|e| e.to_string())? != 1 { return Err("相册不存在".into()); }
    tx.execute("UPDATE albums SET cover_photo_id=(SELECT p.id FROM album_photos ap JOIN photos p ON p.id=ap.photo_id WHERE ap.album_id=?1 AND p.imported=1 AND p.missing=0 ORDER BY p.score DESC,p.id LIMIT 1) WHERE id=?1 AND (cover_photo_id IS NULL OR NOT EXISTS(SELECT 1 FROM album_photos ap WHERE ap.album_id=?1 AND ap.photo_id=albums.cover_photo_id))",[id]).map_err(|e|e.to_string())?;
    let json = serde_json::to_string(&config).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", rusqlite::params![format!("album_galaxy_{id}"), json]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn rename_album(state: State<AppState>, id: i64, name: String) -> Result<(), String> {
    require_unlocked(&state)?;
    let conn = state.db.0.lock();
    conn.execute("UPDATE albums SET name = ?1 WHERE id = ?2", rusqlite::params![name, id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_album_description(state: State<AppState>, id: i64, description: String) -> Result<(), String> {
    require_unlocked(&state)?;
    let conn = state.db.0.lock();
    conn.execute(
        "UPDATE albums SET description = ?1 WHERE id = ?2",
        rusqlite::params![description, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_album(state: State<AppState>, id: i64) -> Result<(), String> {
    require_unlocked(&state)?;
    let conn = state.db.0.lock();
    conn.execute("DELETE FROM albums WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_album_cover(state: State<AppState>, id: i64, photo_id: i64) -> Result<(), String> {
    require_unlocked(&state)?;
    let conn = state.db.0.lock();
    conn.execute(
        "UPDATE albums SET cover_photo_id = ?1 WHERE id = ?2",
        rusqlite::params![photo_id, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- 关系 ----------

#[derive(Serialize)]
struct ConnItem {
    a: i64,
    b: i64,
    strength: f64,
    kind: String,
}

#[tauri::command]
fn get_connections(state: State<AppState>) -> Result<Vec<ConnItem>, String> {
    require_unlocked(&state)?;
    let conn = state.db.0.lock();
    let mut q = conn
        .prepare(
            "SELECT c.photo_a, c.photo_b, c.strength, c.kind FROM connections c
             JOIN photos pa ON pa.id = c.photo_a AND pa.imported=1 AND pa.missing=0
             JOIN photos pb ON pb.id = c.photo_b AND pb.imported=1 AND pb.missing=0",
        )
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| {
            Ok(ConnItem {
                a: r.get(0)?,
                b: r.get(1)?,
                strength: r.get(2)?,
                kind: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

#[tauri::command]
fn add_connection(state: State<AppState>, a: i64, b: i64) -> Result<(), String> {
    require_unlocked(&state)?;
    if a == b {
        return Ok(());
    }
    let (a, b) = if a < b { (a, b) } else { (b, a) };
    let conn = state.db.0.lock();
    conn.execute(
        "INSERT INTO connections(photo_a, photo_b, kind, strength) VALUES(?1, ?2, 'manual', 1.0)
         ON CONFLICT(photo_a, photo_b) DO UPDATE SET kind='manual', strength=1.0",
        rusqlite::params![a, b],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn remove_connection(state: State<AppState>, a: i64, b: i64) -> Result<(), String> {
    require_unlocked(&state)?;
    let (a, b) = if a < b { (a, b) } else { (b, a) };
    let conn = state.db.0.lock();
    conn.execute(
        "DELETE FROM connections WHERE photo_a = ?1 AND photo_b = ?2",
        rusqlite::params![a, b],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- 银河数据 ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GalaxyPhoto {
    id: i64,
    album_id: Option<i64>,
    avg_color: Option<String>,
    capture_date: Option<String>,
    starred: bool,
    title: Option<String>,
    width: i64,
    height: i64,
}

#[tauri::command]
fn get_galaxy_data(state: State<AppState>) -> Result<Vec<GalaxyPhoto>, String> {
    require_unlocked(&state)?;
    let conn = state.db.0.lock();
    let mut q = conn
        .prepare(
            "SELECT p.id, ap.album_id, p.avg_color, p.capture_date, p.starred, m.title, p.width, p.height
             FROM photos p
             LEFT JOIN album_photos ap ON ap.photo_id = p.id
             LEFT JOIN memories m ON m.photo_id = p.id
             WHERE p.imported = 1 AND p.missing = 0
             ORDER BY p.id,
                      CASE WHEN ap.album_id IS NULL THEN 1 ELSE 0 END,
                      (SELECT a.auto FROM albums a WHERE a.id = ap.album_id)",
        )
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| {
            Ok(GalaxyPhoto {
                id: r.get(0)?,
                album_id: r.get(1)?,
                avg_color: r.get(2)?,
                capture_date: r.get(3)?,
                starred: r.get::<_, i64>(4)? != 0,
                title: r.get(5)?,
                width: r.get(6)?,
                height: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    // 一张照片属于多个相册(自动月相册 + 专属相册)时只保留一条:
    // 专属相册优先(查询已按 auto 升序),避免节点重复成 STAR。
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for item in rows.flatten() {
        if seen.insert(item.id) {
            out.push(item);
        }
    }
    Ok(out)
}

// ---------- 备份 ----------

#[tauri::command]
fn export_backup_cmd(
    state: State<AppState>,
    target: String,
    include_photos: bool,
) -> Result<(), String> {
    require_unlocked(&state)?;
    backup::export_backup(&state.db, PathBuf::from(target).as_path(), include_photos)
}

#[tauri::command]
fn import_backup_cmd(state: State<AppState>, source: String) -> Result<usize, String> {
    require_unlocked(&state)?;
    backup::import_backup(&state.db, PathBuf::from(source).as_path())
}

// ---------- 入口 ----------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .register_asynchronous_uri_scheme_protocol("tm", protocol::handle)
        .setup(|app| {
            // 隔离测试环境:仅 debug 构建允许用环境变量重定向数据目录,不触碰真实用户图库
            #[cfg(debug_assertions)]
            let data_dir = match std::env::var("STELLAR_DATA_DIR") {
                Ok(dir) if !dir.trim().is_empty() => std::path::PathBuf::from(dir),
                _ => app.path().app_data_dir().expect("无法获取应用数据目录"),
            };
            #[cfg(not(debug_assertions))]
            let data_dir = app.path().app_data_dir().expect("无法获取应用数据目录");
            std::fs::create_dir_all(data_dir.join("thumbs")).ok();
            std::fs::create_dir_all(data_dir.join("particles")).ok();
            let database = db::open(&data_dir).expect("数据库初始化失败");
            let unlocked_flag = Arc::new(AtomicBool::new(false));
            app.manage(AppState {
                db: database,
                data_dir,
                unlocked: unlocked_flag,
                import_cancel: Arc::new(Mutex::new(None)),
            });
            // 诊断:STELLAR_WEBVIEW_DEVTOOLS=1 时打开 WebView 控制台(仅 debug 构建)
            #[cfg(debug_assertions)]
            if std::env::var("STELLAR_WEBVIEW_DEVTOOLS").as_deref() == Ok("1") {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("main") {
                    w.open_devtools();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            win_minimize, win_toggle_maximize, win_close,
            auth_state, set_password, set_passwordless, change_password, verify_password, lock_app,
            get_setting, set_setting, save_province_wall,
            import_photos, cancel_import,
            list_photos, get_photo_full, save_memory, toggle_star, set_photo_date, set_photo_location,
            delete_photo, rescan_missing, get_stats,
            get_timeline, search_photos,
            list_albums, save_album_galaxy, create_album, rename_album, set_album_description, delete_album, set_album_cover,
            get_connections, add_connection, remove_connection,
            get_galaxy_data,
            export_backup_cmd, import_backup_cmd,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[allow(dead_code)]
fn _keep_imports(_: &models::Photo) {}
