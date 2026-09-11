use image::{DynamicImage, GenericImageView, ImageFormat};
use std::io::BufReader;
use std::path::Path;

pub const SUPPORTED: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "tif",
];
pub const KNOWN_UNSUPPORTED: &[&str] = &["heic", "heif", "avif", "raw", "cr2", "cr3", "nef", "arw", "orf", "rw2", "dng", "raf"];

pub fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

pub fn is_supported(path: &Path) -> bool {
    SUPPORTED.contains(&ext_of(path).as_str())
}

pub fn is_known_unsupported(path: &Path) -> bool {
    KNOWN_UNSUPPORTED.contains(&ext_of(path).as_str())
}

fn guess_format(path: &Path) -> Option<ImageFormat> {
    ImageFormat::from_path(path).ok().or(match ext_of(path).as_str() {
        "jpg" | "jpeg" => Some(ImageFormat::Jpeg),
        "png" => Some(ImageFormat::Png),
        "webp" => Some(ImageFormat::WebP),
        "gif" => Some(ImageFormat::Gif),
        "bmp" => Some(ImageFormat::Bmp),
        "tiff" | "tif" => Some(ImageFormat::Tiff),
        _ => None,
    })
}

/// 加载并按 EXIF orientation 摆正
pub fn load_oriented(path: &Path, orientation: Option<u32>) -> Result<DynamicImage, String> {
    let fmt = guess_format(path).ok_or("不支持的格式")?;
    let file = std::fs::File::open(path).map_err(|e| format!("无法打开: {e}"))?;
    let reader = BufReader::new(file);
    let mut img = image::ImageReader::with_format(reader, fmt)
        .decode()
        .map_err(|e| format!("解码失败: {e}"))?;
    img.apply_orientation(
        image::metadata::Orientation::from_exif(orientation.unwrap_or(1) as u8)
            .unwrap_or(image::metadata::Orientation::NoTransforms),
    );
    Ok(img)
}

pub struct ThumbResult {
    pub width: u32,
    pub height: u32,
    pub avg_color: String,
    pub score: f64,
}

/// 生成缩略图(256)与预览图(1024),返回尺寸/平均色/封面质量分
pub fn generate(
    img: &DynamicImage,
    thumb_out: &Path,
    preview_out: &Path,
) -> Result<ThumbResult, String> {
    let (w, h) = img.dimensions();

    // 缩略图 256
    let thumb = resize_max(img, 256);
    thumb
        .save_with_format(thumb_out, ImageFormat::Jpeg)
        .map_err(|e| format!("写缩略图失败: {e}"))?;

    // 预览图 1024
    let preview = resize_max(img, 1024);
    preview
        .save_with_format(preview_out, ImageFormat::Jpeg)
        .map_err(|e| format!("写预览图失败: {e}"))?;

    // 平均色 8x8
    let small = img.resize_exact(8, 8, image::imageops::FilterType::Triangle).to_rgb8();
    let mut r = 0u64;
    let mut g = 0u64;
    let mut b = 0u64;
    for px in small.pixels() {
        r += px[0] as u64;
        g += px[1] as u64;
        b += px[2] as u64;
    }
    let n = 64;
    let avg_color = format!("#{:02X}{:02X}{:02X}", (r / n) as u8, (g / n) as u8, (b / n) as u8);

    let score = quality_score(&small);

    Ok(ThumbResult { width: w, height: h, avg_color, score })
}

pub fn resize_max(img: &DynamicImage, max: u32) -> DynamicImage {
    let (w, h) = img.dimensions();
    let scale = (max as f64 / w.max(h) as f64).min(1.0);
    if scale >= 1.0 {
        img.clone()
    } else {
        img.resize(
            ((w as f64 * scale) as u32).max(1),
            ((h as f64 * scale) as u32).max(1),
            image::imageops::FilterType::Triangle,
        )
    }
}

/// 封面质量分:清晰度(拉普拉斯方差)+ 曝光接近 0.45~0.6 + 非纯色
fn quality_score(small8: &image::RgbImage) -> f64 {
    let mut gray = [[0f32; 8]; 8];
    for (i, px) in small8.pixels().enumerate() {
        gray[i / 8][i % 8] =
            (0.299 * px[0] as f32 + 0.587 * px[1] as f32 + 0.114 * px[2] as f32) / 255.0;
    }
    // Laplacian
    let mut lap_sum = 0.0;
    let mut lap_sq = 0.0;
    let mut cnt = 0;
    for y in 1..7 {
        for x in 1..7 {
            let v = gray[y - 1][x] + gray[y + 1][x] + gray[y][x - 1] + gray[y][x + 1]
                - 4.0 * gray[y][x];
            lap_sum += v;
            lap_sq += v * v;
            cnt += 1;
        }
    }
    let mean = lap_sum / cnt as f32;
    let variance = lap_sq / cnt as f32 - mean * mean;
    let sharpness = variance.min(1.0);

    let mut lum_mean = 0.0;
    for row in &gray {
        for v in row {
            lum_mean += v;
        }
    }
    lum_mean /= 64.0;
    let exposure = 1.0 - (lum_mean - 0.5).abs() * 1.6;

    // 纯色惩罚
    let mut min_l = 1.0f32;
    let mut max_l = 0.0f32;
    for row in &gray {
        for v in row {
            min_l = min_l.min(*v);
            max_l = max_l.max(*v);
        }
    }
    let contrast = (max_l - min_l).min(1.0);

    ((sharpness * 0.5 + exposure.max(0.0) * 0.3 + contrast * 0.2).clamp(0.0, 1.0)) as f64
}
