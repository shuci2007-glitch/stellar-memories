import { ipc } from "./db";

export const PHOTO_PARTICLE_DEFAULTS = {
  depth: 1.41,
  size: 4.8,
  glow: 1.33,
  breathe: 0.12,
  wave: 0.11,
  scatter: 0.02,
  disturbRadius: 0.6,
  disturbStrength: 0.124,
  disturbRise: 4.5,
  disturbFall: 1.3,
} as const;

export type PhotoParticleSettings = { -readonly [K in keyof typeof PHOTO_PARTICLE_DEFAULTS]: number };

export const PHOTO_PARTICLE_SETTING_SPECS: ReadonlyArray<{
  key: keyof PhotoParticleSettings;
  storageKey: string;
  label: string;
  min: number;
  max: number;
  step: number;
  digits: number;
}> = [
  { key: "depth", storageKey: "photo_particle_depth", label: "立体深度", min: 0, max: 1.8, step: 0.01, digits: 2 },
  { key: "size", storageKey: "photo_particle_size", label: "粒子大小", min: 0.8, max: 4.8, step: 0.05, digits: 2 },
  { key: "glow", storageKey: "photo_particle_glow", label: "发光", min: 0, max: 1.8, step: 0.01, digits: 2 },
  { key: "breathe", storageKey: "photo_particle_breathe", label: "呼吸", min: 0, max: 0.12, step: 0.002, digits: 3 },
  { key: "wave", storageKey: "photo_particle_wave", label: "整体波浪", min: 0, max: 0.12, step: 0.002, digits: 3 },
  { key: "scatter", storageKey: "photo_particle_scatter", label: "初始散开", min: 0, max: 1, step: 0.01, digits: 2 },
  { key: "disturbRadius", storageKey: "photo_particle_disturb_radius", label: "扰动范围", min: 0.12, max: 0.6, step: 0.01, digits: 2 },
  { key: "disturbStrength", storageKey: "photo_particle_disturb_strength", label: "扰动强度", min: 0.01, max: 0.16, step: 0.001, digits: 3 },
  { key: "disturbRise", storageKey: "photo_particle_disturb_rise", label: "散开速度", min: 1, max: 10, step: 0.1, digits: 1 },
  { key: "disturbFall", storageKey: "photo_particle_disturb_fall", label: "回位速度", min: 0.5, max: 4, step: 0.05, digits: 2 },
];

export const PHOTO_PARTICLE_SETTINGS_EVENT = "photo-particle-settings";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function normalizePhotoParticleSettings(values: Partial<PhotoParticleSettings>): PhotoParticleSettings {
  const result = { ...PHOTO_PARTICLE_DEFAULTS } as PhotoParticleSettings;
  for (const spec of PHOTO_PARTICLE_SETTING_SPECS) {
    const raw = values[spec.key];
    result[spec.key] = Number.isFinite(raw) ? clamp(raw as number, spec.min, spec.max) : PHOTO_PARTICLE_DEFAULTS[spec.key];
  }
  return result;
}

export async function loadPhotoParticleSettings(): Promise<PhotoParticleSettings> {
  const values: Partial<PhotoParticleSettings> = {};
  await Promise.all(PHOTO_PARTICLE_SETTING_SPECS.map(async (spec) => {
    const stored = await ipc.getSetting(spec.storageKey);
    if (stored !== null && stored.trim() !== "") values[spec.key] = Number(stored);
  }));
  return normalizePhotoParticleSettings(values);
}

export async function savePhotoParticleSetting<K extends keyof PhotoParticleSettings>(key: K, value: number) {
  const spec = PHOTO_PARTICLE_SETTING_SPECS.find((item) => item.key === key)!;
  const next = clamp(value, spec.min, spec.max);
  await ipc.setSetting(spec.storageKey, String(next));
  window.dispatchEvent(new CustomEvent(PHOTO_PARTICLE_SETTINGS_EVENT, { detail: { key, value: next } }));
  return next;
}

export async function restorePhotoParticleDefaults() {
  await Promise.all(PHOTO_PARTICLE_SETTING_SPECS.map((spec) => ipc.setSetting(spec.storageKey, String(PHOTO_PARTICLE_DEFAULTS[spec.key]))));
  const defaults = { ...PHOTO_PARTICLE_DEFAULTS } as PhotoParticleSettings;
  window.dispatchEvent(new CustomEvent(PHOTO_PARTICLE_SETTINGS_EVENT, { detail: defaults }));
  return defaults;
}
