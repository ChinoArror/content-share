@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

echo === content-share: build ^& deploy ===
where node >nul 2>&1 || (echo [x] Node.js not found in PATH & goto :fail)

echo.
echo [1/5] Installing dependencies (npm ci)...
call npm ci --no-audit --no-fund || goto :fail

echo.
echo [2/5] Running tests (vitest)...
call npm test || goto :fail

echo.
echo [3/5] Building frontend (vite build)...
call npm run build || goto :fail

echo.
echo [4/5] Applying D1 migrations (remote, includes 0006_user_ui_settings)...
call npx wrangler d1 migrations apply content-share-db --remote || goto :fail

echo.
echo [5/5] Deploying Worker (wrangler deploy)...
call npx wrangler deploy || goto :fail

echo.
echo [OK] Deployed to https://content.aryuki.com
echo Note: Adobe PDF Embed needs the ADOBE_PDF_CLIENT_ID secret (run set-adobe-secret.bat once).
pause
exit /b 0

:fail
echo.
echo [x] Failed (exit code %errorlevel%). Nothing after the failed step was run.
pause
exit /b 1
