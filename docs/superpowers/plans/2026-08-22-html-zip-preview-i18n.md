# HTML and ZIP Preview with Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add safe direct HTML preview and an explicit client-side ZIP page viewer, deploy and verify those changes first, then add a persistent Chinese/English UI switch across the web app.

**Architecture:** Keep Worker authorization and R2 streaming as the source of truth. Direct HTML preview uses the existing authorized attachment preview route with a restrictive sandboxed iframe. ZIP files remain download-only by default; an explicit action fetches the authorized ZIP, extracts supported entries in the browser, creates temporary blob URLs for assets, rewrites the entry HTML, and renders it in a sandboxed iframe. Localization is added as a small React context/translation layer with browser language preference and localStorage persistence, while API values, slugs, filenames, and user content remain unchanged.

**Tech Stack:** React 18, TypeScript, Vite, Cloudflare Workers, R2, existing `fflate`-compatible ZIP parser if available or a narrowly scoped ZIP dependency, DOMPurify/marked, Vitest, Wrangler, Playwright CLI.

**Spec:** User request 2026-08-22: HTML preview, ZIP page viewer, then Chinese/English switch.

## Global Constraints

- Public attachments must remain viewable without auth; Worker permission checks must remain server-side.
- HTML and ZIP preview must never bypass the existing attachment access ticket/password/visibility checks.
- HTML runs in a sandboxed iframe without same-origin access; ZIP page assets use temporary object URLs and are revoked on unmount.
- ZIP files stay download-only until the user explicitly chooses “查看实际页面”.
- Unknown or malformed archives show a clear failure message and retain the download action.
- Do not expose secrets, alter R2 storage layout, or add fake buttons.

---

### Phase 1: HTML and ZIP Preview

**Files:**
- Modify: `src/worker.ts`
- Modify: `src/main.tsx`
- Modify: `src/styles.css`
- Modify: `src/transfer-policy.ts` if MIME detection needs an HTML/ZIP correction
- Test: `src/preview-policy.test.ts`
- Test: `src/zip-preview.test.ts`

**Interfaces:**
- Worker `previewKind(filename, contentType)` returns `html` for `.html`/`.htm`, and `zip` for ZIP MIME/extensions.
- Frontend `PreviewInfo.kind` accepts `html` and `zip`.
- Frontend `ZipPagePreview` accepts an authorized `download_url`, chooses an entry HTML file, and reports a user-visible failure without breaking download.

- [ ] Add red tests for HTML/ZIP kind classification and unsafe default ZIP behavior.
- [ ] Run the focused tests and confirm they fail before implementation.
- [ ] Update Worker preview headers so HTML is inline only through the sandboxed preview UI and ZIP remains attachment/download-only.
- [ ] Add direct HTML preview with “全屏/退出全屏” and “查看源代码/查看预览” controls.
- [ ] Add explicit ZIP “查看实际页面” action, entry selection, temporary asset URL mapping, sandboxed rendering, and failure fallback.
- [ ] Add responsive styles for the HTML/ZIP toolbar and iframe without horizontal overflow.
- [ ] Run focused tests, full tests, typecheck, and production build.
- [ ] Deploy with `npx wrangler deploy` and verify public HTML, public ZIP, download, source/preview toggle, fullscreen controls, and malformed ZIP fallback with Playwright/screenshots.

### Phase 2: Chinese/English UI

**Files:**
- Create: `src/i18n.tsx`
- Modify: `src/main.tsx`
- Modify: `src/styles.css`
- Test: `src/i18n.test.ts`
- Modify: `readme.md`, `readme_zh.md`, `CHECKLIST.md`

**Interfaces:**
- `Language = 'zh-CN' | 'en-US'`.
- `I18nProvider` exposes `language`, `setLanguage`, and `t(key, vars?)`.
- Language switch persists under a namespaced localStorage key and does not translate user-created content or server enum values.

- [ ] Add red tests for language persistence, fallback, and interpolation.
- [ ] Implement the translation provider and right-top language switch.
- [ ] Replace visible app chrome, buttons, toasts, empty states, preview controls, and settings copy with translation keys.
- [ ] Preserve filenames, Markdown/text content, slugs, API responses, and admin/data values.
- [ ] Verify desktop/mobile language switching and no horizontal overflow.
- [ ] Update docs/checklist and deploy the final localized build.

## Verification Commands

```powershell
npm.cmd test
npx.cmd tsc --noEmit
npm.cmd run build
npx.cmd wrangler deploy --dry-run
npx.cmd wrangler deploy
```

