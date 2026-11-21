@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed.
    echo Download and install it from https://nodejs.org/ , then run this file again.
    echo.
    pause
    exit /b 1
)

echo Starting local admin server...
echo.
start "Wheels Max - admin server" /D "%~dp0" cmd /k "chcp 65001 >nul && node admin-server.mjs"
timeout /t 3 /nobreak >nul
start "" "http://localhost:8787/admin/"

echo.
echo Browser: http://localhost:8787/admin/
echo If the browser did not open, paste this address into it manually.
echo To stop the server, close the window titled "Wheels Max - admin server".
echo.
timeout /t 6 >nul
