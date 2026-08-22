# Task 3 Report: Business Permissions And API Key Locks

## Implementation

- Extended `HttpError` and Worker error JSON with optional stable `code` and `details` fields while preserving the existing `ok` and `message` contract.
- Enforced public-publish, internal-access, storage, comment, and API permissions through the effective group profile loaded from D1.
- Applied storage and visibility guards to browser text/file creation, direct upload initiation, CLI creation, content visibility updates, and CLI default visibility updates. Task 4 remains responsible for quota reservations and byte-capacity enforcement.
- Required authenticated `can_internal_access` for internal share metadata, notes, preview metadata, preview/download bytes, and media-ticket paths. Anonymous public access and owner-private access remain unchanged.
- Kept authorized comment lists readable while requiring `can_comment` for comments, replies, and owner-only private memo writes.
- Added explicit API Key lock handling separate from active/expired/revoked status. CLI authentication checks revoked, expired, locked, and current owner API permission in that order.
- Added audited admin APIs for permission-group CRUD, user-group assignment, and API Key rotate/lock/unlock/revoke actions. Rotation returns the new secret once and persists only its hash.
- Used one D1 batch for each admin mutation and its audit row. Group API removal, no-API user assignment, and no-API replacement deletion lock affected active keys in the same batch; restoring permission does not clear lock metadata.
- Extended `/api/admin/users` with current permission-group fields, effective permissions, used bytes, active reserved bytes, and quota while preserving existing statistics fields.
- Added Chinese and English messages for the stable permission and API Key error codes.

## RED Evidence

Initial command:

```text
npx vitest run src/access-control.test.ts
```

Result: exit `1`; all `15` initial route tests failed against the pre-Task-3 Worker. Failures were the expected missing behavior: protected routes returned `200`, missing admin routes returned `404`, direct upload returned `503` before permission evaluation, and existing errors lacked stable codes.

Additional red cycles caught and then fixed:

- already-expired keys with lock metadata returned `API_KEY_LOCKED` instead of `API_KEY_EXPIRED`;
- locked owner keys could not be revoked;
- assigning a nonexistent user returned success and would have written an audit row;
- `/api/admin/users` omitted group and storage-accounting fields.

## Verification

Focused command:

```text
npx vitest run src/access-control.test.ts src/worker-permissions.test.ts src/i18n.test.ts
```

Result: exit `0`; `3` files and `39` tests passed.

Full command:

```text
npm test
```

Result: exit `0`; `12` files and `82` tests passed.

Type check:

```text
npx tsc --noEmit
```

Result: exit `0` with no diagnostics.

Production build:

```text
npm run build
```

Result: exit `0`; Vite transformed `1688` modules and completed the production build in `18.21s`.

Diff validation:

```text
git diff --check
```

Result: exit `0`; Git emitted only the checkout's LF-to-CRLF notices.

## Route Coverage

- Default-public creation and explicit public visibility updates return `PUBLIC_PUBLISH_PERMISSION_REQUIRED` without permission.
- Text, legacy file, direct, and CLI creation return `STORAGE_PERMISSION_REQUIRED` without storage permission.
- Internal metadata, preview-info, download, and media-ticket requests reject missing login or `can_internal_access`.
- Comment lists remain readable; comment and memo writes return `COMMENT_PERMISSION_REQUIRED` when disabled.
- User API Key management and CLI settings require `can_api`; CLI key authentication preserves revoked/expired/locked ordering and locks permission-drifted active keys.
- A JWT `role=user` assigned to the `admin` business group still receives `403` from Admin APIs.
- Permission-group creation/update/delete, user reassignment, and all four admin API Key actions are exercised through Worker HTTP routes, including D1 batch inspection for lock and audit membership.

## Files Changed

- `src/worker.ts`
- `src/access-control.test.ts`
- `src/i18n.tsx`
- `.superpowers/sdd/2026-08-22-permissions-large-upload-admin-mobile/task-3-report.md`

## Self-Review

- Admin access checks only the verified JWT role; permission-group names are never consulted for elevation.
- System groups can change permissions and quota but cannot be renamed or deleted. The current default cannot be unset without selecting another default, and custom deletion requires a different existing replacement group.
- Key locks update only active, currently unlocked keys and never alter lifecycle status. Permission restoration has no unlock statement. Admin unlock clears only lock metadata and rechecks the owner's current `can_api` permission first.
- Admin rotation revokes the old key and inserts the replacement plus audit row in one D1 batch. The returned full secret is absent from D1 and audit details.
- Internal tickets remain attachment/content scoped and short-lived, but no longer bypass current login or group permission checks.
- Existing password checks still occur before protected internal access, preserving share-password behavior.

## Concerns

- No blocker remains. Task 4 must still integrate atomic storage reservations, text byte accounting, and quota-capacity errors; Task 3 intentionally enforces storage permission and zero quota only.
- No migration, deployment, or live production checks were requested or performed for this task.
- Vite continues to emit the pre-existing React Babel/esbuild deprecation notices and generated chunk-size warning; neither was introduced by these Worker changes.
