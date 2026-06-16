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
| R2 存储所有文件 | 已完成 | `src/worker.ts` | `/api/contents/upload`, `/api/cli/upload-file`, `/api/attachments/:id/download` | R2 + D1 metadata | 上传文件后下载 |
| Queue 处理上传收尾 | 已完成 | `src/worker.ts`, `wrangler.toml` | 上传 API | Cloudflare Queue + D1 | 上传后 Queue consumer 将 `processing` 改为 `active` |
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
| 拖拽/多文件选择/文件列表 | 已完成 | `src/main.tsx` | `/api/contents/upload` | 表单 File | 选择多个文件 |
| 文件写入 R2 | 已完成 | `src/worker.ts` | `/api/contents/upload`, `/api/cli/upload-file` | R2 | 上传后 R2 查看对象 |
| 附件元数据写入 D1 | 已完成 | `src/worker.ts`, `schema.sql` | 上传 API | D1 `attachments` | 查询 attachments |
| 最近上传/我的文件列表来自 D1 | 已完成 | `src/main.tsx` | `/api/contents?type=file` | D1 `contents` | 上传后刷新列表 |

## D. 内容访问权限

| 功能 | 状态 | 对应文件 | 对应 API | 数据来源 | 测试方法 |
|---|---|---|---|---|---|
| public/internal/private | 已完成 | `src/worker.ts` | `/api/share/:slug` | D1 `visibility` + auth-center user | 分别访问三类内容 |
| admin 预览不增加普通访问次数 | 已完成 | `src/worker.ts`, `src/main.tsx` | `/api/share/:slug?admin_preview=1` | D1 `access_logs` preview | Admin 预览后检查 `view_count` |
| 密码、过期、最大次数、deleted 判断 | 已完成 | `src/worker.ts` | `/api/share/:slug` | D1 `contents` | 设置条件后访问 |
| 访问/下载日志写入 D1 | 已完成 | `src/worker.ts` | `/api/share/:slug`, `/api/attachments/:id/download` | D1 `access_logs` | Admin 访问日志 |

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

## 未完成项

无刻意保留的空按钮或静态假数据。受 Cloudflare 账号权限影响，最终远程 Queue/D1/Deploy 命令需以当前登录的 Wrangler 账号实际执行结果为准。
