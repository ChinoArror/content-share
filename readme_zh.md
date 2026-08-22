[English README](./readme.md) | 语言：中文

# Content Share

Content Share 是运行在 Cloudflare Workers 上的内容发布与文件分享应用，当前域名为 `content.aryuki.com`。前端通过 Workers Assets 提供，后端运行在同一个 Worker 中，结构化数据写入 Cloudflare D1，文件对象只写入 Cloudflare R2，上传激活流程通过 Cloudflare Queues 顺序处理。

## 功能概览

- 只使用 auth-center SSO 登录。Worker 校验 auth-center JWT，并通过 `username` 识别用户。
- 权限判断全部在 Worker 后端完成。只有 JWT `role=admin` 可以进入 Admin Dashboard；业务权限组不能替代 Admin Dashboard 权限。
- 内容类型支持：纯文本、纯文件、文本 + 附件。
- 文本支持：普通文本、Markdown。Markdown 页面带格式工具栏和预览。
- 发布状态支持：`public`、`internal`、`private`。
- 访问控制支持：访问密码、过期时间、最大打开次数、软删除、强制过期、admin 预览不增加普通访问次数。
- 公开内容不登录也可查看。内部/私密内容仍由 Worker 判断登录和权限。
- 常见文件在线预览：图片、音频、视频、文本、PDF（PDF.js）、公开 Office 文件（Office Web Embed），以及使用隔离 iframe 直接打开的 HTML 文件；HTML 预览支持查看源代码和全屏。
- ZIP 压缩包默认保持下载模式。预览页提供“查看实际页面”按钮，会优先查找 `index.html` 或其他 HTML 入口，并把压缩包内相对资源临时映射为 Blob URL；没有可用 HTML 页面时明确提示下载。
- 浏览器上传使用只允许操作单个对象的短时 R2 地址：不超过 16 MiB 单次 PUT，16 MiB 至 100 MiB 使用 8 MiB 分片，100 MiB 以上至 5 GiB 使用 64 MiB 分片，并支持 IndexedDB 队列恢复和真实字节进度。
- 断点续传使用 SHA-256 文件指纹，指纹由文件元数据以及文件首尾各 1 MiB 组成，不会只按文件名匹配。Worker 通过上传进度心跳更新 `last_activity_at`，连续 30 分钟没有进度或心跳后，定时清理未完成会话、R2 分片/临时对象和 D1 分片记录。
- 预览继续由 Worker 完成权限与 Range 检查。新直传附件在 Worker 鉴权后使用 60 秒只读 R2 地址下载；旧对象安全回退为 Worker 流式下载。
- 公开/内部内容支持评论。已登录用户可评论，并选择所有人可见或仅自己可见。发布者可二次确认后删除任意评论。
- 私密内容显示为“备忘”，仅发布者可见和编辑。
- API Key 只允许调用命令行上传接口，不能登录网页端，不能访问 admin。
- 完整 API 文档发布在 [`https://content.aryuki.com/docs`](https://content.aryuki.com/docs)，内容源文件为 `ApiDocs.md`。
- 用户头像优先使用 auth-center JWT/verify 返回的 `avatar_url`，没有时使用本地默认头像。
- 支持响应式移动端、可折叠侧栏、点击空白关闭菜单、R2 背景图配置和落地页背景透明度设置。
- 固定界面支持中文/English 切换，按钮位于右上角，选择会保存在浏览器 `localStorage`；用户自己的标题、文件名和正文不会被翻译。
- 每个用户只能分配一个业务权限组。权限组控制公开发布、API、内部查看/下载、存储额度和评论权限；内置 `admin`、`user` 组不能删除。用户失去 API 权限后，名下 API Key 会自动锁定。
- `/face-transfer` 提供面对面传文件：发送端在浏览器本地生成并循环显示 RaptorQ Fountain Code 动态二维码，每轮自动打乱并可调换码速度；接收端扫码后在本地恢复、预览和保存文件，文件内容不上传 Worker 或 R2。

## Cloudflare 资源

`wrangler.toml` 中需要以下绑定：

- Worker 名称：`content-share`
- 自定义域名：`content.aryuki.com`
- D1 数据库绑定：`DB`
- R2 存储桶绑定：`BUCKET`
- Queue 生产者/消费者绑定：`UPLOAD_QUEUE`
- Workers Assets 绑定：`ASSETS`

重要环境变量：

- `SSO_URL=https://accounts.aryuki.com`
- `SSO_APP_ID=content-share`
- `PUBLIC_BASE_URL=https://content.aryuki.com`
- `R2_ACCOUNT_ID=...`
- `R2_BUCKET_NAME=content-share-save`

以下值必须保存为 Worker Secret，不得作为明文变量或提交到仓库：

- `MEDIA_TICKET_SECRET`
- `R2_UPLOAD_ACCESS_KEY_ID`
- `R2_UPLOAD_SECRET_ACCESS_KEY`
- `R2_DOWNLOAD_ACCESS_KEY_ID`
- `R2_DOWNLOAD_SECRET_ACCESS_KEY`

R2 S3 凭据必须在 R2 概述页的“管理 API 令牌”中创建，并只授权 `content-share-save`。生产环境推荐创建两个 R2 帐户 API 令牌：上传令牌使用 Object Read & Write，下载令牌使用 Object Read。创建后复制页面显示的 **Access Key ID** 和 **Secret Access Key**，不要把通用 Cloudflare API Token、Account ID 或 Token ID 当作 Access Key ID。R2 S3 Access Key ID 必须是接口接受的 32 位字母数字字符串。密钥只能写入对应的 Worker Secret，不要写入 `wrangler.toml`、前端代码或 Git。

## 数据库

首次部署先应用 D1 迁移基线，后续升级继续执行同一命令：

```bash
npm run db:apply
```

`db:apply` 与 `db:migrate` 是同一个迁移命令的别名。`schema.sql` 只作为可读快照，生产数据库版本统一由 `migrations/` 追踪。

Schema 包含：

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
- `permission_groups`、`storage_reservations`、`upload_cleanup_claims`

## 部署

推荐顺序：

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

R2 设置命令需要具备 R2 写权限的账号会话或 API Token。上传签名使用仅限目标 Bucket 的 Object Read/Write 凭证，下载签名另用 Object Read 凭证；通过交互式 `wrangler secret put` 输入，禁止把密钥写进命令参数。

```bash
npx wrangler secret put R2_UPLOAD_ACCESS_KEY_ID
npx wrangler secret put R2_UPLOAD_SECRET_ACCESS_KEY
npx wrangler secret put R2_DOWNLOAD_ACCESS_KEY_ID
npx wrangler secret put R2_DOWNLOAD_SECRET_ACCESS_KEY
```

常用检查：

```bash
npx tsc --noEmit
npm run build
```

## 命令行上传

API Key 认证方式：

```text
Authorization: Bearer <API_KEY>
```

API Key 只能调用：

- `POST /api/cli/upload-text`
- `POST /api/cli/upload-file`
- `POST /api/cli/upload-mixed`
- `POST /api/cli/uploads/initiate`
- `POST /api/cli/uploads/:session_id/heartbeat`
- `GET|POST|DELETE /api/cli/uploads/:session_id/...`

旧版上传接口适合快速接入；大文件或需要刷新页面后续传时，使用 [ApiDocs.md](./ApiDocs.md) 中的可恢复上传会话 API：不超过 16 MiB 的文件使用一次签名 PUT，16 MiB 至 100 MiB 使用 8 MiB 分片，100 MiB 以上至 5 GiB 使用 64 MiB 分片，Queue 校验完成后才激活内容。每个文件可传入小写 64 位十六进制 SHA-256 `fingerprint`，浏览器端默认根据元数据和首尾各 1 MiB 计算；Worker 只会复用所有者、文件指纹、大小、文件数量和最后活动时间均匹配的未完成会话。最后一次进度或心跳在 30 分钟内可复用，超过 30 分钟无活动才会被定时清理。上传签名有效期为 5 分钟，完成后的下载可能跳转到有效期 60 秒的只读 R2 地址。

文件 MIME 类型不是必填项。客户端没有提供有效 MIME 类型时，Worker 会根据文件扩展名自动识别；无法识别的类型会安全保存，并在分享页提示下载。旧版 CLI 接口单次最多接收 20 个文件，每个文件最多 100 MiB；100 MiB 以上请使用可恢复上传会话，单文件上限 5 GiB。未完成的直传会话按用户限制为最多 50 个会话，存储额度由权限组控制，不再使用固定 500 MiB 总量限制。

### curl：上传文本

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

### PowerShell：上传文件

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

### Node.js：上传文本和附件

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

## 开发约束

- 不开发 S3、WebDAV、Mount Management、Mount Explorer 或多存储配置。本项目只使用 R2 存文件。
- 不做仅前端权限判断。所有敏感权限都必须在 `src/worker.ts` 中判断。
- 不添加没有真实 API 的按钮。
- `.gitignore` 已忽略 `.design/`、构建产物、Wrangler 缓存、依赖、截图和本地输出。
