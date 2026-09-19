@echo off
rem ==============================
rem  Шины Макс: автоперенос каталога с Авито
rem  Скрипт каждые 60 минут проверяет профиль Авито
rem  и добавляет новые объявления в wheels_catalog.html.
rem  Остановка: закрыть окно или Ctrl+C.
rem ===============================

cd /d "%~dp0"
node scrape_avito.mjs "https://www.avito.ru/brands/i22897394/all?sellerId=a61479612c120d8fcc4d318554023a70" --watch 60 --apply
pause