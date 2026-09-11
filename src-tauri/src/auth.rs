use crate::db::{self, Db};
use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;

/// OWASP 推荐参数:Argon2id, m=19MiB, t=2, p=1
fn hash_password(pwd: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(pwd.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

fn verify(pwd: &str, phc: &str) -> bool {
    PasswordHash::new(phc)
        .map(|parsed| Argon2::default().verify_password(pwd.as_bytes(), &parsed).is_ok())
        .unwrap_or(false)
}

pub fn has_password(db: &Db) -> bool {
    let conn = db.0.lock();
    db::get_setting(&conn, "password_mode").as_deref()!=Some("none") && db::get_setting(&conn, "password_hash").is_some()
}

pub fn passwordless(db: &Db) -> bool {
    db::get_setting(&db.0.lock(), "password_mode").as_deref()==Some("none")
}

pub fn set_passwordless(db: &Db) -> Result<(), String> {
    // Keep the rest of the settings and the album data intact. Only the explicit
    // unlock mode changes; an old verifier is inactive while this mode is set.
    db.0.lock().execute("INSERT INTO settings(key,value) VALUES('password_mode','none') ON CONFLICT(key) DO UPDATE SET value=excluded.value",[]).map_err(|e|e.to_string())?;
    Ok(())
}

pub fn set_password(db: &Db, pwd: &str) -> Result<(), String> {
    if pwd.len() < 4 {
        return Err("密码至少 4 位".into());
    }
    let h = hash_password(pwd)?;
    let mut conn = db.0.lock();
    let tx=conn.transaction().map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO settings(key,value) VALUES('password_hash',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[h]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO settings(key,value) VALUES('password_mode','required') ON CONFLICT(key) DO UPDATE SET value=excluded.value",[]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())
}

pub fn change_password(db: &Db, old: &str, new: &str) -> Result<(), String> {
    {
        let conn = db.0.lock();
        let Some(h) = db::get_setting(&conn, "password_hash") else {
            return Err("未设置密码".into());
        };
        if !verify(old, &h) {
            return Err("原密码不正确".into());
        }
    }
    set_password(db, new)
}

pub fn verify_and_unlock(db: &Db, unlocked: &std::sync::atomic::AtomicBool, pwd: &str) -> bool {
    let (h,no_password) = {
        let conn = db.0.lock();
        (db::get_setting(&conn, "password_hash"),db::get_setting(&conn, "password_mode").as_deref()==Some("none"))
    };
    // A click in password-free mode still unlocks the backend session. A fresh
    // installation is distinct: it must first finish the existing setup flow.
    let ok = no_password || h.as_ref().is_some_and(|h|verify(pwd,h));
    if ok {
        unlocked.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    ok
}

pub fn lock(unlocked: &std::sync::atomic::AtomicBool) {
    unlocked.store(false, std::sync::atomic::Ordering::SeqCst);
}

pub fn is_unlocked(unlocked: &std::sync::atomic::AtomicBool) -> bool {
    unlocked.load(std::sync::atomic::Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc,atomic::AtomicBool};
    fn database() -> Db {
        let conn=rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)").unwrap();
        Db(Arc::new(parking_lot::Mutex::new(conn)))
    }
    #[test]
    fn password_modes_and_lock_are_enforced() {
        let db=database();let unlocked=AtomicBool::new(false);
        assert!(!verify_and_unlock(&db,&unlocked,""));
        set_password(&db,"test-only-password").unwrap();
        assert!(!verify_and_unlock(&db,&unlocked,"incorrect"));
        assert!(verify_and_unlock(&db,&unlocked,"test-only-password"));
        lock(&unlocked);assert!(!is_unlocked(&unlocked));
        set_passwordless(&db).unwrap();assert!(!has_password(&db));
        assert!(verify_and_unlock(&db,&unlocked,""));
        set_password(&db,"replacement-password").unwrap();lock(&unlocked);
        assert!(!passwordless(&db));assert!(!verify_and_unlock(&db,&unlocked,""));
        assert!(!verify_and_unlock(&db,&unlocked,"test-only-password"));
        assert!(verify_and_unlock(&db,&unlocked,"replacement-password"));
    }
}
