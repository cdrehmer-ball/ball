param([Parameter(Mandatory=$true)][string]$BackupPath)
$ErrorActionPreference = 'Stop'
$marker = '.arc1-backup-'
$pos = $BackupPath.LastIndexOf($marker)
if ($pos -lt 1 -or -not (Test-Path -LiteralPath $BackupPath)) { throw 'Supply the backup path printed by Install-Claude.ps1.' }
$destination = $BackupPath.Substring(0, $pos)
$null = Get-Content -LiteralPath $BackupPath -Raw | ConvertFrom-Json
Copy-Item -LiteralPath $BackupPath -Destination $destination -Force
Write-Host 'Previous configuration restored. Fully quit and reopen Claude.'
