//! 一次性验证工具：对真实照片库跑一遍动态照片补扫。
//!
//! 用法（在 src-tauri 目录）：
//!   cargo run --example relink -- "C:/Users/<user>/AppData/Roaming/org.stellarmemories.app"
//!
//! 只读源照片、写库里的 live_video_id 与 data_dir/live/*.mp4。

use std::path::PathBuf;

fn main() {
    let base = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .expect("需要传入应用数据目录");
    let db = stellar_memories_lib::db::open(&base).expect("打开数据库失败");
    let started = std::time::Instant::now();
    let (tried, done) = stellar_memories_lib::motion::backfill(&db, &base, 5000);
    println!(
        "检查 {tried} 张，关联 {done} 张，耗时 {:?}",
        started.elapsed()
    );
}
