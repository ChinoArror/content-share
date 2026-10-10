# content-share UI refactor — shared spec (authoritative for all sub-agents)

Repo root: /home/claude/work/content-share  (React 18 + plain CSS + Cloudflare Worker + D1)
Style reference: /home/claude/work/ref/snowluma-design-style/ (SKILL.md, references/tokens.css, components.md, motion.md, specimens/*.html)
SnowLuma source reference: /home/claude/work/ref/SnowLuma/packages/webui/src/ (contexts/ActionFeedbackContext.tsx, contexts/ThemeContext.tsx, components/pages/settings-page.tsx)

npm registry is NOT reachable. Do not run npm install. Only libraries already in package.json may be imported
(react, react-dom, lucide-react, marked, dompurify, qrcode, fflate, pdfjs-dist, aws4fetch, @raptorqr/core). No Tailwind, no motion lib — use CSS.
Syntax check command (bundles with all packages external):
  cd /home/claude/work/content-share && node /home/claude/work/check.mjs

## UiSettings (shared by worker + frontend)
```ts
export type UiSettings = {
  mode: 'light' | 'dark' | 'system';          // default 'system'
  accentMode: 'preset' | 'custom';            // default 'preset'
  accentPreset: 'sky'|'blue'|'violet'|'rose'|'emerald'|'amber'|'orange'; // default 'sky'
  accentCustom: string;                       // '#rrggbb', default '#38bdf8'
  density: 'comfortable' | 'compact';         // default 'comfortable'
  radius: number;                             // px, integer 4..16, default 10
  reduceMotion: boolean;                      // default false
  disableMotion: boolean;                     // default false
  sidebarCollapsed: boolean;                  // default false
  feedbackDurationMs: number;                 // 3000..10000 integer, default 5000 (notice + undo countdown)
  pdfViewer: 'adobe' | 'pdfjs';              // default 'adobe'; PDF preview engine (round 4), Adobe falls back to pdf.js automatically
};
```
Sanitizer `sanitizeUiSettings(input: unknown, base = DEFAULT_UI_SETTINGS): UiSettings` lives in `src/ui-settings.ts`
(pure, no DOM, no worker imports) and is imported by BOTH worker.ts and frontend. Unknown keys dropped, invalid values fall back to `base`.

## API
- `GET  /api/me/ui-settings` (SSO required) → `{ ok: true, item: UiSettings, updated_at: string | null }`
- `PUT  /api/me/ui-settings` body: partial UiSettings → merged with stored, sanitized, saved → `{ ok: true, item, updated_at }`
- D1 table `user_ui_settings(username TEXT PRIMARY KEY, settings_json TEXT NOT NULL, updated_at TEXT NOT NULL)`.

## Frontend module layout (new files)
- `src/app/theme.tsx`   ThemeProvider/useTheme — applies UiSettings to <html>, caches in localStorage `content-share-ui`, loads from API when logged in, debounced (600ms) PUT.
- `src/app/feedback.tsx` + `src/app/feedback.css`   ActionFeedbackProvider/useFeedback — bottom-right notices.
- `src/app/router.ts`   tiny History-API router for `/app/*`.
- `src/app/appearance-settings.tsx`   Appearance section for the settings page.

## HTML attributes set by theme engine on document.documentElement
- class `dark` when resolved mode is dark (existing CSS already uses `.dark`).
- `data-density="compact|comfortable"`, `data-reduce-motion="1|0"`, `data-no-motion="1|0"`
- CSS vars `--primary`, `--primary-foreground`, `--ring`, `--radius` via a <style id="cs-accent"> block (light + `.dark` variants).
