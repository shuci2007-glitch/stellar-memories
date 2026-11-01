use image::{DynamicImage, GenericImageView, ImageFormat};
use std::io::BufReader;
use std::path::Path;

pub const SUPPORTED: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "tif",
];
pub const KNOWN_UNSUPPORTED: &[&str] = &["heic", "heif", "avif", "raw", "cr2", "cr3", "nef", "arw", "orf", "rw2", "dng", "raf"];
/// 视频不进图片解码管线:入库后由前端截帧生成封面,tm:// 直接按原文件播放。
pub const VIDEO: &[&str] = &["mp4", "mov", "webm", "m4v", "mkv", "avi"];
/// HEIC/HEIF 静帧。Package A 不解码(直接跳过);Package B 通过 `heic` feature 走系统解码器。
pub const HEIC: &[&str] = &["heic", "heif"];

pub fn is_video(path: &Path) -> bool {
    VIDEO.contains(&ext_of(path).as_str())
}

pub fn is_heic(path: &Path) -> bool {
    HEIC.contains(&ext_of(path).as_str())
}

/// 当前构建是否接受 HEIC:仅开启 `heic` feature 时。用于导入扫描时是否把 HEIC 收进来。
pub fn heic_accepted(path: &Path) -> bool {
    cfg!(feature = "heic") && is_heic(path)
}

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

/// 统一解码入口:HEIC(开启 feature 时)交给系统解码器,其余走 image 管线。
/// 关闭 `heic` feature 时与 `load_oriented` 行为完全一致,Package A 不受影响。
pub fn decode_image(path: &Path, orientation: Option<u32>) -> Result<DynamicImage, String> {
    #[cfg(feature = "heic")]
    {
        if is_heic(path) {
            return decode_heic(path, orientation);
        }
    }
    load_oriented(path, orientation)
}

/// HEIC/HEIF 解码:用 Windows 系统自带的 HEIF 解码器(WIC/WinRT)把静帧读成 RGBA8。
/// 仅在 `heic` feature 下编译。worker 线程需要先进入 COM 多线程单元(MTA),
/// 再用一个单线程 tokio runtime 驱动 WinRT 的异步解码。
#[cfg(feature = "heic")]
pub fn decode_heic(path: &Path, orientation: Option<u32>) -> Result<DynamicImage, String> {
    // 优先用自带的 libheif 解码(零系统依赖,任何 Windows 都能解 HEIC);
    // 失败(如 DLL 缺失/损坏)再回退系统 WinRT 解码器,App 不会因此崩。
    match crate::heif_decode::decode(path, orientation) {
        Ok(img) => return Ok(img),
        Err(e) => eprintln!("[heif] 自带解码器失败,回退系统解码器: {e}"),
    }

    use windows::core::HSTRING;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Storage::FileAccessMode;
    use windows::Storage::StorageFile;
    use windows::Graphics::Imaging::{
        BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, BitmapTransform, ColorManagementMode,
        ExifOrientationMode,
    };

    // 进入 MTA,WinRT 调用才允许在普通 worker 线程上跑。
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("HEIC 解码运行时启动失败: {e}"))?;
    rt.block_on(async move {
        let p = HSTRING::from(path.to_string_lossy().as_ref());
        let file = StorageFile::GetFileFromPathAsync(&p)
            .map_err(|e| e.to_string())?
            .await
            .map_err(|e| e.to_string())?;
        let stream = file
            .OpenAsync(FileAccessMode::Read)
            .map_err(|e| e.to_string())?
            .await
            .map_err(|e| e.to_string())?;
        // windows 0.62 里 HeifDecoderId() 返回 Result<GUID>,需要先拆出来。
        let decoder_id = BitmapDecoder::HeifDecoderId().map_err(|e| e.to_string())?;
        let decoder = BitmapDecoder::CreateWithIdAsync(decoder_id, &stream)
            .map_err(|e| e.to_string())?
            .await
            .map_err(|e| e.to_string())?;
        let w = decoder.PixelWidth().map_err(|e| e.to_string())?;
        let h = decoder.PixelHeight().map_err(|e| e.to_string())?;

        // 直接向解码器要 RGBA8 像素数据,而不是走 SoftwareBitmap + LockBuffer + DataReader。
        // 后者要靠 COM 接口拆箱(IMemoryBufferReference → IBuffer),在不同 windows 版本间
        // 层次签名经常变,这里用取像素数据的 API 更稳。
        // 注意用 IgnoreExifOrientation:这样返回的宽高一定等于解码器的 PixelWidth/Height,
        // 不会因 EXIF 旋转被掉换导致字节数与画布对不上;方向随后按 EXIF 自己摆正。
        // windows 0.62 里 BitmapTransform 是运行时类,只能用 new() 构造再逐个设字段。
        let transform = BitmapTransform::new().map_err(|e| e.to_string())?;
        let provider = decoder
            .GetPixelDataTransformedAsync(
                BitmapPixelFormat::Rgba8,
                BitmapAlphaMode::Premultiplied,
                &transform,
                ExifOrientationMode::IgnoreExifOrientation,
                ColorManagementMode::ColorManageToSRgb,
            )
            .map_err(|e| e.to_string())?
            .await
            .map_err(|e| e.to_string())?;
        let bytes = provider.DetachPixelData().map_err(|e| e.to_string())?;
        let bytes: Vec<u8> = bytes.to_vec();
        let rgba = image::RgbaImage::from_raw(w, h, bytes)
            .ok_or_else(|| format!("HEIC 像素数据尺寸不符({w}x{h})"))?;
        let mut img = DynamicImage::ImageRgba8(rgba);
        img.apply_orientation(
            image::metadata::Orientation::from_exif(orientation.unwrap_or(1) as u8)
                .unwrap_or(image::metadata::Orientation::NoTransforms),
        );
        Ok(img)
    })
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
