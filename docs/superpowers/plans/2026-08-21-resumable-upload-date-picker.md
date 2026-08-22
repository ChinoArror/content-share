# Upload Resume And Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Auth Center-style expiry calendar to API Key creation and make direct/API uploads resume by SHA-256 file identity with activity-based 30-minute cleanup.

**Architecture:** A focused React `ExpiryDatePicker` stores the existing local datetime value while rendering a compact custom calendar and time controls. Upload sessions gain a SHA-256 fingerprint and `last_activity_at`; initiate reuses an owner-scoped matching session, client progress sends throttled heartbeats, and a Worker cron removes only inactive unfinished sessions and their R2 multipart/staging remnants.

**Tech Stack:** React 18, TypeScript, Vitest, Cloudflare Workers, D1, R2, Queues, Wrangler cron triggers, Web Crypto SHA-256.

**Spec:** Approved design in the conversation on 2026-08-21.

## Global Constraints

- Preserve auth-center SSO and existing API Key permission boundaries.
- Store only file objects in R2 and structured upload state in D1.
- Never match resumable uploads by filename alone.
- Use SHA-256 for the browser file identity fingerprint.
- Treat 30 minutes as inactivity since the last heartbeat/progress, not total upload age.
- Keep mobile pages free of horizontal document scrolling.
- Use `apply_patch` for source and documentation edits.

---

### Task 1: Add failing upload identity and cleanup tests

**Files:**
- Create: `src/upload-resume.test.ts`
- Create: `src/upload-resume.ts`

**Interfaces:**
- Produces `sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string>`.
- Produces `buildUploadFingerprint(input): Promise<string>` using filename, size, MIME, lastModified, and first/last file bytes.
- Produces `isUploadSessionReusable(session, fingerprint, nowMs)` and `isUploadSessionStale(session, nowMs, inactivityMs)`.

- [x] Write tests for deterministic SHA-256 output, same-file fingerprint matching, changed-content mismatch, 30-minute reuse, stale cleanup, and active large-file heartbeat preservation.
- [x] Run the focused upload-resume tests in the red/green TDD cycle.
- [ ] Implement the smallest pure helpers needed to make the tests pass.
- [ ] Run the focused test again and then the existing upload tests.

### Task 2: Add the Auth Center expiry calendar

**Files:**
- Create: `src/expiry-date-picker.tsx`
- Modify: `src/main.tsx:780-825`
- Modify: `src/styles.css`

**Interfaces:**
- `ExpiryDatePicker({ value, onChange, label })` consumes the existing `YYYY-MM-DDTHH:mm` form value and emits the same value or an empty string.

- [x] Add calendar tests for local datetime parsing, date selection, clear, today, and month/year navigation.
- [ ] Run the focused tests and confirm the calendar behavior tests fail before the component is implemented.
- [ ] Implement day view, compact month/year selection, time controls, Clear and Today actions.
- [ ] Add `.ui-modal-scroll`, `.ui-date-trigger`, and mobile width/overflow rules from `authcenter-scroll-calendar`.
- [x] Replace only the API Key creation `datetime-local` input.
- [ ] Run the component/type tests and verify no document horizontal overflow at a 390px viewport.

### Task 3: Persist SHA-256 identity and activity timestamps

**Files:**
- Create: `migrations/0002_upload_resume_fingerprint.sql`
- Modify: `schema.sql`
- Modify: `src/worker.ts`

**Interfaces:**
- `upload_sessions.file_fingerprint TEXT` and `upload_sessions.last_activity_at TEXT`.
- `POST /api/uploads/:id/heartbeat` and `POST /api/cli/uploads/:id/heartbeat` refresh activity for the owning session.

- [x] Add the D1 migration and indexes for owner/fingerprint/status/activity lookup.
- [x] Update direct initiate input parsing to accept `fingerprint` and persist it.
- [x] Use a server fallback fingerprint only when the client does not provide one, based on all file metadata rather than filename alone.
- [x] Update part reports, complete, renew, status, and heartbeat paths to refresh `last_activity_at`.
- [x] Verify unauthorised users cannot heartbeat or resume another user's session.

### Task 4: Reuse sessions and clean inactive remnants

**Files:**
- Modify: `src/worker.ts`
- Modify: `src/upload-client.ts`
- Modify: `wrangler.toml`
- Modify: `src/upload-client.test.ts`

**Interfaces:**
- Initiate returns the existing content/session plan when owner, fingerprint, file size, and session activity match within 30 minutes.
- Browser upload progress sends a throttled heartbeat while an XHR is active.
- Scheduled handler runs cleanup every 10 minutes.

- [x] Add failing client tests for fingerprint inclusion in initiate requests and heartbeat calls during a slow upload.
- [ ] Run focused tests and verify they fail before wiring the client.
- [ ] Reuse matching sessions without creating duplicate D1 contents or R2 multipart uploads.
- [ ] Return already completed parts so the client uploads only missing parts.
- [ ] Add cleanup that aborts stale multipart uploads, deletes stale single staging objects, removes part rows, and marks associated sessions/content as expired without touching active sessions.
- [ ] Add the cron trigger and scheduled handler using the latest Wrangler-supported configuration.
- [x] Run tests for resume, inactivity, and cleanup edge cases.

### Task 5: Verify and deploy

**Files:**
- Modify: `CHECKLIST.md`
- Modify: `readme.md`
- Modify: `readme_zh.md`

- [ ] Run `npm test`.
- [ ] Run `npx.cmd tsc --noEmit`.
- [ ] Run `npm run build`.
- [ ] Run `npx.cmd wrangler deploy --dry-run`.
- [ ] Start the local Worker and use Playwright at desktop and 390px mobile viewports to verify API Key calendar containment and no page horizontal scrolling.
- [ ] Apply the remote D1 migration.
- [ ] Deploy with `npx.cmd wrangler deploy`.
- [x] Update the checklist and README with the new fingerprint, heartbeat, cleanup, and calendar behavior.
