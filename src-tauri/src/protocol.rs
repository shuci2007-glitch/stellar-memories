use std::path::Path;
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
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
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

/// 照片还没做缩略图时给一张占位图,避免列表里出现一排破图。
/// 这里不碰解码器,所以待处理的那几千张不会因为渲染再抢一次内存。
fn placeholder(label: &str) -> Response<Vec<u8>> {
    // 该 SVG 与页面同源（image/svg+xml 会被当作文档执行脚本），
    // 现在 label 是常量，但将来一旦传入文件名/相册名就是同源 XSS，先做转义。
    let label = label
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#131a26"/><stop offset="1" stop-color="#0a0e16"/></linearGradient></defs>
<rect width="256" height="256" fill="url(#g)"/>
<circle cx="128" cy="108" r="26" fill="none" stroke="#33445c" stroke-width="2"/>
<path d="M128 92v16l12 10" stroke="#33445c" stroke-width="2" fill="none" stroke-linecap="round"/>
<text x="128" y="176" fill="#4d6180" font-size="18" font-family="Microsoft YaHei,sans-serif" text-anchor="middle">{label}</text>
</svg>"##
    );
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "image/svg+xml")
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store")
        .body(svg.into_bytes())
        .unwrap()
}

/// 视频按 Range 分片读取:一次最多 8MB,不把整个文件读进内存。
fn serve_video(path: &Path, range: Option<&str>) -> Response<Vec<u8>> {
    let mime = mime_for(path);
    let Ok(meta) = std::fs::metadata(path) else {
        return not_found();
    };
    let len = meta.len();
    if len == 0 {
        return not_found();
    }
    const CHUNK: u64 = 8 * 1024 * 1024;
    let (start, end) = match range.and_then(parse_range) {
        // 后缀范围：最后 N 字节
        Some((u64::MAX, Some(n))) => {
            let n = n.min(len);
            let start = len - n;
            (start, (len - 1).min(start + CHUNK - 1))
        }
        Some((s, e)) => {
            let start = s.min(len.saturating_sub(1));
            let end = e.unwrap_or(len - 1).min(len - 1).max(start);
            (start, end.min(start + CHUNK - 1))
        }
        // 浏览器首帧可能不带 Range,这里主动给一段并声明支持分段。
        None => (0, (len - 1).min(CHUNK - 1)),
    };
    let want = (end - start + 1) as usize;
    let mut buf = vec![0u8; want];
    use std::io::{Read, Seek, SeekFrom};
    let ok = std::fs::File::open(path)
        .and_then(|mut f| {
            f.seek(SeekFrom::Start(start))?;
            f.read_exact(&mut buf)
        })
        .is_ok();
    if !ok {
        return not_found();
    }
    let partial = start != 0 || end != len - 1;
    Response::builder()
        .status(if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", want.to_string())
        .header("Content-Range", format!("bytes {start}-{end}/{len}"))
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store")
        .body(buf)
        .unwrap()
}

/// "bytes=start-end" / "bytes=start-" / "bytes=-suffix"
fn parse_range(raw: &str) -> Option<(u64, Option<u64>)> {
    let spec = raw.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (a, b) = first.split_once('-')?;
    if a.is_empty() {
        // 后缀范围 `bytes=-N` 表示「最后 N 字节」，不是「前 N 字节」。
        // 原实现返回 (0, N-1)，播放器请求尾部 moov/索引时会拿到文件头，
        // 表现为部分 MOV 无法拖动进度条。这里用 u64::MAX 作为「从末尾倒数」的哨兵，
        // 由 serve_video 在拿到文件长度后换算成真实偏移。
        let n: u64 = b.trim().parse().ok()?;
        if n == 0 {
            return None;
        }
        return Some((u64::MAX, Some(n)));
    }
    let start: u64 = a.trim().parse().ok()?;
    let end = b.trim().parse::<u64>().ok();
    Some((start, end))
}

/// tm:// 协议:tm://localhost/thumb/{id}.jpg · preview/{id}.jpg · particles/{id}.spc · photo/{id} · video/{id}
pub fn handle<R: tauri::Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app: &AppHandle<R> = ctx.app_handle();
    let state = app.state::<crate::AppState>();
    if !crate::auth::is_unlocked(&state.unlocked) {
        responder.respond(
            Response::builder()
                .status(StatusCode::FORBIDDEN)
                .header("Cache-Control", "no-store")
                .body(Vec::new())
                .unwrap(),
        );
        return;
    }
    let data_dir = state.data_dir.clone();

    let uri = request.uri().to_string();
    let raw = uri
        .strip_prefix("tm://localhost/")
        .or_else(|| uri.strip_prefix("tm://"))
        .or_else(|| uri.strip_prefix("http://tm.localhost/"))
        .or_else(|| uri.strip_prefix("https://tm.localhost/"))
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

    // 视频:按 Range 分片,仍然受解锁状态保护。
    if kind == "video" {
        let range = request
            .headers()
            .get("range")
            .and_then(|v| v.to_str().ok());
        let body = id_of(fname)
            .and_then(|id| {
                let conn = state.db.0.lock();
                conn.query_row(
                    "SELECT path FROM photos WHERE id=?1 AND kind='video'",
                    [id],
                    |r| r.get::<_, String>(0),
                )
                .ok()
            })
            .map(|p| serve_video(Path::new(&p), range))
            .unwrap_or_else(not_found);
        responder.respond(body);
        return;
    }

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
            // 只改写扩展名。原先 `p.replace(".jpg", "_p.jpg")` 是全局替换：
            // 目录名里含 ".jpg"（如 D:\photos.jpg.2024\1.jpg）会推出不存在的路径。
            let p = p.map(|p| {
                let path = std::path::Path::new(&p);
                let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                path.with_file_name(format!("{stem}_p.jpg"))
                    .to_string_lossy()
                    .into_owned()
            });
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
            // 只允许静态图：不过滤 kind 时，tm://.../photo/<视频id> 会把 GB 级视频
            // 整文件读进内存（分配失败在 panic=abort 下直接终止进程）。
            let p: Option<String> = conn
                .query_row("SELECT path FROM photos WHERE id=?1 AND kind='photo'", [id], |r| r.get(0))
                .ok();
            drop(conn);
            p.and_then(|p| {
                let meta = std::fs::metadata(&p).ok()?;
                if !meta.is_file() || meta.len() > 64 * 1024 * 1024 {
                    return None;
                }
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
        None if kind == "thumb" || kind == "preview" => responder.respond(placeholder("待整理")),
        None => responder.respond(not_found()),
    }
}
