[中文说明](./readme_zh.md) | Language: English

# Content Share

Content Share is a Cloudflare Workers based content publishing and file sharing app for `content.aryuki.com`. The frontend is served by Workers Assets, the backend runs in the same Worker, structured data is stored in Cloudflare D1, files are stored only in Cloudflare R2, and upload activation is coordinated through Cloudflare Queues.

## Features

- Auth-center SSO only. The Worker verifies auth-center JWTs and identifies users by `username`.
- Role handling is enforced in the Worker. Only JWT `role=admin` can enter Admin Dashboard; the separate business permission group never grants admin-dashboard access.
- Content types: text, file, and mixed text plus attachments.
- Text formats: plain text and Markdown with a toolbar and live preview.
- Visibility: `public`, `internal`, and `private`.
- Access controls: optional password, optional expiry time, optional max views, soft delete, forced expiry, and admin preview without normal view increments.
- Public share pages can be viewed without login. Internal/private content still requires Worker-side permission checks.
- Online preview for common file types: images, audio, video, text, PDF through PDF.js, Office documents through Office web embedding when public, and direct HTML pages in a sandboxed iframe with source-code and fullscreen controls.
- ZIP archives remain download-first. On the preview page, viewers can explicitly try to open an archive's `index.html` or another HTML entry; archive-relative assets are temporarily mapped to Blob URLs and archives without a usable page show a clear download message.
- Browser uploads use short-lived, object-scoped R2 URLs: files through 16 MiB use one PUT, 16 MiB to 100 MiB files use 8 MiB parts, and larger files up to 5 GiB use 64 MiB parts with IndexedDB queue persistence and real byte progress.
- Resumable uploads use a SHA-256 file identity fingerprint made from metadata plus the first and last 1 MiB. The Worker resumes only an owner-scoped matching unfinished session, refreshes `last_activity_at` with progress heartbeats, and cleans multipart/staging remnants after 30 minutes without activity.
- Preview remains behind Worker permission and Range checks. New direct-upload attachments download through a 60-second read-only R2 URL after Worker authorization; legacy objects safely fall back to Worker streaming.
- Comments for public/internal content. Logged-in viewers can comment and choose public/private visibility. The publisher can delete any comment after confirmation.
- Private content uses a publisher-only memo panel.
- API Keys are for CLI upload endpoints only, never web login or admin access.
- Full API reference is published at [`https://content.aryuki.com/docs`](https://content.aryuki.com/docs) and is rendered from `ApiDocs.md`.
- User avatar comes from auth-center `avatar_url` when available, with a local default fallback.
- Responsive desktop/mobile UI, collapsible mobile sidebar, click-outside close for menus, and a configurable landing-page background stored under `background/` in R2.
- The fixed UI supports Chinese and English switching from the top-right control. The selection is stored in browser `localStorage`; content titles, filenames, and user-authored text are not translated.
- Admin can assign exactly one business permission group per user. Groups control public publishing, API access, internal viewing/downloading, storage quota, and comments; built-in `admin` and `user` groups cannot be deleted. API keys are locked automatically when API permission is removed.
- Face-to-face file transfer at `/face-transfer`: the sender creates locally shuffled RaptorQ Fountain Code QR loops with adjustable frame timing, while the receiver scans, reconstructs, previews, and saves the file locally without uploading it to the Worker or R2.

## Cloudflare Resources

Required bindings in `wrangler.toml`:

- Worker name: `content-share`
- Custom domain: `content.aryuki.com`
- D1 database binding: `DB`
- R2 bucket binding: `BUCKET`
- Queue producer/consumer binding: `UPLOAD_QUEUE`
- Workers Assets binding: `ASSETS`

Important environment variables:

- `SSO_URL=https://accounts.aryuki.com`
- `SSO_APP_ID=content-share`
- `PUBLIC_BASE_URL=https://content.aryuki.com`
- `ADMIN_CONTACT_EMAIL=` optional administrator address used by protected-share contact actions; leave empty to hide that action
- `R2_ACCOUNT_ID=...`
- `R2_BUCKET_NAME=content-share-save`

The following values must be Worker Secrets, never plaintext variables or committed files:

- `MEDIA_TICKET_SECRET`
- `R2_UPLOAD_ACCESS_KEY_ID`
- `R2_UPLOAD_SECRET_ACCESS_KEY`
- `R2_DOWNLOAD_ACCESS_KEY_ID`
- `R2_DOWNLOAD_SECRET_ACCESS_KEY`

For the R2 S3 credentials, open R2 Overview > Manage API Tokens and create bucket-scoped R2 credentials for `content-share-save`. The recommended production setup uses an R2 Account API token with Object Read & Write for upload signing and a separate R2 Account API token with Object Read for download signing. Copy the generated **Access Key ID** and **Secret Access Key** fields, not the generic Cloudflare API token, Account ID, or token ID. The Access Key ID must be the R2 S3 key accepted by the endpoint (32 alphanumeric characters). Never put these values in `wrangler.toml`, the frontend, or Git.

## Database

Apply the D1 migration baseline before the first deploy and rerun it for later upgrades:

```bash
npm run db:apply
```

`db:apply` and `db:migrate` are aliases for the same migration command. `schema.sql` is a readable snapshot; production setup is tracked only through `migrations/`.

The schema includes:

- `users`
- `contents`
- `attachments`
- `access_logs`
- `api_keys`
- `api_key_usage_logs`
- `user_cli_settings`
- `admin_actions`
- `system_settings`
- `content_notes`
- `upload_sessions`
- `upload_parts`
- `permission_groups`, `storage_reservations`, and `upload_cleanup_claims`

## Deploy

Recommended order:

```bash
npm install
npm run queue:create
npm run queue:dlq:create
npm run db:migrate
npm run r2:cors
npm run r2:local-uploads
npm run r2:lifecycle
npm run r2:staging-lifecycle
npm run r2:notify
npm run build
npx wrangler deploy
```

The R2 setup commands require an account session or API token with R2 write permission. Create separate bucket-scoped Object Read/Write credentials for upload signing and Object Read credentials for download signing, then enter them with interactive `wrangler secret put` commands. Never pass secret values on the command line.

```bash
npx wrangler secret put R2_UPLOAD_ACCESS_KEY_ID
npx wrangler secret put R2_UPLOAD_SECRET_ACCESS_KEY
npx wrangler secret put R2_DOWNLOAD_ACCESS_KEY_ID
npx wrangler secret put R2_DOWNLOAD_SECRET_ACCESS_KEY
```

Useful checks:

```bash
npx tsc --noEmit
npm run build
```

Protected share pages are bilingual. Internal access failures can offer account switching and, when `ADMIN_CONTACT_EMAIL` is configured, a controlled contact link. Password input remains in the current document only; password-protected preview URLs do not carry reusable access tickets, so a new tab asks for the password again.

## CLI Upload

API Key authentication uses:

```text
Authorization: Bearer <API_KEY>
```

API Keys may call only:

- `POST /api/cli/upload-text`
- `POST /api/cli/upload-file`
- `POST /api/cli/upload-mixed`
- `POST /api/cli/uploads/initiate`
- `POST /api/cli/uploads/:session_id/heartbeat`
- `GET|POST|DELETE /api/cli/uploads/:session_id/...`

The legacy endpoints are the simplest CLI integration. For large files or clients that must resume after interruption, use the accelerated upload-session API documented in [ApiDocs.md](./ApiDocs.md): files up to 16 MiB use one signed PUT, 16 MiB to 100 MiB files use 8 MiB parts, and files above 100 MiB up to 5 GiB use 64 MiB parts. Queue validates the upload before activation. Include a lowercase 64-character SHA-256 `fingerprint` for each file to enable strong resume matching; the browser client derives it from metadata plus the first and last 1 MiB. A matching session is reusable for 30 minutes after its last progress or heartbeat, and the Worker’s scheduled cleanup removes only sessions inactive for longer than 30 minutes. The signed upload URL lasts 5 minutes; a completed download may use a read-only R2 URL lasting 60 seconds.

File MIME type is optional. When a client does not send a useful MIME type, the Worker detects it from the filename extension. Unknown extensions are stored safely and the share page asks the viewer to download. The legacy CLI endpoints accept up to 20 files per request and limit each file to 100 MiB; use resumable sessions for files above 100 MiB through the 5 GiB per-file limit. Unfinished direct sessions are limited to 50 sessions per user; quota is enforced by the assigned permission group rather than a fixed 500 MiB aggregate cap.

### curl: upload text

```bash
curl -X POST "https://content.aryuki.com/api/cli/upload-text" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "note title",
    "content": "# hello",
    "format": "markdown",
    "visibility": "public",
    "slug": "",
    "password": "",
    "expire_at": null,
    "max_views": 0,
    "remark": "from cli"
  }'
```

### PowerShell: upload file

```powershell
$headers = @{ Authorization = "Bearer YOUR_API_KEY" }
$form = @{
  file = Get-Item ".\report.pdf"
  title = "report"
  visibility = "public"
  max_views = "0"
}
Invoke-RestMethod -Method Post `
  -Uri "https://content.aryuki.com/api/cli/upload-file" `
  -Headers $headers `
  -Form $form
```

### Node.js: upload mixed content

```js
import { readFile } from "node:fs/promises";

const form = new FormData();
form.set("title", "mixed note");
form.set("content", "Markdown body");
form.set("format", "markdown");
form.set("visibility", "public");
form.set("max_views", "0");
form.append("file[]", new Blob([await readFile("./image.png")]), "image.png");

const res = await fetch("https://content.aryuki.com/api/cli/upload-mixed", {
  method: "POST",
  headers: { Authorization: "Bearer YOUR_API_KEY" },
  body: form
});

console.log(await res.json());
```

## Development Notes

- Do not add S3, WebDAV, mount management, mount explorer, or multi-storage configuration. This app stores files only in R2.
- Do not add frontend-only permission checks. All sensitive decisions must happen in `src/worker.ts`.
- Do not add buttons without a real API behind them.
- Build artifacts, `.design/`, screenshots, local output, dependencies, and Wrangler cache are ignored by `.gitignore`.
