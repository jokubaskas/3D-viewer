@echo off
rem Atea 3D Matuoklis - perkelimas i kita kompiuteri. 2 DALIS: paleiskite NAUJAJAME kompiuteryje.
rem Atkuria perkelti-eksportas.bat issaugotus nustatymus ir duomenis, tada paleidzia serveri (start-windows.bat).
setlocal
cd /d "%~dp0"
set "P=deploy"
for %%I in ("%~dp0.") do set "P=%%~nxI"

docker info >nul 2>nul
if errorlevel 1 (
  echo [KLAIDA] Docker Desktop nepaleistas. Paleiskite ji ir bandykite dar karta.
  pause
  exit /b 1
)

set "SRC="
set /p SRC=Aplankas su perkelimo failais (pvz. E:\Atea3D-perkelimas): 
if not exist "%SRC%\portal-data.tar" (
  echo [KLAIDA] %SRC% nerasta portal-data.tar - ar teisingas aplankas?
  pause
  exit /b 1
)

echo.
echo Siame kompiuteryje esami programos duomenys ^(jei jau bandete paleisti^) bus PAKEISTI perkeliamais.
choice /m "Testi"
if errorlevel 2 exit /b 0

docker compose --profile internet down >nul 2>nul

if exist ".env" copy /y ".env" ".env.pries-perkelima" >nul
copy /y "%SRC%\env.txt" ".env" >nul
echo Nustatymai ^(.env^) perkelti.

for %%V in (portal-data ai-models nodeodm-data) do (
  if exist "%SRC%\%%V.tar" (
    echo Atkuriama: %%V ...
    docker volume create --label com.docker.compose.project=%P% --label com.docker.compose.volume=%%V %P%_%%V >nul
    docker run --rm -v %P%_%%V:/v -v "%SRC%":/in:ro alpine sh -c "find /v -mindepth 1 -delete && tar xf /in/%%V.tar -C /v"
    if errorlevel 1 (
      echo [KLAIDA] Nepavyko atkurti %%V.
      pause
      exit /b 1
    )
  )
)

echo.
echo Duomenys atkurti. Paleidziamas serveris...
call "%~dp0start-windows.bat"
