@echo off
title tangOS Console (dev - hot reload)
cd /d "%~dp0console"

rem First run: install dependencies.
if not exist "%~dp0node_modules\electron" (
  echo Installing dependencies (first run, one time)...
  call npm install
  if errorlevel 1 goto :err
)

echo.
echo Starting tangOS in DEV mode. The app window opens on its own.
echo UI edits hot-reload instantly - no rebuild needed.
echo Keep this window open; close it to stop the app.
echo.
call npm run dev
exit /b 0

:err
echo.
echo Could not start dev mode. See the messages above.
pause
