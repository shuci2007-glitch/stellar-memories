use image::{DynamicImage, GenericImageView};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use std::path::Path;

/// 粒子质量档位 → 目标粒子数
pub fn tier_count(tier: &str) -> u32 {
    match tier {
        "low" => 8_000,
        "medium" => 16_000,
        "high" => 32_000,
        "ultra" => 64_000,
        _ => 16_000,
    }
}

pub const SAMPLE_SIZE: u32 = 256;
const MAGIC: u32 = 0x434D5342; // "SMPC" LE
const VERSION: u32 = 1;

/// 重要性采样生成粒子缓存。
/// 重要性 = 0.55·归一化 Sobel 边缘 + 0.30·亮度^0.85 + 0.15·饱和度,近黑抑制。
/// 8×8 块内按重要性比例分配 + 网格抖动;以 photo_id 为种子保证缓存确定性。
pub fn generate(
    img: &DynamicImage,
    photo_id: i64,
    tier: &str,
    out: &Path,
) -> Result<(u32, String), String> {
    let count = tier_count(tier);
    let small = thumbs_resize(img, SAMPLE_SIZE);
    let rgb = small.to_rgb8();
    let (w, h) = (rgb.width() as usize, rgb.height() as usize);
    if w == 0 || h == 0 {
        return Err("空图像".into());
    }

    // 亮度 / 饱和度
    let mut lum = vec![0f32; w * h];
    let mut sat = vec![0f32; w * h];
    for (i, px) in rgb.pixels().enumerate() {
        let r = px[0] as f32 / 255.0;
        let g = px[1] as f32 / 255.0;
        let b = px[2] as f32 / 255.0;
        lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
        let mx = r.max(g).max(b);
        let mn = r.min(g).min(b);
        sat[i] = if mx > 0.0 { (mx - mn) / mx } else { 0.0 };
    }

    // Sobel
    let mut edge = vec![0f32; w * h];
    let mut max_edge = 1e-6f32;
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let at = |xx: usize, yy: usize| lum[yy * w + xx];
            let gx = at(x - 1, y - 1) + 2.0 * at(x - 1, y) + at(x - 1, y + 1)
                - at(x + 1, y - 1) - 2.0 * at(x + 1, y) - at(x + 1, y + 1);
            let gy = at(x - 1, y - 1) + 2.0 * at(x, y - 1) + at(x + 1, y - 1)
                - at(x - 1, y + 1) - 2.0 * at(x, y + 1) - at(x + 1, y + 1);
            let v = (gx * gx + gy * gy).sqrt();
            edge[y * w + x] = v;
            max_edge = max_edge.max(v);
        }
    }

    // 重要性图
    let mut weight = vec![0f32; w * h];
    let mut total_w = 0f64;
    for i in 0..w * h {
        let e = edge[i] / max_edge;
        let l = lum[i].powf(0.85);
        let mut wi = 0.55 * e + 0.30 * l + 0.15 * sat[i];
        if lum[i] < 0.035 {
            wi *= 0.12; // 近黑抑制
        }
        weight[i] = wi;
        total_w += wi as f64;
    }
    if total_w <= 0.0 {
        // 全黑图:均匀采样
        for wi in weight.iter_mut() {
            *wi = 1.0;
        }
    }

    // 累积分布用于加权采样
    let mut cdf = vec![0f64; w * h];
    let mut acc = 0f64;
    for i in 0..w * h {
        acc += weight[i] as f64;
        cdf[i] = acc;
    }

    let mut rng = ChaCha8Rng::seed_from_u64(photo_id as u64 ^ 0x5A17_5A17_0000_0000);
    let mut records: Vec<u8> = Vec::with_capacity(count as usize * 8);

    for _ in 0..count {
        // 加权随机选一个像素
        let pick = rng.gen::<f64>() * acc;
        let idx = match cdf.binary_search_by(|v| v.partial_cmp(&pick).unwrap()) {
            Ok(i) => i,
            Err(i) => i.min(w * h - 1),
        };
        let px = idx % w;
        let py = idx / w;

        let jitter_x: f32 = rng.gen();
        let jitter_y: f32 = rng.gen();
        let fx = (px as f32 + jitter_x) / w as f32; // 0..1
        let fy = (py as f32 + jitter_y) / h as f32;

        let p = rgb.get_pixel(px as u32, py as u32);
        let imp = (weight[idx].min(1.0) * 255.0) as u8;
        // size: 4bit, importance 4bit
        let base_size: f32 = 0.45 + rng.gen::<f32>() * 0.25 + (imp as f32 / 255.0) * 0.30;
        let size_bits = (base_size * 15.0).clamp(0.0, 15.0) as u8;
        let imp_bits = imp >> 4;

        let fx16 = ((fx * u16::MAX as f32).round() as u16).to_le_bytes();
        let fy16 = ((fy * u16::MAX as f32).round() as u16).to_le_bytes();
        records.extend_from_slice(&fx16);
        records.extend_from_slice(&fy16);
        records.push(p[0]);
        records.push(p[1]);
        records.push(p[2]);
        records.push((size_bits << 4) | imp_bits);
    }

    // 文件头
    let mut out_bytes = Vec::with_capacity(16 + records.len());
    out_bytes.extend_from_slice(&MAGIC.to_le_bytes());
    out_bytes.extend_from_slice(&VERSION.to_le_bytes());
    out_bytes.extend_from_slice(&(count).to_le_bytes());
    out_bytes.extend_from_slice(&(w as u32).to_le_bytes());
    out_bytes.extend_from_slice(&(h as u32).to_le_bytes());
    out_bytes.extend_from_slice(&records);

    std::fs::write(out, out_bytes).map_err(|e| format!("写粒子缓存失败: {e}"))?;

    Ok((count, format!("{}_{}", tier, count)))
}

fn thumbs_resize(img: &DynamicImage, max: u32) -> DynamicImage {
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
