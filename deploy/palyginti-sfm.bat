@echo off
rem Atea 3D Matuoklis - kameru padeciu (SfM) palyginimas: ODM (OpenSfM) pries COLMAP 4 + GLOMAP (Atea variklis).
rem Imamos to paties baigto ODM projekto nuotraukos; ODM projektas nekeiciamas. Trunka keliolika minuciu, vaizdo
rem plokste tuo metu uzimta - geriausia leisti, kai niekas neapdorojama.
rem   palyginti-sfm.bat              - naujausias baigtas ODM projektas
rem   palyginti-sfm.bat <projekto ID> - konkretus projektas
setlocal
cd /d "%~dp0"
set "COMPOSE_FILE=docker-compose.yml;docker-compose.gpu.yml"
docker compose exec -T engine python3 compare_sfm.py %*
if errorlevel 1 (
  echo.
  echo [KLAIDA] Palyginimas nepavyko. Ar serveris paleistas su NVIDIA vaizdo plokste (start-windows.bat)?
)
echo.
pause
