import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type {
  Album,
  Connection,
  GalaxyPhoto,
  Memory,
  Photo,
  TimelineItem,
} from "./types";

export const ipc = {
  // 窗口
  winMinimize: () => invoke("win_minimize"),
  winToggleMaximize: () => invoke("win_toggle_maximize"),
  winClose: () => invoke("win_close"),

  // 桌面壁纸
  startWallpaper: () => invoke<number>("start_wallpaper"),
  stopWallpaper: () => invoke("stop_wallpaper"),
  wallpaperRunning: () => invoke<boolean>("wallpaper_running"),

  // 页面(空间)
  listSpaces: () =>
    invoke<import("./spaces").Space[]>("list_spaces"),
  createSpace: (name: string, shape: string, scope: string) =>
    invoke<number>("create_space", { name, shape, scope }),
  saveSpace: (
    id: number,
    name: string,
    shape: string,
    scope: string,
    backgroundPhotoId: number | null,
    backgroundMode: string = "plate",
    backgroundStrength: number = 42,
    backgroundAsset: string | null = null,
  ) =>
    invoke("save_space", {
      id,
      name,
      shape,
      scope,
      backgroundPhotoId,
      backgroundMode,
      backgroundStrength,
      backgroundAsset,
    }),
  deleteSpace: (id: number) => invoke("delete_space", { id }),
  addSpacePhotos: (spaceId: number, photoIds: number[]) =>
    invoke("add_space_photos", { spaceId, photoIds }),
  removeSpacePhotos: (spaceId: number, photoIds: number[]) =>
    invoke("remove_space_photos", { spaceId, photoIds }),

  // 后台补处理
  backfillStatus: () =>
    invoke<{ running: boolean; paused: boolean; done: number; pending: number }>(
      "backfill_status",
    ),
  runBackfill: () => invoke("run_backfill"),
  setBackfillPaused: (paused: boolean) => invoke("set_backfill_paused", { paused }),
  saveVideoPoster: (id: number, bytes: number[]) =>
    invoke("save_video_poster", { id, bytes }),

  // 手机上传
  startPhoneUpload: (targetDir: string) =>
    invoke<{ url: string; qrSvg: string; port: number; target: string }>(
      "start_phone_upload",
      { targetDir },
    ),
  stopPhoneUpload: () => invoke<number>("stop_phone_upload"),
  phoneUploadStatus: () =>
    invoke<{
      active: boolean;
      count: number;
      bytes: number;
      lastName: string | null;
      target: string;
    } | null>("phone_upload_status"),

  // 认证
  authState: () =>
    invoke<{ hasPassword: boolean; passwordless: boolean; unlocked: boolean }>("auth_state"),
  setPasswordless: () => invoke("set_passwordless"),
  setPassword: (password: string) => invoke("set_password", { password }),
  changePassword: (oldP: string, newP: string) =>
    invoke("change_password", { old: oldP, new: newP }),
  verifyPassword: (password: string) => invoke<boolean>("verify_password", { password }),
  lockApp: () => invoke("lock_app"),

  // 设置
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) => invoke("set_setting", { key, value }),

  saveProvinceWall: (province: string, notes: import("./provinceWall").ProvinceWallNotes) => invoke("save_province_wall", {province, notes}),

  // 导入
  importPhotos: (paths: string[], albumName?: string) =>
    invoke<number>("import_photos", { paths, albumName: albumName ?? null }),
  cancelImport: () => invoke("cancel_import"),

  // 照片
  listPhotos: (albumId?: number, spaceId?: number) =>
    invoke<Photo[]>("list_photos", { albumId: albumId ?? null, spaceId: spaceId ?? null }),
  getPhotoFull: (id: number) =>
    invoke<{ photo: Photo; memory: Memory }>("get_photo_full", { id }),
  saveMemory: (
    photoId: number,
    title: string | null,
    text: string | null,
    location: string | null,
    mood: string | null,
  ) => invoke("save_memory", { photoId, title, text, location, mood }),
  toggleStar: (id: number, starred: boolean) =>
    invoke("toggle_star", { id, starred }),
  setPhotoLocation: (id: number, latitude: number|null, longitude: number|null) => invoke('set_photo_location', {id,latitude,longitude}),
  setPhotoDate: (id: number, date: string) =>
    invoke("set_photo_date", { id, date }),
  deletePhoto: (id: number) => invoke("delete_photo", { id }),
  getStats: () =>
    invoke<{ photoCount: number; albumCount: number; memoryCount: number }>(
      "get_stats",
    ),

  // 时间轴/搜索
  getTimeline: (spaceId?: number) =>
    invoke<TimelineItem[]>("get_timeline", { spaceId: spaceId ?? null }),
  getOnThisDay: () => invoke<Photo[]>("get_on_this_day"),
  searchPhotos: (query: string) => invoke<Photo[]>("search_photos", { query }),

  // 相册
  saveAlbumGalaxy: (id: number, name: string, config: import("./types").AlbumGalaxyConfig, addPhotoIds: number[] = [], removePhotoIds: number[] = []) => invoke("save_album_galaxy", { id, name, config, addPhotoIds, removePhotoIds }),
  createAlbum: (name: string, photoIds: number[]) => invoke<number>("create_album", { name, photoIds }),
  listAlbums: () => invoke<Album[]>("list_albums"),
  renameAlbum: (id: number, name: string) =>
    invoke("rename_album", { id, name }),
  setAlbumDescription: (id: number, description: string) =>
    invoke("set_album_description", { id, description }),
  deleteAlbum: (id: number) => invoke("delete_album", { id }),
  setAlbumCover: (id: number, photoId: number) =>
    invoke("set_album_cover", { id, photoId }),

  // 关系
  getConnections: () => invoke<Connection[]>("get_connections"),
  addConnection: (a: number, b: number) => invoke("add_connection", { a, b }),
  removeConnection: (a: number, b: number) =>
    invoke("remove_connection", { a, b }),

  // 银河
  getGalaxyData: (spaceId?: number) =>
    invoke<GalaxyPhoto[]>("get_galaxy_data", { spaceId: spaceId ?? null }),

  // 备份
  exportBackup: (target: string, includePhotos: boolean) =>
    invoke("export_backup_cmd", { target, includePhotos }),
  importBackup: (source: string) => invoke<number>("import_backup_cmd", { source }),

  // 单个相册导出/导入(本地分享)
  exportAlbum: (albumId: number, target: string) =>
    invoke<{ folder: string; photoCount: number; skipped: number; name: string }>(
      "export_album_cmd",
      { albumId, target },
    ),
  importAlbum: (source: string) =>
    invoke<{ albumId: number; name: string; photoCount: number; memoryCount: number }>(
      "import_album_cmd",
      { source },
    ),
};

/** 本地文件 → 可显示 URL(用于原生 img) */
export const fileUrl = (path: string) => convertFileSrc(path);
