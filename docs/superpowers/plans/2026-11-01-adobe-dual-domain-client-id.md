# Adobe PDF Embed Dual-Domain Client ID Implementation Plan

> **For agentic workers:** Implement the tasks in order, with a failing test before each behavior change.

**Goal:** Serve the Adobe PDF Embed Client ID registered for the page's public domain while preserving the existing PDF.js fallback and protected-file flow.

**Architecture:** The same-origin `/api/public/pdf-embed-config` endpoint selects between the existing `.com` ID and a new `.cn` ID. The Worker recognizes `.cn` only after validating the existing `CONTENT_PROXY_ORIGIN_SECRET` HMAC proof with `signedContentOrigin`; otherwise it uses the `.com` ID. No client-provided hostname or query parameter selects the ID.

**Tech stack:** Cloudflare Worker, TypeScript, Vitest, Adobe PDF Embed API.

**Constraints:** Write repository documentation in English. Keep `/api/*` responses `private, no-store`. Do not alter share authorization, PDF byte loading, download controls, or ESA caching. The Client ID is delivered to the browser by design; store its configured value in a Worker Secret to match current operations.

## Task 1: Domain-specific endpoint response

**Files:** `src/worker.ts`, a focused Vitest test file.

- [x] Add failing tests for direct `.com` requests, valid signed `.cn` requests, forged or stale `.cn` headers, and a missing `.cn` ID.
- [x] Add optional `ADOBE_PDF_CLIENT_ID_CN` to `Env`; keep `ADOBE_PDF_CLIENT_ID` for `.com`.
- [x] In `/api/public/pdf-embed-config`, await `signedContentOrigin(req, env.CONTENT_PROXY_ORIGIN_SECRET)` and select the `.cn` ID only for the verified `https://content.aryuki.cn` origin. Return `null` when the selected domain's ID is missing, so the existing viewer falls back to PDF.js; never use the `.com` ID for `.cn`.
- [x] Normalize configured IDs as the existing endpoint does and keep the response shape `{ ok: true, client_id }`.
- [x] Run focused and full tests, type-check, and build.

## Task 2: Configure and validate

**Files:** `readme.md`, `docs/esa-cn-proxy.md`.

- [x] Document both Client ID variables, domain mapping, and PDF.js fallback in English.
- [x] Confirm the user's `.cn` ID was installed with `wrangler secret put ADOBE_PDF_CLIENT_ID_CN`; its value was not placed in Git, chat, test output, or logs.
- [x] Deploy the Content Share Worker. No proxy Worker or ESA rule change was required because the existing HMAC proof already reaches the app.
- [x] Verify the two live config endpoints report distinct, nonempty IDs without displaying their values; both are `private, no-store`, and `.cn` is ESA `DYNAMIC`.
- [x] Open a public PDF on each domain and confirm the Adobe iframe renders with no invalid-client-ID error or fallback.
- [ ] Repeat with an authorized password-protected or internal PDF to confirm the existing authorization path and download switch; this requires a suitable test item and access credentials.

## Rollback

Remove `ADOBE_PDF_CLIENT_ID_CN` or redeploy the previous Worker version. The `.cn` viewer then uses PDF.js fallback; `.com` continues using its existing ID. Do not copy the `.com` ID into the `.cn` variable.
