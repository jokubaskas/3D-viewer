# Atea 3D Matuoklis – persiuntėjo nustatymas (kviečia relay-setup.bat).
# 1) deploy\.env: RELAY_HOST, RELAY_KEY (atsitiktinis), RELAY_AUTH (nginx Basic „relay:raktas“);
# 2) per SSH (root@VPS) paleidžia deploy/relay/install.sh su konfigūracija deploy/relay/mediamtx.yml.
$ErrorActionPreference = 'Stop'
$deploy = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $deploy '.env'
if (-not (Test-Path $envFile)) { Copy-Item (Join-Path $deploy '.env.example') $envFile }
$text = [IO.File]::ReadAllText($envFile)
function Get-EnvValue($name) { if ($text -match "(?m)^$name=([^\r\n]*)") { return $Matches[1].Trim() } return '' }
function Set-EnvValue($name, $value) {
  if ($script:text -match "(?m)^$name=") { $script:text = $script:text -replace "(?m)^$name=[^\r\n]*", "$name=$value" }
  else { $script:text = $script:text.TrimEnd() + "`r`n$name=$value`r`n" }
}

$hostIp = Get-EnvValue 'RELAY_HOST'
$ask = Read-Host ("VPS viesas IP adresas" + $(if ($hostIp) { " [$hostIp]" } else { '' }))
if ($ask) { $hostIp = $ask.Trim() }
if ($hostIp -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { Write-Host '[KLAIDA] Iveskite IPv4 adresa, pvz. 2.29.109.25'; exit 1 }

$key = Get-EnvValue 'RELAY_KEY'
if ($key -notmatch '^[A-Za-z0-9]{24,}$') {
  $chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = New-Object byte[] 40
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $key = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}
$auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("relay:$key"))

Write-Host ''
Write-Host "Diegiama i $hostIp. Jei paklaus - iveskite 'yes', tada VPS root slaptazodi (is Hetzner laisko)."
Write-Host ''
$yml = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'mediamtx.yml')) -replace "`r", ''
$sh = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'install.sh')) -replace "`r", ''
$payload = "export RELAY_KEY='$key'`nexport RELAY_PUBLIC_IP='$hostIp'`ncat > /tmp/atea-relay.yml <<'ATEA_EOF'`n$yml`nATEA_EOF`n$sh`nexit 0`n"
$OutputEncoding = New-Object Text.UTF8Encoding $false
$payload | ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "root@$hostIp" 'bash -s'
if ($LASTEXITCODE -ne 0) { Write-Host "[KLAIDA] SSH diegimas baigesi klaida ($LASTEXITCODE)."; exit 1 }

Set-EnvValue 'RELAY_HOST' $hostIp
Set-EnvValue 'RELAY_KEY' $key
Set-EnvValue 'RELAY_AUTH' $auth
[IO.File]::WriteAllText($envFile, $text)
Write-Host ''
Write-Host "Irasyta i deploy\.env: RELAY_HOST=$hostIp, RELAY_KEY, RELAY_AUTH."
