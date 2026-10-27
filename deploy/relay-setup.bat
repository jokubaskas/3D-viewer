@echo off
rem Atea 3D Matuoklis - transliaciju persiuntejas (VPS su viesu IP): klientams is interneto WebRTC su mazu velavimu.
rem Sugeneruoja rakta, iraso ji i .env ir per SSH idiegia MediaMTX i VPS (Ubuntu). Galima paleisti pakartotinai.
setlocal
cd /d "%~dp0"
where ssh >nul 2>nul
if errorlevel 1 (
  echo [KLAIDA] Nerasta ssh programa. Windows: Parametrai - Programos - Pasirinktines funkcijos - OpenSSH Client.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0relay\setup.ps1" %*
if errorlevel 1 (
  echo.
  echo [KLAIDA] Persiuntejo idiegti nepavyko - zr. pranesimus auksciau.
  pause
  exit /b 1
)
echo.
echo Dabar paleiskite start-windows.bat - serveris persikraus su persiunteju.
pause
