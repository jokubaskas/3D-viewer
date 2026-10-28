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

rem Atsargine duomenu kopija pries atnaujinima (paskyros, uzsakymai ir ju istorija, klientu failai) - jei serveris veikia
docker compose exec -T portal python app.py backup pries-atnaujinima >nul 2>nul && echo Padaryta atsargine duomenu kopija pries atnaujinima.

rem Vienkartinis perejimas i vidini tinkla "atea3d": seni konteineriai prijungti prie ankstesnio tinklo ir
rem be perkurimo nepasileidzia ("network deploy_default not found"). Duomenys (projektai, modeliai, paskyros) islieka.
set "NETFIX="
for /f %%i in ('docker compose --profile internet ps -aq 2^>nul') do (
  docker inspect -f "{{json .NetworkSettings.Networks}}" %%i 2>nul | findstr /c:"atea3d" >nul || set "NETFIX=1"
)
if defined NETFIX (
  echo Atnaujinamas vidinis Docker tinklas ^(vienkartinai^)...
  docker compose --profile internet down --remove-orphans >nul 2>nul
)

rem Senas (ar nepasileides) programos konteineris - sukuriamas is naujo
docker compose rm -s -f web >nul 2>nul

echo.
echo Paleidziama (pirma karta atsisiuncia ~6 GB: OpenDroneMap + AI modeliai, gali uztrukti 15-30 min.)...
echo Jei serveris jau veike, jis bus atnaujintas.
rem Patikimi Windows sertifikatai transliaciju serveriui (imoniu tinkluose HTTPS pasirasomas imones sertifikatu)
set "CA_DIR="
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0export-certs.ps1" >nul 2>nul
rem Tik jei eksportas pavyko (tuscias failas be sertifikatu sugadintu HTTPS patikra)
for %%F in ("certs\windows-roots.pem") do if %%~zF GTR 1000 set "CA_DIR=/certs"

rem Adresas kvietimu nuorodoms: is .env (PUBLIC_URL), kitaip - sio kompiuterio prievadas
set "PUBLIC="
for /f "tokens=1,* delims==" %%a in ('findstr /b "PUBLIC_URL=" .env 2^>nul') do set "PUBLIC=%%b"
if not defined PUBLIC set "PUBLIC_URL=http://localhost:%PORT%"

rem Prieiga is interneto (Cloudflare Tunnel) - tik jei .env faile nustatytas CF_TUNNEL_TOKEN
set "PROFILE="
for /f "tokens=1,* delims==" %%a in ('findstr /b "CF_TUNNEL_TOKEN=" .env 2^>nul') do if not "%%b"=="" set "PROFILE=--profile internet"
docker compose %PROFILE% up -d --build
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
  docker compose exec -T web wget -q -O /dev/null http://127.0.0.1/ >nul 2>nul
  if not errorlevel 1 (
    powershell -NoProfile -Command "$o=@(); foreach($c in (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue)){ $p=Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; if($p -and $p.ProcessName -notmatch '^com\.docker|^docker|^vpnkit'){ $o+=('  '+$p.ProcessName+'  PID '+$c.OwningProcess+'  adresas '+$c.LocalAddress) } }; if($o.Count){ Write-Host ''; Write-Host 'Prievada %PORT% uzima ir kita programa - narsykle jungiasi prie jos, o ne prie Docker:'; $o | Select-Object -Unique | ForEach-Object { Write-Host $_ }; Write-Host 'Uzdarykite ja (arba: taskkill /PID <numeris> /F) ir paleiskite si faila is naujo.'; Write-Host 'Kol kas programa turetu atsidaryti adresu http://127.0.0.1:%PORT%'; exit 2 }; exit 0"
    if errorlevel 2 (
      pause
      exit /b 1
    )
    echo.
    echo Programa konteineryje VEIKIA, bet Windows jos nepasiekia prievadu %PORT% - sutriko Docker Desktop prievadu persiuntimas.
    echo Dazniausiai padeda:
    echo   1. Uzdarykite Docker Desktop ^(Quit Docker Desktop^).
    echo   2. Komandu eiluteje paleiskite:  wsl --shutdown
    echo   3. Vel paleiskite Docker Desktop, palaukite, ir paleiskite si faila is naujo.
    echo Jei nepadeda - patikrinkite, ar prievado neuzima kita programa ir ar jis nera rezervuotas Windows:
    netstat -ano | findstr ":%PORT% "
    netsh interface ipv4 show excludedportrange protocol=tcp
  ) else (
    echo Konteineriu busena ir programos ^(web^) pranesimai - nusiuskite juos, jei reikia pagalbos:
    docker compose ps
    docker compose logs --tail 40 web
  )
  pause
  exit /b 1
)

echo.
echo Tikrinama, ar veikia AI paslauga (iki 2 min.)...
rem Tikrinama paciame AI konteineryje: per nginx /ai/ pasiekiama tik prisijungus (atsakytu 401)
set /a AI_TRY=0
:ai_wait
docker compose exec -T ai python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=3)" >nul 2>&1
if not errorlevel 1 goto ai_ok
set /a AI_TRY+=1
if %AI_TRY% geq 40 goto ai_fail
timeout /t 3 /nobreak >nul
goto ai_wait
:ai_fail
echo.
echo [ISPEJIMAS] AI paslauga neatsako. Programa ir OpenDroneMap veiks, bet AI irankiai - ne.
echo Konteineriu busena ir paskutiniai AI pranesimai - nusiuskite juos, jei reikia pagalbos:
docker compose ps
docker compose logs --tail 40 ai
goto ai_done
:ai_ok
echo AI paslauga veikia.
:ai_done

rem Pirmas paleidimas: dar nera administratoriaus - sukuriamas kvietimas
powershell -NoProfile -Command "try{$r=Invoke-RestMethod -TimeoutSec 5 'http://localhost:%PORT%/api/health'; if($r.admins -gt 0){exit 0}else{exit 1}}catch{exit 2}"
if errorlevel 2 (
  echo [ISPEJIMAS] Portalas ^(paskyros^) neatsako. Perziurekite: docker compose logs --tail 40 portal
) else if errorlevel 1 (
  docker compose exec -T portal python app.py list-backups >nul 2>nul
  if not errorlevel 1 (
    echo.
    echo [DEMESIO] Paskyru nera, bet rasta atsargine duomenu kopija.
    echo Jei duomenys dingo - uzdarykite si langa ir paleiskite restore-backup.bat ^(atkurs paskyras, uzsakymus ir failus^).
  )
  echo.
  echo Dar nera administratoriaus paskyros - sukurkite ja dabar.
  call "%~dp0create-admin.bat" nopause
)

echo.
echo ============================================================
echo  Paruosta! Programa siame kompiuteryje: http://localhost:%PORT%
if defined PROFILE if defined PUBLIC echo  Is interneto ^(kitiems kompiuteriams, klientams^): %PUBLIC%
if defined PROFILE if not defined PUBLIC echo  Prieiga is interneto ijungta - .env faile irasykite PUBLIC_URL=https://jusu-adresas
set "RELAY="
for /f "tokens=1,* delims==" %%a in ('findstr /b "RELAY_HOST=" .env 2^>nul') do set "RELAY=%%b"
if defined RELAY echo  Transliaciju persiuntejas klientams ^(WebRTC^): %RELAY%
echo  Programoje "Is nuotrauku": Adresas ./odm/, Rakto laukeli palikite tuscia.
echo  Transliacija is drono: pulte RTMP adresas rtmp://^<sio-kompiuterio-IP^>:1935/drone
set "BKP=%~dp0..\..\atea3d-atsargines-kopijos"
for /f "tokens=1,* delims==" %%a in ('findstr /b "BACKUP_DIR=" .env 2^>nul') do if not "%%b"=="" set "BKP=%%b"
echo  Atsargines duomenu kopijos ^(kas para ir pries atnaujinima^): %BKP%
echo  Sustabdyti: docker compose down  (siame aplanke)
echo ============================================================
start "" http://localhost:%PORT%
pause
