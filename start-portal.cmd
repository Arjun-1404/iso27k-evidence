@echo off
cd /d "%~dp0"
echo Starting the Evidence Portal. Leave this window open; close it (or press Ctrl+C) to stop.
echo.
node scripts\local.mjs start
echo.
echo The portal has stopped. Press any key to close this window.
pause >nul
