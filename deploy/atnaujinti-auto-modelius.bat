@echo off
rem Atea 3D Matuoklis - automobiliu markiu ir modeliu sarasas (numeriu filtro pozymiams) pagal Regitros duomenis.
rem 1. Atsisiuskite Regitros atviru duomenu faila "Lietuvoje iregistruotu kelio transporto priemoniu duomenys"
rem    (data.gov.lt arba regitra.lt -> Atviri duomenys), pvz. Atviri_TP_parko_duomenys.zip
rem 2. Paleiskite:  atnaujinti-auto-modelius.bat C:\kelias\Atviri_TP_parko_duomenys.zip
rem Suskaiciuojamos populiariausios markes ir modeliai Lietuvoje; sarasas issaugomas AI paslaugoje ir islieka
rem atnaujinus programa. Asmens duomenu faile nera - imami tik markiu ir modeliu pavadinimai.
setlocal
cd /d "%~dp0"
if "%~1"=="" (
  echo Nurodykite Regitros faila, pvz.: atnaujinti-auto-modelius.bat C:\Atsisiuntimai\Atviri_TP_parko_duomenys.zip
  pause
  exit /b 1
)
if not exist "%~1" (
  echo [KLAIDA] Failas nerastas: %~1
  pause
  exit /b 1
)
set "COMPOSE_FILE=docker-compose.yml"
echo Kopijuojamas failas i AI paslauga...
docker compose cp "%~1" ai:/tmp/regitra%~x1
if errorlevel 1 (
  echo [KLAIDA] Nepavyko - ar serveris paleistas ^(start-windows.bat^)?
  pause
  exit /b 1
)
docker compose exec -T ai python3 regitra_models.py /tmp/regitra%~x1
if errorlevel 1 (
  echo [KLAIDA] Failo apdoroti nepavyko - zr. pranesima auksciau.
) else (
  docker compose exec -T ai rm -f /tmp/regitra%~x1
  echo Perkraunama AI paslauga, kad imtu nauja sarasa...
  docker compose restart ai
  echo Atlikta.
)
echo.
pause
