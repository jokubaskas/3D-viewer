# Atea 3D Matuoklis - atsarginiu kopiju vieta (.env BACKUP_DIR). Naudoja start-windows.bat ir restore-backup.bat.
#   Vietinis diskas (pvz. D:\)    - portalas kopijas raso tiesiai ten.
#   Tinklo / USB diskas (pvz. O:\) - Docker jo nemato arba jis gali buti atjungtas, todel kopijos rasomos
#                                    vietoje, o is ten kas valanda (ir paleidziant) nukopijuojamos i ta diska.
# Isveda: DOCKER=<aplankas portalui, su />, COPY=<kur papildomai kopijuoti arba tuscia>, LOCAL=<aplankas portalui, su \>.
# -Sync: nukopijuoti dabar (robocopy, be trynimo - tinklo diske niekas neistrinama).
param([switch]$Sync)

$envFile = Join-Path $PSScriptRoot '.env'
$local = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\atea3d-atsargines-kopijos'))
$want = ''
if (Test-Path $envFile) {
  foreach ($line in [IO.File]::ReadAllLines($envFile)) {
    if ($line -match '^\s*BACKUP_DIR\s*=(.*)$') { $want = $Matches[1] }
  }
}
# Nematomi simboliai (kopijuojant kelia is Windows ypatybiu pridedamas U+202A), kabutes, tarpai
$want = ($want -replace '[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF"'']', '').Trim() -replace '/', '\'
if ($want -match '^[A-Za-z]:\\?$') { $want = $want.Substring(0, 2) + '\Atea3D-atsargines-kopijos' }  # disko saknis - atskiras aplankas

$docker = $local
$copy = ''
if ($want) {
  $type = 'Network'
  if (-not $want.StartsWith('\\')) {
    try { $type = ([IO.DriveInfo]::new($want.Substring(0, 3))).DriveType.ToString() } catch { $type = 'NoRootDirectory' }
  }
  if ($type -eq 'Fixed') { $docker = $want }
  elseif ($type -in 'Network', 'Removable') { $copy = $want }
  else {
    [Console]::Error.WriteLine("[ISPEJIMAS] Atsarginiu kopiju diskas $want nerastas - kopijos laikomos $local")
  }
}
New-Item -ItemType Directory -Force -Path $docker -ErrorAction SilentlyContinue | Out-Null

# Kas valanda - kopijavimas i tinklo / USB diska (Windows uzduociu planuoklis, tik prisijungus - mato tinklo diskus)
$task = 'Atea3D atsargines kopijos'
try {
  if ($copy) {
    $arg = "-NoProfile -WindowStyle Hidden -Command `"robocopy '$docker' '$copy' /E /R:1 /W:5 /NP /NFL /NDL /NJH /NJS | Out-Null`""
    $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
    $trg = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours 1)
    $prn = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive
    $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
    Register-ScheduledTask -TaskName $task -Action $act -Trigger $trg -Principal $prn -Settings $set -Force | Out-Null
  } elseif (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $task -Confirm:$false
  }
} catch {
  [Console]::Error.WriteLine("[ISPEJIMAS] Nepavyko sukurti kopijavimo uzduoties: $($_.Exception.Message)")
}

if ($Sync -and $copy) {
  New-Item -ItemType Directory -Force -Path $copy -ErrorAction SilentlyContinue | Out-Null
  robocopy $docker $copy /E /R:1 /W:5 /NP /NFL /NDL /NJH /NJS | Out-Null
  if ($LASTEXITCODE -ge 8) { [Console]::Error.WriteLine("[ISPEJIMAS] Nepavyko nukopijuoti i $copy (ar diskas prijungtas?)") }
}

"DOCKER=$($docker -replace '\\', '/')"
"COPY=$copy"
"LOCAL=$docker"
