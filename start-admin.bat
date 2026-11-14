@echo off
chcp 65001 >nul
title Шины Макс — админ-панель
cd /d "%~dp0"

if not exist node_modules (
    echo Устанавливаю зависимости...
    call npm install
)

echo.
echo Запускаю локальный сервер админ-панели...
start "Шины Макс — сервер админки" cmd /k "chcp 65001 >nul && node admin-server.mjs"
timeout /t 2 /nobreak >nul
start "" "http://localhost:8787/admin/"
