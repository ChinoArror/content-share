# Final Polish Report

日期：2026-08-23

## 本次范围

- 登录入口与切换账户统一生成当前同源 `pathname/search/hash` 的 `return_to`，通过 `/sso-callback?return_to=...` 进入 auth-center；回调继续使用 `safeReturnTo`。
- `/api/public/admin-contact` 改为先通过 `verifySso`，配置有效时返回登录用户主动点击使用的 `mailto` 地址，未配置仍返回 404。
- 管理页状态、角色、可见性、日志动作和内容类型显示统一通过 i18n；存储配额显示文案统一为存储空间。

## 回归验证

- `npm test`：17 个测试文件，166 个测试通过。
- `npx tsc --noEmit`：通过。
- `git diff --check`：通过。
- `npm run build`：本轮按要求未运行，由主线程独立验证。
- 部署：本轮未部署。
