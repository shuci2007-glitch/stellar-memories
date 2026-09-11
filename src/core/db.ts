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
  listPhotos: (albumId?: number) =>
    invoke<Photo[]>("list_photos", { albumId: albumId ?? null }),
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
  getTimeline: () => invoke<TimelineItem[]>("get_timeline"),
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
  getGalaxyData: () => invoke<GalaxyPhoto[]>("get_galaxy_data"),

  // 备份
  exportBackup: (target: string, includePhotos: boolean) =>
    invoke("export_backup_cmd", { target, includePhotos }),
  importBackup: (source: string) => invoke<number>("import_backup_cmd", { source }),
};

/** 本地文件 → 可显示 URL(用于原生 img) */
export const fileUrl = (path: string) => convertFileSrc(path);
