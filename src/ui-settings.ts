export type UiSettings = {
  mode: 'light' | 'dark' | 'system';
  accentMode: 'preset' | 'custom';
  accentPreset: 'sky' | 'blue' | 'violet' | 'rose' | 'emerald' | 'amber' | 'orange';
  accentCustom: string;
  density: 'comfortable' | 'compact';
  radius: number;
  reduceMotion: boolean;
  disableMotion: boolean;
  sidebarCollapsed: boolean;
  feedbackDurationMs: number;
};

export const ACCENT_PRESETS = ['sky', 'blue', 'violet', 'rose', 'emerald', 'amber', 'orange'] as const;

export const DEFAULT_UI_SETTINGS: UiSettings = {
  mode: 'system',
  accentMode: 'preset',
  accentPreset: 'sky',
  accentCustom: '#38bdf8',
  density: 'comfortable',
  radius: 10,
  reduceMotion: false,
  disableMotion: false,
  sidebarCollapsed: false,
  feedbackDurationMs: 5000,
};

const MODES: readonly UiSettings['mode'][] = ['light', 'dark', 'system'];
const ACCENT_MODES: readonly UiSettings['accentMode'][] = ['preset', 'custom'];
const DENSITIES: readonly UiSettings['density'][] = ['comfortable', 'compact'];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickClampedInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function sanitizeUiSettings(input: unknown, base: UiSettings = DEFAULT_UI_SETTINGS): UiSettings {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ...base };
  const src = input as Record<string, unknown>;
  const accentCustom =
    typeof src.accentCustom === 'string' && HEX_COLOR.test(src.accentCustom)
      ? src.accentCustom.toLowerCase()
      : base.accentCustom;
  return {
    mode: pickEnum(src.mode, MODES, base.mode),
    accentMode: pickEnum(src.accentMode, ACCENT_MODES, base.accentMode),
    accentPreset: pickEnum(src.accentPreset, ACCENT_PRESETS, base.accentPreset),
    accentCustom,
    density: pickEnum(src.density, DENSITIES, base.density),
    radius: pickClampedInt(src.radius, 4, 16, base.radius),
    reduceMotion: pickBoolean(src.reduceMotion, base.reduceMotion),
    disableMotion: pickBoolean(src.disableMotion, base.disableMotion),
    sidebarCollapsed: pickBoolean(src.sidebarCollapsed, base.sidebarCollapsed),
    feedbackDurationMs: pickClampedInt(src.feedbackDurationMs, 3000, 10000, base.feedbackDurationMs),
  };
}

export function mergeUiSettings(stored: unknown, patch: unknown): UiSettings {
  return sanitizeUiSettings(patch, sanitizeUiSettings(stored));
}
