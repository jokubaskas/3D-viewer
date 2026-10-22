@echo off
rem Atea 3D Matuoklis - administratoriaus paskyra (arba nauja slaptazodzio nustatymo nuoroda, jei pamirsote)
setlocal
cd /d "%~dp0"
set "EMAIL="
set /p EMAIL=Administratoriaus el. pastas: 
if "%EMAIL%"=="" (
  echo Nenurodytas el. pastas.
  if not "%1"=="nopause" pause
  exit /b 1
)
docker compose exec -T portal python app.py create-admin "%EMAIL%"
if errorlevel 1 echo [KLAIDA] Nepavyko. Ar paleistas serveris (start-windows.bat)?
if not "%1"=="nopause" pause
