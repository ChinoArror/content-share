// Pure helpers for the landing background (original + cropped objects, pending deletes).
// No Worker/D1/R2 access here so the logic stays unit-testable.

export const BACKGROUND_MAX_BYTES = 15 * 1024 * 1024;
export const BACKGROUND_ORIGINAL_ENDPOINT = '/api/admin/background/original';
export const BACKGROUND_RESTORE_MS = 30 * 60 * 1000;
export const BACKGROUND_DEFAULT_OPACITY = 0.32;

const ALLOWED_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif'
};

export class BackgroundInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BackgroundInputError';
  }
}

export type ParsedImage = { mime: string; ext: string; bytes: Uint8Array };

export type BackgroundCrop = {
  scale: number;
  offsetX: number;
  offsetY: number;
  previewWidth: number;
  previewHeight: number;
};

export type BackgroundValue = {
  original_key: string | null;
  cropped_key: string | null;
  url: string | null;
  opacity: number;
  crop: BackgroundCrop | null;
  updated_at: string;
};

const DATA_URL_RE = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

// Parses a base64 image data URL. Throws BackgroundInputError (status 400) on any problem.
export function parseImageDataUrl(dataUrl: unknown, maxBytes = BACKGROUND_MAX_BYTES): ParsedImage {
  if (typeof dataUrl !== 'string' || !dataUrl) throw new BackgroundInputError('Background image data is required');
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) throw new BackgroundInputError('Background image must be a base64 data URL');
  const mime = match[1].toLowerCase();
  const ext = ALLOWED_MIME_EXT[mime];
  if (!ext) throw new BackgroundInputError('Unsupported background image type');
  const b64 = match[2].replace(/\s+/g, '');
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const estimated = Math.floor((b64.length * 3) / 4) - padding;
  if (estimated > maxBytes) throw new BackgroundInputError('Background image is too large');
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    throw new BackgroundInputError('Background image data is not valid base64');
  }
  if (binary.length > maxBytes) throw new BackgroundInputError('Background image is too large');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.length === 0) throw new BackgroundInputError('Background image is empty');
  return { mime, ext, bytes };
}

// Object keys for a save. The original keeps its own extension; the cropped image may differ.
export function backgroundKeys(ts: number | string, originalExt: string, croppedExt: string = originalExt): { original_key: string; cropped_key: string } {
  return {
    original_key: `background/landing/original/background-original-${ts}.${originalExt}`,
    cropped_key: `background/landing/cropped/background-cropped-${ts}.${croppedExt}`
  };
}

// Public URL for a cropped key: strips the leading "background/" and keeps safe path segments as-is.
export function backgroundPublicUrl(key: string): string {
  const rest = key.startsWith('background/') ? key.slice('background/'.length) : key;
  return `/api/background/${rest.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`;
}

export function clampOpacity(value: unknown, fallback = BACKGROUND_DEFAULT_OPACITY): number {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

// Returns null for anything that is not an object or has an invalid preview size.
// Scale is clamped to 1..3, offsets default to 0 when not finite.
export function normalizeCrop(input: unknown): BackgroundCrop | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const previewWidth = Number(raw.previewWidth);
  const previewHeight = Number(raw.previewHeight);
  if (!Number.isFinite(previewWidth) || !Number.isFinite(previewHeight) || previewWidth <= 0 || previewHeight <= 0) return null;
  const scaleN = Number(raw.scale);
  const scale = Number.isFinite(scaleN) ? Math.min(3, Math.max(1, scaleN)) : 1;
  const offsetX = Number(raw.offsetX);
  const offsetY = Number(raw.offsetY);
  return {
    scale,
    offsetX: Number.isFinite(offsetX) ? offsetX : 0,
    offsetY: Number.isFinite(offsetY) ? offsetY : 0,
    previewWidth,
    previewHeight
  };
}

// Accepts the current shape ({ original_key, cropped_key, ... }) or the legacy single-image shape
// ({ key | object_key, url, opacity }), where original and cropped are the same object.
export function normalizeBackgroundValue(raw: unknown): BackgroundValue | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, any>;
  const opacity = clampOpacity(v.opacity);
  const updatedAt = typeof v.updated_at === 'string' ? v.updated_at : '';
  if ('original_key' in v || 'cropped_key' in v) {
    const croppedKey = typeof v.cropped_key === 'string' && v.cropped_key ? v.cropped_key : null;
    const originalKey = typeof v.original_key === 'string' && v.original_key ? v.original_key : croppedKey;
    if (!croppedKey && !originalKey) return null;
    const cropped = croppedKey || originalKey;
    return {
      original_key: originalKey,
      cropped_key: cropped,
      url: typeof v.url === 'string' && v.url ? v.url : cropped ? backgroundPublicUrl(cropped) : null,
      opacity,
      crop: normalizeCrop(v.crop),
      updated_at: updatedAt
    };
  }
  const legacyKey = typeof v.key === 'string' && v.key ? v.key : typeof v.object_key === 'string' && v.object_key ? v.object_key : null;
  if (!legacyKey) return null;
  return {
    original_key: legacyKey,
    cropped_key: legacyKey,
    url: typeof v.url === 'string' && v.url ? v.url : backgroundPublicUrl(legacyKey),
    opacity,
    crop: null,
    updated_at: updatedAt
  };
}

// All distinct object keys referenced by a value.
export function backgroundKeysOf(value: BackgroundValue | null): string[] {
  if (!value) return [];
  return Array.from(new Set([value.original_key, value.cropped_key].filter((k): k is string => Boolean(k))));
}

// Keys in `keys` that are not referenced by `keep`. Used to find objects safe to delete.
export function unreferencedKeys(keys: string[], keep: BackgroundValue | null): string[] {
  const kept = new Set(backgroundKeysOf(keep));
  return Array.from(new Set(keys)).filter((k) => !kept.has(k));
}
