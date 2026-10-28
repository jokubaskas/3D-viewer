@echo off
rem Atea 3D Matuoklis - duomenu atkurimas is atsargines kopijos (paskyros, uzsakymai ir ju istorija, klientu failai)
setlocal
cd /d "%~dp0"

echo Atsargines kopijos (naujausia - apacioje):
docker compose run --rm --no-deps -T portal python app.py list-backups
if errorlevel 1 (
  echo [KLAIDA] Atsarginiu kopiju nerasta arba Docker nepaleistas.
  pause
  exit /b 1
)
echo.
set "NAME="
set /p NAME=Iveskite kopijos data ir laika (pvz. 20261028-0915), arba spauskite Enter - naujausia: 
echo.
echo Dabartiniai duomenys bus pakeisti kopijos duomenimis (pries tai ju busena irasoma kaip kopija "pries-atkurima").
choice /m "Testi"
if errorlevel 2 exit /b 0

docker compose stop portal
docker compose run --rm --no-deps portal python app.py restore %NAME%
set "ERR=%errorlevel%"
docker compose start portal
if not "%ERR%"=="0" (
  echo [KLAIDA] Atkurti nepavyko.
) else (
  echo Atkurta. Atnaujinkite programos puslapi narsykleje.
)
pause
