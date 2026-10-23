# Patikimi Windows sertifikatai -> certs\windows-roots.pem (transliacijų serveriui, MediaMTX).
# Įmonių tinkluose HTTPS ryšius dažnai perima saugumo sistema ir pasirašo įmonės sertifikatu: Windows ir naršyklė
# jį pažįsta, o Docker konteineris – ne, todėl serveris negalėtų paimti transliacijos iš https / wheps šaltinio.
$ErrorActionPreference = 'Stop'
$dir = Join-Path $PSScriptRoot 'certs'
New-Item -ItemType Directory -Force $dir | Out-Null
$sb = New-Object System.Text.StringBuilder
$seen = @{}
foreach ($store in 'Cert:\LocalMachine\Root', 'Cert:\CurrentUser\Root', 'Cert:\LocalMachine\CA') {
  foreach ($c in Get-ChildItem $store -ErrorAction SilentlyContinue) {
    if ($seen.ContainsKey($c.Thumbprint)) { continue }
    $seen[$c.Thumbprint] = $true
    [void]$sb.Append("-----BEGIN CERTIFICATE-----`n")
    [void]$sb.Append([Convert]::ToBase64String($c.RawData, 'InsertLineBreaks').Replace("`r", ''))
    [void]$sb.Append("`n-----END CERTIFICATE-----`n")
  }
}
[System.IO.File]::WriteAllText((Join-Path $dir 'windows-roots.pem'), $sb.ToString(), (New-Object System.Text.UTF8Encoding $false))
Write-Output $seen.Count
