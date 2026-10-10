import { describe, expect, it } from 'vitest';
import {
  BackgroundInputError,
  backgroundKeys,
  backgroundKeysOf,
  backgroundPublicUrl,
  normalizeBackgroundValue,
  normalizeCrop,
  parseImageDataUrl,
  unreferencedKeys
} from './background-store';

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('parseImageDataUrl', () => {
  it('decodes a png data url', () => {
    const parsed = parseImageDataUrl(PNG_1PX);
    expect(parsed.mime).toBe('image/png');
    expect(parsed.ext).toBe('png');
    expect(parsed.bytes[0]).toBe(0x89);
    expect(parsed.bytes[1]).toBe(0x50);
  });

  it('maps allowed mimes to extensions', () => {
    expect(parseImageDataUrl(PNG_1PX.replace('image/png', 'image/webp')).ext).toBe('webp');
    expect(parseImageDataUrl(PNG_1PX.replace('image/png', 'image/jpeg')).ext).toBe('jpg');
  });

  it('rejects disallowed or malformed input with a 400 error', () => {
    const cases: unknown[] = [
      undefined,
      '',
      'not a data url',
      PNG_1PX.replace('image/png', 'image/svg+xml'),
      PNG_1PX.replace('image/png', 'text/html'),
      'data:image/png;base64,@@@@'
    ];
    for (const c of cases) {
      expect(() => parseImageDataUrl(c)).toThrow(BackgroundInputError);
    }
    try {
      parseImageDataUrl(PNG_1PX.replace('image/png', 'image/svg+xml'));
    } catch (err) {
      expect((err as BackgroundInputError).status).toBe(400);
    }
  });

  it('enforces the byte limit', () => {
    expect(() => parseImageDataUrl(PNG_1PX, 10)).toThrow(BackgroundInputError);
    expect(() => parseImageDataUrl(PNG_1PX, 1000)).not.toThrow();
  });
});

describe('backgroundKeys', () => {
  it('builds original and cropped keys under the landing folder', () => {
    expect(backgroundKeys(123, 'png', 'webp')).toEqual({
      original_key: 'background/landing/original/background-original-123.png',
      cropped_key: 'background/landing/cropped/background-cropped-123.webp'
    });
  });

  it('uses the original extension for the cropped key by default', () => {
    expect(backgroundKeys('t', 'jpg').cropped_key).toBe('background/landing/cropped/background-cropped-t.jpg');
  });
});

describe('backgroundPublicUrl', () => {
  it('maps a key to the public serving route', () => {
    expect(backgroundPublicUrl('background/landing/cropped/background-cropped-1.png')).toBe(
      '/api/background/landing/cropped/background-cropped-1.png'
    );
  });

  it('keeps nested segments and encodes unsafe characters only', () => {
    expect(backgroundPublicUrl('background/a b/c.png')).toBe('/api/background/a%20b/c.png');
  });
});

describe('normalizeCrop', () => {
  it('clamps scale to 1..3 and keeps finite numbers', () => {
    expect(normalizeCrop({ scale: 9, offsetX: 4, offsetY: -2, previewWidth: 320, previewHeight: 180 })).toEqual({
      scale: 3, offsetX: 4, offsetY: -2, previewWidth: 320, previewHeight: 180
    });
    expect(normalizeCrop({ scale: 0.2, previewWidth: 320, previewHeight: 180 })?.scale).toBe(1);
  });

  it('defaults non-finite values', () => {
    expect(normalizeCrop({ scale: 'x', offsetX: NaN, offsetY: Infinity, previewWidth: 10, previewHeight: 5 })).toEqual({
      scale: 1, offsetX: 0, offsetY: 0, previewWidth: 10, previewHeight: 5
    });
  });

  it('rejects non-objects and invalid preview sizes', () => {
    expect(normalizeCrop(null)).toBeNull();
    expect(normalizeCrop([])).toBeNull();
    expect(normalizeCrop({ scale: 1, previewWidth: 0, previewHeight: 5 })).toBeNull();
    expect(normalizeCrop({ scale: 1, previewWidth: 'abc', previewHeight: 5 })).toBeNull();
  });
});

describe('normalizeBackgroundValue', () => {
  it('converts a legacy single-image value into original and cropped keys', () => {
    const value = normalizeBackgroundValue({ key: 'background/1-x.png', url: '/api/background/1-x.png', opacity: 0.5 });
    expect(value).toEqual({
      original_key: 'background/1-x.png',
      cropped_key: 'background/1-x.png',
      url: '/api/background/1-x.png',
      opacity: 0.5,
      crop: null,
      updated_at: ''
    });
  });

  it('accepts the legacy object_key field written by the old upload handler', () => {
    const value = normalizeBackgroundValue({ object_key: 'background/2-y.png', opacity: 0.1 });
    expect(value?.cropped_key).toBe('background/2-y.png');
    expect(value?.url).toBe('/api/background/2-y.png');
  });

  it('keeps the current shape and clamps opacity', () => {
    const value = normalizeBackgroundValue({
      original_key: 'background/landing/original/o.png',
      cropped_key: 'background/landing/cropped/c.webp',
      url: '/api/background/landing/cropped/c.webp',
      opacity: 7,
      crop: { scale: 2, offsetX: 1, offsetY: 1, previewWidth: 320, previewHeight: 180 },
      updated_at: '2026-10-11T00:00:00.000Z'
    });
    expect(value?.opacity).toBe(1);
    expect(value?.crop?.scale).toBe(2);
    expect(value?.updated_at).toBe('2026-10-11T00:00:00.000Z');
  });

  it('returns null for empty or invalid input', () => {
    expect(normalizeBackgroundValue(null)).toBeNull();
    expect(normalizeBackgroundValue('x')).toBeNull();
    expect(normalizeBackgroundValue({ opacity: 0.3 })).toBeNull();
  });
});

describe('key helpers', () => {
  it('lists distinct keys and finds unreferenced ones', () => {
    const legacy = normalizeBackgroundValue({ key: 'background/a.png', opacity: 0.3 });
    expect(backgroundKeysOf(legacy)).toEqual(['background/a.png']);
    const current = normalizeBackgroundValue({
      original_key: 'background/o.png',
      cropped_key: 'background/c.png',
      opacity: 0.3
    });
    expect(unreferencedKeys(['background/o.png', 'background/old.png', 'background/old.png'], current)).toEqual([
      'background/old.png'
    ]);
    expect(unreferencedKeys(['background/a.png'], null)).toEqual(['background/a.png']);
  });
});
