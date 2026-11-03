//! 安卓 / 华为 / 小米 / 三星的「动态照片」支持。
//!
//! 这类实况只有一个文件：JPEG 里通过 XMP 标注，并在文件尾部塞进一段 MP4。
//! 桌面端要能「播放实况」，就得把这段视频抽出来单独存一份，再和静帧建立关联
//! （photos.live_video_id），复用既有的 `tm://video/<id>` 播放链路。
//!
//! 识别顺序：
//! 1. XMP 里的 `GCamera:MicroVideoOffset="N"` —— 绝大多数国产 / 谷歌方案；
//! 2. 文件尾部扫描 `ftyp` box —— 少数只标 `MotionPhoto="1"` 的老实现。
//!
//! 两种都要求抽出的片段 > 16KB，避免把缩略图残片当成视频。

use crate::db::Db;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// 内嵌视频在源文件里的字节区间。
#[derive(Clone, Copy, Debug)]
pub struct Embedded {
    pub start: u64,
    pub len: u64,
}

/// 合法的 MP4 major brand（尾部扫描时用来确认「这里确实是一段视频」）。
const BRANDS: [&[u8]; 9] = [
    b"isom", b"iso2", b"iso4", b"iso5", b"iso6", b"mp41", b"mp42", b"3gp4", b"avc1",
];

/// 低于这个长度的片段一律不认（缩略图 / 预览用的小视频没有播放价值）。
const MIN_LEN: u64 = 16 * 1024;

/// 在 XMP 头里读 `MicroVideoOffset`（表示「视频占文件末尾 N 字节」）。
/// XMP 位于 JPEG 的 APP1 段，基本都在文件前几百 KB 内。
fn offset_from_head(head: &[u8]) -> Option<u64> {
    let text = String::from_utf8_lossy(head);
    for key in ["MicroVideoOffset=\"", "MicroVideoOffset='"] {
        let Some(i) = text.find(key) else { continue };
        let rest = &text[i + key.len()..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(v) = digits.parse::<u64>() {
            if v > MIN_LEN {
                return Some(v);
            }
        }
    }
    None
}

/// 在 XMP 头里读 `Container:Directory` 列表（谷歌 MotionPhoto v1，vivo/小米/Oppo 常用）。
/// 结构：`<Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="N"/>`
/// `Item:Length` 就是这个内嵌视频的字节数。
fn length_from_container(text: &str) -> Option<u64> {
    let needle = "Container:Item";
    let mut from = 0usize;
    while let Some(rel) = text[from..].find(needle) {
        let start = from + rel;
        let max = text[start..].len().min(600);
        let window = &text[start..start + max];
        let is_video = window.contains("Semantic=\"MotionPhoto\"")
            || window.contains("Semantic='MotionPhoto'");
        if is_video {
            for key in ["Item:Length=\"", "Item:Length='"] {
                let Some(p) = window.find(key) else { continue };
                let digits: String = window[p + key.len()..]
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                if let Ok(v) = digits.parse::<u64>() {
                    if v > MIN_LEN {
                        return Some(v);
                    }
                }
            }
        }
        from = start + needle.len();
    }
    None
}

/// 在文件尾部找 MP4 的 `ftyp` box：`[4B size][ftyp][4B brand]`。
/// 取最靠后且校验通过的候选（真实视频一定在 JPEG 数据之后）。
fn ftyp_from_tail(tail: &[u8], tail_start: u64, file_size: u64) -> Option<u64> {
    let mut end = tail.len();
    while end >= 12 {
        let Some(pos) = tail[..end].windows(4).rposition(|w| w == b"ftyp") else {
            break;
        };
        if pos >= 4 && pos + 8 <= tail.len() {
            let bs = u32::from_be_bytes([tail[pos - 4], tail[pos - 3], tail[pos - 2], tail[pos - 1]])
                as u64;
            let brand = &tail[pos + 4..pos + 8];
            if bs >= 16 && bs <= file_size && BRANDS.contains(&brand) {
                let start = tail_start + pos as u64 - 4;
                if file_size > start && file_size - start > MIN_LEN {
                    return Some(start);
                }
            }
        }
        if pos == 0 {
            break;
        }
        end = pos;
    }
    None
}

/// 检测文件里是否内嵌动态照片视频；命中返回字节区间。
pub fn detect(path: &Path) -> Option<Embedded> {
    let size = std::fs::metadata(path).ok()?.len();
    if size <= MIN_LEN {
        return None;
    }
    // 只对 JPEG 系列做检测：视频、PNG 等没有这种封装。
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !matches!(ext.as_str(), "jpg" | "jpeg") {
        return None;
    }

    let mut f = File::open(path).ok()?;
    let head_len = size.min(320 * 1024) as usize;
    let mut head = vec![0u8; head_len];
    f.read_exact(&mut head).ok()?;

    if let Some(len) = offset_from_head(&head) {
        if len < size {
            return Some(Embedded { start: size - len, len });
        }
    }
    // 新规范：Container:Directory 里标了视频长度，同样表示「占文件末尾 N 字节」。
    if let Some(len) = length_from_container(&String::from_utf8_lossy(&head)) {
        if len < size {
            return Some(Embedded { start: size - len, len });
        }
    }

    // 兜底：读尾部 8MB 找 mp4 头。多数 3 秒片段都在此范围内。
    let tail_len = size.min(8 * 1024 * 1024) as usize;
    let tail_start = size - tail_len as u64;
    let mut tail = vec![0u8; tail_len];
    f.seek(SeekFrom::Start(tail_start)).ok()?;
    f.read_exact(&mut tail).ok()?;
    let start = ftyp_from_tail(&tail, tail_start, size)?;
    Some(Embedded { start, len: size - start })
}

/// 把内嵌片段复制到 `dest`，返回写入字节数。
fn extract_to(src: &Path, emb: Embedded, dest: &Path) -> std::io::Result<u64> {
    let mut f = File::open(src)?;
    f.seek(SeekFrom::Start(emb.start))?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut out = File::create(dest)?;
    let mut left = emb.len;
    let mut buf = vec![0u8; 256 * 1024];
    while left > 0 {
        let want = buf.len().min(left as usize);
        let n = f.read(&mut buf[..want])?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])?;
        left -= n as u64;
    }
    out.flush()?;
    Ok(emb.len.saturating_sub(left))
}

/// 这一帧已经关联过视频就返回原 id。
fn existing_link(conn: &rusqlite::Connection, photo_id: i64) -> Option<i64> {
    conn.query_row(
        "SELECT live_video_id FROM photos WHERE id=?1",
        [photo_id],
        |r| r.get::<_, Option<i64>>(0),
    )
    .ok()
    .flatten()
}

/// 抽出内嵌视频并登记成一条隐藏的 `kind='video'` 记录，再回填 live_video_id。
///
/// 抽出的文件放在 `data_dir/live/<photo_id>.mp4`（不落在用户照片目录里，
/// 避免用户看到一堆莫名其妙的 mp4，也避免被重复扫描导入）。
pub fn attach(db: &Db, data_dir: &Path, photo_id: i64, src: &Path, filename: &str) -> Option<i64> {
    let conn = db.0.lock();
    if let Some(vid) = existing_link(&conn, photo_id) {
        return Some(vid);
    }
    drop(conn);

    let emb = detect(src)?;

    let dest: PathBuf = data_dir.join("live").join(format!("{photo_id}.mp4"));
    let ok = match std::fs::metadata(&dest) {
        Ok(m) if m.len() > MIN_LEN => true,
        _ => extract_to(src, emb, &dest).map(|n| n > MIN_LEN).unwrap_or(false),
    };
    if !ok {
        let _ = std::fs::remove_file(&dest);
        return None;
    }

    let stem = filename
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(filename)
        .to_string();

    let conn = db.0.lock();
    // 并发场景下可能刚被别人写好，再确认一次
    if let Some(vid) = existing_link(&conn, photo_id) {
        return Some(vid);
    }
    // imported=1 但 processed=1：让它不被后台当成待处理视频去截帧，
    // listPhotos 会通过 PHOTO_FILTER 把它排除，不会出现在时间轴里。
    let inserted = conn.execute(
        "INSERT INTO photos(path, filename, kind, imported, processed, capture_date, date_source)
         VALUES(?1, ?2, 'video', 1, 1,
                (SELECT capture_date FROM photos WHERE id=?3),
                (SELECT COALESCE(date_source,'live') FROM photos WHERE id=?3))",
        rusqlite::params![dest.to_string_lossy(), format!("{stem}.mp4"), photo_id],
    );
    if inserted.is_err() {
        return None;
    }
    let vid = conn.last_insert_rowid();
    if conn
        .execute("UPDATE photos SET live_video_id=?1 WHERE id=?2", [vid, photo_id])
        .is_err()
    {
        return None;
    }
    Some(vid)
}

/// 删除照片时清掉它专属的实况视频（行 + 文件），避免留下孤儿。
pub fn drop_for(conn: &rusqlite::Connection, photo_id: i64) {
    let vid: Option<i64> = conn
        .query_row(
            "SELECT live_video_id FROM photos WHERE id=?1",
            [photo_id],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    let Some(vid) = vid else { return };
    let path: Option<String> = conn
        .query_row("SELECT path FROM photos WHERE id=?1", [vid], |r| r.get(0))
        .ok();
    conn.execute("UPDATE photos SET live_video_id=NULL WHERE id=?1", [photo_id])
        .ok();
    conn.execute("DELETE FROM photos WHERE id=?1", [vid]).ok();
    if let Some(p) = path {
        let _ = std::fs::remove_file(p);
    }
}

/// 给存量照片批量补做识别（导入前没有这个能力，老库里的实况需要补一次）。
/// 返回 (尝试数, 成功数)。只处理还没有 live_video_id 的静帧。
pub fn backfill(db: &Db, data_dir: &Path, limit: usize) -> (usize, usize) {
    let targets: Vec<(i64, String, String)> = {
        let conn = db.0.lock();
        let mut q = match conn.prepare(
            "SELECT id, path, filename FROM photos
             WHERE kind='photo' AND imported=1 AND missing=0 AND live_video_id IS NULL
               AND (LOWER(path) LIKE '%.jpg' OR LOWER(path) LIKE '%.jpeg')
             ORDER BY id DESC LIMIT ?1",
        ) {
            Ok(q) => q,
            Err(_) => return (0, 0),
        };
        let collected: Vec<(i64, String, String)> =
            match q.query_map([limit as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))) {
                Ok(rows) => rows.flatten().collect(),
                Err(_) => return (0, 0),
            };
        collected
    };
    let mut tried = 0;
    let mut done = 0;
    for (id, path, filename) in targets {
        tried += 1;
        if attach(db, data_dir, id, Path::new(&path), &filename).is_some() {
            done += 1;
        }
    }
    (tried, done)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_container_directory_length() {
        // 谷歌 MotionPhoto v1：Primary 是静帧，MotionPhoto 才是视频，长度在同一个 item 里
        let xmp = r#"<Container:Directory><rdf:Seq>
            <rdf:li><Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0"/></rdf:li>
            <rdf:li><Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="4633692" Item:Padding="0"/></rdf:li>
        </rdf:Seq></Container:Directory>"#;
        assert_eq!(length_from_container(xmp), Some(4633692));
    }

    #[test]
    fn primary_item_alone_is_not_a_video() {
        let xmp = r#"<Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="999999"/>"#;
        assert_eq!(length_from_container(xmp), None);
    }

    #[test]
    fn reads_micro_video_offset() {
        let head = br#"<x:xmpmeta><GCamera:MicroVideoOffset="524288"/></x:xmpmeta>"#;
        assert_eq!(offset_from_head(head), Some(524288));
    }

    #[test]
    fn ignores_tiny_offset() {
        let head = br#"GCamera:MicroVideoOffset="1024""#;
        assert_eq!(offset_from_head(head), None);
    }

    #[test]
    fn finds_ftyp_in_tail() {
        // [size=32][ftyp][isom] 后面跟一段足够长的数据（片段要过 16KB 门槛）
        let mut tail = vec![0u8; 20_000];
        tail[10..14].copy_from_slice(&32u32.to_be_bytes());
        tail[14..18].copy_from_slice(b"ftyp");
        tail[18..22].copy_from_slice(b"isom");
        let start = ftyp_from_tail(&tail, 0, 20_000).unwrap();
        assert_eq!(start, 10);
    }

    #[test]
    fn rejects_non_video_extension() {
        assert!(detect(Path::new("nope.mp4")).is_none());
    }
}
