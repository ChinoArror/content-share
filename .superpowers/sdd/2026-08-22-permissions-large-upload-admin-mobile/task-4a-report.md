# Task 4A Report: Transfer Policy And Client Windowed Multipart

## Implementation

- Exported binary `GiB`, raised `MAX_UPLOAD_SIZE` to exactly `5 * GiB`, and retained single PUT selection through 16 MiB.
- Added `partSizeFor(size)`: 8 MiB through 100 MiB and 64 MiB above 100 MiB through 5 GiB.
- Kept every non-final multipart part uniform. A 5 GiB file now produces exactly 80 parts of 64 MiB, while `5 GiB + 1` is rejected with a 5 GiB error.
- Added `buildPartWindow(size, completedParts, startAfter, windowSize)`, capped at eight missing parts. It excludes completed part numbers, treats the cursor as exclusive, and reports the next missing part plus whether more remain.
- Extended `UploadPlan` with optional `next_part_number` and `has_more_parts`, preserving compatibility with existing single and all-parts responses where those fields are absent.
- Changed multipart execution to upload and report one signed window, request `GET /api/uploads/:sessionId/parts?after=N&limit=8`, and repeat only while `has_more_parts` is true.
- Renew requests now include `after` and `limit: 8`. Refresh recovery starts at cursor zero, while an expired URL renews its current window.
- Merged server and locally persisted completed-part records by part number, preventing stale renew responses from discarding progress or causing duplicate uploads.
- Preserved the existing default multipart concurrency while recognizing touch devices through `navigator.maxTouchPoints`: two parts on touch/mobile and three on non-touch desktops.
- Exported structured `UploadRequestError` data and persisted `error_code` and `error_details` alongside the task. Failed initiation retains both the task and its selected file blob.
- Left signed upload plans out of IndexedDB as before. No `upload-resume.ts` change was needed because refresh recovery deliberately renews from persisted completed parts rather than persisting expiring URLs or cursors.

## RED Evidence

Transfer-policy RED command:

```text
npx vitest run src/transfer-policy.test.ts
```

Result: exit `1`; `5` tests failed for the expected old behavior: missing `GiB`, `partSizeFor`, and `buildPartWindow`, plus the old 100 MiB maximum.

Combined RED command after adding client tests:

```text
npx vitest run src/transfer-policy.test.ts src/upload-client.test.ts
```

Result: exit `1`; `11` tests failed. Client failures showed that error codes/details were dropped, only the initial multipart parts uploaded, renew omitted the bounded cursor, restored completed gaps could be overwritten, and files above 100 MiB were rejected.

## Verification

Focused command:

```text
npx vitest run src/transfer-policy.test.ts src/upload-client.test.ts src/upload-resume.test.ts
```

Result: exit `0`; `3` files and `31` tests passed.

Full command:

```text
npm test
```

Result: exit `0`; `12` files and `99` tests passed.

Type check:

```text
npx tsc --noEmit
```

Result: exit `0` with no diagnostics.

Production build:

```text
npm run build
```

Result: exit `0`; Vite transformed `1688` modules and completed the production build.

Diff validation:

```text
git diff --check
```

Result: exit `0`; Git emitted only the checkout's LF-to-CRLF notices.

## Compatibility Coverage

- Existing single-upload plans still use `upload_url` and never enter multipart pagination.
- Existing all-parts multipart plans omit `has_more_parts`; the client uploads that array once and completes exactly as before.
- Windowed plans fetch the next cursor only after every pending part in the current window is reported.
- Restored tasks renew from cursor zero and union completed parts from IndexedDB, status responses, renew responses, and newly reported parts.
- A stale renew response that omits an already completed gap cannot remove that completion or make the client upload it again.
- Failed API initiation keeps the task, selected file blob, structured error code, and quota details in persistence; no removal call occurs.

## Files Changed

- `src/transfer-policy.ts`
- `src/transfer-policy.test.ts`
- `src/upload-client.ts`
- `src/upload-client.test.ts`
- `.superpowers/sdd/2026-08-22-permissions-large-upload-admin-mobile/task-4a-report.md`

## Self-Review

- `buildPartWindow` clamps caller-requested windows to eight and never returns a completed part.
- `nextPartNumber` is the first missing part not included in the returned window; `hasMoreParts` is derived from that value.
- Pagination uses the highest part number in the completed current window as the exclusive `after` cursor. A response with no parts can advance from `next_part_number`.
- Signed URLs and window cursors remain transient. Completed parts and file blobs are the durable recovery state.
- Error handling accepts non-JSON failures, keeps the HTTP status, and retains machine-readable fields when the Worker supplies them.
- No Worker, quota, reservation, migration, UI, or documentation file was changed.

## Concerns

- No blocker remains for Task 4A.
- The current Worker still signs all multipart parts and does not yet expose the `/parts` endpoint. Task 4B must integrate `buildPartWindow` before this becomes an end-to-end windowed upload protocol.
- Existing Worker and UI messages still mention the old 100 MiB limit. They were intentionally left untouched because Worker quota lifecycle and UI localization are outside the exact 4A scope.
- Vite continues to emit the pre-existing generated chunk-size warning, and Vitest continues to emit the pre-existing React Babel/esbuild deprecation notices.
