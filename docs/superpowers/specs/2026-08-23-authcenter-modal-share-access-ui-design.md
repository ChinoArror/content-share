# Auth Center Modal and Share Access UI Design

## Goal

Bring all new floating windows and destructive confirmations into one Auth Center-style interaction system, compact the admin data views for desktop and mobile, and give internal/password-protected share failures a complete bilingual experience.

## Decisions

- Reuse the existing React app, i18n context, Lucide icons, and `useBodyScrollLock`; do not add a UI framework or database tables.
- Mount modal shells at the document root with a very high z-index, a fixed close button in the upper-right corner, backdrop-close behavior, and mobile bottom-sheet behavior.
- Replace browser `confirm()` calls with an in-app confirmation modal. Destructive confirmations use a red primary action.
- Keep permission enforcement in the Worker. The visibility control only reflects the permissions already returned by `/api/me`.
- Keep password access in React memory only. Do not persist password tickets or passwords in local/session storage.
- Use `ADMIN_CONTACT_EMAIL` as a Worker variable and expose it only through a controlled contact action. Without a mail binding, the contact action uses a Worker-generated `mailto:` URL.
- Make list loading visible with a moving gray shimmer and keep all visible labels in `i18n`.

## Acceptance Criteria

- QR, user-management, permission-group, content-edit, and confirmation windows share the same close/scroll-lock behavior.
- No specified destructive action invokes the browser-native confirmation dialog.
- Admin user, access-log, and API-audit views fit the phone viewport without page-level horizontal scrolling and use compact expandable details.
- Internal-share and password-share error pages have Chinese/English switching, clear status art, and only the actions allowed by the server response.
- `locked_at = null` is labeled as not locked and `last_used_at = null` as never used; only an unset expiry is labeled as permanent.
- The landing/sidebar brand mark and favicon use the same visual mark.

