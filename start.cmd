@echo off
title vantage agent
cd /d "%~dp0"
echo.
echo   Starting vantage agent...
echo   A browser window will open at http://localhost:8123
echo.
node agent.mjs
echo.
echo   Agent stopped. Press any key to close.
pause >nul
