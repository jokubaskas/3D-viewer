# Atea 3D Matuoklis - ar serveris dabar kazka apdoroja (naudoja update.bat).
# Isveda: ODM=<projektu eileje ir apdorojamu skaicius>, AI=<True, jei vyksta AI mokymas>
$ErrorActionPreference = 'SilentlyContinue'
Set-Location $PSScriptRoot
$tok = ''
$m = Select-String -Path .env -Pattern '^NODEODM_TOKEN=(.*)$' | Select-Object -First 1
if ($m) { $tok = $m.Matches[0].Groups[1].Value.Trim() }
$odm = 0
$out = docker compose exec -T web wget -qO- "http://nodeodm:3000/info?token=$tok" 2>$null
if ($out) { try { $odm = [int](($out -join '') | ConvertFrom-Json).taskQueueCount } catch {} }
$ai = $false
$out = docker compose exec -T web wget -qO- "http://ai:8000/train/status" 2>$null
if ($out) { try { $ai = [bool](($out -join '') | ConvertFrom-Json).running } catch {} }
"ODM=$odm"
"AI=$ai"
