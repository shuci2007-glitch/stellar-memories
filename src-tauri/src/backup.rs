use crate::db::Db;
use serde_json::json;
use std::path::Path;

/// 导出备份(元数据 JSON;可选复制原图)
pub fn export_backup(db: &Db, target: &Path, include_photos: bool) -> Result<(), String> {
    let conn = db.0.lock();

    let mut photos = Vec::new();
    let mut q = conn
        .prepare("SELECT id, path, filename, capture_date, date_source, gps_lat, gps_lon, camera, lens, iso, shutter, aperture, focal, starred FROM photos WHERE imported=1")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "path": r.get::<_, String>(1)?,
                "filename": r.get::<_, String>(2)?,
                "captureDate": r.get::<_, Option<String>>(3)?,
                "dateSource": r.get::<_, Option<String>>(4)?,
                "gpsLat": r.get::<_, Option<f64>>(5)?,
                "gpsLon": r.get::<_, Option<f64>>(6)?,
                "camera": r.get::<_, Option<String>>(7)?,
                "lens": r.get::<_, Option<String>>(8)?,
                "iso": r.get::<_, Option<i64>>(9)?,
                "shutter": r.get::<_, Option<String>>(10)?,
                "aperture": r.get::<_, Option<String>>(11)?,
                "focal": r.get::<_, Option<String>>(12)?,
                "starred": r.get::<_, i64>(13)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        photos.push(row.map_err(|e| e.to_string())?);
    }
    drop(q);

    let mut albums = Vec::new();
    let mut q = conn
        .prepare("SELECT id, name, description, cover_photo_id, auto FROM albums")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "name": r.get::<_, String>(1)?,
                "description": r.get::<_, Option<String>>(2)?,
                "coverPhotoId": r.get::<_, Option<i64>>(3)?,
                "auto": r.get::<_, i64>(4)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        albums.push(row.map_err(|e| e.to_string())?);
    }
    drop(q);

    let mut memories = Vec::new();
    let mut q = conn
        .prepare("SELECT photo_id, title, text, location, mood FROM memories")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| {
            Ok(json!({
                "photoId": r.get::<_, i64>(0)?,
                "title": r.get::<_, Option<String>>(1)?,
                "text": r.get::<_, Option<String>>(2)?,
                "location": r.get::<_, Option<String>>(3)?,
                "mood": r.get::<_, Option<String>>(4)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        memories.push(row.map_err(|e| e.to_string())?);
    }
    drop(q);

    let mut conns = Vec::new();
    let mut q = conn
        .prepare("SELECT photo_a, photo_b, kind, strength FROM connections")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| {
            Ok(json!({
                "a": r.get::<_, i64>(0)?,
                "b": r.get::<_, i64>(1)?,
                "kind": r.get::<_, String>(2)?,
                "strength": r.get::<_, f64>(3)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        conns.push(row.map_err(|e| e.to_string())?);
    }
    drop(q);

    let mut album_photos = Vec::new();
    let mut q = conn
        .prepare("SELECT album_id, photo_id FROM album_photos")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| {
            Ok(json!({
                "albumId": r.get::<_, i64>(0)?,
                "photoId": r.get::<_, i64>(1)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        album_photos.push(row.map_err(|e| e.to_string())?);
    }
    drop(q);

    let payload = json!({
        "app": "stellar-memories",
        "formatVersion": 1,
        "exportedAt": chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        "photos": photos,
        "albums": albums,
        "albumPhotos": album_photos,
        "memories": memories,
        "connections": conns,
    });

    std::fs::write(target, serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?)
        .map_err(|e| format!("写备份失败: {e}"))?;

    if include_photos {
        let orig_dir = target.parent().unwrap_or(Path::new(".")).join("StellarBackup_Originals");
        std::fs::create_dir_all(&orig_dir).map_err(|e| e.to_string())?;
        let mut q = conn.prepare("SELECT path FROM photos WHERE imported=1").map_err(|e| e.to_string())?;
        let paths: Vec<String> = q
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .flatten()
            .collect();
        drop(q);
        for p in paths {
            let src = Path::new(&p);
            if let Some(name) = src.file_name() {
                let dst = orig_dir.join(name);
                if !dst.exists() {
                    std::fs::copy(src, &dst).ok();
                }
            }
        }
    }
    Ok(())
}

/// 导入备份(按 path 合并;恢复文字记忆/相册/关系)
pub fn import_backup(db: &Db, source: &Path) -> Result<usize, String> {
    let data = std::fs::read(source).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
    if v["app"].as_str() != Some("stellar-memories") {
        return Err("不是有效的星辰相册备份文件".into());
    }
    restore_memories(db, &v)
}

fn restore_memories(db: &Db, v: &serde_json::Value) -> Result<usize, String> {
    let mut conn=db.0.lock();
    let tx=conn.transaction().map_err(|e|e.to_string())?;
    let mut ids=std::collections::HashMap::new();
    if let Some(photos)=v["photos"].as_array() {
        for photo in photos {
            if let (Some(old),Some(path))=(photo["id"].as_i64(),photo["path"].as_str()) {
                let current=tx.query_row("SELECT id FROM photos WHERE path=?1 COLLATE NOCASE",[path],|r|r.get::<_,i64>(0));
                if let Ok(id)=current { ids.insert(old,id); }
            }
        }
    }
    let mut restored=0;
    if let Some(memories)=v["memories"].as_array() {
        for memory in memories {
            let Some(id)=memory["photoId"].as_i64().and_then(|id|ids.get(&id).copied()) else { continue; };
            tx.execute("INSERT INTO memories(photo_id,title,text,location,mood) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(photo_id) DO UPDATE SET title=excluded.title,text=excluded.text,location=excluded.location,mood=excluded.mood",
                rusqlite::params![id,memory["title"].as_str(),memory["text"].as_str(),memory["location"].as_str(),memory["mood"].as_str()]).map_err(|e|e.to_string())?;
            restored+=1;
        }
    }
    tx.commit().map_err(|e|e.to_string())?;
    Ok(restored)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restoration_uses_photo_path_not_reused_database_ids() {
        let conn=rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE photos(id INTEGER PRIMARY KEY,path TEXT);CREATE TABLE memories(photo_id INTEGER PRIMARY KEY,title TEXT,text TEXT,location TEXT,mood TEXT);INSERT INTO photos VALUES(1,'different.jpg'),(2,'original.jpg');INSERT INTO memories(photo_id,title) VALUES(1,'keep me');").unwrap();
        let db=Db(std::sync::Arc::new(parking_lot::Mutex::new(conn)));
        let data=serde_json::json!({"photos":[{"id":1,"path":"original.jpg"}],"memories":[{"photoId":1,"title":"restored"}]});
        assert_eq!(restore_memories(&db,&data).unwrap(),1);
        let conn=db.0.lock();
        assert_eq!(conn.query_row("SELECT title FROM memories WHERE photo_id=1",[],|r|r.get::<_,String>(0)).unwrap(),"keep me");
        assert_eq!(conn.query_row("SELECT title FROM memories WHERE photo_id=2",[],|r|r.get::<_,String>(0)).unwrap(),"restored");
    }
}
