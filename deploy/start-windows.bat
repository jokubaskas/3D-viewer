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
  powershell -NoProfile -Command "$t=[guid]::NewGuid().ToString('N'); (Get-Content .env) -replace '^NODEODM_TOKEN=.*',('NODEODM_TOKEN='+$t) | Set-Content .env"
  echo Sukurtas nustatymu failas .env su nauju slaptu raktu.
)

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
echo  Paruosta! Programa: http://localhost:8080
echo  Programoje "Is nuotrauku": Adresas ./odm/, Rakto laukeli palikite tuscia.
echo  Raktas (reikia tik jungiantis tiesiogiai, ne per localhost:8080):
for /f "tokens=2 delims==" %%a in ('findstr /b "NODEODM_TOKEN=" .env') do echo     %%a
echo  Sustabdyti: docker compose down  (siame aplanke)
echo ============================================================
start "" http://localhost:8080
pause
