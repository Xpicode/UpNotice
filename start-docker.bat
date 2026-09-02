@echo off
setlocal
cd /d "%~dp0"
title UpNotice - start (Docker)
echo ==============================================
echo  UpNotice - rebuilding and starting in Docker
echo ==============================================
echo.
echo Stopping any old server on port 4000...
for /f "tokens=5" %%A in ('netstat -ano ^| findstr /r /c:":4000 .*LISTENING"') do taskkill /PID %%A /F >nul 2>&1
echo Building the image (first time takes a few minutes)...
docker compose up -d --build
if errorlevel 1 (
  echo.
  echo Docker failed. Is Docker Desktop running?
  pause
  exit /b 1
)
timeout /t 4 /nobreak >nul
start "" http://localhost:4000
echo.
echo Done. Sign in with admin@company.com / admin123
echo Logs: docker compose logs -f   ^|   Stop: docker compose down
echo.
pause
