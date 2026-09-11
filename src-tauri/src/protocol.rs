use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, UriSchemeContext, UriSchemeResponder};

fn mime_for(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "tiff" | "tif" => "image/tiff",
        _ => "application/octet-stream",
    }
}

fn respond(body: Vec<u8>, mime: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store")
        .body(body)
        .unwrap()
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header("Access-Control-Allow-Origin", "*")
        .body(Vec::new())
        .unwrap()
}

/// tm:// 协议:tm://localhost/thumb/{id}.jpg · thumb/{id}_p.jpg · particles/{id}.spc · photo/{id}
pub fn handle<R: tauri::Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app: &AppHandle<R> = ctx.app_handle();
    let state = app.state::<crate::AppState>();
    if !crate::auth::is_unlocked(&state.unlocked) {
        responder.respond(Response::builder().status(StatusCode::FORBIDDEN).header("Cache-Control","no-store").body(Vec::new()).unwrap());
        return;
    }
    let data_dir = state.data_dir.clone();

    let uri = request.uri().to_string();
    let raw = uri
        .strip_prefix("tm://localhost/")
        .or_else(|| uri.strip_prefix("tm://"))
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("")
        .to_string();
    let parts: Vec<&str> = raw.split('/').filter(|s| !s.is_empty()).collect();

    if parts.len() != 2 {
        responder.respond(not_found());
        return;
    }
    let (kind, fname) = (parts[0], parts[1]);

    let id_of = |f: &str| -> Option<i64> {
        f.split('.')
            .next()
            .and_then(|s| s.parse::<i64>().ok())
    };

    let result: Option<(Vec<u8>, String)> = match (kind, fname) {
        ("thumb", f) => id_of(f).and_then(|id| {
            let conn = state.db.0.lock();
            let p: Option<String> = conn
                .query_row("SELECT thumb_path FROM photos WHERE id=?1", [id], |r| r.get(0))
                .ok();
            drop(conn);
            p.and_then(|p| std::fs::read(p).ok().map(|b| (b, "image/jpeg".to_string())))
        }),
        ("preview", f) => id_of(f).and_then(|id| {
            let conn = state.db.0.lock();
            let p: Option<String> = conn
                .query_row("SELECT thumb_path FROM photos WHERE id=?1", [id], |r| r.get(0))
                .ok();
            drop(conn);
            let p = p.map(|p| p.replace(".jpg", "_p.jpg"));
            p.and_then(|p| std::fs::read(p).ok().map(|b| (b, "image/jpeg".to_string())))
        }),
        ("particles", f) => id_of(f).and_then(|id| {
            let conn = state.db.0.lock();
            let p: Option<String> = conn
                .query_row("SELECT particle_path FROM photos WHERE id=?1", [id], |r| r.get(0))
                .ok();
            drop(conn);
            p.and_then(|p| {
                std::fs::read(&p)
                    .ok()
                    .map(|b| (b, "application/octet-stream".to_string()))
            })
        }),
        ("photo", f) => id_of(f).and_then(|id| {
            let conn = state.db.0.lock();
            let p: Option<String> = conn
                .query_row("SELECT path FROM photos WHERE id=?1", [id], |r| r.get(0))
                .ok();
            drop(conn);
            p.and_then(|p| {
                let mime = mime_for(std::path::Path::new(&p));
                std::fs::read(&p).ok().map(|b| (b, mime.to_string()))
            })
        }),
        _ => None,
    };

    // 兜底:找不到文件时也从 data_dir 推断缩略图路径
    let result = result.or_else(|| {
        match (kind, id_of(fname)) {
            ("thumb", Some(id)) => std::fs::read(data_dir.join("thumbs").join(format!("{id}.jpg")))
                .ok()
                .map(|b| (b, "image/jpeg".to_string())),
            ("preview", Some(id)) => std::fs::read(
                data_dir.join("thumbs").join(format!("{id}_p.jpg")),
            )
            .ok()
            .map(|b| (b, "image/jpeg".to_string())),
            ("particles", Some(id)) => std::fs::read(
                data_dir.join("particles").join(format!("{id}.spc")),
            )
            .ok()
            .map(|b| (b, "application/octet-stream".to_string())),
            _ => None,
        }
    });

    match result {
        Some((body, mime)) => responder.respond(respond(body, &mime)),
        None => responder.respond(not_found()),
    }
}
