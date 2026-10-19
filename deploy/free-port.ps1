# Atea 3D Matuoklis - parenka prievada programai ir iraso ji i .env (WEB_PORT). Isveda pasirinkta prievada.
# Naudoja start-windows.bat. Prievadas turi likti pastovus: narsykle projektu sarasa ir nustatymus saugo
# atskirai kiekvienam adresui (localhost:8080 ir localhost:8081 - skirtingi).
#   0) Jei 8080 laisvas - 8080.
#   1) Jei 8080 uzima musu pacios programos konteineris - jo prievadas.
#   2) Kitaip - laukiama 8080 (Docker Desktop prievada po konteinerio sustabdymo atlaisvina per kelias sekundes).
#   3) Tik jei 8080 tikrai uzimtas kitos programos - kitas laisvas (8081...) ir parodoma, kas uzima 8080.
param([int]$Preferred = 8080)

$envFile = Join-Path $PSScriptRoot '.env'
$text = ''
if (Test-Path $envFile) { $text = [IO.File]::ReadAllText($envFile) }

function Test-Bind($addr, [int]$p) {
  try {
    $l = [Net.Sockets.TcpListener]::new($addr, $p)
    $l.Start(); $l.Stop(); return $true
  } catch { return $false }
}

# Laisvas turi buti ir IPv4, ir IPv6 localhost ([::1]) - narsykle „localhost“ pirmiausia jungiasi per [::1],
# todel kita programa, uzemusi tik [::1]:prievada, „pavogia“ visus narsykles rysius.
function Test-Free([int]$p) {
  if (-not (Test-Bind ([Net.IPAddress]::Any) $p)) { return $false }
  if ([Net.Sockets.Socket]::OSSupportsIPv6 -and -not (Test-Bind ([Net.IPAddress]::IPv6Loopback) $p)) { return $false }
  return $true
}

# Kas klauso prievado (be Docker): "pavadinimas (PID n)"
function Get-Owner([int]$p) {
  try {
    $out = @()
    foreach ($c in (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop)) {
      $pr = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
      if ($pr -and $pr.ProcessName -notmatch '^com\.docker|^docker|^vpnkit') { $out += "$($pr.ProcessName) (PID $($c.OwningProcess), $($c.LocalAddress))" }
    }
    if ($out.Count) { return ($out | Select-Object -Unique) -join ', ' }
  } catch {}
  return $null
}

function Save-Port([int]$p) {
  if ($text -match '(?m)^WEB_PORT=') { $t = $text -replace '(?m)^WEB_PORT=[^\r\n]*', "WEB_PORT=$p" }
  else { $t = $text.TrimEnd() + "`r`nWEB_PORT=$p`r`n" }
  if ($t -ne $text) { [IO.File]::WriteAllText($envFile, $t) }
}

# 0) 8080 laisvas - visada ji (net jei programa siuo metu veikia kitu prievadu - grizta i pastovu adresa)
$port = $null
if (Test-Free $Preferred) { $port = $Preferred }

# 1) Musu programos konteineris jau veikia (8080 uzimtas - galbut paties musu konteinerio)
if (-not $port) { Push-Location $PSScriptRoot
try {
  $cur = (& docker compose port web 80 2>$null) | Select-Object -First 1
  if ($cur -match ':(\d+)\s*$') { $port = [int]$Matches[1] }
} catch {}
Pop-Location }

# 2) Pageidaujamas prievadas (palaukiame, kol Docker ji atlaisvins)
if (-not $port) {
  for ($i = 0; $i -lt 15; $i++) {
    if (Test-Free $Preferred) { $port = $Preferred; break }
    Start-Sleep -Seconds 1
  }
}

# 3) Pageidaujamas uzimtas kitos programos
if (-not $port) {
  $owner = Get-Owner $Preferred
  if ($owner) { [Console]::Error.WriteLine("Prievada $Preferred uzima: $owner. Uzdarykite ja, jei norite naudoti $Preferred.") }
  $port = $Preferred + 1
  while (-not (Test-Free $port)) {
    $port++
    if ($port -gt $Preferred + 200) { $port = $Preferred; break }
  }
}

Save-Port $port
Write-Output $port
