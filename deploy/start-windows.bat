@echo off
rem Atea 3D Matuoklis - apdorojimo serverio paleidimas Windows kompiuteryje
rem Reikia: Docker Desktop (https://www.docker.com/products/docker-desktop/)
setlocal
cd /d "%~dp0"

where docker >nul 2>nul
if errorlevel 1 (
  echo [KLAIDA] Docker nerastas. Idiekite Docker Desktop: https://www.docker.com/products/docker-desktop/
  pause
  exit /b 1
)

docker info >nul 2>nul
if errorlevel 1 (
  echo [KLAIDA] Docker Desktop nepaleistas. Paleiskite ji, palaukite kol pasileis, ir paleiskite si faila dar karta.
  pause
  exit /b 1
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  powershell -NoProfile -Command "$f=(Resolve-Path .env).Path; $t=[guid]::NewGuid().ToString('N'); $s=[IO.File]::ReadAllText($f) -replace '(?m)^NODEODM_TOKEN=[^\r\n]*',('NODEODM_TOKEN='+$t); [IO.File]::WriteAllText($f,$s)"
  echo Sukurtas nustatymu failas .env su nauju slaptu raktu.
)

rem Senas (ar nepasileides) programos konteineris atlaisvina prievada
docker compose rm -s -f web >nul 2>nul

rem Laisvas prievadas: jei 8080 uzimtas kitos programos, parenkamas kitas (8081, 8082...)
set "PORT="
for /f "usebackq delims=" %%p in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0free-port.ps1"`) do set "PORT=%%p"
if not defined PORT set "PORT=8080"
if not "%PORT%"=="8080" echo Prievadas 8080 uzimtas kitos programos - naudojamas %PORT%.

echo.
echo Paleidziama (pirma karta atsisiuncia ~6 GB: OpenDroneMap + AI modeliai, gali uztrukti 15-30 min.)...
echo Jei serveris jau veike, jis bus atnaujintas.
docker compose up -d --build
if errorlevel 1 (
  echo [KLAIDA] Nepavyko paleisti. Perziurekite klaidas auksciau.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo  Paruosta! Programa: http://localhost:%PORT%
echo  Programoje "Is nuotrauku": Adresas ./odm/, Rakto laukeli palikite tuscia.
echo  Vieno failo versijai (release\...html) adresai: http://localhost:%PORT%/odm/ ir http://localhost:%PORT%/ai/
echo  Raktas (reikia tik jungiantis tiesiogiai, ne per localhost:%PORT%):
for /f "tokens=2 delims==" %%a in ('findstr /b "NODEODM_TOKEN=" .env') do echo     %%a
echo  Sustabdyti: docker compose down  (siame aplanke)
echo ============================================================
start "" http://localhost:%PORT%
pause
