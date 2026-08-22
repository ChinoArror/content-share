# Permission Groups, Large Uploads, and Admin Mobile Design

**Date:** 2026-08-22

## Goal

Extend Content Share with single-group business permissions, quota-safe uploads up to 5 GiB, faster QR poster backgrounds, compact mobile administration, and a polished SSO callback screen. All authorization remains enforced by the Cloudflare Worker; frontend visibility is only a usability layer.

## Identity Boundary

- Admin Dashboard access is granted only when the verified auth-center JWT has `role=admin`.
- Remove the `ADMIN_USERNAMES` configuration and username-based role promotion.
- A permission group named `admin` grants business permissions only. Assigning it to a JWT `role=user` account must never grant Admin Dashboard access.
- Each user belongs to exactly one permission group.
- New users receive the current default group on first login. Later logins preserve manually assigned groups.

## Permission Groups

Add a `permission_groups` D1 table with:

- unique name;
- system-group and default-group flags;
- public-publish permission;
- API permission;
- internal-share view/download permission;
- storage/upload permission and a byte quota;
- comment permission;
- audit timestamps.

The built-in `user` and `admin` groups cannot be deleted but their permissions can be edited. Initially both have all five permissions. `user` has a 5 GiB quota and is the default; `admin` has a 100 GiB quota. Existing JWT admins are assigned to `admin`; all other existing users are assigned to `user`. Custom groups can be created, edited, deleted after their users are reassigned, and selected as the single default group.

## Permission Enforcement

The Worker resolves a user's effective business permissions from the single assigned group and enforces them on every relevant route:

- Without public-publish permission, content cannot be created or changed to `public`. The frontend also removes the public visibility option.
- Without API permission, API Key navigation and user API Key management are unavailable. Existing active keys are automatically locked when a user moves to a group without API permission or that permission is removed from the group.
- Locked keys remain locked after permission is restored until an admin explicitly unlocks them. Unlocking is rejected while the owner lacks API permission.
- Without internal-access permission, authenticated users cannot open, preview, or download `internal` shares. Public content and the user's own private content remain unaffected.
- Without comment permission, users can read comments on content they may access but cannot see the composer or create/reply through the API.
- Without storage permission, or with a zero quota, text and file creation is rejected.

`/api/me` returns the assigned group, effective permissions, used bytes, reserved bytes, and quota bytes. The frontend consumes this response but cannot override Worker decisions.

## Storage Accounting

Add `contents.text_size` and count UTF-8 text bytes along with attachment bytes. Active, expired, and soft-deleted content occupies quota because its data still exists. Permanent deletion releases quota only after R2 objects and associated D1 records are removed.

Add `storage_reservations` for upload batches. Upload initiation creates a reservation with one atomic conditional D1 statement that checks:

`used bytes + active reservations + requested bytes <= group quota`.

Successful activation converts reserved bytes into normal content usage and removes the reservation. Failed uploads retain the reservation while heartbeats show progress. The existing 30-minute inactivity cleanup aborts stale multipart uploads, removes staging objects and sessions, and releases reservations. Quota failures return `STORAGE_QUOTA_EXCEEDED` with used, reserved, requested, and quota values. Permission failures return stable machine-readable codes. Frontend failures preserve all text, settings, and selected files.

## Upload Protocol

- Maximum file size: 5 GiB.
- At or below 16 MiB: one signed R2 PUT.
- Above 16 MiB through 100 MiB: multipart with the existing small-part recovery behavior.
- Above 100 MiB: multipart with uniform 64 MiB parts and two to three concurrent browser uploads.
- File bytes travel directly between the browser or CLI and R2, never through the Worker request body.
- Multipart signing is windowed. The Worker returns only the next bounded set of pending signed part URLs; clients request or renew later windows as required.
- The IndexedDB queue, SHA-256 file fingerprint, completed-part records, progress heartbeats, page-refresh recovery, Queue completion, and object-size validation remain in place.
- Legacy multipart form endpoints remain available for small files. They reject large bodies with a response that points clients to the resumable API.
- API documentation covers large uploads, window renewal, quota errors, permission errors, and resumable recovery.

## API Key Administration

Add lock metadata separately from the existing active/expired/revoked lifecycle. Admin audit rows retain the left expand control. Text action menus are replaced by Lucide icon buttons for rotate, lock/unlock, and revoke. Rotation revokes the old key and shows the new secret once. Revoke is an audited logical deletion so historical usage remains available. Every icon has a tooltip and accessible name.

## User And Permission Administration

Rename User Statistics to User Management. Each collapsed row shows compact usage data. The expanded section exposes the existing detailed statistics. An admin action opens a modal showing the assigned group, group permissions, storage usage, and a single-group selector.

Add Permission Management next to User Management. It supports creating and editing groups, changing the default group, and deleting non-system groups after reassignment. Changes write `admin_actions` records.

On mobile, admin tables use compact spacing and their own overflow containers. Long API keys, IP addresses, IPv6 values, user agents, and device strings use middle ellipsis while retaining the full value for copying. A copy icon copies the complete value, changes to a check for five seconds, then restores.

## Filters And Responsive Layout

Mobile search toolbars remain one row: the search input shrinks within available space while the filter icon stays at the trailing edge. Filter choices continue to use the custom menu rather than native select controls. Page-level horizontal scrolling is forbidden; only explicitly designated table containers may scroll horizontally.

## QR Poster Performance

Generate optimized display and thumbnail WebP variants for bundled QR backgrounds. Opening the poster modal loads only the selected display image immediately. Other backgrounds use small lazy-decoded thumbnails. Custom backgrounds remain local object URLs and are never uploaded.

All current and new dialogs use a shared scroll lock: opening a dialog preserves the current scroll position, freezes the document behind it, prevents touch scroll-through, and restores the exact position on close. Mobile inputs, textareas, and custom selectors use at least 16px text to prevent focus-triggered iOS zoom without disabling user pinch zoom.

## SSO Loading Screen

The auth-center callback state renders a dedicated sign-in completion screen with an animated square progress indicator and concise status text. It must not flash the landing page, dashboard, or an empty page while exchanging the token.

## Errors And Observability

Permission and quota failures use stable error codes with localized frontend messages. Admin mutations and API Key actions are audited. API Key calls continue writing usage logs. Upload errors distinguish unsupported legacy upload size, quota exhaustion, missing permissions, expired signatures, and stale sessions.

## Verification

- Unit tests cover strict JWT admin identity, permission resolution, visibility enforcement, internal share access, comments, API Key locking, storage accounting, reservations, and upload boundaries at 16 MiB, 100 MiB, 5 GiB, and over 5 GiB.
- Export the remote D1 database before applying the migration.
- Run full tests, TypeScript checking, production build, remote migration, Wrangler dry-run, and `npx wrangler deploy`.
- Upload a production test object larger than 100 MiB through the resumable path, download it from its share, compare SHA-256, and clean up the test content.
- Verify that a JWT `role=user` assigned to the `admin` permission group still receives 403 from Admin APIs.
- Toggle every permission and verify both frontend visibility and direct API rejection.
- Use Playwright at desktop and phone viewports to verify User Management, Permission Management, API Key audit actions, middle-ellipsis copy behavior, filters, QR modal loading and scroll lock, SSO loading, and absence of page-level horizontal overflow.
