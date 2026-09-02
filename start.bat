@echo off
setlocal
cd /d "%~dp0"
title UpNotice - start (development)
echo ==============================================
echo  UpNotice - starting server + app (dev mode)
echo ==============================================
echo.

echo [1/5] Stopping anything old on ports 4000 and 4001...
docker compose down --remove-orphans >nul 2>&1
docker rm -f teamannounce upnotice >nul 2>&1
for %%P in (4000 4001) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr /r /c:":%%P .*LISTENING"') do taskkill /PID %%A /F >nul 2>&1
)

echo [2/5] Installing server packages...
pushd server
call npm install --no-audit --no-fund
popd

echo [3/5] Installing app packages and clearing the Vite cache...
pushd app
call npm install --no-audit --no-fund
if exist node_modules\.vite rmdir /s /q node_modules\.vite
popd

echo [4/5] Starting the server (new window)...
start "UpNotice API (port 4001)" cmd /k "cd /d "%~dp0server" && npm run dev"
timeout /t 4 /nobreak >nul

echo [5/5] Starting the app (new window)...
start "UpNotice app (port 4000)" cmd /k "cd /d "%~dp0app" && npx vite --force"
timeout /t 6 /nobreak >nul

start "" http://localhost:4000
echo.
echo Done. Sign in with admin@company.com / admin123
echo Close the two new windows to stop UpNotice.
echo.
pause
