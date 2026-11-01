//! 动态壁纸:把渲染窗口挂到 Explorer 的 WorkerW 桌面层后面。
//!
//! 原理:Explorer 的桌面由 `Progman` 与若干 `WorkerW` 组成,最底层那个 WorkerW
//! 承载壁纸、上面一层承载桌面图标。向 Progman 发 0x052C 会让 Windows 把
//! 图标层与壁纸层拆开,此时把我们的窗口 SetParent 到壁纸层的 WorkerW,
//! 窗口就永远待在图标后面、且不会抢焦点。
//!
//! Explorer 重启会重建 WorkerW,所以这里有一个看门狗线程定期校验父子关系并重新挂载,
//! 否则壁纸会变成一块黑屏。

use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::thread::ThreadId;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// 主线程标识。窗口必须在主线程创建:Tauri 的 async 命令跑在 tokio 工作线程上,
/// 在那里初始化 WebView2 会直接失败并报 ERROR_INVALID_STATE(0x8007139F)。
static MAIN_THREAD: OnceLock<ThreadId> = OnceLock::new();

/// 在 setup(确定跑在主线程)里调用一次,之后才能判断当前是不是主线程。
pub fn mark_main_thread() {
    let _ = MAIN_THREAD.set(std::thread::current().id());
}

fn on_main_thread() -> bool {
    MAIN_THREAD.get() == Some(&std::thread::current().id())
}

pub struct WallpaperManager {
    running: AtomicBool,
    /// (窗口标签, HWND, 显示器序号)
    windows: Mutex<Vec<WindowSlot>>,
}

#[derive(Clone)]
struct WindowSlot {
    label: String,
    hwnd: isize,
    monitor: usize,
}

impl WallpaperManager {
    pub fn new() -> Self {
        Self {
            running: AtomicBool::new(false),
            windows: Mutex::new(Vec::new()),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}

fn window_title(index: usize) -> String {
    format!("STELLAR_WALLPAPER_{index}")
}

/// 读取每个显示器的桌面矩形。
fn monitor_rects(app: &AppHandle) -> Result<Vec<(i32, i32, i32, i32)>, String> {
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("无法读取显示器信息: {e}"))?;
    if monitors.is_empty() {
        return Err("没有找到可用显示器".into());
    }
    Ok(monitors
        .iter()
        .map(|m| {
            (
                m.position().x,
                m.position().y,
                m.size().width as i32,
                m.size().height as i32,
            )
        })
        .collect())
}

/// 真正在主线程里搭窗口。
fn build_window(app: &AppHandle, label: &str, title: &str, rect: (i32, i32, i32, i32)) -> Result<(), String> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("wallpaper.html".into()))
        .title(title)
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .shadow(false)
        // 先隐藏建好,挂到桌面层后由 SetWindowPos 显示,避免在桌面上闪一下。
        .visible(false)
        .inner_size(rect.2.max(1) as f64, rect.3.max(1) as f64)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 创建单个壁纸窗口并返回 HWND。
///
/// 这里绕开了两个坑:
/// 1) Tauri 的 async 命令跑在 tokio 工作线程上,WebView2 在那里初始化会失败并报
///    ERROR_INVALID_STATE(0x8007139F),所以必须把创建动作丢回主线程;
/// 2) 上一个实例还没关干净就立刻重建,同样会把 WebView2 拖进错误状态,
///    所以先轮询等到旧窗口真的消失,失败再退避重试。
fn create_wallpaper_window(
    app: &AppHandle,
    index: usize,
    rect: (i32, i32, i32, i32),
) -> Result<isize, String> {
    let label = format!("wallpaper-{index}");
    let title = window_title(index);

    // 等旧窗口彻底关掉(最多 3 秒),否则重建会撞上 0x8007139F。
    for _ in 0..60 {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.close();
            std::thread::sleep(Duration::from_millis(50));
        } else {
            break;
        }
    }

    let mut last_err = String::new();
    for attempt in 0..3u32 {
        if on_main_thread() {
            // 已经在主线程就不能再投递给自己再等回执,那会一直卡到超时。
            last_err = match build_window(app, &label, &title, rect) {
                Ok(()) => String::new(),
                Err(e) => e,
            };
        } else {
            let (tx, rx) = mpsc::channel();
            let (app_c, label_c, title_c) = (app.clone(), label.clone(), title.clone());
            if let Err(e) = app.run_on_main_thread(move || {
                let res = build_window(&app_c, &label_c, &title_c, rect);
                let _ = tx.send(res);
            }) {
                return Err(format!("调度主线程失败: {e}"));
            }
            last_err = match rx.recv_timeout(Duration::from_secs(15)) {
                Ok(Ok(())) => String::new(),
                Ok(Err(e)) => e,
                Err(_) => "创建窗口超时".to_string(),
            };
        }
        if last_err.is_empty() {
            break;
        }
        if attempt < 2 {
            std::thread::sleep(Duration::from_millis(400 * (attempt as u64 + 1)));
        }
    }
    if !last_err.is_empty() {
        return Err(format!("壁纸窗口创建失败: {last_err}"));
    }

    // 窗口刚建好,HWND 可能要过一个消息周期才登记出来,轮询兜一下。
    for _ in 0..40 {
        if let Some(h) = ffi::find_by_title(&title) {
            return Ok(h);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err("找不到壁纸窗口句柄".to_string())
}

/// 创建每个显示器一个窗口,并挂到对应桌面上。
pub fn start(app: &AppHandle, manager: &Arc<WallpaperManager>) -> Result<usize, String> {
    if manager.is_running() {
        return Ok(manager.windows.lock().len());
    }
    // 先占位再干活:建窗要一两秒,期间第二次点击会绕过上面的判断,
    // 结果是两套窗口叠在桌面上(日志里出现两次 attach 就是这个原因)。
    manager.running.store(true, Ordering::SeqCst);
    let fail = |e: String| -> Result<usize, String> {
        manager.running.store(false, Ordering::SeqCst);
        Err(e)
    };
    let rects = monitor_rects(app).map_err(|e| {
        manager.running.store(false, Ordering::SeqCst);
        e
    })?;

    // 先确认能拿到桌面壁纸层,拿不到就不用白建一堆窗口了。
    let hosts = ffi::prepare_hosts();
    if hosts.is_empty() {
        return fail("无法定位桌面壁纸层（Explorer 可能未正常启动）".into());
    }

    let mut slots: Vec<WindowSlot> = Vec::new();
    for (index, rect) in rects.iter().enumerate() {
        match create_wallpaper_window(app, index, *rect) {
            Ok(hwnd) => slots.push(WindowSlot {
                label: format!("wallpaper-{index}"),
                hwnd,
                monitor: index,
            }),
            Err(e) => {
                // 已建出来的要收干净,别在桌面留下半截窗口。
                for s in &slots {
                    ffi::detach(s.hwnd);
                    let _ = app.get_webview_window(&s.label).map(|w| w.close());
                }
                ffi::redraw_desktop();
                return fail(e);
            }
        }
    }

    let mut attached = 0usize;
    for slot in &slots {
        let host = ffi::attach(slot.hwnd, rects[slot.monitor], &hosts);
        if host == 0 {
            continue;
        }
        // 只靠 SWP_SHOWWINDOW 只显示了个空窗口壳:WebView2 控制器的可见性是
        // Tauri 自己管的,必须走一次 show() 才会真正开始呈现内容。
        if let Some(w) = app.get_webview_window(&slot.label) {
            if let Err(e) = w.show() {
                println!("[wallpaper] show 失败: {e}");
            }
        }
        // show() 之后必须复核:父子关系一旦丢了,这个窗口就会盖在所有软件上面。
        if !ffi::enforce(slot.hwnd, rects[slot.monitor], host) {
            println!("[wallpaper] show() 之后父子关系丢失，收起窗口以免遮挡桌面");
            if let Some(w) = app.get_webview_window(&slot.label) {
                let _ = w.hide();
            }
            continue;
        }
        attached += 1;
    }
    println!(
        "[wallpaper] 显示器 {} 个，候选层 {} 个，成功挂载 {} 个",
        rects.len(),
        hosts.len(),
        attached
    );
    if attached == 0 {
        for s in &slots {
            ffi::detach(s.hwnd);
            let _ = app.get_webview_window(&s.label).map(|w| w.close());
        }
        ffi::redraw_desktop();
        return fail(format!(
            "壁纸窗口已创建，但没能挂到桌面层（显示器 {} 个 / 候选层 {} 个）。请把这行数字发我。",
            rects.len(),
            hosts.len()
        ));
    }

    *manager.windows.lock() = slots;
    spawn_watchdog(app.clone(), manager.clone());
    Ok(manager.windows.lock().len())
}

pub fn stop(app: &AppHandle, manager: &Arc<WallpaperManager>) {
    manager.running.store(false, Ordering::SeqCst);
    let slots: Vec<WindowSlot> = std::mem::take(&mut *manager.windows.lock());
    for slot in slots {
        ffi::detach(slot.hwnd);
        if let Some(win) = app.get_webview_window(&slot.label) {
            let _ = win.close();
        }
    }
    // 把被我们抢走的桌面层还给 Explorer
    ffi::redraw_desktop();
}

/// 看门狗:Explorer 重启后 WorkerW 会消失,这里定期校验并重新挂载。
fn spawn_watchdog(app: AppHandle, manager: Arc<WallpaperManager>) {
    std::thread::spawn(move || {
        let mut ticks: u32 = 0;
        while manager.is_running() {
            std::thread::sleep(std::time::Duration::from_millis(3000));
            ticks = ticks.wrapping_add(1);
            if !manager.is_running() {
                break;
            }
            let broken = {
                let slots = manager.windows.lock();
                slots
                    .iter()
                    .any(|slot| !ffi::still_attached(slot.hwnd))
            };
            if !broken || ticks % 2 != 0 {
                continue;
            }
            let hosts = ffi::prepare_hosts();
            if hosts.is_empty() {
                continue;
            }
            let monitors = match app.available_monitors() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let slots = { manager.windows.lock().clone() };
            for slot in slots {
                let Some(monitor) = monitors.get(slot.monitor) else {
                    continue;
                };
                let rect = (
                    monitor.position().x,
                    monitor.position().y,
                    monitor.size().width as i32,
                    monitor.size().height as i32,
                );
                let host = ffi::attach(slot.hwnd, rect, &hosts);
                if host != 0 {
                    ffi::enforce(slot.hwnd, rect, host);
                } else if let Some(w) = app.get_webview_window(&slot.label) {
                    // 挂不回去就先藏起来:一个没有父窗口的全屏窗口会盖住所有软件。
                    let _ = w.hide();
                }
            }
        }
    });
}

// ---------------------------------------------------------------- 原生窗口调用

#[cfg(windows)]
mod ffi {
    use std::ffi::c_void;

    type Hwnd = isize;
    type Hmonitor = isize;

    const GWL_STYLE: i32 = -16;
    const GWL_EXSTYLE: i32 = -20;
    const WS_CHILD: i32 = 0x4000_0000;
    const WS_POPUP: i32 = 0x8000_0000u32 as i32;
    const WS_EX_NOACTIVATE: i32 = 0x0800_0000;
    const WS_EX_TOOLWINDOW: i32 = 0x0000_0080;

    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_FRAMECHANGED: u32 = 0x0020;
    const SWP_SHOWWINDOW: u32 = 0x0040;
    const HWND_TOP: Hwnd = 0;

    const SMTO_NORMAL: u32 = 0x0000;
    const MONITOR_DEFAULTTONEAREST: u32 = 2;

    #[repr(C)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(class: *const u16, name: *const u16) -> Hwnd;
        fn FindWindowExW(parent: Hwnd, after: Hwnd, class: *const u16, name: *const u16) -> Hwnd;
        fn GetClassNameW(hwnd: Hwnd, buf: *mut u16, max: i32) -> i32;
        fn GetParent(hwnd: Hwnd) -> Hwnd;
        fn SetParent(hwnd: Hwnd, parent: Hwnd) -> Hwnd;
        fn IsWindow(hwnd: Hwnd) -> i32;
        fn IsWindowVisible(hwnd: Hwnd) -> i32;
        fn ShowWindow(hwnd: Hwnd, cmd: i32) -> i32;
        fn GetWindowRect(hwnd: Hwnd, rect: *mut Rect) -> i32;
        fn GetWindowLongW(hwnd: Hwnd, index: i32) -> i32;
        fn SetWindowLongW(hwnd: Hwnd, index: i32, value: i32) -> i32;
        fn SetWindowPos(
            hwnd: Hwnd,
            after: Hwnd,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
        fn SendMessageTimeoutW(
            hwnd: Hwnd,
            msg: u32,
            wparam: usize,
            lparam: isize,
            flags: u32,
            timeout: u32,
            result: *mut usize,
        ) -> isize;
        fn MonitorFromWindow(hwnd: Hwnd, flags: u32) -> Hmonitor;
        fn MonitorFromPoint(point: Point, flags: u32) -> Hmonitor;
        fn SystemParametersInfoW(action: u32, param: u32, data: *mut c_void, winini: u32) -> i32;
        fn InvalidateRect(hwnd: Hwnd, rect: *const Rect, erase: i32) -> i32;
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn class_of(hwnd: Hwnd) -> String {
        let mut buf = [0u16; 64];
        let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        if n <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..n as usize])
    }

    pub fn find_by_title(title: &str) -> Option<Hwnd> {
        let name = wide(title);
        let hwnd = unsafe { FindWindowW(std::ptr::null(), name.as_ptr()) };
        (hwnd != 0).then_some(hwnd)
    }

    /// 向上回溯父窗口,确认 hwnd 最终属于 Progman 子树(真正的桌面层)。
    /// 只有 Progman 的子窗口才保证位于所有普通软件之下;一旦不是,就绝不能显示。
    fn is_desktop_descendant(hwnd: Hwnd) -> bool {
        unsafe {
            let progman = FindWindowW(wide("Progman").as_ptr(), std::ptr::null());
            let mut cur = hwnd;
            for _ in 0..40 {
                if cur == 0 {
                    return false;
                }
                if progman != 0 && cur == progman {
                    return true;
                }
                cur = GetParent(cur);
            }
            false
        }
    }

    /// 触发 Explorer 拆出壁纸层,并返回所有候选的桌面层窗口。
    ///
    /// 关键:只认 Progman 的**直接子窗口**里的 WorkerW。WorkerW 有两种——
    /// 一种带 SHELLDLL_DefView(桌面图标层,在壁纸之上),一种不带(纯壁纸层)。
    /// 我们要的是后者,且它必须是 Progman 的子树,这样挂上去才一定在所有软件之下。
    ///
    /// 之前用 EnumWindows 枚举所有顶层 WorkerW,在某些环境会捞到一些并不在
    /// Progman 子树里的同名窗口,挂上去反而盖住软件。
    pub fn prepare_hosts() -> Vec<Hwnd> {
        let progman = unsafe { FindWindowW(wide("Progman").as_ptr(), std::ptr::null()) };
        if progman == 0 {
            return Vec::new();
        }
        // 0x052C = 让 Explorer 把图标层与壁纸层拆开,生成独立的壁纸 WorkerW。
        unsafe {
            let mut result: usize = 0;
            SendMessageTimeoutW(progman, 0x052C, 0, 0, SMTO_NORMAL, 1000, &mut result);
        }
        let mut hosts: Vec<Hwnd> = Vec::new();
        let mut after: Hwnd = 0;
        loop {
            let w =
                unsafe { FindWindowExW(progman, after, wide("WorkerW").as_ptr(), std::ptr::null()) };
            if w == 0 {
                break;
            }
            after = w;
            // 带 SHELLDLL_DefView 的是桌面图标层(在壁纸之上),跳过。
            let has_icons = unsafe {
                FindWindowExW(w, 0, wide("SHELLDLL_DefView").as_ptr(), std::ptr::null()) != 0
            };
            if has_icons {
                continue;
            }
            // 必须可见且覆盖屏幕,否则挂上去也看不见,或挂到 1x1 的内部辅助层。
            let (w_, h_) = window_rect(w).unwrap_or((0, 0));
            if unsafe { IsWindowVisible(w) } != 0 && w_ >= 64 && h_ >= 64 {
                hosts.push(w);
            }
        }
        println!(
            "[wallpaper] Progman 子 WorkerW(非图标层)共 {} 个",
            hosts.len()
        );
        if hosts.is_empty() {
            // 兜底:某些环境 0x052C 不拆层,直接把整个桌面(Progman)当挂载点。
            hosts.push(progman);
        }
        hosts
    }

    fn window_rect(hwnd: Hwnd) -> Option<(i32, i32)> {
        let mut r = Rect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if unsafe { GetWindowRect(hwnd, &mut r) } == 0 {
            return None;
        }
        Some((r.right - r.left, r.bottom - r.top))
    }

    /// 候选层必须真的盖住这块屏幕,而不是某个 1x1 的内部辅助窗口。
    fn covers(hwnd: Hwnd, rect: (i32, i32, i32, i32)) -> bool {
        match window_rect(hwnd) {
            Some((w, h)) => w >= rect.2 / 2 && h >= rect.3 / 2,
            None => false,
        }
    }

    fn monitor_handle(host: Hwnd) -> Hmonitor {
        unsafe { MonitorFromWindow(host, MONITOR_DEFAULTTONEAREST) }
    }

    fn monitor_at(x: i32, y: i32) -> Hmonitor {
        unsafe { MonitorFromPoint(Point { x, y }, MONITOR_DEFAULTTONEAREST) }
    }

    /// 按优先级排出候选层:同显示器 + 覆盖屏幕 + 可见 最优先,其余依次兜底。
    fn ordered_hosts(rect: (i32, i32, i32, i32), hosts: &[Hwnd]) -> Vec<Hwnd> {
        let want = monitor_at(rect.0 + rect.2 / 2, rect.1 + rect.3 / 2);
        let visible = |h: Hwnd| unsafe { IsWindowVisible(h) } != 0;
        let mut out: Vec<Hwnd> = Vec::new();
        let mut push = |h: Hwnd| {
            if !out.contains(&h) {
                out.push(h);
            }
        };
        for h in hosts.iter().copied() {
            if monitor_handle(h) == want && covers(h, rect) && visible(h) {
                push(h);
            }
        }
        for h in hosts.iter().copied() {
            if covers(h, rect) && visible(h) {
                push(h);
            }
        }
        for h in hosts.iter().copied() {
            if visible(h) {
                push(h);
            }
        }
        for h in hosts.iter().copied() {
            push(h);
        }
        out
    }

    /// 挂到桌面层。返回 host(0 表示失败)。
    ///
    /// 关键约束:**只有确认 GetParent 真的是 host 之后才定位/显示**。
    /// 之前不看返回值就直接 `HWND_TOP`,一旦 SetParent 没生效,就会变成一个
    /// 没有父窗口的全屏置顶窗口——盖住所有软件、连鼠标光标都被 cursor:none 吃掉。
    pub fn attach(hwnd: Hwnd, rect: (i32, i32, i32, i32), hosts: &[Hwnd]) -> Hwnd {
        if hosts.is_empty() {
            println!("[wallpaper] 没有可用的桌面层候选");
            return 0;
        }
        unsafe {
            // 永不激活、不进 Alt+Tab:桌面层里的窗口不该抢焦点。
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
            SetWindowLongW(hwnd, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW);
            // 变成子窗口后才会跟随桌面层的可见性,否则可能被 DWM 单独合成。
            let style = GetWindowLongW(hwnd, GWL_STYLE);
            SetWindowLongW(hwnd, GWL_STYLE, (style & !WS_POPUP) | WS_CHILD);

            // 逐个候选试挂:有的 WorkerW 不让外进程 SetParent,试下一个比盲猜一个稳。
            for host in ordered_hosts(rect, hosts) {
                SetParent(hwnd, host);
                if GetParent(hwnd) != host {
                    SetParent(hwnd, host); // 偶发失败,补一次
                }
                let parent = GetParent(hwnd);
                if parent != host {
                    println!("[wallpaper] host={} 挂不上（实际父={}），换下一个", host, parent);
                    continue;
                }
                // 双保险:父窗口本身必须位于 Progman 子树内,否则这个窗口就可能压在普通软件之上。
                if !is_desktop_descendant(hwnd) {
                    println!("[wallpaper] host={} 不在桌面子树内,放弃以免遮挡软件", host);
                    continue;
                }
                // 确认是子窗口了,再在父窗口内部放到最上层(桌面层自己也画壁纸,放下层会被盖住)。
                let ok = SetWindowPos(
                    hwnd,
                    HWND_TOP,
                    rect.0,
                    rect.1,
                    rect.2,
                    rect.3,
                    SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW,
                ) != 0;
                println!(
                    "[wallpaper] attach hwnd={} host={} host类名={} host可见={} host尺寸={:?} 定位={} 自身可见={}",
                    hwnd,
                    host,
                    class_of(host),
                    IsWindowVisible(host),
                    window_rect(host),
                    ok,
                    IsWindowVisible(hwnd)
                );
                if ok {
                    return host;
                }
            }
            println!("[wallpaper] 所有候选层都挂不上,本次不显示壁纸窗口");
            0
        }
    }

    /// show() 之后复核父子关系并重新落位。
    /// Tauri 的 show() 会把窗口抬起来,如果这期间父子关系丢了,必须立刻收手。
    pub fn enforce(hwnd: Hwnd, rect: (i32, i32, i32, i32), host: Hwnd) -> bool {
        unsafe {
            if GetParent(hwnd) != host {
                SetParent(hwnd, host);
            }
            if GetParent(hwnd) != host {
                return false;
            }
            // 建窗时是 visible(false),SWP_SHOWWINDOW 偶尔不认(刚改过子窗口样式),
            // 这里再显式 ShowWindow 一次;用 SW_SHOWNOACTIVATE 保证不抢焦点。
            ShowWindow(hwnd, 4);
            SetWindowPos(
                hwnd,
                HWND_TOP,
                rect.0,
                rect.1,
                rect.2,
                rect.3,
                SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW,
            ) != 0
        }
    }

    pub fn detach(hwnd: Hwnd) {
        unsafe {
            if IsWindow(hwnd) == 0 {
                return;
            }
            SetParent(hwnd, 0);
            let style = GetWindowLongW(hwnd, GWL_STYLE);
            SetWindowLongW(hwnd, GWL_STYLE, (style & !WS_CHILD) | WS_POPUP);
        }
    }

    pub fn still_attached(hwnd: Hwnd) -> bool {
        unsafe {
            if IsWindow(hwnd) == 0 {
                return false;
            }
            let parent = GetParent(hwnd);
            parent != 0 && IsWindow(parent) != 0
        }
    }

    /// 让 Explorer 重绘桌面,避免留下我们窗口的残影。
    pub fn redraw_desktop() {
        let progman = unsafe { FindWindowW(wide("Progman").as_ptr(), std::ptr::null()) };
        if progman != 0 {
            unsafe { InvalidateRect(progman, std::ptr::null(), 0) };
        }
        // 0x0014 = SPI_SETDESKWALLPAPER,带 SPIF_SENDCHANGE 只是让 Explorer 重绘桌面。
        unsafe {
            SystemParametersInfoW(0x0014, 0, std::ptr::null_mut(), 0x0001 | 0x0002);
        }
    }
}

#[cfg(not(windows))]
mod ffi {
    type Hwnd = isize;

    pub fn find_by_title(_title: &str) -> Option<Hwnd> {
        None
    }
    pub fn prepare_hosts() -> Vec<Hwnd> {
        Vec::new()
    }
    pub fn attach(_hwnd: Hwnd, _rect: (i32, i32, i32, i32), _hosts: &[Hwnd]) -> Hwnd {
        0
    }
    pub fn enforce(_hwnd: Hwnd, _rect: (i32, i32, i32, i32), _host: Hwnd) -> bool {
        false
    }
    pub fn detach(_hwnd: Hwnd) {}
    pub fn still_attached(_hwnd: Hwnd) -> bool {
        false
    }
    pub fn redraw_desktop() {}
}
