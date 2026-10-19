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

rem Prievadas: tas pats kaip veikiancios programos, kitaip 8080 (tik jei jis uzimtas kitos programos - 8081...).
rem Prievadas turi buti pastovus - narsykle projektu sarasa saugo atskirai kiekvienam adresui.
set "PORT="
for /f "usebackq delims=" %%p in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0free-port.ps1"`) do set "PORT=%%p"
if not defined PORT set "PORT=8080"
if not "%PORT%"=="8080" echo [DEMESIO] Naudojamas prievadas %PORT% (ne 8080) - projektu sarasas narsykleje bus atskiras.

rem Senas (ar nepasileides) programos konteineris - sukuriamas is naujo
docker compose rm -s -f web >nul 2>nul

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
echo Tikrinama, ar atsidaro programa (iki 1 min.)...
powershell -NoProfile -Command "for($i=0;$i -lt 30;$i++){try{$r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 'http://localhost:%PORT%/'; if($r.StatusCode -eq 200){exit 0}}catch{}; Start-Sleep 2}; exit 1"
if errorlevel 1 (
  echo.
  echo [KLAIDA] Programa neatsako adresu http://localhost:%PORT%
  echo Konteineriu busena ir programos ^(web^) pranesimai - nusiuskite juos, jei reikia pagalbos:
  docker compose ps
  docker compose logs --tail 40 web
  pause
  exit /b 1
)

echo.
echo Tikrinama, ar veikia AI paslauga (iki 2 min.)...
powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){try{$r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 'http://localhost:%PORT%/ai/health'; if($r.StatusCode -eq 200){exit 0}}catch{}; Start-Sleep 3}; exit 1"
if errorlevel 1 (
  echo.
  echo [ISPEJIMAS] AI paslauga neatsako. Programa ir OpenDroneMap veiks, bet AI irankiai - ne.
  echo Konteineriu busena ir paskutiniai AI pranesimai - nusiuskite juos, jei reikia pagalbos:
  docker compose ps
  docker compose logs --tail 40 ai
) else (
  echo AI paslauga veikia.
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
