@echo off
rem Atea 3D Matuoklis - atnaujinimas vienu paspaudimu:
rem   patikrina, ar niekas neapdorojama (ODM, AI mokymas), padaro atsargine kopija, parsiuncia nauja versija
rem   (git pull) ir paleidzia start-windows.bat. Duomenys (paskyros, uzsakymai, failai, projektai) islieka.
rem Sis failas atnaujinimo metu gali pasikeisti, todel vykdoma jo kopija is TEMP aplanko.
if /i not "%~1"=="--tmp" (
  copy /y "%~f0" "%TEMP%\atea3d-update.bat" >nul
  "%TEMP%\atea3d-update.bat" --tmp "%~dp0"
  exit /b
)
setlocal
cd /d "%~2"

where git >nul 2>nul
if errorlevel 1 (
  echo [KLAIDA] Git nerastas. Idiekite: https://git-scm.com/download/win
  pause
  exit /b 1
)
git -C .. rev-parse --git-dir >nul 2>nul
if errorlevel 1 (
  echo [KLAIDA] Programos aplankas nera git kopija. Atsisiuskite is naujo:
  echo   git clone https://github.com/jokubaskas/3D-viewer.git C:\3D-viewer
  pause
  exit /b 1
)

echo Tikrinama, ar yra nauja versija...
git -C .. fetch -q origin
if errorlevel 1 (
  echo [KLAIDA] Nepavyko prisijungti prie GitHub - patikrinkite interneto rysi.
  pause
  exit /b 1
)
set "CUR="
set "NEW="
for /f %%i in ('git -C .. rev-parse HEAD') do set "CUR=%%i"
for /f %%i in ('git -C .. rev-parse "@{u}" 2^>nul') do set "NEW=%%i"
if not defined NEW for /f %%i in ('git -C .. rev-parse origin/main') do set "NEW=%%i"
for /f "tokens=1,2" %%a in ('git -C .. log -1 "--format=%%cs %%h"') do echo Dabartine versija: %%a (%%b)
if "%CUR%"=="%NEW%" (
  echo Jau naudojama naujausia versija.
  choice /m "Vis tiek perkrauti serveri"
  if errorlevel 2 exit /b 0
  goto start
)
echo.
echo Naujoje versijoje:
git -C .. log --no-merges "--format=  - %%s" HEAD..%NEW%
echo.

rem --- Ar niekas neapdorojama (atnaujinant serveris perkraunamas) ---
docker info >nul 2>nul
if errorlevel 1 goto pull
set "ODM=0"
set "AI=False"
for /f "usebackq tokens=1,* delims==" %%a in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~2busy-check.ps1"`) do set "%%a=%%b"
set "BUSY="
if not "%ODM%"=="0" (
  echo [DEMESIO] Serveryje apdorojama ar laukia eileje 3D projektu: %ODM%.
  set "BUSY=1"
)
if /i "%AI%"=="True" (
  echo [DEMESIO] Vyksta AI modelio mokymas.
  set "BUSY=1"
)
if defined BUSY (
  echo Atnaujinant serveris perkraunamas - vykstantis apdorojimas gali nutruki ^(ji bus galima pratesti mygtuku "Kartoti"^).
  echo Rekomenduojama palaukti, kol baigsis.
  choice /m "Vis tiek atnaujinti dabar"
  if errorlevel 2 exit /b 0
)

rem Atsargine duomenu kopija daroma start-windows.bat - pries perkuriant serveri

:pull
echo Parsiunciama nauja versija...
git -C .. pull --ff-only -q
if errorlevel 1 (
  echo.
  echo [KLAIDA] Nepavyko atnaujinti - programos aplanke pakeisti failai. Ju sarasas:
  git -C .. status --short --untracked-files=no
  echo Jei ju nereikia: git -C "%~2.." checkout -- .   ^(nustatymai .env ir duomenys nelieciami^)
  pause
  exit /b 1
)
for /f "tokens=1,2" %%a in ('git -C .. log -1 "--format=%%cs %%h"') do echo Nauja versija: %%a (%%b)

:start
echo.
call "%~2start-windows.bat"
