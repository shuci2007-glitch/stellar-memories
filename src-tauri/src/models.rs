use serde::{Deserialize, Serialize};

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    pub id: i64,
    pub path: String,
    pub filename: String,
    pub width: i64,
    pub height: i64,
    pub thumb_path: Option<String>,
    pub particle_path: Option<String>,
    pub avg_color: Option<String>,
    pub score: f64,
    pub capture_date: Option<String>,
    pub date_source: Option<String>,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub iso: Option<i64>,
    pub shutter: Option<String>,
    pub aperture: Option<String>,
    pub focal: Option<String>,
    pub starred: bool,
    pub missing: bool,
    pub imported: bool,
    /// photo | video
    #[serde(default = "default_kind")]
    pub kind: String,
    /// 缩略图 / 粒子是否已生成;大批量导入时先入库、后补处理
    #[serde(default)]
    pub processed: bool,
    #[serde(default)]
    pub duration: Option<f64>,
    /// 实况照片:静帧(photo)指向配对的动态(mov/video)的 id;普通照片为空
    #[serde(default)]
    pub live_video_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

fn default_kind() -> String {
    "photo".to_string()
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    #[serde(default)]
    pub galaxy_config: Option<String>,
    #[serde(default)]
    pub photo_ids: Vec<i64>,
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub cover_photo_id: Option<i64>,
    pub auto: bool,
    pub sort_order: f64,
    pub photo_count: i64,
    pub created_at: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub photo_id: i64,
    pub title: Option<String>,
    pub text: Option<String>,
    pub location: Option<String>,
    pub mood: Option<String>,
    pub updated_at: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoConnection {
    pub id: i64,
    pub photo_a: i64,
    pub photo_b: i64,
    pub kind: String,
    pub strength: f64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryPhoto {
    pub id: i64,
    pub album_id: Option<i64>,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub avg_color: Option<String>,
    pub capture_date: Option<String>,
    pub starred: bool,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExifInfo {
    pub capture_date: Option<String>,
    pub date_source: Option<String>,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub iso: Option<i64>,
    pub shutter: Option<String>,
    pub aperture: Option<String>,
    pub focal: Option<String>,
    pub orientation: Option<u32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}
