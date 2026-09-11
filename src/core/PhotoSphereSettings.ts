import { ipc } from "./db";

export const PHOTO_SPHERE_DEFAULTS = {
  radius: 1.58,
  size: 2.8,
  glow: 0.68,
  brightness: 0.68,
  breathe: 0.07,
  wave: 0.028,
  scatter: 0,
  disturbRadius: 0.28,
  disturbStrength: 0.09,
  disturbRise: 6.4,
  disturbFall: 1.9,
} as const;

export type PhotoSphereSettings = { -readonly [K in keyof typeof PHOTO_SPHERE_DEFAULTS]: number };

export const PHOTO_SPHERE_SETTING_SPECS: ReadonlyArray<{ key: keyof PhotoSphereSettings; storageKey: string; label: string; min: number; max: number; step: number; digits: number }> = [
  { key: "radius", storageKey: "photo_sphere_radius", label: "球体半径", min: 1.1, max: 2.2, step: .01, digits: 2 },
  { key: "size", storageKey: "photo_sphere_size", label: "球粒大小", min: .7, max: 5, step: .05, digits: 2 },
  { key: "glow", storageKey: "photo_sphere_glow", label: "球体发光", min: 0, max: 1.8, step: .01, digits: 2 },
  { key: "brightness", storageKey: "photo_sphere_brightness", label: "球体亮度", min: .25, max: 1.25, step: .01, digits: 2 },
  { key: "breathe", storageKey: "photo_sphere_breathe", label: "球体呼吸", min: 0, max: .16, step: .002, digits: 3 },
  { key: "wave", storageKey: "photo_sphere_wave", label: "球体波浪", min: 0, max: .16, step: .002, digits: 3 },
  { key: "scatter", storageKey: "photo_sphere_scatter", label: "球体散开", min: 0, max: 1, step: .01, digits: 2 },
  { key: "disturbRadius", storageKey: "photo_sphere_disturb_radius", label: "球面扰动范围", min: .08, max: .48, step: .01, digits: 2 },
  { key: "disturbStrength", storageKey: "photo_sphere_disturb_strength", label: "球面扰动强度", min: .01, max: .2, step: .002, digits: 3 },
  { key: "disturbRise", storageKey: "photo_sphere_disturb_rise", label: "球面散开速度", min: 1, max: 10, step: .1, digits: 1 },
  { key: "disturbFall", storageKey: "photo_sphere_disturb_fall", label: "球面回位速度", min: .5, max: 4, step: .05, digits: 2 },
];

export const PHOTO_SPHERE_SETTINGS_EVENT = "photo-sphere-settings";
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function normalizePhotoSphereSettings(values: Partial<PhotoSphereSettings>): PhotoSphereSettings {
  const result = { ...PHOTO_SPHERE_DEFAULTS } as PhotoSphereSettings;
  for (const spec of PHOTO_SPHERE_SETTING_SPECS) { const value = values[spec.key]; result[spec.key] = Number.isFinite(value) ? clamp(value as number, spec.min, spec.max) : PHOTO_SPHERE_DEFAULTS[spec.key]; }
  return result;
}
export async function loadPhotoSphereSettings() { const values: Partial<PhotoSphereSettings> = {}; await Promise.all(PHOTO_SPHERE_SETTING_SPECS.map(async (spec) => { const stored = await ipc.getSetting(spec.storageKey); if (stored !== null && stored.trim() !== "") values[spec.key] = Number(stored); })); return normalizePhotoSphereSettings(values); }
export async function savePhotoSphereSetting(key: keyof PhotoSphereSettings, value: number) { const spec = PHOTO_SPHERE_SETTING_SPECS.find((item) => item.key === key)!; const next = clamp(value, spec.min, spec.max); await ipc.setSetting(spec.storageKey, String(next)); window.dispatchEvent(new CustomEvent(PHOTO_SPHERE_SETTINGS_EVENT, { detail: { key, value: next } })); return next; }
export async function restorePhotoSphereDefaults() { await Promise.all(PHOTO_SPHERE_SETTING_SPECS.map((spec) => ipc.setSetting(spec.storageKey, String(PHOTO_SPHERE_DEFAULTS[spec.key])))); const defaults = { ...PHOTO_SPHERE_DEFAULTS } as PhotoSphereSettings; window.dispatchEvent(new CustomEvent(PHOTO_SPHERE_SETTINGS_EVENT, { detail: defaults })); return defaults; }
