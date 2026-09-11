export interface Photo {
  id: number;
  path: string;
  filename: string;
  width: number;
  height: number;
  thumbPath: string | null;
  particlePath: string | null;
  avgColor: string | null;
  score: number;
  captureDate: string | null;
  dateSource: string | null; // exif | file | user
  gpsLat: number | null;
  gpsLon: number | null;
  camera: string | null;
  lens: string | null;
  iso: number | null;
  shutter: string | null;
  aperture: string | null;
  focal: string | null;
  starred: boolean;
  missing: boolean;
  imported: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Memory {
  photoId: number;
  title: string | null;
  text: string | null;
  location: string | null;
  mood: string | null;
  updatedAt: string;
}

export interface Album {
  photoIds?: number[];
  galaxyConfig?: string | null;
  id: number;
  name: string;
  description: string | null;
  coverPhotoId: number | null;
  auto: boolean;
  sortOrder: number;
  photoCount: number;
  createdAt: string;
}

export interface GalaxyPhoto {
  id: number;
  albumId: number | null;
  avgColor: string | null;
  captureDate: string | null;
  starred: boolean;
  title: string | null;
  width: number;
  height: number;
}

export interface Connection {
  a: number;
  b: number;
  strength: number;
  kind: string;
}

export interface ImportProgress {
  jobId: number;
  phase: "scanning" | "processing" | "relations" | "done" | "canceled";
  done: number;
  total: number;
  skipped: number;
  current: string;
}

export interface TimelineItem {
  id: number;
  date: string | null;
  starred: boolean;
  avgColor: string | null;
}

export type QualityTier = "low" | "medium" | "high" | "ultra";
export type PerfMode = "performance" | "balanced" | "quality";
export type ViewMode = "galaxy" | "timeline" | "map" | "shelf";

export const tmThumb = (id: number) => `http://tm.localhost/thumb/${id}.jpg`;
export const tmPreview = (id: number) => `http://tm.localhost/preview/${id}.jpg`;
export const tmPhoto = (id: number) => `http://tm.localhost/photo/${id}`;
export const tmParticles = (id: number) =>
  `http://tm.localhost/particles/${id}.spc`;

export interface AlbumGalaxyConfig { photoIds: number[] | null; positions: Record<string, [number, number, number]> | null; }
export function albumGalaxyConfig(album: Album): AlbumGalaxyConfig {
  try {
    const value = JSON.parse(album.galaxyConfig ?? "null");
    const members = new Set(album.photoIds ?? []);
    const photoIds = Array.isArray(value?.photoIds) ? [...new Set<number>(value.photoIds.filter((id:unknown)=>typeof id==='number'&&members.has(id)))] : null;
    const positions = value?.positions && typeof value.positions==='object' ? Object.fromEntries(
      Object.entries(value.positions).filter(([key,point])=>members.has(Number(key))&&Array.isArray(point)&&point.length===3&&point.every(v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=30))
    ) as Record<string,[number,number,number]> : null;
    return {photoIds,positions};
  }
  catch { return {photoIds:null, positions:null}; }
}
