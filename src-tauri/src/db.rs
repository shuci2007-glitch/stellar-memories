use rusqlite::Connection;
use std::path::Path;
use std::sync::Arc;

#[derive(Clone)]
pub struct Db(pub Arc<parking_lot::Mutex<Connection>>);

pub fn open(app_data: &Path) -> Result<Db, String> {
    std::fs::create_dir_all(app_data).map_err(|e| e.to_string())?;
    let db_path = app_data.join("stellar.db");
    let conn = Connection::open(&db_path).map_err(|e| format!("打开数据库失败: {e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.pragma_update(None, "synchronous", "NORMAL").ok();
    conn.pragma_update(None, "foreign_keys", "ON").ok();
    let conn = migrate(conn)?;
    Ok(Db(Arc::new(parking_lot::Mutex::new(conn))))
}

fn migrate(mut conn: Connection) -> Result<Connection, String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    if version < 1 {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS photos (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                path            TEXT NOT NULL UNIQUE,
                filename        TEXT NOT NULL,
                width           INTEGER NOT NULL DEFAULT 0,
                height          INTEGER NOT NULL DEFAULT 0,
                thumb_path      TEXT,
                particle_path   TEXT,
                avg_color       TEXT,
                score           REAL NOT NULL DEFAULT 0,
                capture_date    TEXT,
                date_source     TEXT,
                gps_lat         REAL,
                gps_lon         REAL,
                camera          TEXT,
                lens            TEXT,
                iso             INTEGER,
                shutter         TEXT,
                aperture        TEXT,
                focal           TEXT,
                starred         INTEGER NOT NULL DEFAULT 0,
                missing         INTEGER NOT NULL DEFAULT 0,
                imported        INTEGER NOT NULL DEFAULT 0,
                created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                updated_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );
            CREATE INDEX IF NOT EXISTS idx_photos_capture ON photos(capture_date);
            CREATE INDEX IF NOT EXISTS idx_photos_imported ON photos(imported);

            CREATE TABLE IF NOT EXISTS albums (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                name            TEXT NOT NULL,
                description     TEXT,
                cover_photo_id  INTEGER,
                auto            INTEGER NOT NULL DEFAULT 0,
                sort_order      REAL NOT NULL DEFAULT 0,
                created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );

            CREATE TABLE IF NOT EXISTS album_photos (
                album_id        INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
                photo_id        INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
                added_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                PRIMARY KEY (album_id, photo_id)
            );

            CREATE TABLE IF NOT EXISTS memories (
                photo_id        INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
                title           TEXT,
                text            TEXT,
                location        TEXT,
                mood            TEXT,
                updated_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );

            CREATE TABLE IF NOT EXISTS tags (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                name    TEXT NOT NULL UNIQUE
            );

            CREATE TABLE IF NOT EXISTS photo_tags (
                photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
                tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY (photo_id, tag_id)
            );

            CREATE TABLE IF NOT EXISTS connections (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                photo_a    INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
                photo_b    INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
                kind       TEXT NOT NULL DEFAULT 'auto',
                strength   REAL NOT NULL DEFAULT 0.5,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                UNIQUE (photo_a, photo_b)
            );
            CREATE INDEX IF NOT EXISTS idx_conn_a ON connections(photo_a);
            CREATE INDEX IF NOT EXISTS idx_conn_b ON connections(photo_b);

            CREATE TABLE IF NOT EXISTS settings (
                key    TEXT PRIMARY KEY,
                value  TEXT
            );

            CREATE TABLE IF NOT EXISTS import_jobs (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                root_path  TEXT NOT NULL,
                total      INTEGER NOT NULL DEFAULT 0,
                done       INTEGER NOT NULL DEFAULT 0,
                skipped    INTEGER NOT NULL DEFAULT 0,
                state      TEXT NOT NULL DEFAULT 'running',
                updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );
            "#,
        )
        .map_err(|e| format!("建表失败: {e}"))?;
        tx.pragma_update(None, "user_version", 1)
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }

    if version < 2 {
        // 多页面(空间)+ 视频 + 延迟处理。全部是加列/建表,老库原地升级。
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        // 重复升级时列已存在,忽略错误即可。
        let _ = tx.execute("ALTER TABLE photos ADD COLUMN kind TEXT NOT NULL DEFAULT 'photo'", []);
        let _ = tx.execute("ALTER TABLE photos ADD COLUMN processed INTEGER NOT NULL DEFAULT 1", []);
        let _ = tx.execute("ALTER TABLE photos ADD COLUMN duration REAL", []);
        tx.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS spaces (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                name               TEXT NOT NULL,
                shape              TEXT NOT NULL DEFAULT 'spiral',
                scope              TEXT NOT NULL DEFAULT 'shared',
                background_photo_id INTEGER,
                sort_order         REAL NOT NULL DEFAULT 0,
                created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE IF NOT EXISTS space_photos (
                space_id   INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
                photo_id   INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
                added_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                PRIMARY KEY (space_id, photo_id)
            );
            CREATE INDEX IF NOT EXISTS idx_space_photos ON space_photos(space_id);
            CREATE INDEX IF NOT EXISTS idx_photos_processed ON photos(processed);
            "#,
        )
        .map_err(|e| format!("建表失败: {e}"))?;
        // 首个页面:共享全部照片,保证升级后打开就是原来那一片星辰。
        let has_space: bool = tx
            .query_row("SELECT EXISTS(SELECT 1 FROM spaces)", [], |r| r.get(0))
            .unwrap_or(false);
        if !has_space {
            tx.execute(
                "INSERT INTO spaces(name, shape, scope, sort_order) VALUES('主星系', 'spiral', 'shared', 0)",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.pragma_update(None, "user_version", 2)
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }

    if version < 3 {
        // 背景照片的两种呈现:plate = 半透明背景板,nebula = 整页粒子星云;strength 是 0-100 的存在感
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let _ = tx.execute(
            "ALTER TABLE spaces ADD COLUMN background_mode TEXT NOT NULL DEFAULT 'plate'",
            [],
        );
        let _ = tx.execute(
            "ALTER TABLE spaces ADD COLUMN background_strength INTEGER NOT NULL DEFAULT 42",
            [],
        );
        tx.pragma_update(None, "user_version", 3)
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }

    if version < 4 {
        // 实况照片:静帧关联其动态视频。加列即可,老库原地升级。
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let _ = tx.execute("ALTER TABLE photos ADD COLUMN live_video_id INTEGER", []);
        tx.pragma_update(None, "user_version", 4)
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }

    if version < 5 {
        // 内置星云背景:存素材 id(carina/orion/...),与 background_photo_id 二选一。
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let _ = tx.execute("ALTER TABLE spaces ADD COLUMN background_asset TEXT", []);
        tx.pragma_update(None, "user_version", 5)
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(conn)
}

pub fn get_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        [key],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}
