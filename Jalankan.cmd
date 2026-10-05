@echo off
cd /d "%~dp0"
if not exist node_modules (
  call npm install
  if errorlevel 1 (
    echo Instalasi gagal. Periksa koneksi internet / versi Node.js.
    pause
    exit /b 1
  )
)
call npm start
if errorlevel 1 pause
