@echo off
title tangOS Console
cd /d "%~dp0console"

rem First run (or after a clean checkout): install deps and build.
if not exist "out\main\index.js" (
  echo Preparing tangOS Console for first run...
  if not exist "node_modules" (
    call npm install
    if errorlevel 1 goto :err
  )
  call npm run build
  if errorlevel 1 goto :err
)

rem Launch the built app (production mode, no dev server).
rem electron is hoisted to the monorepo root node_modules (npm workspaces).
start "" "%~dp0node_modules\.bin\electron.cmd" .
exit /b 0

:err
echo.
echo Could not prepare tangOS Console. See the messages above.
pause
