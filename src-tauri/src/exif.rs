use crate::models::ExifInfo;
use exif::{In, Tag};
use std::io::BufReader;
use std::path::Path;

pub fn read_exif(path: &Path) -> ExifInfo {
    let mut info = ExifInfo::default();

    match read_any_exif(path) {
        Some(reader) => fill_from_exif(&reader, &mut info),
        None => {
            // 无 EXIF:退回文件系统时间(推断日期)
            apply_file_time(path, &mut info);
            return info;
        }
    }
    if info.capture_date.is_none() {
        apply_file_time(path, &mut info);
    }
    info
}

/// 先按常规容器(JPEG/TIFF)读;HEIC 是 ISOBMFF 容器,EXIF 藏在里面,
/// 常规读法会失败,所以再走一遍 HEIC 专用定位(仅 Package B 编译进来)。
fn read_any_exif(path: &Path) -> Option<exif::Exif> {
    if let Ok(file) = std::fs::File::open(path) {
        if let Ok(r) = exif::Reader::new().read_from_container(&mut BufReader::new(&file)) {
            return Some(r);
        }
    }
    #[cfg(feature = "heic")]
    if crate::thumbs::is_heic(path) {
        return read_heic_exif(path);
    }
    None
}

/// HEIC/HEIF:文件本身是 ISOBMFF(MP4 家族)容器,EXIF 作为一个 item 存在,
/// 内容就是一段标准的 TIFF 数据。先把它在文件里的位置找出来,再交给 exif 解析。
/// 这样拍摄时间、GPS 经纬度、机型、光圈快门、方向都能和普通照片一样拿到。
#[cfg(feature = "heic")]
fn read_heic_exif(path: &Path) -> Option<exif::Exif> {
    use std::io::{Read, Seek, SeekFrom};

    const WINDOW: u64 = 8 * 1024 * 1024;
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len == 0 {
        return None;
    }

    // meta box 通常紧跟在文件头;少数写入器把它放到了末尾,所以头尾各查一遍。
    let head_end = len.min(WINDOW);
    let tail_start = len.saturating_sub(WINDOW);
    let mut windows: Vec<(u64, u64)> = vec![(0, head_end)];
    if tail_start > 0 {
        windows.push((tail_start, len - tail_start));
    }

    for (offset, size) in windows {
        let mut buf = Vec::with_capacity(size as usize);
        if file.seek(SeekFrom::Start(offset)).is_err() {
            continue;
        }
        if file.by_ref().take(size).read_to_end(&mut buf).is_err() {
            continue;
        }
        if let Some(pos) = find_tiff_offset(&buf) {
            if let Ok(r) = exif::Reader::new().read_raw(buf[pos..].to_vec()) {
                return Some(r);
            }
        }
    }
    None
}

/// 在字节流里找 EXIF 的 TIFF 起始位置。
/// ISOBMFF 的 Exif item 常见写法是「4 字节长度 + "Exif\0\0" + TIFF 头」。
#[cfg(feature = "heic")]
fn find_tiff_offset(buf: &[u8]) -> Option<usize> {
    if buf.len() > 6 {
        for i in 0..buf.len() - 6 {
            if &buf[i..i + 6] == b"Exif\0\0" {
                let p = i + 6;
                if is_tiff_head(buf.get(p..p + 4)?) {
                    return Some(p);
                }
            }
        }
    }
    for i in 0..buf.len().saturating_sub(4) {
        if is_tiff_head(&buf[i..i + 4]) {
            return Some(i);
        }
    }
    None
}

#[cfg(feature = "heic")]
fn is_tiff_head(s: &[u8]) -> bool {
    s == b"II*\0" || s == b"MM\0*"
}
fn fill_from_exif(reader: &exif::Exif, info: &mut ExifInfo) {
    // 拍摄时间优先级:DateTimeOriginal > ModifyDate
    for (tag, source) in [(Tag::DateTimeOriginal, "exif"), (Tag::DateTime, "exif")] {
        if info.capture_date.is_some() {
            break;
        }
        if let Some(f) = reader.get_field(tag, In::PRIMARY) {
            let s = f.display_value().with_unit(()).to_string();
            if let Some(dt) = parse_exif_datetime(&s) {
                info.capture_date = Some(dt);
                info.date_source = Some(source.into());
            }
        }
    }
    // 没有拍期也不要紧,继续往下取 GPS 等信息;日期由外层按文件时间兜底。

    // GPS
    if let (Some(lat), Some(lat_ref), Some(lon), Some(lon_ref)) = (
        reader.get_field(Tag::GPSLatitude, In::PRIMARY),
        reader.get_field(Tag::GPSLatitudeRef, In::PRIMARY),
        reader.get_field(Tag::GPSLongitude, In::PRIMARY),
        reader.get_field(Tag::GPSLongitudeRef, In::PRIMARY),
    ) {
        let lat = dms_to_degrees(&lat.value);
        let lon = dms_to_degrees(&lon.value);
        let lat_neg = lat_ref
            .display_value()
            .with_unit(())
            .to_string()
            .contains('S');
        let lon_neg = lon_ref
            .display_value()
            .with_unit(())
            .to_string()
            .contains('W');
        if let (Some(lat), Some(lon)) = (lat, lon) {
            info.gps_lat = Some(if lat_neg { -lat } else { lat });
            info.gps_lon = Some(if lon_neg { -lon } else { lon });
        }
    }

    info.camera = get_str(&reader, Tag::Model);
    info.lens = get_str(&reader, Tag::LensModel);
    if let Some(f) = reader.get_field(Tag::PhotographicSensitivity, In::PRIMARY) {
        info.iso = f.value.get_uint(0).map(|v| v as i64);
    }
    if let Some(f) = reader.get_field(Tag::FNumber, In::PRIMARY) {
        if let Some(v) = as_rational(&f.value, 0) {
            info.aperture = Some(format!("f/{:.1}", v));
        }
    }
    if let Some(f) = reader.get_field(Tag::ExposureTime, In::PRIMARY) {
        if let Some(v) = as_rational(&f.value, 0) {
            info.shutter = Some(if v >= 1.0 {
                format!("{v:.0}s")
            } else if v > 0.0 {
                format!("1/{:.0}s", 1.0 / v)
            } else {
                String::new()
            });
        }
    }
    if let Some(f) = reader.get_field(Tag::FocalLength, In::PRIMARY) {
        if let Some(v) = as_rational(&f.value, 0) {
            info.focal = Some(format!("{v:.0}mm"));
        }
    }
    if let Some(f) = reader.get_field(Tag::Orientation, In::PRIMARY) {
        info.orientation = f.value.get_uint(0);
    }
    if let Some(f) = reader.get_field(Tag::ImageWidth, In::PRIMARY) {
        info.width = f.value.get_uint(0);
    }
    if let Some(f) = reader.get_field(Tag::ImageLength, In::PRIMARY) {
        info.height = f.value.get_uint(0);
    }
}

fn apply_file_time(path: &Path, info: &mut ExifInfo) {
    use std::time::UNIX_EPOCH;
    if let Ok(meta) = std::fs::metadata(path) {
        let dur = meta
            .created()
            .ok()
            .filter(|t| *t != UNIX_EPOCH)
            .or_else(|| meta.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok());
        if let Some(dur) = dur {
            if let Some(dt) =
                chrono::DateTime::from_timestamp(dur.as_secs() as i64, 0)
                    .map(|d| d.with_timezone(&chrono::Local))
            {
                info.capture_date = Some(dt.format("%Y-%m-%d %H:%M:%S").to_string());
                info.date_source = Some("file".into());
            }
        }
    }
}

fn get_str(reader: &exif::Exif, tag: Tag) -> Option<String> {
    reader
        .get_field(tag, In::PRIMARY)
        .map(|f| {
            f.display_value()
                .with_unit(())
                .to_string()
                .trim_matches('"')
                .to_string()
        })
        .filter(|s| !s.is_empty() && s != "[unavailable]")
}

fn as_rational(value: &exif::Value, idx: usize) -> Option<f64> {
    if let exif::Value::Rational(ref v) = value {
        return v.get(idx).map(|r| r.to_f64());
    }
    None
}

fn parse_exif_datetime(s: &str) -> Option<String> {
    // exif 库的 display_value 会把 DateTime 归一成 "2026-07-12 18:32:05"（横杠），
    // 而不是 EXIF 原始的 "2026:07:12 18:32:05"（冒号）——以前只认冒号，导致所有照片
    // 的拍摄时间都解析失败、悄悄退化成文件修改时间。两种分隔符都接受。
    let s = s.trim().trim_matches('"');
    if s.len() < 19 { return None; }
    let b = s.as_bytes();
    // 年-月 / 月-日两处分隔符:允许 ':' 或 '-'
    let sep = |i: usize| b[i] == b':' || b[i] == b'-';
    if !sep(4) || !sep(7) { return None; }
    let date = s.get(0..4)?;
    let month = s.get(5..7)?;
    let day = s.get(8..10)?;
    let time = s.get(11..19)?;
    let out = format!("{date}-{month}-{day} {time}");
    chrono::NaiveDateTime::parse_from_str(&out, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|_| out)
}

fn dms_to_degrees(value: &exif::Value) -> Option<f64> {
    if let exif::Value::Rational(ref v) = value {
        if v.len() >= 3 {
            let deg = v[0].to_f64();
            let min = v[1].to_f64();
            let sec = v[2].to_f64();
            return Some(deg + min / 60.0 + sec / 3600.0);
        }
    }
    None
}


#[cfg(test)]
mod tests {
    use super::parse_exif_datetime;
    #[cfg(feature = "heic")]
    use super::find_tiff_offset;

    #[test]
    fn parses_exif_datetime_in_both_forms() {
        // exif 库的 display_value 会归一成横杠形式;以前只认冒号,导致所有照片的
        // 拍摄时间解析失败、退化成文件修改时间。两种都必须能解析。
        assert_eq!(
            parse_exif_datetime("2026:07:12 18:32:05"),
            Some("2026-07-12 18:32:05".into())
        );
        assert_eq!(
            parse_exif_datetime("2026-07-12 18:32:05"),
            Some("2026-07-12 18:32:05".into())
        );
    }

    #[test]
    fn rejects_non_datetime() {
        assert_eq!(parse_exif_datetime(""), None);
        assert_eq!(parse_exif_datetime("2026-7-2 8:32"), None);
        assert_eq!(parse_exif_datetime("2026/07/12 18:32:05"), None);
    }

    #[cfg(feature = "heic")]
    #[test]
    fn locates_exif_item_with_marker() {
        // ISOBMFF 里典型的 Exif item:长度前缀 + "Exif\0\0" + TIFF 头
        let mut buf = vec![0u8; 32];
        buf.extend_from_slice(&[0x00, 0x00, 0x01, 0x28]);
        buf.extend_from_slice(b"Exif\0\0");
        buf.extend_from_slice(b"II*\0");
        buf.extend_from_slice(&[0u8; 16]);
        let expected = buf.len() - 20;
        assert_eq!(find_tiff_offset(&buf), Some(expected));
        assert_eq!(&buf[expected..expected + 4], b"II*\0");
    }

    #[cfg(feature = "heic")]
    #[test]
    fn locates_bare_tiff_head() {
        let mut buf = vec![0xAAu8; 40];
        buf.extend_from_slice(b"MM\0*");
        buf.extend_from_slice(&[0u8; 8]);
        assert_eq!(find_tiff_offset(&buf), Some(40));
    }

    #[cfg(feature = "heic")]
    #[test]
    fn returns_none_when_absent() {
        assert_eq!(find_tiff_offset(&[0u8; 64]), None);
    }
}
