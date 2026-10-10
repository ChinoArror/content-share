import { describe, expect, it } from 'vitest';
import { ACCENT_PRESETS, DEFAULT_UI_SETTINGS, mergeUiSettings, sanitizeUiSettings } from './ui-settings';

describe('UI settings defaults', () => {
  it('uses the documented defaults', () => {
    expect(DEFAULT_UI_SETTINGS).toEqual({
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
    });
  });

  it('exposes the seven accent presets', () => {
    expect([...ACCENT_PRESETS]).toEqual(['sky', 'blue', 'violet', 'rose', 'emerald', 'amber', 'orange']);
  });

  it('returns a copy of the base for non-object input', () => {
    for (const input of [null, undefined, 'dark', 42, true, ['dark']]) {
      const result = sanitizeUiSettings(input);
      expect(result).toEqual(DEFAULT_UI_SETTINGS);
      expect(result).not.toBe(DEFAULT_UI_SETTINGS);
    }
  });

  it('uses a custom base for fallbacks', () => {
    const base = { ...DEFAULT_UI_SETTINGS, mode: 'dark' as const, radius: 12 };
    expect(sanitizeUiSettings({ mode: 'bogus' }, base)).toEqual(base);
  });
});

describe('UI settings validation', () => {
  it('falls back to the base for invalid enum values', () => {
    const result = sanitizeUiSettings({
      mode: 'neon',
      accentMode: 'gradient',
      accentPreset: 'pink',
      density: 'huge',
    });
    expect(result).toEqual(DEFAULT_UI_SETTINGS);
  });

  it('accepts valid enum values', () => {
    const result = sanitizeUiSettings({ mode: 'dark', accentMode: 'custom', accentPreset: 'violet', density: 'compact' });
    expect(result.mode).toBe('dark');
    expect(result.accentMode).toBe('custom');
    expect(result.accentPreset).toBe('violet');
    expect(result.density).toBe('compact');
  });

  it('only accepts real booleans', () => {
    const result = sanitizeUiSettings({ reduceMotion: 'yes', disableMotion: 1, sidebarCollapsed: null });
    expect(result.reduceMotion).toBe(false);
    expect(result.disableMotion).toBe(false);
    expect(result.sidebarCollapsed).toBe(false);
    expect(sanitizeUiSettings({ reduceMotion: true, disableMotion: true, sidebarCollapsed: true })).toMatchObject({
      reduceMotion: true,
      disableMotion: true,
      sidebarCollapsed: true,
    });
  });

  it('falls back for non-numeric radius and feedback duration', () => {
    const result = sanitizeUiSettings({ radius: '12', feedbackDurationMs: '4000' });
    expect(result.radius).toBe(10);
    expect(result.feedbackDurationMs).toBe(5000);
  });

  it('falls back to base for non-finite numbers', () => {
    const result = sanitizeUiSettings({ radius: Number.NaN, feedbackDurationMs: Number.POSITIVE_INFINITY });
    expect(result.radius).toBe(10);
    expect(result.feedbackDurationMs).toBe(5000);
  });
});

describe('UI settings clamping', () => {
  it('clamps radius to 4..16 and rounds to integers', () => {
    expect(sanitizeUiSettings({ radius: 1 }).radius).toBe(4);
    expect(sanitizeUiSettings({ radius: 99 }).radius).toBe(16);
    expect(sanitizeUiSettings({ radius: 7.4 }).radius).toBe(7);
    expect(sanitizeUiSettings({ radius: 7.6 }).radius).toBe(8);
  });

  it('clamps feedback duration to 3000..10000 milliseconds', () => {
    expect(sanitizeUiSettings({ feedbackDurationMs: 100 }).feedbackDurationMs).toBe(3000);
    expect(sanitizeUiSettings({ feedbackDurationMs: 60000 }).feedbackDurationMs).toBe(10000);
    expect(sanitizeUiSettings({ feedbackDurationMs: 4321.4 }).feedbackDurationMs).toBe(4321);
  });
});

describe('UI settings accent colour', () => {
  it('accepts six-digit hex colours and stores them lowercase', () => {
    expect(sanitizeUiSettings({ accentCustom: '#AABBCC' }).accentCustom).toBe('#aabbcc');
    expect(sanitizeUiSettings({ accentCustom: '#0f172a' }).accentCustom).toBe('#0f172a');
  });

  it('rejects malformed colours and keeps the base value', () => {
    for (const value of ['#abc', '#aabbccdd', 'aabbcc', '#gggggg', 'red', '', ' #aabbcc', 123]) {
      expect(sanitizeUiSettings({ accentCustom: value }).accentCustom).toBe(DEFAULT_UI_SETTINGS.accentCustom);
    }
  });
});

describe('UI settings unknown keys', () => {
  it('drops keys that are not part of the settings shape', () => {
    const result = sanitizeUiSettings({ mode: 'dark', __proto__x: 1, password: 'secret', extra: { a: 1 } });
    expect(Object.keys(result).sort()).toEqual(Object.keys(DEFAULT_UI_SETTINGS).sort());
    expect(result).not.toHaveProperty('password');
    expect(result).not.toHaveProperty('extra');
  });
});

describe('UI settings merge', () => {
  it('applies a partial patch on top of stored settings', () => {
    const stored = { mode: 'dark', radius: 14, accentPreset: 'rose' };
    const result = mergeUiSettings(stored, { density: 'compact' });
    expect(result).toEqual({ ...DEFAULT_UI_SETTINGS, mode: 'dark', radius: 14, accentPreset: 'rose', density: 'compact' });
  });

  it('lets the patch override stored values and sanitizes the patch', () => {
    const stored = { mode: 'dark' };
    const result = mergeUiSettings(stored, { mode: 'light', radius: 50, accentCustom: 'nope' });
    expect(result.mode).toBe('light');
    expect(result.radius).toBe(16);
    expect(result.accentCustom).toBe(DEFAULT_UI_SETTINGS.accentCustom);
  });

  it('ignores invalid stored data and falls back to defaults', () => {
    expect(mergeUiSettings('garbage', { sidebarCollapsed: true })).toEqual({ ...DEFAULT_UI_SETTINGS, sidebarCollapsed: true });
    expect(mergeUiSettings(null, null)).toEqual(DEFAULT_UI_SETTINGS);
  });
});
