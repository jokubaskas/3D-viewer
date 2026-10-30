@echo off
rem Atea 3D Matuoklis - perkelimas i kita kompiuteri. 1 DALIS: paleiskite SENAJAME kompiuteryje.
rem Isaugo: nustatymus (.env - raktai, Cloudflare tunelis, persiuntejas), paskyras, uzsakymus ir ju istorija,
rem klientu failus, savus AI modelius ir (pasirinktinai) OpenDroneMap projektus. Po to senasis serveris sustabdomas,
rem kad nedirbtu kartu su naujuoju (Cloudflare tunelis skirstytu uzklausas abiem).
setlocal
cd /d "%~dp0"
set "P=deploy"
for %%I in ("%~dp0.") do set "P=%%~nxI"

docker info >nul 2>nul
if errorlevel 1 (
  echo [KLAIDA] Docker Desktop nepaleistas.
  pause
  exit /b 1
)

echo Perkelimo failai bus irasyti i nurodyta aplanka - geriausia isorinis USB diskas ar kitas vietinis diskas
echo ^(tinklo disko Docker nemato - tada irasykite i vietini aplanka ir nukopijuokite ranka^).
set "DEST="
set /p DEST=Aplankas (pvz. E:\Atea3D-perkelimas): 
if "%DEST%"=="" exit /b 1
if not exist "%DEST%" mkdir "%DEST%"
if not exist "%DEST%" (
  echo [KLAIDA] Nepavyko sukurti aplanko %DEST%
  pause
  exit /b 1
)

set "ODM=1"
echo.
echo OpenDroneMap projektai ^(nuotraukos ir rezultatai^) gali uzimti simtus GB.
choice /m "Perkelti ir OpenDroneMap projektus"
if errorlevel 2 set "ODM="

echo.
echo Stabdomas serveris ^(duomenys turi nekisti kopijuojant^)...
docker compose --profile internet stop
if errorlevel 1 (
  echo [KLAIDA] Nepavyko sustabdyti. Perziurekite klaidas auksciau.
  pause
  exit /b 1
)

copy /y ".env" "%DEST%\env.txt" >nul
set "VOLS=portal-data ai-models"
if defined ODM set "VOLS=portal-data ai-models nodeodm-data"
for %%V in (%VOLS%) do (
  echo Kopijuojama: %%V ...
  docker run --rm -v %P%_%%V:/v:ro -v "%DEST%":/out alpine tar cf /out/%%V.tar -C /v .
  if errorlevel 1 (
    echo [KLAIDA] Nepavyko nukopijuoti %%V.
    pause
    exit /b 1
  )
)
echo %DATE% %TIME% > "%DEST%\PERKELIMAS.txt"

echo.
echo ============================================================
echo  Paruosta: %DEST%
dir /b "%DEST%"
echo.
echo  Senasis serveris SUSTABDYTAS ir pats nebepasileis ^(ir perkrovus kompiuteri^).
echo  Naujajame kompiuteryje: idiekite Docker Desktop ir Git, atsisiuskite programa
echo  ^(git clone^) ir paleiskite deploy\perkelti-importas.bat.
echo  Jei persigalvosite - cia vel paleiskite start-windows.bat.
echo ============================================================
pause
