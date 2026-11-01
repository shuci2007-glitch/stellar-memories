//! 自带 HEIC 解码器(libheif)的极薄 FFI 封装。
//!
//! 为什么不用 `libheif-sys`：它编译期需要 libheif 的头文件 + 导入库，本机没有 MSVC 导入库，
//! 也拉不到。这里改成运行时 `LoadLibrary` + `GetProcAddress` 动态绑定，DLL 直接随安装包分发，
//! 因此 App 在**任何 Windows**(含没装「HEIF Image Extensions」的 LTSC/精简版)都能解 HEIC，
//! 不再依赖系统编解码器。
//!
//! 若 DLL 缺失或任意一步失败，`decode` 会返回 Err，调用方(thumbs::decode_heic)会回退到
//! 系统 WinRT 解码器，App 绝不会因此崩。

use std::ffi::{c_char, c_int, c_void, CStr};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::OnceLock;

use image::{DynamicImage, RgbaImage};
use windows::core::PCSTR;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::System::LibraryLoader::{
    GetProcAddress, LoadLibraryExW, LOAD_WITH_ALTERED_SEARCH_PATH,
};

type HeifContext = c_void;
type HeifImageHandle = c_void;
type HeifImage = c_void;

#[repr(C)]
struct HeifError {
    code: c_int,
    _subcode: c_int,
    message: *const c_char,
}

// libheif 1.19 C API 常量(取自官方 heif.h)
const HEIF_COLORSPACE_RGB: c_int = 1;
const HEIF_CHROMA_INTERLEAVED_RGBA: c_int = 11;
const HEIF_CHANNEL_INTERLEAVED: c_int = 10;

#[repr(C)]
struct DecodingOptions {
    _version: c_int,
    ignore_transformations: u8,
}

#[allow(non_snake_case)]
struct LibHeif {
    heif_init: unsafe extern "system" fn(*const c_void) -> HeifError,
    heif_context_alloc: unsafe extern "system" fn() -> *mut HeifContext,
    heif_context_read_from_memory_without_copy:
        unsafe extern "system" fn(*mut HeifContext, *const c_void, usize, *const c_void) -> HeifError,
    heif_context_get_primary_image_handle:
        unsafe extern "system" fn(*mut HeifContext, *mut *mut HeifImageHandle) -> HeifError,
    heif_image_handle_release: unsafe extern "system" fn(*mut HeifImageHandle),
    heif_decode_image: unsafe extern "system" fn(
        *mut HeifImageHandle,
        *mut *mut HeifImage,
        c_int,
        c_int,
        *const c_void,
    ) -> HeifError,
    heif_image_release: unsafe extern "system" fn(*mut HeifImage),
    heif_image_get_width: unsafe extern "system" fn(*mut HeifImage, c_int) -> c_int,
    heif_image_get_height: unsafe extern "system" fn(*mut HeifImage, c_int) -> c_int,
    heif_image_get_plane_readonly:
        unsafe extern "system" fn(*mut HeifImage, c_int, *mut usize) -> *const u8,
    heif_decoding_options_alloc: unsafe extern "system" fn() -> *mut c_void,
    heif_decoding_options_free: unsafe extern "system" fn(*mut c_void),
    heif_context_free: unsafe extern "system" fn(*mut HeifContext),
}

fn wide(p: &Path) -> Vec<u16> {
    p.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// 候选 DLL 目录：测试用 LIBHEIF_DIR、打包后用 TAURI_RESOURCE_DIR/heif、最后是 exe 旁的 heif/。
fn dll_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(d) = std::env::var("LIBHEIF_DIR") {
        dirs.push(PathBuf::from(d));
    }
    if let Ok(rd) = std::env::var("TAURI_RESOURCE_DIR") {
        dirs.push(Path::new(&rd).join("heif"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.join("heif"));
        }
    }
    dirs
}

fn err_to_string(e: HeifError) -> String {
    if e.message.is_null() {
        format!("heif error code {}", e.code)
    } else {
        unsafe { CStr::from_ptr(e.message).to_string_lossy().into_owned() }
    }
}

/// 取导出函数指针：找不到返回 null。windows 0.62 的 GetProcAddress 直接返回 FARPROC(=Option<fn>)。
unsafe fn sym(module: HMODULE, name: &[u8]) -> *mut c_void {
    match GetProcAddress(module, PCSTR::from_raw(name.as_ptr())) {
        Some(f) => f as *mut c_void,
        None => ptr::null_mut(),
    }
}

/// 把导出的裸指针 transmute 成具体函数指针类型。
macro_rules! fnptr {
    ($p:expr, $t:ty) => {
        std::mem::transmute::<*mut c_void, $t>($p)
    };
}

fn load_lib() -> Option<LibHeif> {
    for dir in dll_search_dirs() {
        let candidate = dir.join("libheif.dll");
        if !candidate.exists() {
            continue;
        }
        let w = wide(&candidate);
        let handle = unsafe {
            LoadLibraryExW(
                windows::core::PCWSTR::from_raw(w.as_ptr()),
                None,
                LOAD_WITH_ALTERED_SEARCH_PATH,
            )
            .ok()?
        };

        unsafe {
        let heif_init = fnptr!(sym(handle, b"heif_init\0"), unsafe extern "system" fn(*const c_void) -> HeifError);
        let heif_context_alloc = fnptr!(sym(handle, b"heif_context_alloc\0"), unsafe extern "system" fn() -> *mut HeifContext);
        let heif_context_read_from_memory_without_copy = fnptr!(
            sym(handle, b"heif_context_read_from_memory_without_copy\0"),
            unsafe extern "system" fn(*mut HeifContext, *const c_void, usize, *const c_void) -> HeifError
        );
        let heif_context_get_primary_image_handle = fnptr!(
            sym(handle, b"heif_context_get_primary_image_handle\0"),
            unsafe extern "system" fn(*mut HeifContext, *mut *mut HeifImageHandle) -> HeifError
        );
        let heif_image_handle_release = fnptr!(sym(handle, b"heif_image_handle_release\0"), unsafe extern "system" fn(*mut HeifImageHandle));
        let heif_decode_image = fnptr!(
            sym(handle, b"heif_decode_image\0"),
            unsafe extern "system" fn(*mut HeifImageHandle, *mut *mut HeifImage, c_int, c_int, *const c_void) -> HeifError
        );
        let heif_image_release = fnptr!(sym(handle, b"heif_image_release\0"), unsafe extern "system" fn(*mut HeifImage));
        let heif_image_get_width = fnptr!(sym(handle, b"heif_image_get_width\0"), unsafe extern "system" fn(*mut HeifImage, c_int) -> c_int);
        let heif_image_get_height = fnptr!(sym(handle, b"heif_image_get_height\0"), unsafe extern "system" fn(*mut HeifImage, c_int) -> c_int);
        let heif_image_get_plane_readonly = fnptr!(
            sym(handle, b"heif_image_get_plane_readonly\0"),
            unsafe extern "system" fn(*mut HeifImage, c_int, *mut usize) -> *const u8
        );
        let heif_decoding_options_alloc = fnptr!(sym(handle, b"heif_decoding_options_alloc\0"), unsafe extern "system" fn() -> *mut c_void);
        let heif_decoding_options_free = fnptr!(sym(handle, b"heif_decoding_options_free\0"), unsafe extern "system" fn(*mut c_void));
        let heif_context_free = fnptr!(sym(handle, b"heif_context_free\0"), unsafe extern "system" fn(*mut HeifContext));

        // 任一关键符号缺失都视为不可用,交给上层回退。
        if heif_init as usize == 0
            || heif_context_alloc as usize == 0
            || heif_context_read_from_memory_without_copy as usize == 0
            || heif_context_get_primary_image_handle as usize == 0
            || heif_decode_image as usize == 0
            || heif_image_get_plane_readonly as usize == 0
            || heif_decoding_options_alloc as usize == 0
            || heif_context_free as usize == 0
        {
            return None;
        }

        return Some(LibHeif {
            heif_init,
            heif_context_alloc,
            heif_context_read_from_memory_without_copy,
            heif_context_get_primary_image_handle,
            heif_image_handle_release,
            heif_decode_image,
            heif_image_release,
            heif_image_get_width,
            heif_image_get_height,
            heif_image_get_plane_readonly,
            heif_decoding_options_alloc,
            heif_decoding_options_free,
            heif_context_free,
        });
        }
    }
    None
}

fn get_lib() -> Option<&'static LibHeif> {
    static LIB: OnceLock<Option<LibHeif>> = OnceLock::new();
    LIB.get_or_init(load_lib).as_ref()
}

/// 用自带 libheif 解码 HEIC/HEIF 静帧为 RGBA8 `DynamicImage`，方向由 `orientation`(来自 EXIF) 应用。
pub fn decode(path: &Path, orientation: Option<u32>) -> Result<DynamicImage, String> {
    let lib = get_lib().ok_or_else(|| "libheif 未加载(未找到 vendor DLL)".to_string())?;
    unsafe { decode_inner(lib, path, orientation) }
}

unsafe fn decode_inner(
    lib: &LibHeif,
    path: &Path,
    orientation: Option<u32>,
) -> Result<DynamicImage, String> {
    // 初始化(参数可空)
    let _ = (lib.heif_init)(ptr::null());

    let ctx = (lib.heif_context_alloc)();
    if ctx.is_null() {
        return Err("heif_context_alloc 失败".into());
    }

    let buf = std::fs::read(path).map_err(|e| format!("读取文件失败: {e}"))?;
    // without_copy 会持有 buf 引用,必须保证 buf 在解码期间存活(本函数结束前都不释放)。
    let err = (lib.heif_context_read_from_memory_without_copy)(
        ctx,
        buf.as_ptr() as *const c_void,
        buf.len(),
        ptr::null(),
    );
    if err.code != 0 {
        let m = err_to_string(err);
        (lib.heif_context_free)(ctx);
        return Err(format!("读取 HEIF 容器失败: {m}"));
    }

    let mut handle: *mut HeifImageHandle = ptr::null_mut();
    let err = (lib.heif_context_get_primary_image_handle)(ctx, &mut handle);
    if err.code != 0 || handle.is_null() {
        let m = err_to_string(err);
        (lib.heif_context_free)(ctx);
        return Err(format!("取主图像句柄失败: {m}"));
    }

    // 关闭 libheif 自带的方向变换,拿回未旋转的「原始像素」,方向由 EXIF 自行处理(与 JPEG 流程一致)。
    let opts = (lib.heif_decoding_options_alloc)();
    if !opts.is_null() {
        let p = opts as *mut DecodingOptions;
        (*p).ignore_transformations = 1;
    }

    let mut img: *mut HeifImage = ptr::null_mut();
    let err = (lib.heif_decode_image)(
        handle,
        &mut img,
        HEIF_COLORSPACE_RGB,
        HEIF_CHROMA_INTERLEAVED_RGBA,
        opts,
    );
    if !opts.is_null() {
        (lib.heif_decoding_options_free)(opts);
    }
    if err.code != 0 || img.is_null() {
        let m = err_to_string(err);
        (lib.heif_image_handle_release)(handle);
        (lib.heif_context_free)(ctx);
        return Err(format!("解码像素失败: {m}"));
    }

    let w = (lib.heif_image_get_width)(img, HEIF_CHANNEL_INTERLEAVED) as u32;
    let h = (lib.heif_image_get_height)(img, HEIF_CHANNEL_INTERLEAVED) as u32;
    let mut stride: usize = 0;
    let ptr = (lib.heif_image_get_plane_readonly)(img, HEIF_CHANNEL_INTERLEAVED, &mut stride);
    if ptr.is_null() {
        (lib.heif_image_release)(img);
        (lib.heif_image_handle_release)(handle);
        (lib.heif_context_free)(ctx);
        return Err("取像素平面失败".into());
    }

    // 拷贝 RGBA(每行 stride 可能含对齐填充,只取有效 width*4)
    let row_bytes = w as usize * 4;
    let mut out = Vec::with_capacity(w as usize * h as usize * 4);
    for y in 0..h as usize {
        let src = ptr.add(y * stride);
        out.extend_from_slice(std::slice::from_raw_parts(src, row_bytes));
    }

    (lib.heif_image_release)(img);
    (lib.heif_image_handle_release)(handle);
    (lib.heif_context_free)(ctx);

    let rgba = RgbaImage::from_raw(w, h, out)
        .ok_or_else(|| format!("HEIC 像素尺寸不符({w}x{h})"))?;
    let mut dyn_img = DynamicImage::ImageRgba8(rgba);
    dyn_img.apply_orientation(
        image::metadata::Orientation::from_exif(orientation.unwrap_or(1) as u8)
            .unwrap_or(image::metadata::Orientation::NoTransforms),
    );
    Ok(dyn_img)
}

#[cfg(all(test, feature = "heic"))]
mod tests {
    use super::decode;
    use image::GenericImageView;
    use std::path::PathBuf;

    fn manifest_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    #[test]
    fn libheif_decodes_solid_red_heic() {
        // 测试中 TAURI_RESOURCE_DIR 不存在,改用 LIBHEIF_DIR 指向 vendored DLL。
        let vendor = manifest_dir().join("vendor").join("heif");
        std::env::set_var("LIBHEIF_DIR", &vendor);

        let sample = manifest_dir().join("testdata").join("heif_roundtrip.heic");
        assert!(sample.exists(), "测试 HEIC 缺失: {}", sample.display());

        let img = decode(&sample, Some(1)).expect("libheif 解码失败");
        let (w, h) = img.dimensions();
        assert_eq!((w, h), (16, 12), "尺寸应为 16x12,实际 {w}x{h}");

        let rgba = img.to_rgba8();
        let mut reds = 0;
        let mut total = 0;
        for px in rgba.pixels() {
            total += 1;
            // 纯红图经 HEIC 有损压缩后,r 应仍很高,g/b 很低
            if px[0] > 200 && px[1] < 60 && px[2] < 60 {
                reds += 1;
            }
        }
        let ratio = reds as f64 / total as f64;
        assert!(ratio > 0.9, "红色像素占比过低({ratio:.2}),解码可能出错");
    }
}
