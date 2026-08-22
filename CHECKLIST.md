# 已填写验收 Checklist

## A. 总体架构

| 功能 | 状态 | 对应文件 | 对应 API | 数据来源 | 测试方法 |
|---|---|---|---|---|---|
| 前端运行在 Cloudflare Workers | 已完成 | `wrangler.toml`, `src/main.tsx` | 静态 assets fallback | Workers Assets | `npm run build`, `npx wrangler deploy --dry-run` |
| 后端 API 运行在 Cloudflare Workers | 已完成 | `src/worker.ts` | `/api/*` | Worker bindings | `npx wrangler deploy --dry-run` |
| 使用 auth-center SSO 登录 | 已完成 | `src/main.tsx`, `src/worker.ts` | `/api/sso-callback`, `/api/me` | auth-center verify | 浏览器点击登录 |
| 后端验证 auth-center JWT | 已完成 | `src/worker.ts` | 所有网页端受保护 API | `accounts.aryuki.com/api/verify` | 传入无效 token 返回 401/403 |
| 使用 JWT username 作为用户唯一标识 | 已完成 | `src/worker.ts`, `schema.sql` | `/api/me` | D1 `users.username` | 登录后查看 `users` |
| D1 存储结构化数据 | 已完成 | `schema.sql`, `src/worker.ts` | 所有内容/API Key/Admin API | D1 | `wrangler d1 execute` |
| R2 存储所有文件 | 已完成 | `src/worker.ts`, `src/r2-signer.ts` | `/api/uploads/initiate`, `/api/contents/upload`, `/api/attachments/:id/download` | R2 + D1 metadata | 分别上传小文件和大于 16 MiB 文件后下载并核对字节数 |
| Queue 处理上传收尾 | 已完成 | `src/worker.ts`, `wrangler.toml` | `/api/uploads/:id/part`, `/api/uploads/:id/complete`, `/api/admin/uploads/:id/retry` | Cloudflare Queue + DLQ + R2 event + D1 | 重复完成消息；模拟最终失败后检查 D1 failed、DLQ 与 admin 重试 |
| 生产 R2 S3 直传凭证 | 已完成 | `wrangler.toml`, `src/r2-signer.ts`, Worker Secrets | `/api/uploads/*`, `/api/attachments/:id/download` | R2 S3 + Worker Secrets + D1 状态 | 已按 `secret.txt` 的标记格式正确解析并写入 4 个 Secret；R2 PUT=200、Range GET=206、DELETE=204 |
| 未开发 S3/Mount/WebDAV | 已完成 | 全项目 | 无 | 无 | 搜索 UI 与源码无相关入口 |
| 没有空按钮 | 已完成 | `src/main.tsx` | 所有按钮均调用 API、复制、下载、登录或确认 | D1/R2/API | 手动点击验证 |
| 统计来自 D1/R2 聚合 | 已完成 | `src/worker.ts` | `/api/admin/dashboard`, `/api/admin/users` | D1 聚合，R2 占用来自附件元数据 | Admin Dashboard 查看 |

## B. 用户端发布文本

| 功能 | 状态 | 对应文件 | 对应 API | 数据来源 | 测试方法 |
|---|---|---|---|---|---|
| 普通文本/Markdown/预览 | 已完成 | `src/main.tsx` | `/api/contents/text` | D1 `contents.text_content` | 切换格式并发布 |
| 标题、备注、slug、密码、状态、过期、最大次数 | 已完成 | `src/main.tsx`, `src/worker.ts` | `/api/contents/text` | D1 `contents` | 发布后在我的内容查看 |
| 随机 slug 与自定义 slug | 已完成 | `src/worker.ts` | `/api/contents/text` | D1 slug 唯一索引 | 留空/填写 slug 发布 |
| 创建后真实链接可访问 | 已完成 | `src/worker.ts`, `src/main.tsx` | `/api/share/:slug` | D1 | 打开 `/s/:slug` |

## C. 用户端发布文件

| 功能 | 状态 | 对应文件 | 对应 API | 数据来源 | 测试方法 |
|---|---|---|---|---|---|
| 拖拽/多文件选择/文件列表 | 已完成 | `src/main.tsx`, `src/upload-client.ts` | `/api/uploads/initiate` | 浏览器 File + IndexedDB | 选择多个文件并刷新页面验证续传 |
| 文件写入 R2 | 已完成 | `src/worker.ts`, `src/r2-signer.ts` | `/api/uploads/*`, `/api/contents/upload`, `/api/cli/upload-file` | 私有 R2 | 上传后核对 R2 对象大小和 ETag |
| 附件元数据写入 D1 | 已完成 | `src/worker.ts`, `schema.sql`, `migrations/0001_direct_r2_transfers.sql` | `/api/uploads/*` | D1 `attachments`, `upload_sessions`, `upload_parts` | 查询会话、分片和附件状态 |
| SHA-256 指纹断点续传 | 已完成 | `src/upload-resume.ts`, `src/upload-client.ts`, `src/worker.ts`, `migrations/0002_upload_resume_fingerprint.sql` | `/api/uploads/initiate`, `/api/uploads/:id/heartbeat`, `/api/cli/uploads/*` | D1 `file_fingerprint`, `last_activity_at`, `upload_parts` | 中断后 30 分钟内用同一文件重传并检查已完成分片被复用；修改首尾内容后确认不复用 |
| 30 分钟无活动清理残留 | 已完成 | `src/worker.ts`, `wrangler.toml` | Worker scheduled handler | D1 + R2 multipart/staging objects | 设置旧 `last_activity_at` 后运行清理，确认会话、分片和 R2 残留被清理；持续心跳的大文件不被清理 |
| 最近上传/我的文件列表来自 D1 | 已完成 | `src/main.tsx` | `/api/contents?type=file` | D1 `contents` | 上传后刷新列表 |

## D. 内容访问权限

| 功能 | 状态 | 对应文件 | 对应 API | 数据来源 | 测试方法 |
|---|---|---|---|---|---|
| public/internal/private | 已完成 | `src/worker.ts` | `/api/share/:slug` | D1 `visibility` + auth-center user | 分别访问三类内容 |
| admin 预览不增加普通访问次数 | 已完成 | `src/worker.ts`, `src/main.tsx` | `/api/share/:slug?admin_preview=1` | D1 `access_logs` preview | Admin 预览后检查 `view_count` |
| 密码、过期、最大次数、deleted 判断 | 已完成 | `src/worker.ts` | `/api/share/:slug` | D1 `contents` | 设置条件后访问 |
| 访问/下载日志写入 D1 | 已完成 | `src/worker.ts` | `/api/share/:slug`, `/api/attachments/:id/download` | D1 `access_logs` | Admin 访问日志 |

### D.1 分享文件预览

| 功能 | 状态 | 对应文件 | 对应 API | 数据来源 | 测试方法 |
|---|---|---|---|---|---|
| HTML 文件默认在线预览 | 已完成 | `src/preview-policy.ts`, `src/main.tsx`, `src/worker.ts` | `/api/attachments/:id/preview`, `/api/attachments/:id/preview-info` | R2 HTML 对象 + D1 附件元数据 | 公开 HTML 分享在未登录状态打开，确认 iframe 显示文件页面而非首页 |
| HTML 源代码/预览切换 | 已完成 | `src/main.tsx`, `src/styles.css` | 同上 | R2 HTML 对象 | 点击 `View source`，确认按钮变为 `View preview` 且仅显示源代码 |
| HTML 全屏预览 | 已完成 | `src/main.tsx`, `src/styles.css` | 无新增 API | 浏览器 Fullscreen API | Playwright 点击 `Fullscreen`，检查 `document.fullscreenElement`，按 Esc 退出 |
| ZIP 默认不展开 | 已完成 | `src/main.tsx`, `src/zip-preview.ts` | `/api/attachments/:id/preview` | R2 ZIP 对象 | 打开公开 ZIP 分享，确认先显示下载模式和 `View actual page` |
| ZIP 主动尝试页面 | 已完成 | `src/main.tsx`, `src/zip-preview.ts` | `/api/attachments/:id/preview` | R2 ZIP 中的 HTML/CSS/媒体对象 | 点击 `View actual page`，优先加载 index.html；无 HTML 时显示失败提示并保留下载 |

## E. 我的内容

| 功能 | 状态 | 对应文件 | 对应 API | 数据来源 | 测试方法 |
|---|---|---|---|---|---|
| 展示、筛选、搜索当前用户内容 | 已完成 | `src/main.tsx` | `/api/contents` | D1 `contents` | 我的内容页操作 |
| 预览、复制链接、复制二维码、编辑、删除、过期、恢复 | 已完成 | `src/main.tsx`, `src/worker.ts` | `/api/contents/:id`, `/delete`, `/expire`, `/restore` | D1 | 点击每个操作 |

## F. Admin 面板

| 功能 | 状态 | 对应文件 | 对应 API | 数据来源 | 测试方法 |
|---|---|---|---|---|---|
| Dashboard 全部统计 | 已完成 | `src/main.tsx`, `src/worker.ts` | `/api/admin/dashboard` | D1 聚合 | Admin Dashboard |
| 内容管理全部操作 | 已完成 | `src/main.tsx`, `src/worker.ts` | `/api/admin/contents*` | D1/R2 | Admin 内容管理 |
| 永久删除清理 D1 和 R2 | 已完成 | `src/worker.ts` | `DELETE /api/admin/contents/:id/permanent` | D1/R2 | 上传文件后永久删除 |
| 用户统计 | 已完成 | `src/worker.ts` | `/api/admin/users` | D1 聚合 | Admin 用户统计 |
| Admin 操作日志 | 已完成 | `src/worker.ts` | Admin mutating API | D1 `admin_actions` | 执行 Admin 操作后查询 |

## G. API Key

| 功能 | 状态 | 对应文件 | 对应 API | 数据来源 | 测试方法 |
|---|---|---|---|---|---|
| 创建、备注、过期、永久有效 | 已完成 | `src/main.tsx`, `src/worker.ts` | `/api/api-keys` | D1 `api_keys` | API Key 页创建 |
| Auth Center 风格滚动日期选择器 | 已完成 | `src/expiry-date-picker.tsx`, `src/styles.css` | `/api/api-keys` | React 表单 + D1 API Key 过期时间 | 在桌面和 390px 手机宽度打开选择器，确认弹层不溢出、可切月/选时/清除 |
| 完整 key 仅显示一次 | 已完成 | `src/main.tsx`, `src/worker.ts` | `POST /api/api-keys` | 响应一次返回明文 | 刷新后只显示前缀后缀 |
| 只存 hash，列表显示前缀和后四位 | 已完成 | `src/worker.ts`, `schema.sql` | `/api/api-keys` | D1 `key_hash/key_prefix/key_suffix` | 查询 D1 |
| rotate/revoke/过期限制 | 已完成 | `src/worker.ts` | `/api/api-keys/:id/rotate`, `/revoke`, `/api/cli/*` | D1 `api_keys` | 旋转/吊销后调用旧 key |
| API Key 只允许 CLI 上传 | 已完成 | `src/worker.ts` | `/api/cli/upload-*` | API Key hash | 用 API Key 调 `/api/me` 失败 |
| 使用日志 | 已完成 | `src/worker.ts` | `/api/cli/*` | D1 `api_key_usage_logs` | CLI 调用后查看审计 |

## H. 命令行上传

| 功能 | 状态 | 对应文件 | 对应 API | 数据来源 | 测试方法 |
|---|---|---|---|---|---|
| 上传文本/文件/混合内容 | 已完成 | `src/worker.ts` | `/api/cli/upload-text`, `/upload-file`, `/upload-mixed` | D1/R2 | README curl 测试 |
| curl、PowerShell、Node.js 示例 | 已完成 | `readme.md` | `/api/cli/*` | 文档 | 复制示例执行 |
| 内容归属 key 所属用户 | 已完成 | `src/worker.ts` | `/api/cli/*` | D1 `api_keys.owner_username` | CLI 上传后查 owner |
| 用户默认配置页面 | 已完成 | `src/main.tsx`, `src/worker.ts` | `/api/settings/cli` | D1 `user_cli_settings` | 用户设置保存 |

## I. 响应式与 UI

| 功能 | 状态 | 对应文件 | 对应 API | 数据来源 | 测试方法 |
|---|---|---|---|---|---|
| 桌面固定侧栏、手机折叠侧栏 | 已完成 | `src/styles.css`, `src/main.tsx` | 无 | UI 状态 | 调整视口 |
| 移动端 Markdown Tab | 已完成 | `src/main.tsx`, `src/styles.css` | 无 | UI 状态 | 375px 视口 |
| 表格横向滚动/紧凑操作 | 已完成 | `src/styles.css`, `src/main.tsx` | 内容/Admin API | D1 | 手机视口查看 |
| hover、Toast、二次确认 | 已完成 | `src/styles.css`, `src/main.tsx` | 删除/永久删除 API | UI + D1/R2 | 点击删除/复制 |
| Huashu Design 全站视觉与响应式重构 | 已完成 | `src/styles.css`, `src/main.tsx` | 沿用全部现有 API | D1/R2/浏览器实时状态 | Playwright 检查落地页、分享页、面对面传输的桌面与手机布局 |

## 未完成项

无刻意保留的空按钮或静态假数据。受 Cloudflare 账号权限影响，最终远程 Queue/D1/Deploy 命令需以当前登录的 Wrangler 账号实际执行结果为准。

## J. 面对面传文件

| 功能 | 状态 | 对应文件 | 对应 API | 数据来源 | 测试方法 |
|---|---|---|---|---|---|
| 公开页面与登录后侧栏入口 | 已完成 | `src/main.tsx`, `src/face-transfer.tsx` | 无，Workers Assets 页面 | 浏览器本地状态 | 打开 `/face-transfer`，切换传文件/收文件 |
| 本地 RaptorQ Fountain Code 编码与动态二维码 | 已完成 | `src/face-transfer.tsx`, `src/workers/fountain-encode.worker.ts` | 无，本地 Web Worker | 用户选择的本地 File | `npm run test:fountain`；选择文件并生成动态码 |
| 摄像头扫码、丢包恢复、预览与保存 | 已完成 | `src/face-transfer.tsx`, `src/workers/fountain-decode.worker.ts` | 无，Camera/Blob 浏览器 API | 摄像头识别的二维码帧 | 两台设备分别打开传文件和收文件模式，扫码至完成后保存并比对文件 |
| 扫码收尾防卡住与速度校准 | 已完成 | `src/face-transfer.tsx` | 无，本地播放/Camera API | 每轮打乱的二维码帧与随机采样节拍 | 生成动态码，调节换码间隔，接收端跨多轮扫码直至恢复完成 |
| 桌面与手机响应式布局 | 已完成 | `src/styles.css` | 无 | 页面真实状态 | Playwright 1440×900、390×844 截图并检查页面无横向滚动 |

## K. 多语言

| 功能 | 状态 | 对应文件 | 对应 API | 数据来源 | 测试方法 |
|---|---|---|---|---|---|
| 中文/English 全站切换 | 已完成 | `src/i18n.tsx`, `src/main.tsx`, `src/face-transfer.tsx`, `src/expiry-date-picker.tsx` | 无，浏览器本地语言偏好 | `localStorage` `content-share-language` + 浏览器语言回退 | Playwright 在落地页切换 English，确认导航/公共页面/预览固定文案切换 |
| 语言偏好刷新后保留 | 已完成 | `src/i18n.tsx` | 无 | 浏览器 `localStorage` | 切换语言后刷新页面，确认按钮与标题保持所选语言 |
| 移动端语言按钮不溢出 | 已完成 | `src/styles.css` | 无 | 浏览器视口布局 | Playwright 390×844 检查 `document.documentElement.scrollWidth === 390` |
