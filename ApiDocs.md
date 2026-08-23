# ShareWorker API Docs

Base URL: `https://content.aryuki.com`  
Online page: [`https://content.aryuki.com/docs`](https://content.aryuki.com/docs)

## Authentication

CLI APIs require an API Key created in the ShareWorker web app. Send it only in this header:

```http
Authorization: Bearer <API_KEY>
```

API Keys are upload credentials only. They cannot log in to the website, call `/api/me`, use user settings, or access admin APIs. The complete key is shown only once when it is created or rotated. Store it in an environment variable and never commit it to a script or repository.

The API Key above is a ShareWorker user API Key. It is different from the R2 S3 credentials used by the Worker deployment. For R2, use the R2 dashboard's **Manage API Tokens** page and copy the generated **Access Key ID** and **Secret Access Key** fields. Do not paste a generic Cloudflare API token, Account ID, or token ID into an R2 S3 Access Key ID field.

API Key routes:

- `POST /api/cli/upload-text`
- `POST /api/cli/upload-file`
- `POST /api/cli/upload-mixed`
- `POST /api/cli/uploads/initiate`
- `POST /api/cli/uploads/:session_id/heartbeat`
- `GET|POST|DELETE /api/cli/uploads/:session_id/...`

Successful responses use JSON. Errors use the same shape with an HTTP error status:

```json
{
  "ok": false,
  "message": "error description"
}
```

## Common fields

| Field | Description |
| --- | --- |
| `title` | Optional title. File uploads default to the first filename. |
| `visibility` | `public`, `internal`, or `private`; default `public`. |
| `slug` | Optional custom slug. Blank or omitted values receive a random slug. |
| `password` | Optional access password. |
| `expire_at` | Optional ISO 8601 timestamp, for example `2026-12-31T23:59:59+08:00`; `null` means no expiry. |
| `max_views` | Optional non-negative integer. `0` means unlimited. |
| `remark` | Optional note shown to the owner. |
| `format` | `plain` or `markdown`; text and mixed uploads default to `plain`. |

File MIME type is optional. When the client does not provide a useful MIME type, the Worker detects it from the filename extension. Common extensions such as `pdf`, `docx`, `xlsx`, `pptx`, images, video, audio, `txt`, `md`, `csv`, `json`, and `xml` are recognized. Unknown types are stored as `application/octet-stream` and the share page asks the viewer to download the file.

## Upload text

`POST /api/cli/upload-text`

Content-Type: `application/json`.

```json
{
  "title": "note title",
  "content": "# Hello",
  "format": "markdown",
  "visibility": "public",
  "slug": "",
  "password": "",
  "expire_at": null,
  "max_views": 0,
  "remark": "from cli"
}
```

curl:

```bash
export API_KEY='paste-key-locally'
curl --fail-with-body -X POST "https://content.aryuki.com/api/cli/upload-text" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"note title","content":"# Hello","format":"markdown","visibility":"public","max_views":0}'
```

PowerShell 7:

```powershell
$headers = @{ Authorization = "Bearer $env:API_KEY" }
$body = @{
  title = "note title"
  content = "# Hello"
  format = "markdown"
  visibility = "public"
  max_views = 0
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://content.aryuki.com/api/cli/upload-text" -Headers $headers -ContentType "application/json" -Body $body
```

Node.js 18+:

```js
const response = await fetch('https://content.aryuki.com/api/cli/upload-text', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.API_KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    title: 'note title',
    content: '# Hello',
    format: 'markdown',
    visibility: 'public',
    max_views: 0
  })
});
console.log(await response.json());
```

## Upload file

`POST /api/cli/upload-file`

Content-Type: `multipart/form-data`. The required field is `file`. Optional fields are the common fields above. Do not manually add a file type field; the filename extension is used when the browser or CLI does not provide a MIME type.

curl:

```bash
curl --fail-with-body -X POST "https://content.aryuki.com/api/cli/upload-file" \
  -H "Authorization: Bearer $API_KEY" \
  -F "file=@./demo.mp4" \
  -F "title=Demo video" \
  -F "visibility=public" \
  -F "max_views=0"
```

PowerShell 7:

```powershell
$headers = @{ Authorization = "Bearer $env:API_KEY" }
$form = @{
  file = Get-Item ".\demo.mp4"
  title = "Demo video"
  visibility = "public"
  max_views = "0"
}
Invoke-RestMethod -Method Post -Uri "https://content.aryuki.com/api/cli/upload-file" -Headers $headers -Form $form
```

Node.js 18+:

```js
import { readFile } from 'node:fs/promises';

const form = new FormData();
form.append('file', new Blob([await readFile('./demo.mp4')]), 'demo.mp4');
form.append('title', 'Demo video');
form.append('visibility', 'public');
form.append('max_views', '0');

const response = await fetch('https://content.aryuki.com/api/cli/upload-file', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.API_KEY}` },
  body: form
});
console.log(await response.json());
```

The legacy file endpoint accepts up to 20 files per request and limits each file to 100 MiB. For files above 100 MiB, use the resumable upload-session API below; its per-file limit is 5 GiB. The legacy endpoint writes the file through the Worker and returns `queued: true` while Queue finalization is pending.

## Upload text with files

`POST /api/cli/upload-mixed`

Content-Type: `multipart/form-data`. Required fields are `content` and at least one `file` or `file[]`. `format` is optional and defaults to `plain`. Attach multiple files by repeating `file[]`.

curl:

```bash
curl --fail-with-body -X POST "https://content.aryuki.com/api/cli/upload-mixed" \
  -H "Authorization: Bearer $API_KEY" \
  -F "content=# Release note" \
  -F "format=markdown" \
  -F "file[]=@./report.pdf" \
  -F "file[]=@./demo.mp4" \
  -F "visibility=public"
```

PowerShell 7:

```powershell
$headers = @{ Authorization = "Bearer $env:API_KEY" }
$form = @{
  content = "# Release note"
  format = "markdown"
  visibility = "public"
  "file[]" = @((Get-Item ".\report.pdf"), (Get-Item ".\demo.mp4"))
}
Invoke-RestMethod -Method Post -Uri "https://content.aryuki.com/api/cli/upload-mixed" -Headers $headers -Form $form
```

Node.js 18+:

```js
import { readFile } from 'node:fs/promises';

const form = new FormData();
form.set('content', '# Release note');
form.set('format', 'markdown');
form.set('visibility', 'public');
form.append('file[]', new Blob([await readFile('./report.pdf')]), 'report.pdf');
form.append('file[]', new Blob([await readFile('./demo.mp4')]), 'demo.mp4');

const response = await fetch('https://content.aryuki.com/api/cli/upload-mixed', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.API_KEY}` },
  body: form
});
console.log(await response.json());
```

## Accelerated resumable upload

For direct R2 transfer, real byte progress, parallel parts, and resume after interruption, use the upload-session API. These routes still require the API Key.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/cli/uploads/initiate` | Create content, attachment records, and signed R2 upload plans |
| `GET` | `/api/cli/uploads/:session_id/status` | Read persisted progress after interruption |
| `POST` | `/api/cli/uploads/:session_id/renew` | Replace expired URLs for unfinished parts |
| `POST` | `/api/cli/uploads/:session_id/part` | Record a completed multipart part and its R2 ETag |
| `POST` | `/api/cli/uploads/:session_id/complete` | Queue object verification and content activation |
| `DELETE` | `/api/cli/uploads/:session_id` | Cancel an unfinished session |

Initiation body:

```json
{
  "title": "Demo video",
  "visibility": "public",
  "max_views": 0,
  "files": [
    {
      "client_id": "local-1",
      "name": "demo.mp4",
      "size": 134217728,
      "type": "",
      "last_modified": 1724200000000,
      "fingerprint": "sha256-of-file-identity"
    }
  ]
}
```

`fingerprint` is a lowercase 64-character SHA-256 file identity. The browser client calculates it from the file metadata plus the first and last 1 MiB, so a reconnect is never matched by filename alone. External clients should send the same fingerprint when they want strong resume matching; if omitted, the Worker creates a metadata-based SHA-256 fallback.

The response is `201` and includes `direct: true`, a content URL, and one plan per file. Files up to 16 MiB receive one `upload_url`; files from 16 MiB through 100 MiB use 8 MiB parts; files above 100 MiB through 5 GiB use 64 MiB parts. Send each PUT to the returned R2 URL, using the returned headers when present, retain each response `ETag`, and report it:

```json
{
  "part_number": 1,
  "etag": "etag-from-r2"
}
```

After every part is reported, call `complete`. Queue validates object size and ETag, copies single-file staging objects into the final `attachments/` prefix, and then activates the content. Poll `status` until the session is `completed` or `failed`. The browser client persists this queue in IndexedDB so a page refresh can resume it.

While a transfer is active, send a heartbeat at least once every few minutes:

```http
POST /api/cli/uploads/:session_id/heartbeat
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

```json
{
  "fingerprint": "sha256-of-file-identity"
}
```

The Worker updates `last_activity_at` for the owner’s unfinished session. A matching unfinished session can be reused when its fingerprint, size, owner, and file count match and the last activity is within 30 minutes. A scheduled Worker cleanup removes stale unfinished sessions, multipart uploads, staging objects, and their D1 part records only after 30 minutes without progress or heartbeat. A long-running upload is therefore not deleted merely because it is old.

Upload signing URLs expire after 5 minutes. A completed download may be redirected to a short-lived read-only R2 URL valid for 60 seconds. Never print, log, or persist signed URLs beyond their intended lifetime.

## Successful response

The legacy upload endpoints return:

```json
{
  "ok": true,
  "url": "https://content.aryuki.com/s/abc123",
  "slug": "abc123",
  "content_id": "cnt_...",
  "source": "cli"
}
```

File and mixed uploads may additionally return `queued: true` while Queue finishes validation. Public shares can be opened and downloaded without signing in. Internal shares require auth-center login; private shares are limited to their owner.

## Limits and safety

- API Keys are hashed in D1 and shown in full only once.
- A single CLI request accepts at most 20 files.
- Legacy upload endpoints limit a single file to 100 MiB; resumable upload sessions support a single file up to 5 GiB.
- Unfinished direct uploads are limited to 50 sessions per user; storage quota comes from the assigned permission group.
- `ADMIN_CONTACT_EMAIL` is optional. When configured, protected-share pages can open a bilingual contact link; when empty, the contact action is omitted.
- Do not expose API Keys, R2 credentials, signed URLs, or password values in logs.
