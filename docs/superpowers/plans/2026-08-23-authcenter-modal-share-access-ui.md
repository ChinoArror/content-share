# Auth Center Modal and Share Access UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved Auth Center-style modal system, compact bilingual admin views, loading shimmer, and redesigned internal/password share access states.

**Architecture:** Keep the existing Worker API and React SPA. Add reusable modal, confirmation, query-loading, copy-value, and access-state presentation helpers in the existing frontend, with one small Worker route/variable surface for administrator contact. Use existing permission responses and i18n rather than duplicating authorization logic.

**Tech Stack:** Cloudflare Workers, D1/R2, React, TypeScript, Vite, CSS, Lucide React, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-authcenter-modal-share-access-ui-design.md`

## Global Constraints

- Use only the existing auth-center SSO for login; API keys remain CLI-only.
- Keep Worker-side permission checks authoritative; frontend controls are presentation only.
- Use Lucide icons and existing i18n keys; no hand-written SVG or browser-native confirm dialogs.
- Keep phone layouts within the viewport; local data tables may scroll only inside their own container.
- Do not log, commit, or expose any auth-center secret.

### Task 1: Shared modal and confirmation primitives

**Files:**
- Modify: `src/main.tsx`
- Modify: `src/styles.css`
- Test: `src/admin-display.test.ts` or a new focused UI-helper test if a pure helper is extracted

**Interfaces:**
- Produce `ModalShell({ children, close, title?, className?, mobileMode? })` and `ConfirmModal({ open, title, message, confirmLabel, destructive, onConfirm, onClose })`.
- Consume existing `useBodyScrollLock`, `useI18n`, `Toast`, and Lucide icons.

- [ ] Extract the fixed overlay/panel/scroll-lock rules into `ModalShell`; keep the close button absolute at the upper-right and make the panel scroll internally.
- [ ] Replace the QR, edit-content, user-management, and permission-group wrappers with `ModalShell`.
- [ ] Replace content delete/permanent-delete, API-key revoke/rotate/lock/unlock, permission-group delete, background clear, and comment-delete `confirm()` calls with `ConfirmModal` state.
- [ ] Add red destructive styling and backdrop-close handling; stop propagation inside panel content.
- [ ] Run `npm test -- --runInBand` and verify no `confirm(` remains in the specified interaction paths.
- [ ] Commit as `feat: unify auth center modal interactions`.

### Task 2: Query loading, visibility segments, and filters

**Files:**
- Modify: `src/main.tsx`
- Modify: `src/styles.css`
- Modify: `src/i18n.tsx`
- Test: `src/admin-display.test.ts`, `src/i18n.test.ts`

**Interfaces:**
- Produce `QueryLoading` and dynamic `VisibilitySegment` sizing based on `options.length`.

- [ ] Add `loading` state with `try/finally` to My Contents, recent files, API keys, admin contents, users, permission groups, logs/audit, and settings loaders.
- [ ] Render `QueryLoading` below active list panels and implement a gray moving horizontal shimmer in CSS.
- [ ] Make visibility segment CSS variables derive from the rendered option count so a missing public option also reduces the background width.
- [ ] Put My Contents search, filter icon, and action button on one responsive row with `min-width: 0`.
- [ ] Add and test translations for all new loading, not-locked, never-used, permission-group, and share access labels.
- [ ] Run focused tests and commit as `feat: compact loading filters and visibility controls`.

### Task 3: Compact Admin user, permission, access-log, and API-audit views

**Files:**
- Modify: `src/main.tsx`
- Modify: `src/styles.css`
- Modify: `src/i18n.tsx`
- Test: `src/admin-display.test.ts`

**Interfaces:**
- Consume `middleEllipsis`, `compactAuditValue`, `CopyFullValue`, `permissionKeys`, and `labelOf`.
- Preserve API payload keys while mapping only approved display fields.

- [ ] Give refresh/export buttons the same dimensions and retain icon plus translated text at all breakpoints.
- [ ] Reduce user table minimum width, make permission badges content-sized, and keep only an inner table scroll on narrow screens.
- [ ] Replace raw `Object.entries(row)` details with a translated display map that excludes `permission_group_id` and sensitive internal fields.
- [ ] Make expanded details compact two-column rows without individual borders; keep long IP, browser, log/content/key IDs as first/last ellipsis plus a five-second copy action.
- [ ] Merge API key prefix/suffix in both summary and details; label `created_at` as creation time; show “not locked” for null `locked_at` and “never used” for null `last_used_at`.
- [ ] Remove redundant row actions while preserving real API-backed manage/rotate/lock/unlock/revoke actions.
- [ ] Run tests and commit as `feat: tighten admin data views`.

### Task 4: Permission editor, branding, and contact configuration

**Files:**
- Modify: `src/main.tsx`
- Modify: `src/styles.css`
- Modify: `src/i18n.tsx`
- Modify: `src/worker.ts`
- Modify: `wrangler.toml`
- Modify: `public/favicon.svg`
- Modify: `readme.md`
- Modify: `readme_zh.md`

**Interfaces:**
- Add `ADMIN_CONTACT_EMAIL` to the Worker environment type and the controlled contact response/action.

- [ ] Move permission-group create/edit/delete into the shared modal; rename storage quota UI to storage space, add a fixed `GB` suffix, and keep checkbox controls visually sized to the checkbox.
- [ ] Add the admin contact environment variable documentation without putting a value in source control.
- [ ] Implement the contact action as a Worker-generated mailto target when no email-sending binding exists, with a safe missing-address response.
- [ ] Extract a reusable `BrandMark` used by sidebar, SSO loading shell, landing view, and favicon design.
- [ ] Build and run typecheck; commit as `feat: polish permission editor and branding`.

### Task 5: Bilingual internal and password share access states

**Files:**
- Modify: `src/main.tsx`
- Modify: `src/styles.css`
- Modify: `src/i18n.tsx`
- Modify: `src/worker.ts` only if the contact response is not covered by Task 4
- Test: `src/access-control.test.ts`, `src/worker-permissions.test.ts`

**Interfaces:**
- Consume the existing `ShareAccessError` response codes and `shareHeaders`.
- Keep password input state local to `ContentPreviewPage`.

- [ ] Add bilingual access-state cards for login-required internal content, insufficient internal permission, and password-required/incorrect-password states.
- [ ] Add language switcher to all failure states, red circular failure mark, concise explanation, and responsive spacing.
- [ ] Implement switch-login by clearing the current SSO token and redirecting through the existing auth-center logout flow.
- [ ] Implement contact-admin using the controlled Worker-provided mailto action; hide it when no configured admin address exists.
- [ ] Ensure new tabs do not reuse password state or password tickets; keep password submission scoped to the current document.
- [ ] Add/update access-control tests and commit as `feat: redesign protected share access states`.

### Task 6: Verification, screenshots, deployment, and checklist

**Files:**
- Modify: `CHECKLIST.md`
- Modify: `ApiDocs.md` only if the contact environment or endpoint is documented
- Create/refresh: `output/playwright/*.png` locally; keep ignored by git

- [ ] Run `npm test`, `npx tsc --noEmit`, `npm run build`, and `git diff --check`.
- [ ] Run Playwright at desktop and 390px mobile for landing, My Contents, users, permission modal, logs, audit, internal error, password error, and a public share.
- [ ] Assert `scrollWidth <= clientWidth`, modal scroll lock, backdrop close, five-second copy feedback, and absence of native confirmation dialogs.
- [ ] Apply any failing visual or behavior regressions before deployment.
- [ ] Apply pending D1 migrations if required, deploy with `npx wrangler deploy`, and verify live `200` responses for `/`, `/docs`, `/s/5`, `/sso-callback`, and `/face-transfer`.
- [ ] Update the checklist with status, file, API, data source, and test method for every changed function.
- [ ] Commit final docs/verification as `docs: record modal and access state delivery`.

