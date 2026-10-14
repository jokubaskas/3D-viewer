# Atea 3D Matuoklis - randa laisva prievada programai ir iraso ji i .env (WEB_PORT).
# Naudoja start-windows.bat. Isveda pasirinkta prievada.
$envFile = Join-Path $PSScriptRoot '.env'
$text = [IO.File]::ReadAllText($envFile)
$want = 8080
if ($text -match '(?m)^WEB_PORT=(\d+)') { $want = [int]$Matches[1] }

function Test-Free([int]$p) {
  try {
    $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any, $p)
    $l.Start(); $l.Stop(); return $true
  } catch { return $false }
}

$port = $want
while (-not (Test-Free $port)) {
  $port++
  if ($port -gt $want + 200) { $port = $want; break }
}

if ($port -ne $want -or $text -notmatch '(?m)^WEB_PORT=') {
  if ($text -match '(?m)^WEB_PORT=') { $text = $text -replace '(?m)^WEB_PORT=[^\r\n]*', "WEB_PORT=$port" }
  else { $text = $text.TrimEnd() + "`r`nWEB_PORT=$port`r`n" }
  [IO.File]::WriteAllText($envFile, $text)
}
Write-Output $port
