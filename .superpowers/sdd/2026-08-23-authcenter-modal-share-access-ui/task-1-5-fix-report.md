# Task 1-5 Fix Report

## Scope

基于 `4687f34`，仅处理密码分享 ticket 安全、SSO 回跳安全和 Admin 详情字段本地化；未部署，未扩展 UI。

## A. Password ticket security

- 有 `password_hash` 的内容不再接受 `x-share-ticket` 或 `media` ticket 作为密码校验替代。
- `/api/share` 对密码内容不返回 `share_ticket`。
- 密码内容的附件不返回 `media_ticket`。
- 密码附件的 `preview-info` 在无法通过安全请求头继续在线预览时返回明确的 `PASSWORD_ATTACHMENT_RELOAD_REQUIRED` 状态。
- 回归测试覆盖 `/api/share`、`preview-info`、`preview`、`download` 的有效 ticket + 缺少 `x-share-password` 场景，并覆盖密码正确时不下发 ticket。

## B. SSO return_to

- `switchLogin` 将当前同源 `pathname/search/hash` 编码到 `/sso-callback?return_to=...`。
- 先清除本地会话并经过 auth-center logout，再进入 auth-center 登录。
- callback 只接受同源回跳，外域、协议相对地址和携带 `token` 的回跳回到 `/`。
- `token` 不写入 `return_to`。

## C. Admin detail localization

- `slug`、`Key`、`mixed_count`、`public/internal/private` 统一使用 i18n key。
- `permission_group_id` 仍不展示。
- 增加中英文映射测试。

## Verification

- `npm test`: 16 test files, 159 tests passed。
- `npx tsc --noEmit`: passed。
- `npm run build`: passed；仅有既有的 chunk size warning。
- `git diff --check`: passed。
- 未部署。
