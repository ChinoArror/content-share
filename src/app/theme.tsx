// Theme engine: applies UiSettings to <html>, caches them per browser, and syncs
// them to the account (GET/PUT /api/me/ui-settings) when signed in.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ACCENT_PRESETS, DEFAULT_UI_SETTINGS, sanitizeUiSettings, type UiSettings } from '../ui-settings';

export type AccentPreset = UiSettings['accentPreset'];
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export type AccentSpec = {
  id: AccentPreset;
  /** Preview colour for the swatch picker (the light-mode primary). */
  swatch: string;
  light: { primary: string; foreground: string };
  dark: { primary: string; foreground: string };
};

const WHITE_FG = 'oklch(99% 0.005 240)';
const DARK_FG = 'oklch(15% 0.02 250)';

/** Seven presets; L/C are tuned per mode so the accent glows on dark without vibrating. */
export const ACCENT_SPECS: readonly AccentSpec[] = [
  { id: 'sky', swatch: 'oklch(68.5% 0.155 230)',
    light: { primary: 'oklch(68.5% 0.155 230)', foreground: WHITE_FG },
    dark: { primary: 'oklch(75% 0.14 230)', foreground: DARK_FG } },
  { id: 'blue', swatch: 'oklch(60% 0.18 258)',
    light: { primary: 'oklch(60% 0.18 258)', foreground: WHITE_FG },
    dark: { primary: 'oklch(70% 0.16 258)', foreground: DARK_FG } },
  { id: 'violet', swatch: 'oklch(60% 0.2 290)',
    light: { primary: 'oklch(60% 0.2 290)', foreground: WHITE_FG },
    dark: { primary: 'oklch(72% 0.17 290)', foreground: DARK_FG } },
  { id: 'rose', swatch: 'oklch(63% 0.21 18)',
    light: { primary: 'oklch(63% 0.21 18)', foreground: WHITE_FG },
    dark: { primary: 'oklch(72% 0.18 18)', foreground: DARK_FG } },
  { id: 'emerald', swatch: 'oklch(64% 0.16 162)',
    light: { primary: 'oklch(64% 0.16 162)', foreground: DARK_FG },
    dark: { primary: 'oklch(74% 0.15 162)', foreground: DARK_FG } },
  { id: 'amber', swatch: 'oklch(72% 0.17 70)',
    light: { primary: 'oklch(72% 0.17 70)', foreground: DARK_FG },
    dark: { primary: 'oklch(78% 0.16 70)', foreground: DARK_FG } },
  { id: 'orange', swatch: 'oklch(67% 0.2 45)',
    light: { primary: 'oklch(67% 0.2 45)', foreground: DARK_FG },
    dark: { primary: 'oklch(74% 0.18 45)', foreground: DARK_FG } },
];

const DARK_QUERY = '(prefers-color-scheme: dark)';
const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';
const CACHE_KEY = 'content-share-ui';
const LEGACY_THEME_KEY = 'theme';
const TOKEN_KEY = 'sso_token';
const API = '/api/me/ui-settings';
const SAVE_DEBOUNCE_MS = 600;
const HEX_RE = /^#[0-9a-f]{6}$/i;
const DEFAULT_CUSTOM = '#38bdf8';

function matches(query: string): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export function resolveMode(mode: UiSettings['mode']): 'light' | 'dark' {
  if (mode === 'system') return matches(DARK_QUERY) ? 'dark' : 'light';
  return mode;
}

// ─── Colour helpers (custom hex accent) ─────────────────────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Black or white text, whichever reads better on the given fill. */
function readableForeground(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.6 ? '#0b0d12' : '#ffffff';
}

/** Mix a hex colour toward white by `ratio` (0..1). */
function lightenHex(hex: string, ratio: number): string {
  const { r, g, b } = hexToRgb(hex);
  const mix = (c: number) => Math.round(c + (255 - c) * ratio);
  return `#${[mix(r), mix(g), mix(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function findAccent(id: string): AccentSpec {
  const known = (ACCENT_PRESETS as readonly string[]).includes(id);
  return (known ? ACCENT_SPECS.find((a) => a.id === id) : undefined) ?? ACCENT_SPECS[0];
}

function accentPair(s: UiSettings): { light: AccentSpec['light']; dark: AccentSpec['dark'] } {
  if (s.accentMode === 'custom') {
    // accentCustom is sanitized upstream, but the cache is locally editable: re-check before it reaches CSS.
    const hex = HEX_RE.test(s.accentCustom) ? s.accentCustom.toLowerCase() : DEFAULT_CUSTOM;
    const darkHex = lightenHex(hex, 0.15);
    return {
      light: { primary: hex, foreground: readableForeground(hex) },
      dark: { primary: darkHex, foreground: readableForeground(darkHex) },
    };
  }
  const spec = findAccent(s.accentPreset);
  return { light: spec.light, dark: spec.dark };
}

function writeAccentStyle(s: UiSettings): void {
  const { light, dark } = accentPair(s);
  // :root:not(.dark) and :root.dark out-specify the OS-preference fallback in styles.css.
  const css =
    `:root:not(.dark){--primary:${light.primary};--primary-foreground:${light.foreground};--ring:${light.primary}}` +
    `:root.dark{--primary:${dark.primary};--primary-foreground:${dark.foreground};--ring:${dark.primary}}`;
  let el = document.getElementById('cs-accent') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = 'cs-accent';
    document.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

/** Apply settings to <html>: mode class, density, motion switches, radius and accent. */
export function applyUiSettings(s: UiSettings): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const resolved = resolveMode(s.mode);
  root.classList.toggle('dark', resolved === 'dark');
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  root.dataset.density = s.density;
  // "Reduce" collapses durations; "disable" also strips CSS animations (spinners excepted).
  root.dataset.reduceMotion = s.reduceMotion || s.disableMotion || matches(REDUCE_QUERY) ? '1' : '0';
  root.dataset.noMotion = s.disableMotion ? '1' : '0';
  root.style.setProperty('--radius', `${s.radius}px`);
  writeAccentStyle(s);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#14171f' : '#fafbfc');
}

// ─── Storage & API ──────────────────────────────────────────────────────────

function readCache(): UiSettings {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) return sanitizeUiSettings(JSON.parse(raw));
    // Migration: before this engine existed, only the light/dark choice was stored.
    const legacy = localStorage.getItem(LEGACY_THEME_KEY);
    if (legacy === 'dark' || legacy === 'light') return sanitizeUiSettings({ mode: legacy });
  } catch {
    // Storage blocked or cache corrupt: fall through to defaults.
  }
  return { ...DEFAULT_UI_SETTINGS };
}

function writeCache(s: UiSettings): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(s));
  } catch {
    // Private mode / quota: the page still works with in-memory settings.
  }
}

function authToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

async function pushServer(token: string, s: UiSettings, keepalive = false): Promise<void> {
  const res = await fetch(API, {
    method: 'PUT',
    keepalive,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(s),
  });
  if (!res.ok) throw new Error(`ui-settings save failed: ${res.status}`);
}

function isDefault(s: UiSettings): boolean {
  return JSON.stringify(sanitizeUiSettings(s)) === JSON.stringify(DEFAULT_UI_SETTINGS);
}

// ─── Provider & hooks ───────────────────────────────────────────────────────

export type ThemeContextValue = {
  settings: UiSettings;
  /** Merge a partial change: applies instantly, caches, and (when signed in) debounced-saves. */
  update: (patch: Partial<UiSettings>) => void;
  reset: () => void;
  saving: SaveStatus;
  /** True once the account's settings have been read (or migrated) from the server. */
  loadedFromServer: boolean;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ authed, children }: { authed: boolean; children: ReactNode }) {
  const [settings, setSettings] = useState<UiSettings>(readCache);
  const [saving, setSaving] = useState<SaveStatus>('idle');
  const [loadedFromServer, setLoadedFromServer] = useState(false);

  const settingsRef = useRef(settings);
  const authedRef = useRef(authed);
  authedRef.current = authed;
  // Set once the user edits locally; a late server response must not clobber those edits.
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    applyUiSettings(settings);
    writeCache(settings);
  }, [settings]);

  // Re-apply when the OS scheme or reduced-motion preference changes.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const queries = [DARK_QUERY, REDUCE_QUERY].map((q) => window.matchMedia(q));
    const onChange = () => applyUiSettings(settingsRef.current);
    queries.forEach((mq) => mq.addEventListener('change', onChange));
    return () => queries.forEach((mq) => mq.removeEventListener('change', onChange));
  }, []);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  // A debounced save still pending when the tab closes is sent with keepalive so it is not lost.
  useEffect(() => {
    const onPageHide = () => {
      if (!timerRef.current) return;
      clearTimeout(timerRef.current);
      timerRef.current = null;
      const token = authToken();
      if (token && authedRef.current) void pushServer(token, settingsRef.current, true).catch(() => {});
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  const persist = useCallback(async (token: string, s: UiSettings) => {
    setSaving('saving');
    try {
      await pushServer(token, s);
      setSaving('saved');
    } catch {
      setSaving('error');
    }
  }, []);

  const schedulePush = useCallback(() => {
    if (!authedRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    setSaving('saving');
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const token = authToken();
      if (!token) {
        setSaving('error');
        return;
      }
      void persist(token, settingsRef.current);
    }, SAVE_DEBOUNCE_MS);
  }, [persist]);

  const commit = useCallback((next: UiSettings) => {
    dirtyRef.current = true;
    settingsRef.current = next;
    setSettings(next);
    schedulePush();
  }, [schedulePush]);

  const update = useCallback((patch: Partial<UiSettings>) => {
    commit(sanitizeUiSettings({ ...settingsRef.current, ...patch }, settingsRef.current));
  }, [commit]);

  const reset = useCallback(() => commit(sanitizeUiSettings(DEFAULT_UI_SETTINGS)), [commit]);

  // Load the account's settings once signed in.
  useEffect(() => {
    if (!authed) {
      setLoadedFromServer(false);
      return;
    }
    const token = authToken();
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(API, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`ui-settings load failed: ${res.status}`);
        const body = (await res.json()) as { item?: unknown; updated_at?: string | null };
        if (cancelled) return;
        if (body.updated_at == null) {
          // First sign-in on this account: push local choices once so other devices pick them up.
          if (!isDefault(settingsRef.current)) await persist(token, settingsRef.current);
        } else if (!dirtyRef.current) {
          const adopted = sanitizeUiSettings(body.item);
          settingsRef.current = adopted;
          setSettings(adopted);
        }
        if (!cancelled) setLoadedFromServer(true);
      } catch {
        if (!cancelled) setSaving('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authed, persist]);

  const value = useMemo<ThemeContextValue>(
    () => ({ settings, update, reset, saving, loadedFromServer }),
    [settings, update, reset, saving, loadedFromServer],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>');
  return value;
}

/** False when the user or the OS asks for less motion. Components gate JS-driven animation on this. */
export function useMotionEnabled(): boolean {
  const { settings } = useTheme();
  const [systemReduce, setSystemReduce] = useState(() => matches(REDUCE_QUERY));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(REDUCE_QUERY);
    const onChange = () => setSystemReduce(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return !settings.reduceMotion && !settings.disableMotion && !systemReduce;
}
