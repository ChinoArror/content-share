# Task 4B Report: Worker Quota Reservations And Upload Lifecycle

## Status

Task 4B is implemented and verified. All focused and full automated tests pass, TypeScript passes, the production build passes, and the installed Wrangler CLI completes the deployment dry-run with exit code 0.

The `npx.cmd wrangler deploy --dry-run` package wrapper consistently prints Wrangler's complete successful dry-run output, including `--dry-run: exiting now`, but remains open afterward on this Windows/proxy environment. Three bounded attempts were stopped rather than left running indefinitely. The same installed Wrangler 4.93.0 entry point exits normally when invoked directly; details are recorded under Verification and Concerns.

## Implementation

### Conditional quota reservations

- Kept zero-byte payloads reservation-free because migration `0003` requires reservation bytes to be positive.
- Made reservation insertion and replacement one conditional SQL statement. The quota gate includes retained content bytes and active, unexpired reservations while excluding the deterministic reservation row being replaced.
- Reuses the deterministic `res_<content_id>` reservation only for the same owner and content.
- When a conditional reservation reports zero changes, reloads the current access profile and returns either:
  - `STORAGE_PERMISSION_REQUIRED` with HTTP 403, or
  - `STORAGE_QUOTA_EXCEEDED` with HTTP 413.
- Both errors include numeric `used_bytes`, `reserved_bytes`, `requested_bytes`, and `quota_bytes` details.

### Placeholder and setup lifecycle

- Text, legacy form, mixed form, browser direct, and CLI direct creation first insert a `processing` content placeholder with `text_size=0` and `file_size=0`.
- Capacity is reserved for UTF-8 text bytes plus declared file bytes before any R2 multipart upload is created.
- Text-only creation activates synchronously through the same placeholder, conditional reservation, and atomic activation/release flow.
- Setup rollback aborts created multipart uploads, removes staged R2 objects, then deletes upload parts, sessions, attachments, reservations, and content in foreign-key-safe order.
- Final content byte fields are never written during setup. They are written only in the D1 batch that marks the content active and releases its reservation.

### Transfer boundaries and plans

- Browser and CLI direct initiation accept each file through exactly 5 GiB and reject larger files with stable `FILE_TOO_LARGE` HTTP 413 responses.
- Legacy browser and CLI form endpoints retain the compatibility path through 100 MiB. Larger files through 5 GiB receive stable `RESUMABLE_UPLOAD_REQUIRED` HTTP 413 responses; files above 5 GiB still fail through transfer policy.
- Removed the 500 MiB aggregate pending-byte cap and retained the 50-session pending count cap.
- Initial, reused, renewed, browser `GET /parts`, and CLI `GET /parts` multipart plans sign no more than eight missing parts.
- Part windows use an exclusive `after` cursor, clamp `limit` to eight, skip completed parts, and report the next missing part and whether more parts remain.
- Browser routes authenticate the SSO owner. CLI routes authenticate the API key owner.

### Reservation reuse and activity

- Reused sessions return their existing active reservation without inserting another row.
- If the current reservation is absent or expired, the Worker recomputes UTF-8 text plus all session bytes and performs one conditional deterministic reservation before returning plans.
- Heartbeats update session activity, the longer session expiry, and the active reservation's 30-minute inactivity expiry in one ordered D1 batch.
- Part reports, renewals, completion requests, and paged part-plan requests ensure the reservation still exists before continuing.

### Queue and cleanup lifecycle

- Legacy Queue activation derives final UTF-8 text and active attachment bytes, then marks content active and releases the reservation in one D1 batch.
- Direct finalization marks the session and attachment complete, then performs the same atomic content activation/release batch.
- Activation SQL requires the matching active, unexpired reservation. A zero-change activation throws so Queue delivery retries instead of acknowledging unreserved content.
- A Queue retry for an already completed single-upload session re-runs content activation rather than silently returning.
- Terminal Queue failure removes all related staging and finalized objects before expiring the processing content and its reservation.
- Scheduled inactivity cleanup works per content: it aborts active multipart uploads and deletes all sibling staging/final objects before its D1 batch expires sessions, fails attachments, clears processing text, expires content, and expires the reservation last.
- Permanent deletion removes reservation rows before deleting the referenced content.

### Frontend behavior

- Worker/API and legacy XHR failures retain stable HTTP status, error code, and structured details through `UploadRequestError`.
- Quota errors display localized used, reserved, requested, and quota byte totals in Chinese and English.
- Direct initiation, quota, upload persistence, and fallback failures leave the selected files and form fields intact.
- Completed queue entries are cleared before the form and selected files reset; any cleanup persistence failure prevents those UI resets.
- Legacy fallback removes queued direct-upload entries only after the compatibility upload succeeds.
- UI file-size messaging now reflects the 5 GiB direct-upload limit.

## RED Evidence

### Permission and quota classification

```text
npx.cmd vitest run src/worker-permissions.test.ts
```

Initial result: exit 1 with 2 expected failures. The old code returned a generic quota error after a zero-change conditional insert and did not provide the refreshed numeric accounting or distinguish upload permission denial.

GREEN: the focused file later passed all 11 tests.

### Worker route and lifecycle coverage

```text
npx.cmd vitest run src/worker-upload.test.ts
```

Initial result: exit 1 with the initial 20 lifecycle tests failing against the old Worker behavior. Failures covered missing placeholder/reservation ordering, legacy/direct boundaries, the removed pending-byte cap, missing eight-part routes, reservation reuse, heartbeat coupling, cleanup ordering, Queue activation, and setup rollback.

Additional targeted RED cases were added while closing lifecycle races:

- Missing/expired reservations on paged part requests initially returned plans without conditionally restoring quota.
- An activation batch reporting zero changes was initially acknowledged instead of retried.
- Completed single-upload sessions initially skipped terminal cleanup after repeated activation failures.

The final terminal-failure RED command was:

```text
npx.cmd vitest run src/worker-upload.test.ts -t "terminally failed activation"
```

Initial result: exit 1. Only the staging key was deleted; the finalized attachment object was left behind and no terminal cleanup batch ran.

GREEN: after content-scoped Queue failure cleanup, the complete Worker lifecycle file passed 22 of 22 tests.

### Localization

```text
npx.cmd vitest run src/i18n.test.ts
```

Initial result: exit 1 because stable storage quota errors and numeric detail interpolation had no localized messages.

GREEN: the final localization suite passed with Chinese and English quota detail coverage.

## Final Verification

### Focused tests

```text
npx.cmd vitest run src/worker-upload.test.ts src/worker-permissions.test.ts src/access-control.test.ts src/transfer-policy.test.ts src/upload-client.test.ts src/upload-resume.test.ts src/i18n.test.ts
```

Result: exit 0; 7 test files and 105 tests passed.

The final Worker lifecycle file also passed independently:

```text
npx.cmd vitest run src/worker-upload.test.ts
```

Result: exit 0; 22 tests passed.

### Full tests

```text
npm.cmd test -- --run
```

Result: exit 0; 13 test files and 126 tests passed.

### Type check

```text
npx.cmd tsc --noEmit
```

Result: exit 0 with no diagnostics.

### Production build

```text
npm.cmd run build
```

Result: exit 0; Vite transformed 1688 modules and completed the production build in 18.25 seconds.

### Diff validation

```text
git diff --check
```

Result: exit 0. Git emitted only the checkout's LF-to-CRLF notices.

### Wrangler dry-run

Requested command:

```text
npx.cmd wrangler deploy --dry-run
```

Three bounded runs all reached Wrangler 4.93.0's completed output:

- Read 15 asset files from `dist`.
- Worker upload size: 143.89 KiB, gzip 31.58 KiB.
- Resolved the Queue, D1, R2, Assets, SSO, public URL, and R2 environment bindings.
- Printed `--dry-run: exiting now`.

In this Windows/proxy environment, the `npx.cmd` wrapper remained open with no further output after Wrangler completed. The runs were interrupted after bounded waits and therefore do not have exit code 0.

The installed CLI entry point was then run directly:

```text
node .\node_modules\wrangler\bin\wrangler.js deploy --dry-run
```

Result: exit 0 in 8.2 seconds with the identical Wrangler 4.93.0 bundle and binding output. No deployment was performed.

## Requirement Self-Review

- Reservation expiry is 30 minutes from current activity; session expiry remains 24 hours and both are updated together on heartbeat.
- Placeholder rows precede conditional quota reservations, and reservations precede R2 multipart creation.
- Rollback removes R2 state before deleting reservations and content rows in foreign-key-safe order.
- Final byte sizes appear only in atomic activation/release batches, preventing reservation plus retained-size double counting.
- Legacy compatibility and 5 GiB direct route boundaries are enforced in Worker code and integration-style route tests.
- No aggregate 500 MiB pending-byte check remains; the pending-session count limit remains.
- Reuse does not double reserve and restores one missing/expired reservation before signing plans.
- Initial, reused, browser parts, CLI parts, and renew plans are bounded to eight and skip completed parts.
- Browser and CLI part routes use owner-scoped authentication.
- Scheduled and terminal cleanup remove upload objects before reservation expiry.
- Queue activation failure remains retryable, including the completed-session race.
- Conditional reservation denial always refreshes the profile and returns stable storage permission/quota errors with numeric details.
- Frontend quota, initiation, upload, and persistence failures do not reset selected files or form fields.
- Task 4A files `src/transfer-policy.ts` and `src/upload-client.ts` remain unchanged by Task 4B.

## Files Changed

- `src/worker.ts`
- `src/worker-permissions.ts`
- `src/worker-upload.test.ts`
- `src/worker-permissions.test.ts`
- `src/main.tsx`
- `src/i18n.tsx`
- `src/i18n.test.ts`
- `.superpowers/sdd/2026-08-22-permissions-large-upload-admin-mobile/task-4b-report.md`

## Concerns

- No implementation or test blocker remains.
- `npx.cmd` does not terminate after Wrangler's completed dry-run output in the current Windows/proxy environment. Direct invocation of the same installed Wrangler 4.93.0 entry point exits 0 with identical output.
- Vitest continues to print the existing React Babel/esbuild deprecation notices.
- Vite continues to print the existing generated chunk-size warning for assets larger than 500 kB.
