# Permissions, Large Uploads, and Admin Mobile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add strict JWT-admin identity, single-group business permissions, quota-safe 5 GiB uploads, responsive administration, faster QR posters, and a polished SSO callback to Content Share.

**Architecture:** Keep auth-center JWT verification as the sole identity source, resolve business permissions from one normalized D1 group, and enforce every permission in the Worker. Reserve quota atomically before direct-to-R2 uploads, issue multipart signatures in bounded windows, and expose a typed `/api/me` profile for frontend affordances. Preserve the existing IndexedDB queue, Queue completion, R2-only file storage, and D1 audit model.

**Tech Stack:** Cloudflare Workers, D1, R2, Queues, React 18, TypeScript, Vite, Vitest, Playwright, Lucide React, Sharp for build-time image optimization.

**Spec:** `docs/superpowers/specs/2026-08-22-permissions-large-upload-admin-mobile-design.md`

## Global Constraints

- Worker name remains `content-share` and production remains `https://content.aryuki.com`.
- Only a verified auth-center JWT `role=admin` may enter `/api/admin/*`; permission groups cannot grant dashboard access.
- Every user belongs to exactly one permission group.
- Files remain in R2 and structured records remain in D1.
- Maximum file size is 5 GiB; file bytes must not traverse the Worker.
- Existing IndexedDB queue, SHA-256 identity, heartbeats, and 30-minute stale cleanup remain functional.
- All permission checks are authoritative in the Worker; hidden frontend controls are not security boundaries.
- Dialogs lock background scrolling; mobile controls use at least 16px input text and page-level horizontal overflow is forbidden.
- Successful long-field copy icons show a check for five seconds.
- Never print, commit, or expose credentials from `.design/secret.txt`.

---

### Task 1: Permission Policy And D1 Migration

**Files:**
- Create: `migrations/0003_permission_groups_and_quotas.sql`
- Create: `src/permission-policy.ts`
- Create: `src/permission-policy.test.ts`
- Modify: `schema.sql`

**Interfaces:**
- Produces: `PermissionKey`, `PermissionSet`, `PermissionGroupRecord`, `UserAccessProfile`.
- Produces: `canUseVisibility(profile, visibility)`, `assertUploadAllowance(profile, requestedBytes)`, and `middleEllipsis(value, head, tail)`.
- Migration produces `permission_groups`, `storage_reservations`, `users.permission_group_id`, `contents.text_size`, and API Key lock columns.

- [ ] **Step 1: Write failing policy tests**

```ts
it('does not let a business group grant dashboard access', () => {
  expect(canEnterAdminDashboard({ role: 'user', groupName: 'admin' })).toBe(false);
  expect(canEnterAdminDashboard({ role: 'admin', groupName: 'user' })).toBe(true);
});

it('rejects quota exhaustion with stable accounting', () => {
  expect(() => assertUploadAllowance(profile({ can_upload: true, quota_bytes: 100, used_bytes: 70, reserved_bytes: 20 }), 11))
    .toThrowError(expect.objectContaining({ code: 'STORAGE_QUOTA_EXCEEDED' }));
});

it('uses middle ellipsis for long audit values', () => {
  expect(middleEllipsis('2409:8970:b56:15c4:2c32:982e:798f:9ad7', 10, 8)).toBe('2409:8970:…798f:9ad7');
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `npx vitest run src/permission-policy.test.ts`

Expected: FAIL because `permission-policy.ts` and its exports do not exist.

- [ ] **Step 3: Implement pure policy types and functions**

```ts
export const PERMISSION_KEYS = ['can_public_publish', 'can_api', 'can_internal_access', 'can_upload', 'can_comment'] as const;
export type PermissionKey = typeof PERMISSION_KEYS[number];

export function canEnterAdminDashboard(user: { role: string }): boolean {
  return user.role === 'admin';
}

export function assertUploadAllowance(profile: UserAccessProfile, requestedBytes: number): void {
  if (!profile.permissions.can_upload || profile.quota_bytes <= 0) throw new PolicyError('STORAGE_PERMISSION_REQUIRED', 403);
  if (profile.used_bytes + profile.reserved_bytes + requestedBytes > profile.quota_bytes) {
    throw new PolicyError('STORAGE_QUOTA_EXCEEDED', 413, { requested_bytes: requestedBytes, used_bytes: profile.used_bytes, reserved_bytes: profile.reserved_bytes, quota_bytes: profile.quota_bytes });
  }
}
```

- [ ] **Step 4: Add the normalized migration and mirror it in `schema.sql`**

The migration inserts immutable-name system groups with byte quotas `5368709120` and `107374182400`, marks `user` as default, assigns existing users by stored role, and adds partial unique index `idx_permission_groups_single_default ON permission_groups(is_default) WHERE is_default = 1`.

- [ ] **Step 5: Run policy tests and schema checks**

Run: `npx vitest run src/permission-policy.test.ts`

Expected: PASS.

Run: `npx wrangler d1 migrations apply content-share-db --local`

Expected: migration 0003 applies without constraint errors.

### Task 2: Permission Store, Strict Admin Identity, And Profile APIs

**Files:**
- Create: `src/worker-permissions.ts`
- Create: `src/worker-permissions.test.ts`
- Modify: `src/worker.ts`
- Modify: `wrangler.toml`

**Interfaces:**
- Consumes: policy types from Task 1.
- Produces: `ensureUserGroup(db, username, jwtRole)`, `loadUserAccessProfile(db, username)`, `requireBusinessPermission(profile, key)`, `reserveStorage(db, input)`, and `releaseStorageReservation(db, reservationId)`.
- Produces API: `GET /api/me` with `{ user, group, permissions, storage }`.

- [ ] **Step 1: Write failing store tests with a recording D1 stub**

```ts
it('assigns the default group only when a user has no group', async () => {
  const db = recordingDb({ first: { id: 'grp_user' } });
  await ensureUserGroup(db, 'alice', 'user');
  expect(db.sql).toContain('permission_group_id IS NULL');
});

it('uses one conditional insert to reserve storage', async () => {
  const db = recordingDb({ changes: 1 });
  await reserveStorage(db, { id: 'res_1', username: 'alice', contentId: 'cnt_1', bytes: 1024, expiresAt: '2026-08-22T00:30:00.000Z' });
  expect(db.sql.filter((sql) => sql.includes('INSERT INTO storage_reservations'))).toHaveLength(1);
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run src/worker-permissions.test.ts`

Expected: FAIL because the store module does not exist.

- [ ] **Step 3: Implement D1 access helpers and `/api/me`**

Return storage fields as numbers: `used_bytes`, `reserved_bytes`, `quota_bytes`, `available_bytes`. Count all non-permanently-deleted content records because soft deletion retains data.

- [ ] **Step 4: Remove username admin promotion**

Delete `ADMIN_USERNAMES` from `Env`, JWT role resolution, and `wrangler.toml`. Keep `requireAdmin(user)` as strict `user.role === 'admin'` and add a regression test that username `admin` with JWT role `user` receives 403.

- [ ] **Step 5: Run focused and existing auth tests**

Run: `npx vitest run src/permission-policy.test.ts src/worker-permissions.test.ts`

Expected: PASS.

### Task 3: Enforce Business Permissions And API Key Locks

**Files:**
- Modify: `src/worker.ts`
- Create: `src/access-control.test.ts`
- Modify: `src/i18n.tsx`

**Interfaces:**
- Consumes: `loadUserAccessProfile` and policy guards.
- Produces Admin APIs: `/api/admin/users/:username/group`, `/api/admin/permission-groups`, `/api/admin/permission-groups/:id`, `/api/admin/api-keys/:id/{rotate,lock,unlock,revoke}`.
- Existing share, content, notes, user API Key, and CLI routes gain server-side permission checks.

- [ ] **Step 1: Write failing route-policy tests**

```ts
it.each([
  ['public publish', 'can_public_publish'],
  ['internal access', 'can_internal_access'],
  ['comment create', 'can_comment'],
  ['api key use', 'can_api']
])('rejects %s when %s is false', async (_label, permission) => {
  const response = await invokeProtectedRoute({ permission, enabled: false });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ ok: false, code: expect.any(String) });
});
```

- [ ] **Step 2: Confirm tests fail, then centralize guards**

Run: `npx vitest run src/access-control.test.ts`

Expected: FAIL before route guards are added.

- [ ] **Step 3: Enforce public, internal, storage, and comment permissions**

Apply guards to browser create/update, CLI create, direct-upload initiation, share metadata, preview, download, notes create, and replies. Preserve anonymous public access and owner private access.

- [ ] **Step 4: Implement API Key lock lifecycle**

Key authentication checks revoked, expiry, explicit lock, and current owner API permission in that order. Removing API permission or assigning a no-API group locks active keys in the same D1 batch. Unlock rechecks permission and returns `API_PERMISSION_REQUIRED` when blocked.

- [ ] **Step 5: Implement permission-group and user-group admin mutations**

System names cannot be deleted, only one default is allowed, and deleting a custom group requires `replacement_group_id`. Write an `admin_actions` row for every mutation.

- [ ] **Step 6: Run access-control and full tests**

Run: `npx vitest run src/access-control.test.ts src/worker-permissions.test.ts && npm test`

Expected: PASS.

### Task 4: Quota Reservations And 5 GiB Windowed Multipart Uploads

**Files:**
- Modify: `src/transfer-policy.ts`
- Modify: `src/transfer-policy.test.ts`
- Modify: `src/upload-client.ts`
- Modify: `src/upload-client.test.ts`
- Modify: `src/worker.ts`
- Modify: `src/upload-resume.ts`
- Modify: `src/upload-resume.test.ts`

**Interfaces:**
- Produces: `MAX_UPLOAD_SIZE = 5 * GiB`, `partSizeFor(size)`, and `buildPartWindow(size, completedParts, startAfter, windowSize)`.
- Upload plans return `parts`, `next_part_number`, `has_more_parts`, and existing session metadata.
- Produces API: `GET /api/uploads/:sessionId/parts?after=N&limit=8` and CLI equivalent.

- [ ] **Step 1: Extend boundary tests**

```ts
expect(chooseUploadMode(16 * MiB)).toBe('single');
expect(partSizeFor(100 * MiB)).toBe(8 * MiB);
expect(partSizeFor(100 * MiB + 1)).toBe(64 * MiB);
expect(buildPartPlan(5 * GiB)).toHaveLength(80);
expect(() => buildPartPlan(5 * GiB + 1)).toThrow(/5 GiB/);
```

- [ ] **Step 2: Run transfer tests and confirm failure**

Run: `npx vitest run src/transfer-policy.test.ts src/upload-client.test.ts`

Expected: FAIL at the old 100 MiB limit and all-parts plan assumptions.

- [ ] **Step 3: Implement adaptive parts and bounded signing windows**

Keep all non-final parts uniform. Return at most eight signed URLs per call, omit completed parts, and renew only the current window. Limit large-file browser concurrency to two on touch/mobile devices and three elsewhere.

- [ ] **Step 4: Add quota reservation to text and direct-upload creation**

Compute text with `new TextEncoder().encode(text).byteLength`. Create the reservation before R2 multipart initialization; abort created multipart uploads and release the reservation when subsequent setup fails. Queue completion updates content size and releases the reservation in one D1 batch.

- [ ] **Step 5: Integrate reservation cleanup**

The scheduled stale-session cleanup deletes matching active reservations after aborting multipart uploads and removing staging objects. Heartbeats extend both session activity and reservation expiry.

- [ ] **Step 6: Preserve form/file state on permission and quota errors**

Do not call form-reset or queue removal unless the Worker returns success. Map `STORAGE_PERMISSION_REQUIRED` and `STORAGE_QUOTA_EXCEEDED` to localized messages containing available and requested sizes.

- [ ] **Step 7: Run upload tests**

Run: `npx vitest run src/transfer-policy.test.ts src/upload-client.test.ts src/upload-resume.test.ts && npm test`

Expected: PASS.

### Task 5: User, Permission, And API Key Admin UI

**Files:**
- Modify: `src/main.tsx`
- Modify: `src/styles.css`
- Modify: `src/i18n.tsx`
- Create: `src/admin-display.ts`
- Create: `src/admin-display.test.ts`

**Interfaces:**
- Consumes `/api/me` and Task 3 admin APIs.
- Produces `CopyFullValue` with a five-second success state and `CompactValue` using `middleEllipsis`.
- Produces Admin tabs `users` and `permissions`.

- [ ] **Step 1: Write failing presentation tests**

```ts
it('keeps the beginning and end of long values', () => {
  expect(compactAuditValue('Mozilla/5.0 very long browser signature', 22)).toMatch(/^Mozilla\/5\.0.*….*signature$/);
});
```

- [ ] **Step 2: Implement profile-aware navigation and visibility controls**

Hide API Key navigation without API permission and omit `public` from all visibility segmented controls without public-publish permission. Keep server errors visible if permissions change while a form is open.

- [ ] **Step 3: Replace User Statistics with User Management**

Keep compact expandable statistics, remove the old text operation button, and add an icon action that opens group assignment with usage and effective permissions.

- [ ] **Step 4: Add Permission Management**

Use real APIs for create, edit, default, and delete-with-reassignment. Built-in groups show disabled delete controls rather than a nonfunctional button.

- [ ] **Step 5: Rebuild API Key audit actions**

Keep the expand arrow. Show a compact ellipsized key plus icon-only rotate, lock/unlock, and revoke controls with Lucide icons, tooltips, confirmation for destructive actions, and real API calls.

- [ ] **Step 6: Make mobile admin dense and locally scrollable**

At phone widths, reduce gutters and row padding, keep icon touch targets at least 36px, wrap expanded details, and confine horizontal scrolling to `.admin-table-scroll`.

- [ ] **Step 7: Run tests and type checking**

Run: `npx vitest run src/admin-display.test.ts && npx tsc --noEmit`

Expected: PASS.

### Task 6: Filter Layout, Modal Lock, QR Performance, And SSO Loading

**Files:**
- Create: `src/modal-scroll-lock.ts`
- Create: `src/modal-scroll-lock.test.ts`
- Modify: `src/main.tsx`
- Modify: `src/styles.css`
- Modify: `src/i18n.tsx`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `scripts/optimize-qr-backgrounds.mjs`
- Create: `src/assets/qr-bg-collage.webp`
- Create: `src/assets/qr-bg-collage-thumb.webp`
- Create: `src/assets/qr-bg-minimal.webp`
- Create: `src/assets/qr-bg-minimal-thumb.webp`
- Create: `src/assets/qr-bg-punk.webp`
- Create: `src/assets/qr-bg-punk-thumb.webp`

**Interfaces:**
- Produces: `lockDocumentScroll()` returning an idempotent unlock function.
- QR metadata contains separate `src` and `thumbnail` URLs.

- [ ] **Step 1: Write scroll-lock state tests**

```ts
it('restores the original scroll position exactly once', () => {
  const unlock = lockDocumentScroll(fakeDocument, fakeWindow({ scrollY: 420 }));
  unlock();
  unlock();
  expect(scrollTo).toHaveBeenCalledTimes(1);
  expect(scrollTo).toHaveBeenCalledWith(0, 420);
});
```

- [ ] **Step 2: Implement shared dialog scroll locking**

Apply it to QR posters, confirmations, user/group management, API Key secret display, filters, and existing dialogs. Mark background content inert while open and restore focus to the invoking control on close.

- [ ] **Step 3: Optimize bundled QR assets**

Install Sharp as a dev dependency and generate 1200x675 display WebP files and 240x135 thumbnail WebP files. Keep each display file below 300 KiB and each thumbnail below 40 KiB. Load only the selected display image eagerly; thumbnails use `loading="lazy"` and `decoding="async"`.

- [ ] **Step 4: Make mobile search and filter controls share one row**

Use `grid-template-columns: minmax(0, 1fr) auto`; give the search input `min-width: 0`, and keep the filter icon fixed-size at the trailing edge.

- [ ] **Step 5: Prevent focus-triggered mobile zoom**

Set mobile input, textarea, button-menu, and custom date controls to at least 16px. Do not add viewport maximum-scale restrictions.

- [ ] **Step 6: Add the auth callback loading screen**

Render four animated squares with reduced-motion fallback while token exchange is pending. Keep landing/dashboard content unmounted until the session resolves.

- [ ] **Step 7: Run focused tests and production build**

Run: `npx vitest run src/modal-scroll-lock.test.ts && npm run build`

Expected: PASS and optimized assets emitted by Vite.

### Task 7: Documentation, Migration, Deployment, And Live Verification

**Files:**
- Modify: `ApiDocs.md`
- Modify: `readme.md`
- Modify: `readme_zh.md`
- Modify: `CHECKLIST.md`

**Interfaces:**
- Documents stable errors `STORAGE_PERMISSION_REQUIRED`, `STORAGE_QUOTA_EXCEEDED`, `PUBLIC_PUBLISH_PERMISSION_REQUIRED`, `API_PERMISSION_REQUIRED`, `INTERNAL_ACCESS_REQUIRED`, and `COMMENT_PERMISSION_REQUIRED`.

- [ ] **Step 1: Update API and project documentation**

Document the 5 GiB maximum, adaptive multipart sizes, part-window endpoint, renew behavior, quota fields, Key lock behavior, permission groups, and curl/PowerShell/Node resumable examples. Update checklist rows with files, APIs, D1/R2 data sources, and tests.

- [ ] **Step 2: Run repository verification**

Run: `npm test`

Run: `npx tsc --noEmit`

Run: `npm run build`

Run: `npx wrangler deploy --dry-run`

Expected: all commands exit 0 and Wrangler lists D1, R2, Queue, Assets, cron, and custom-domain configuration without `ADMIN_USERNAMES`.

- [ ] **Step 3: Export remote D1 before migration**

Run: `npx wrangler d1 export content-share-db --remote --output output/backups/content-share-db-before-permissions-2026-08-22.sql`

Expected: a nonempty SQL export stored under ignored `output/`.

- [ ] **Step 4: Apply migration and deploy**

Run: `npx wrangler d1 migrations apply content-share-db --remote`

Run: `npx wrangler deploy`

Expected: migration 0003 applies and deployment prints a new Worker version for `content.aryuki.com`.

- [ ] **Step 5: Verify live permissions**

Use the existing authorized test-login flow without logging its secret. Confirm JWT role admin reaches Admin Dashboard; a role user assigned to business group `admin` receives 403 from `/api/admin/dashboard`; disabled public/API/internal/storage/comment permissions each block their corresponding direct API.

- [ ] **Step 6: Verify a real large transfer**

Generate a deterministic 128 MiB binary fixture under ignored `output/`, upload through `/api/cli/uploads/initiate` and multipart part windows, activate it, download through the public share, and compare local/uploaded SHA-256. Permanently delete the test content afterward.

- [ ] **Step 7: Run Playwright desktop and mobile checks**

At 1440x900 and 390x844, capture screenshots for User Management, Permission Management, API Key audit, filter row, QR modal, and SSO loading. Assert `document.documentElement.scrollWidth === window.innerWidth`, modal background scroll remains fixed, full-value copy changes to a check for five seconds, and QR nonselected display images are not eagerly requested.

- [ ] **Step 8: Record final evidence**

Report tests, migration, Worker version, large-file SHA-256 equality, permission-boundary statuses, screenshot paths, and any residual production risk without exposing credentials.
