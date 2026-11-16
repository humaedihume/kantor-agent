@echo off
rem Buka halaman Kantor Kelana Photobooth. Server dinyalakan (jendela kecil di taskbar) bila belum berjalan.
rem Pemakaian:  kantor-buka.cmd [halaman]     halaman: kantor (default) | brand | report | agen
set "KANTOR_PROJECT=C:\Users\rizki\Documents\Kantor Kelana Photobooth"
set "PAGE=/kerja"
if /i "%~1"=="brand"  set "PAGE=/kerja/brand"
if /i "%~1"=="report" set "PAGE=/kerja/report"
if /i "%~1"=="agen"   set "PAGE=/kerja/agen"

curl.exe -s -o nul --max-time 2 http://127.0.0.1:8788/kerja/api/ping
if errorlevel 1 (
  start "Kantor Kelana Photobooth (jangan ditutup)" /min cmd /c "cd /d "%KANTOR_PROJECT%" && node "%~dp0skills\kantor-agent\runtime\bin\serve-node.mjs""
  rem tunggu server siap (maks ~10 detik)
  for /l %%i in (1,1,20) do (
    curl.exe -s -o nul --max-time 1 http://127.0.0.1:8788/kerja/api/ping && goto :buka
    ping -n 2 127.0.0.1 >nul
  )
)
:buka
start "" "http://127.0.0.1:8788%PAGE%"
