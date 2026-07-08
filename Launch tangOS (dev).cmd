@echo off
setlocal
title tangOS Console (dev - hot reload)
cd /d "%~dp0console"

rem Make sure Node/npm are reachable in a double-click context (this is the usual reason the
rem window flashed and closed - npm not on PATH).
where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: npm / Node.js is not on your PATH in this window.
  echo Install Node.js from https://nodejs.org, then run this again.
  echo.
  pause
  exit /b 1
)

rem First run: install workspace deps from the repo root (deps hoist to the root node_modules).
if not exist "%~dp0node_modules\electron-vite" if not exist "%~dp0console\node_modules\electron-vite" (
  echo Installing dependencies (first run, one time)...
  pushd "%~dp0"
  call npm install
  popd
  if errorlevel 1 (
    echo.
    echo Dependency install failed - see the messages above.
    pause
    exit /b 1
  )
)

echo.
echo Starting tangOS in DEV mode. The app window opens on its own; UI edits hot-reload.
echo Keep THIS window open - closing it stops the app.
echo.
call npm run dev

rem We only get here if dev exits (crash or you closed the app). Never auto-close - show why.
echo.
echo === dev mode stopped (exit code %errorlevel%) ===
echo If this closed right after starting, copy the error above and send it over.
pause
