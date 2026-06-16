# ShareWorker / content-share

Cloudflare Workers 上运行的内容发布与分享 WebApp。前端 SPA 由 Workers Assets 提供，后端 API、权限判断、R2 文件读写、D1 结构化数据和 Queue 上传收尾都在同一个 Worker 中完成。

生产域名：`https://content.aryuki.com`

## 架构

- Worker 名称：`content-share`
- 前端：React + Vite，构建后由 Cloudflare Workers Assets 托管
- 后端：Cloudflare Worker 原生 Fetch handler
- 登录：auth-center SSO，仅网页端 JWT 可访问网页/API 管理接口
- 用户识别：auth-center JWT 中的 `username`，后端结合 `role` / `ADMIN_USERNAMES` 判断 admin
- 数据库：Cloudflare D1，绑定 `DB`
- 文件存储：Cloudflare R2，绑定 `BUCKET`，bucket `content-share-save`
- 上传队列：Cloudflare Queues，绑定 `UPLOAD_QUEUE`，queue `content-share-upload-queue`

## 初始化与部署

先创建 Queue，再应用 D1 表结构，最后构建并部署：

```bash
npm install
npx wrangler queues create content-share-upload-queue
npx wrangler d1 execute content-share-db --remote --file=./schema.sql
npm run build
npx wrangler deploy
```

`wrangler.toml` 已配置自定义域：

```toml
routes = [
  { pattern = "content.aryuki.com", custom_domain = true }
]
```

## auth-center SSO

登录入口使用：

```text
https://accounts.aryuki.com/?client_id=content-share&redirect=https%3A%2F%2Fcontent.aryuki.com%2Fsso-callback
```

后端不会用 App Secret 本地验签，而是调用：

```text
GET https://accounts.aryuki.com/api/verify?app_id=content-share
Authorization: Bearer <JWT>
```

网页端所有受保护 API 都要求 auth-center JWT。API Key 只允许访问 `/api/cli/*`，不能登录网页端，不能访问用户/API/Admin 管理接口。

## 核心 API

网页端：

- `POST /api/sso-callback`
- `GET /api/me`
- `GET /api/contents`
- `POST /api/contents/text`
- `POST /api/contents/upload`
- `GET /api/contents/:id`
- `PATCH /api/contents/:id`
- `POST /api/contents/:id/delete`
- `POST /api/contents/:id/expire`
- `POST /api/contents/:id/restore`
- `GET /api/share/:slug`
- `GET /api/attachments/:id/download`

API Key：

- `GET /api/api-keys`
- `POST /api/api-keys`
- `POST /api/api-keys/:id/rotate`
- `POST /api/api-keys/:id/revoke`

CLI 上传：

- `POST /api/cli/upload-text`
- `POST /api/cli/upload-file`
- `POST /api/cli/upload-mixed`

Admin：

- `GET /api/admin/dashboard`
- `GET /api/admin/contents`
- `GET /api/admin/contents/:id`
- `PATCH /api/admin/contents/:id`
- `POST /api/admin/contents/:id/delete`
- `DELETE /api/admin/contents/:id/permanent`
- `POST /api/admin/contents/:id/expire`
- `POST /api/admin/contents/:id/restore`
- `GET /api/admin/users`
- `GET /api/admin/access-logs`
- `GET /api/admin/api-keys`
- `GET /api/admin/settings`

## CLI 上传示例

认证方式统一为：

```text
Authorization: Bearer <API_KEY>
```

### curl 上传 Markdown 文本

```bash
curl -X POST "https://content.aryuki.com/api/cli/upload-text" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "My Note",
    "content": "# Hello\n\nThis is a markdown note.",
    "format": "markdown",
    "visibility": "public",
    "slug": "my-note",
    "password": "",
    "expire_at": null,
    "max_views": 0,
    "remark": "uploaded from cli"
  }'
```

### curl 上传文件

```bash
curl -X POST "https://content.aryuki.com/api/cli/upload-file" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "file=@./report.pdf" \
  -F "title=Report" \
  -F "visibility=private" \
  -F "max_views=0"
```

### curl 上传文字 + 附件

```bash
curl -X POST "https://content.aryuki.com/api/cli/upload-mixed" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "content=# Report
See attachment." \
  -F "format=markdown" \
  -F "file=@./report.pdf" \
  -F "title=Report with Attachment" \
  -F "visibility=public" \
  -F "expire_at=2026-12-31T23:59:59Z" \
  -F "max_views=0" \
  -F "remark=uploaded from cli"
```

### PowerShell 上传文本

```powershell
$headers = @{
  Authorization = "Bearer YOUR_API_KEY"
}

$body = @{
  title = "PowerShell Note"
  content = "# Hello from PowerShell"
  format = "markdown"
  visibility = "public"
  expire_at = $null
  max_views = 0
  remark = "uploaded from powershell"
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "https://content.aryuki.com/api/cli/upload-text" `
  -Method Post `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $body
```

### PowerShell 上传文件

```powershell
$headers = @{ Authorization = "Bearer YOUR_API_KEY" }
$form = @{
  file = Get-Item ".\report.pdf"
  title = "Report"
  visibility = "public"
  max_views = "0"
}

Invoke-RestMethod `
  -Uri "https://content.aryuki.com/api/cli/upload-file" `
  -Method Post `
  -Headers $headers `
  -Form $form
```

### Node.js 上传文本

```js
const res = await fetch("https://content.aryuki.com/api/cli/upload-text", {
  method: "POST",
  headers: {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    title: "Node Note",
    content: "# Hello from Node.js",
    format: "markdown",
    visibility: "public",
    expire_at: null,
    max_views: 0,
    remark: "uploaded from node"
  })
});

console.log(await res.json());
```

### Node.js 上传文件

```js
import { readFile } from "node:fs/promises";

const form = new FormData();
form.append("file", new Blob([await readFile("./report.pdf")]), "report.pdf");
form.append("title", "Report");
form.append("visibility", "public");
form.append("max_views", "0");

const res = await fetch("https://content.aryuki.com/api/cli/upload-file", {
  method: "POST",
  headers: { "Authorization": "Bearer YOUR_API_KEY" },
  body: form
});

console.log(await res.json());
```

返回格式：

```json
{
  "ok": true,
  "url": "https://content.aryuki.com/s/abc123",
  "slug": "abc123",
  "content_id": "cnt_xxx"
}
```

参数说明：

- `visibility`: `public` / `internal` / `private`
- `expire_at`: ISO 时间字符串，`null` 或空值表示永久
- `max_views`: `0` 表示无限制
- `format`: `markdown` / `plain`

## 本地验证

```bash
npm run build
npx tsc --noEmit
npx wrangler deploy --dry-run
```
