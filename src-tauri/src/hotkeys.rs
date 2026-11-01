//! 桌面全局快捷键:在壁纸运行时提供两个一键操作。
//!
//! - Ctrl+Alt+H:隐藏所有软件与桌面图标(只留动态壁纸),再按一次恢复。
//! - Ctrl+Alt+T:在壁纸画面内叠加/关闭时间轴。
//!
//! 与「退出壁纸」(Ctrl+Alt+Shift+W) 一起在 lib.rs 的全局快捷键处理器里分发。

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
mod ffi {
    use std::ffi::c_void;
    type Hwnd = isize;
    const VK_LWIN: u8 = 0x5B;
    const KEYEVENTF_KEYUP: u32 = 0x0002;
    const SW_HIDE: i32 = 0;
    const SW_SHOW: i32 = 5;

    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(class: *const u16, name: *const u16) -> Hwnd;
        fn FindWindowExW(parent: Hwnd, after: Hwnd, class: *const u16, name: *const u16) -> Hwnd;
        fn ShowWindow(hwnd: Hwnd, cmd: i32) -> i32;
        fn keybd_event(code: u8, scan: u8, flags: u32, extra: *const c_void);
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 找到承载桌面图标的 WorkerW(带 SHELLDLL_DefView 的那个),切换其可见性。
    pub fn set_desktop_icons_visible(visible: bool) {
        unsafe {
            let progman = FindWindowW(wide("Progman").as_ptr(), std::ptr::null());
            if progman == 0 {
                return;
            }
            let mut after: Hwnd = 0;
            loop {
                let w = FindWindowExW(progman, after, wide("WorkerW").as_ptr(), std::ptr::null());
                if w == 0 {
                    break;
                }
                after = w;
                let def = FindWindowExW(w, 0, wide("SHELLDLL_DefView").as_ptr(), std::ptr::null());
                if def != 0 {
                    ShowWindow(w, if visible { SW_SHOW } else { SW_HIDE });
                    break;
                }
            }
        }
    }

    /// 模拟 Win+D 切换「显示桌面」(最小化/还原所有窗口)。
    pub fn toggle_show_desktop() {
        unsafe {
            keybd_event(VK_LWIN, 0, 0, std::ptr::null());
            keybd_event(0x44, 0, 0, std::ptr::null()); // 'D'
            keybd_event(0x44, 0, KEYEVENTF_KEYUP, std::ptr::null());
            keybd_event(VK_LWIN, 0, KEYEVENTF_KEYUP, std::ptr::null());
        }
    }
}

#[cfg(not(windows))]
mod ffi {
    pub fn set_desktop_icons_visible(_visible: bool) {}
    pub fn toggle_show_desktop() {}
}

static CLEARED: AtomicBool = AtomicBool::new(false);

/// Ctrl+Alt+H:清空桌面(隐藏软件 + 图标),再按一次恢复。
pub fn toggle_desktop_clear() {
    ffi::toggle_show_desktop();
    let clearing = !CLEARED.load(Ordering::SeqCst);
    ffi::set_desktop_icons_visible(!clearing);
    CLEARED.store(clearing, Ordering::SeqCst);
}

static TIMELINE_ON: AtomicBool = AtomicBool::new(false);

/// Ctrl+Alt+T:在壁纸窗口内切换时间轴叠加层。
pub fn toggle_wallpaper_timeline(app: &AppHandle) {
    let on = !TIMELINE_ON.load(Ordering::SeqCst);
    TIMELINE_ON.store(on, Ordering::SeqCst);
    let _ = app.emit("wallpaper:timeline", on);
}
