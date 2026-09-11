use crate::models::ExifInfo;
use exif::{In, Tag};
use std::io::BufReader;
use std::path::Path;

pub fn read_exif(path: &Path) -> ExifInfo {
    let mut info = ExifInfo::default();

    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return info,
    };
    let reader = match exif::Reader::new().read_from_container(&mut BufReader::new(&file)) {
        Ok(r) => r,
        Err(_) => {
            // 无 EXIF:退回文件系统时间(推断日期)
            apply_file_time(path, &mut info);
            return info;
        }
    };

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
    if info.capture_date.is_none() {
        apply_file_time(path, &mut info);
    }

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
    info
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
    // EXIF: "2026:07:12 18:32:05" → "2026-07-12 18:32:05"
    let s = s.trim().trim_matches('"');
    if s.len() < 19 {
        return None;
    }
    let bytes = s.as_bytes();
    if bytes[4] != b':' || bytes[7] != b':' {
        return None;
    }
    let out = format!("{}-{}-{} {}", &s[0..4], &s[5..7], &s[8..10], &s[11..19]);
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
