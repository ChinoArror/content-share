# Password Blob Resource UX Fix Report

## Scope

基于 `40844f3`，仅修复密码保护附件在当前分享页面中的预览和下载资源加载；未修改 Worker 安全规则，未部署。

## Implementation

- 新增 `src/share-resource.ts`：用纯函数区分普通直连资源与“当前页密码 + 无 media ticket”的 `protected-blob` 资源，并区分密码失败与普通资源失败。
- `src/main.tsx` 的当前页资源加载使用 `fetch(url, { headers: shareHeaders(password), credentials: 'include' })`，成功后生成 object URL。
- 图片、视频、音频、文本 iframe、PDF、HTML、ZIP 预览统一使用受控资源 URL；组件卸载或资源替换时调用 `URL.revokeObjectURL`。
- 密码附件下载使用带文件名的临时 blob URL 和 `<a download>` 触发，不把密码写入 URL、`localStorage` 或 `sessionStorage`。
- 加载失败时不渲染破碎媒体，显示中英文错误状态；密码类失败可回到当前页面重新输入密码，普通失败可重试。
- public/internal 无密码或已有 media ticket 的资源继续保留原 URL 和原有行为。

## Tests

- 新增 `src/share-resource.test.ts`，覆盖资源模式和错误分类纯函数。
- `npm test`: 17 个测试文件，163 个测试通过。
- `npx tsc --noEmit`: 通过。
- `npm run build`: 通过；仅有既有的 chunk size warning。
- `git diff --check`: 通过。

## Delivery

- 未调用部署命令。
- 本报告对应当前安全 UX 修复提交。
