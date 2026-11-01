//! 手机上传:临时局域网 HTTP 服务。
//!
//! 只在用户主动点击「手机上传」时启动,只监听局域网,会话结束(手动关闭 / 空闲超时 /
//! 上传完成)即停止。照片直接落盘到用户选定的文件夹,不经过任何外部服务;
//! 落盘后复用桌面端同一条导入管线,保证缩略图、EXIF、粒子缓存的行为完全一致。

use crate::db::Db;
use crate::import::{self, ImportControl};
use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
use parking_lot::Mutex;
use rand::RngCore;
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::{Path as FsPath, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// 单文件上限 200MB:照片足够,也容纳得下实况照片的动态片段与较长视频。
const MAX_FILE: usize = 200 * 1024 * 1024;
/// 无任何上传动作时长的上限,到点自动关闭,避免服务被遗忘在后台。
const IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub struct UploadSession {
    pub token: String,
    pub target: PathBuf,
    pub app: AppHandle,
    pub db: Db,
    pub data_dir: PathBuf,
    pub quality: String,
    pub count: AtomicU32,
    pub bytes: AtomicU64,
    pub closed: AtomicBool,
    pub saved: Mutex<Vec<String>>,
    pub last_name: Mutex<Option<String>>,
    pub last_activity: Mutex<Instant>,
    pub stopper: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl UploadSession {
    fn touch(&self) {
        *self.last_activity.lock() = Instant::now();
    }

    fn idle_for(&self) -> Duration {
        self.last_activity.lock().elapsed()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadInfo {
    pub url: String,
    pub qr_svg: String,
    pub port: u16,
    pub target: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadStatus {
    pub active: bool,
    pub count: u32,
    pub bytes: u64,
    pub last_name: Option<String>,
    pub target: String,
}

#[derive(serde::Deserialize)]
struct FileQuery {
    name: Option<String>,
    /// 手机端文件的时间戳(毫秒)。浏览器上传会丢掉文件系统时间,
    /// 没有 EXIF 的照片靠它才能落到正确的日期上。
    ts: Option<i64>,
}

fn random_token() -> String {
    let mut buf = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn token_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 当前局域网地址。UDP connect 只做路由查询、不发送任何数据包,
/// 因此仍然满足「不联网」的前提。
fn lan_ip() -> Option<Ipv4Addr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    match sock.local_addr().ok()?.ip() {
        IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_unspecified() => Some(v4),
        _ => None,
    }
}

fn is_lan(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => v6.is_loopback(),
    }
}

/// 只保留文件名,扩展名必须在桌面端支持列表内,防止路径穿越与任意文件写入。
fn sanitize_name(raw: &str) -> Option<String> {
    let base = FsPath::new(raw).file_name()?.to_string_lossy().into_owned();
    let cut = base.rfind('.').unwrap_or(base.len());
    let (stem, ext) = base.split_at(cut);
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    // 照片 / 视频 / HEIC 静帧都收:实况照片 = 静帧 + 配对 .mov,二者都要能落盘。
    if !crate::thumbs::SUPPORTED.contains(&ext.as_str())
        && !crate::thumbs::VIDEO.contains(&ext.as_str())
        && !["heic", "heif"].contains(&ext.as_str())
    {
        return None;
    }
    let mut stem: String = stem
        .chars()
        .filter(|c| !c.is_control() && !"/\\:*?\"<>|".contains(*c))
        .take(80)
        .collect();
    if stem.trim().is_empty() {
        stem = "upload".to_string();
    }
    Some(format!("{stem}.{ext}"))
}

/// 同目录重名时追加 _1 / _2,绝不覆盖已有照片。
fn unique_path(dir: &FsPath, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let cut = name.rfind('.').unwrap_or(name.len());
    let (stem, ext) = name.split_at(cut);
    for i in 1..10_000u32 {
        let next = dir.join(format!("{stem}_{i}{ext}"));
        if !next.exists() {
            return next;
        }
    }
    dir.join(format!("{stem}_{}{ext}", random_token()))
}

fn html_page() -> Html<&'static str> {
    Html(include_str!("upload_page.html"))
}

fn json_err(code: StatusCode, msg: &str) -> Response {
    (code, Json(serde_json::json!({ "ok": false, "error": msg }))).into_response()
}

fn unauthorized() -> Response {
    json_err(StatusCode::FORBIDDEN, "上传会话已失效，请在电脑上重新打开手机上传")
}

pub fn router(session: Arc<UploadSession>) -> Router {
    Router::new()
        .route("/u/{token}", get(page))
        .route("/u/{token}/file", post(upload_file))
        .route("/u/{token}/status", get(status))
        .route("/u/{token}/done", post(done))
        .route("/favicon.ico", get(|| async { StatusCode::NO_CONTENT }))
        .layer(DefaultBodyLimit::max(MAX_FILE))
        .with_state(session)
}

async fn page(State(s): State<Arc<UploadSession>>, Path(token): Path<String>) -> Response {
    if !token_eq(&token, &s.token) {
        return unauthorized();
    }
    s.touch();
    html_page().into_response()
}

async fn status(State(s): State<Arc<UploadSession>>, Path(token): Path<String>) -> Response {
    if !token_eq(&token, &s.token) {
        return unauthorized();
    }
    Json(serde_json::json!({
        "ok": true,
        "count": s.count.load(Ordering::Relaxed),
        "closed": s.closed.load(Ordering::Relaxed),
    }))
    .into_response()
}

async fn upload_file(
    State(s): State<Arc<UploadSession>>,
    Path(token): Path<String>,
    Query(q): Query<FileQuery>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> Response {
    if !token_eq(&token, &s.token) {
        return unauthorized();
    }
    if s.closed.load(Ordering::Relaxed) {
        return json_err(StatusCode::GONE, "上传已结束，请重新扫码");
    }
    if !is_lan(peer.ip()) {
        return json_err(StatusCode::FORBIDDEN, "只接受局域网内的上传");
    }
    if body.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "空文件");
    }
    let Some(raw_name) = q.name.as_deref() else {
        return json_err(StatusCode::BAD_REQUEST, "缺少文件名");
    };
    let Some(name) = sanitize_name(raw_name) else {
        return json_err(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "不支持的格式（支持 照片 JPG/PNG/WebP/GIF/BMP/TIFF、视频/实况照片 MP4/MOV/WebM/M4V，以及 HEIC）",
        );
    };

    let path = unique_path(&s.target, &name);
    if let Err(e) = std::fs::write(&path, &body) {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, &format!("写入失败: {e}"));
    }
    // 用手机端记录的修改时间回填 mtime:没有 EXIF 的照片靠它落到拍摄当天。
    if let Some(ts) = q.ts.filter(|v| *v > 0) {
        let secs = ts / 1000;
        if (1_000_000_000..=4_000_000_000).contains(&secs) {
            let _ = filetime::set_file_mtime(&path, filetime::FileTime::from_unix_time(secs, 0));
        }
    }

    s.saved.lock().push(path.to_string_lossy().into_owned());
    s.count.fetch_add(1, Ordering::Relaxed);
    s.bytes.fetch_add(body.len() as u64, Ordering::Relaxed);
    *s.last_name.lock() = Some(name.clone());
    s.touch();

    Json(serde_json::json!({ "ok": true, "name": name })).into_response()
}

async fn done(State(s): State<Arc<UploadSession>>, Path(token): Path<String>) -> Response {
    if !token_eq(&token, &s.token) {
        return unauthorized();
    }
    s.touch();
    let imported = import_pending(&s);
    Json(serde_json::json!({ "ok": true, "imported": imported })).into_response()
}

/// 把这批新文件交给桌面端导入管线。同一天多次上传会并入同一个相册。
fn import_pending(s: &Arc<UploadSession>) -> usize {
    let paths: Vec<String> = std::mem::take(&mut *s.saved.lock());
    if paths.is_empty() {
        return 0;
    }
    let quality = s.quality.clone();
    let album = Some(format!(
        "手机上传 · {}",
        chrono::Local::now().format("%m-%d")
    ));
    let control = Arc::new(ImportControl {
        cancel: AtomicBool::new(false),
    });
    match import::start_import(
        s.app.clone(),
        s.db.clone(),
        s.data_dir.clone(),
        paths.clone(),
        control,
        album,
        quality,
    ) {
        Ok(_) => paths.len(),
        Err(_) => 0,
    }
}

pub fn shutdown(s: &Arc<UploadSession>) {
    s.closed.store(true, Ordering::Relaxed);
    if let Some(tx) = s.stopper.lock().take() {
        let _ = tx.send(());
    }
}

/// 启动监听。端口由系统分配,监听成功后才返回,失败直接报错给前端。
pub async fn start(
    app: AppHandle,
    db: Db,
    data_dir: PathBuf,
    quality: String,
    target: PathBuf,
) -> Result<(Arc<UploadSession>, UploadInfo), String> {
    let token = random_token();
    let session = Arc::new(UploadSession {
        token: token.clone(),
        target: target.clone(),
        app,
        db,
        data_dir,
        quality,
        count: AtomicU32::new(0),
        bytes: AtomicU64::new(0),
        closed: AtomicBool::new(false),
        saved: Mutex::new(Vec::new()),
        last_name: Mutex::new(None),
        last_activity: Mutex::new(Instant::now()),
        stopper: Mutex::new(None),
    });

    let (port_tx, port_rx) = tokio::sync::oneshot::channel::<Result<u16, String>>();
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    *session.stopper.lock() = Some(stop_tx);

    let serve_session = session.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(("0.0.0.0", 0u16)).await {
            Ok(l) => l,
            Err(e) => {
                let _ = port_tx.send(Err(format!("无法监听端口: {e}")));
                return;
            }
        };
        let port = match listener.local_addr() {
            Ok(addr) => addr.port(),
            Err(e) => {
                let _ = port_tx.send(Err(format!("端口不可用: {e}")));
                return;
            }
        };
        let _ = port_tx.send(Ok(port));
        let _ = axum::serve(
            listener,
            router(serve_session).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = stop_rx.await;
        })
        .await;
    });

    let port = port_rx
        .await
        .map_err(|_| "上传服务启动失败".to_string())??;

    // 空闲看门狗:长时间没有上传动作就自动关闭,不让服务留在后台。
    let watch = session.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            if watch.closed.load(Ordering::Relaxed) {
                return;
            }
            if watch.idle_for() >= IDLE_TIMEOUT {
                shutdown(&watch);
                return;
            }
        }
    });

    let ip = lan_ip()
        .map(|v| v.to_string())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let url = format!("http://{ip}:{port}/u/{token}");
    let qr_svg = qrcode::QrCode::new(url.as_bytes())
        .map(|code| {
            code.render::<qrcode::render::svg::Color>()
                .min_dimensions(200, 200)
                .quiet_zone(true)
                .build()
        })
        .unwrap_or_default();

    let info = UploadInfo {
        url,
        qr_svg,
        port,
        target: target.to_string_lossy().into_owned(),
    };
    Ok((session, info))
}

pub fn status_of(session: &Arc<UploadSession>) -> UploadStatus {
    UploadStatus {
        active: !session.closed.load(Ordering::Relaxed),
        count: session.count.load(Ordering::Relaxed),
        bytes: session.bytes.load(Ordering::Relaxed),
        last_name: session.last_name.lock().clone(),
        target: session.target.to_string_lossy().into_owned(),
    }
}

/// 结束会话:先关服务,再把没导入的照片补进图库。
pub fn finish(session: &Arc<UploadSession>) -> usize {
    shutdown(session);
    import_pending(session)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_and_unknown_extensions() {
        assert_eq!(sanitize_name("../../evil.exe"), None);
        assert_eq!(sanitize_name("a/b/../../x.jpg").as_deref(), Some("x.jpg"));
        assert_eq!(sanitize_name("C:\\Windows\\IMG_0001.JPG").as_deref(), Some("IMG_0001.jpg"));
        assert_eq!(sanitize_name("photo.heic"), Some("photo.heic".to_string()));
        // 只有空白主干时退化成 upload.jpg,扩展名合法就收,不拒收
        assert_eq!(sanitize_name("   .jpg").as_deref(), Some("upload.jpg"));
    }

    #[test]
    fn token_compare_is_exact() {
        assert!(token_eq("abc123", "abc123"));
        assert!(!token_eq("abc123", "abc124"));
        assert!(!token_eq("abc", "abc123"));
    }

    #[test]
    fn dedupes_file_names() {
        let dir = std::env::temp_dir().join(format!("sm-upload-test-{}", random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.jpg"), b"x").unwrap();
        let next = unique_path(&dir, "a.jpg");
        assert_eq!(next.file_name().unwrap(), "a_1.jpg");
        std::fs::remove_dir_all(&dir).ok();
    }
}
